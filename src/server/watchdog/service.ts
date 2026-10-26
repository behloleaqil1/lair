/**
 * The watchdog service: one Watchdog per project with `watchdog.enabled`.
 *
 * Each tick:
 * 1. every active detector reads a fresh ProjectView;
 * 2. findings open breaches (one per key) or refresh open ones, and open
 *    breaches no longer reported are resolved as "cleared";
 * 3. each open breach is handled: in act mode, with its playbook opted in,
 *    the playbook runs (respecting max attempts and cooldown); otherwise, or
 *    once the playbooks are used up, it is escalated once to the inbox.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import { actBlockedReason, parseWatchdogConfig, type WatchdogSettings } from "./config.js";
import { DETECTORS } from "./detectors.js";
import { Escalator } from "./escalation.js";
import { PlaybookEngine } from "./playbook-engine.js";
import { BUILTIN_PLAYBOOKS, playbooksFor } from "./playbooks.js";
import { systemProbes, type Probes } from "./probes.js";
import { WatchdogStore } from "./store.js";
import type { Breach, DetectorId, Finding, PlaybookRun, SloStatus } from "./types.js";
import { ProjectView, type WatchdogContext } from "./view.js";

export interface WatchdogOptions {
  project: string;
  config: ProjectConfig;
  settings: WatchdogSettings;
  store: WatchdogStore;
  probes: Probes;
  events?: EventBus;
}

export interface TickSummary {
  at: string;
  findings: number;
  opened: number;
  cleared: number;
  runs: number;
  escalations: number;
}

export class Watchdog {
  readonly project: string;
  private ctx: WatchdogContext;
  private engine: PlaybookEngine;
  private escalator: Escalator;
  private events?: EventBus;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<TickSummary> | null = null;
  private stopped = true;
  private abort = new AbortController();
  lastTick?: TickSummary;
  lastError?: string;

  constructor(options: WatchdogOptions) {
    this.project = options.project;
    this.events = options.events;
    this.ctx = {
      project: options.project,
      config: options.config,
      settings: options.settings,
      probes: options.probes,
      store: options.store,
      signal: this.abort.signal,
    };
    this.engine = new PlaybookEngine(this.ctx, options.events);
    this.escalator = new Escalator(this.ctx, options.events);
  }

  get settings(): WatchdogSettings {
    return this.ctx.settings;
  }

  /** Why act mode is off for this project, or null when it is on. */
  get actBlocked(): string | null {
    return actBlockedReason(this.ctx.config, this.ctx.settings);
  }

  /** True between start() and stop(). */
  get running(): boolean {
    return !this.stopped;
  }

  private iso(ms = this.ctx.probes.clock.now()): string {
    return new Date(ms).toISOString();
  }

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<TickSummary> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<TickSummary> {
    const { store, project, settings } = this.ctx;
    const view = new ProjectView(this.ctx);
    const at = this.iso(view.now);
    const summary: TickSummary = { at, findings: 0, opened: 0, cleared: 0, runs: 0, escalations: 0 };

    // 1. Detect
    const statuses: SloStatus[] = [];
    const findings = new Map<string, Finding>();
    const evaluated = new Set<DetectorId>();
    const errored = new Set<DetectorId>();
    for (const detector of DETECTORS) {
      const inactive = settings.disabledDetectors.includes(detector.id)
        ? "disabled in watchdog.disabled_detectors"
        : detector.inactiveReason(this.ctx);
      if (inactive) {
        statuses.push({ detector: detector.id, state: "inactive", openBreaches: 0, detail: inactive, checkedAt: at });
        continue;
      }
      try {
        const result = await detector.detect(view);
        evaluated.add(detector.id);
        for (const finding of result.findings) findings.set(finding.key, finding);
        statuses.push({
          detector: detector.id,
          state: result.findings.length > 0 ? "breached" : "ok",
          openBreaches: 0,
          detail:
            result.detail ??
            (result.findings.length > 0 ? result.findings.map((f) => f.summary).join("; ") : "ok"),
          checkedAt: at,
        });
      } catch (e) {
        errored.add(detector.id);
        statuses.push({
          detector: detector.id,
          state: "error",
          openBreaches: 0,
          detail: e instanceof Error ? e.message : String(e),
          checkedAt: at,
        });
      }
    }
    summary.findings = findings.size;

    // 2. Reconcile breaches
    const open = new Map<string, Breach>(
      store.openBreaches(project).map((b) => [b.key, b] as const),
    );
    for (const finding of findings.values()) {
      const existing = open.get(finding.key);
      if (existing) {
        store.touchBreach(existing.id, finding, at);
      } else {
        const breach = store.createBreach(project, finding, at);
        summary.opened++;
        await this.events?.emit("slo.breached", {
          project,
          breachId: breach.id,
          detector: breach.detector,
          key: breach.key,
          summary: breach.summary,
          evidence: breach.evidence,
        });
      }
    }
    for (const breach of open.values()) {
      if (evaluated.has(breach.detector) && !findings.has(breach.key)) {
        store.resolveBreach(breach.id, "cleared", at);
        summary.cleared++;
        await this.events?.emit("slo.recovered", {
          project,
          breachId: breach.id,
          key: breach.key,
          resolution: "cleared",
        });
      }
    }

    // 3. Handle open breaches. Skip those whose detector failed this tick (a
    // probe error): no playbook on stale data, no attempt used up, no
    // escalation. Stop handling once the watchdog is stopping.
    for (const breach of store.openBreaches(project)) {
      if (this.ctx.signal?.aborted) break;
      if (errored.has(breach.detector)) continue;
      const handled = await this.handle(breach);
      summary.runs += handled.runs;
      summary.escalations += handled.escalations;
    }

    const openCounts = new Map<DetectorId, number>();
    for (const breach of store.openBreaches(project)) {
      openCounts.set(breach.detector, (openCounts.get(breach.detector) ?? 0) + 1);
    }
    store.setSloStatus(
      project,
      statuses.map((s) => ({ ...s, openBreaches: openCounts.get(s.detector) ?? 0 })),
    );
    this.lastTick = summary;
    this.lastError = undefined;
    return summary;
  }

  private async handle(breach: Breach): Promise<{ runs: number; escalations: number }> {
    const { store, settings, probes, project } = this.ctx;
    const playbooks = playbooksFor(breach.detector);
    const blocked = this.actBlocked;
    const optedIn = playbooks.filter((p) => settings.playbooks[p.id].act);
    let escalations = 0;

    const escalate = async (reason: string, run?: PlaybookRun) => {
      if (breach.escalatedAt || this.ctx.signal?.aborted) return;
      if (await this.escalator.escalate(breach, reason, run)) escalations++;
    };

    // Observe: record what would run, and escalate once
    if (blocked || optedIn.length === 0) {
      if (!breach.escalatedAt && !store.hasEscalation(breach.id)) {
        const reason = blocked
          ? `Not acting: ${blocked}.`
          : `Not acting: no playbook for ${breach.detector} has act: true.`;
        const run = playbooks[0] ? this.engine.observe(playbooks[0], breach, reason) : undefined;
        await escalate(reason, run);
      }
      return { runs: 0, escalations };
    }

    // Act: the first opted-in playbook with attempts left, after its cooldown.
    // An attempt is a run that reached its act step; a run that stopped at
    // diagnose (a probe error) or before acting (a stop) doesn't use one up.
    const now = probes.clock.now();
    const actRuns = () =>
      store
        .runsForBreach(breach.id)
        .filter((r) => r.mode === "act" && r.steps.some((s) => s.type === "act" && s.status !== "skipped"));
    const runs = actRuns();
    for (const playbook of optedIn) {
      const playbookSettings = settings.playbooks[playbook.id];
      const previous = runs.filter((r) => r.playbookId === playbook.id);
      if (previous.length >= playbookSettings.maxAttempts) continue;
      const last = previous[0];
      if (last && now - Date.parse(last.startedAt) < playbookSettings.cooldownMinutes * 60000) {
        return { runs: 0, escalations };
      }
      const run = await this.engine.run(playbook, breach, previous.length + 1, playbookSettings);
      if (run.outcome === "recovered" || run.outcome === "cleared") {
        store.resolveBreach(breach.id, run.outcome === "recovered" ? "recovered" : "cleared", this.iso());
        await this.events?.emit("slo.recovered", {
          project,
          breachId: breach.id,
          key: breach.key,
          resolution: run.outcome,
          runId: run.id,
        });
      } else if (run.status === "failed" && this.usedUp(optedIn, actRuns())) {
        await escalate(
          `Playbook ${playbook.id} failed on its last attempt (${run.attempt}/${playbookSettings.maxAttempts}).`,
          run,
        );
      }
      return { runs: 1, escalations };
    }

    // Every opted-in playbook is used up and the breach is still open
    const last = runs[0];
    if (last) {
      const cooldown = settings.playbooks[last.playbookId].cooldownMinutes * 60000;
      if (last.status === "failed" || now - Date.parse(last.startedAt) >= cooldown) {
        await escalate(`Still detected after ${runs.length} playbook attempt(s).`, last);
      }
    }
    return { runs: 0, escalations };
  }

  private usedUp(playbooks: typeof BUILTIN_PLAYBOOKS, runs: PlaybookRun[]): boolean {
    return playbooks.every(
      (p) =>
        runs.filter((r) => r.playbookId === p.id).length >= this.ctx.settings.playbooks[p.id].maxAttempts,
    );
  }

  /** Tick now, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.abort.signal.aborted) {
      this.abort = new AbortController();
      this.ctx.signal = this.abort.signal;
    }
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[watchdog] ${this.project}: tick failed:`, e);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.ctx.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  /**
   * Stop ticking. A tick in progress ends early: a verify delay is cut short
   * and no further action starts. Resolves once that tick has finished.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
  }
}

/** Build a Watchdog from a project config; throws when `watchdog:` is invalid. */
export function createWatchdog(options: Omit<WatchdogOptions, "settings">): Watchdog {
  const parsed = parseWatchdogConfig(options.config.watchdog);
  if (!parsed.ok) {
    throw new Error(`Invalid watchdog config for ${options.project}: ${parsed.errors.join("; ")}`);
  }
  return new Watchdog({ ...options, settings: parsed.settings });
}

export interface WatchdogProjectStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  /** Why act mode is off (observe mode, read_only), or null */
  actBlocked: string | null;
  errors: string[];
  intervalSeconds: number | null;
  lastTick: TickSummary | null;
  lastError: string | null;
  slos: SloStatus[];
  playbooks: {
    id: string;
    name: string;
    detector: DetectorId;
    act: boolean;
    maxAttempts: number;
    cooldownMinutes: number;
    actionConfigured: boolean;
  }[];
}

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

/**
 * All projects' watchdogs. The store (data/watchdog.db) is opened only when
 * at least one project enables the watchdog.
 */
export class WatchdogManager {
  private watchdogs = new Map<string, Watchdog>();
  private problems = new Map<string, string[]>();
  private store: WatchdogStore | null = null;

  constructor(
    private options: {
      dbPath: string;
      probes?: Probes;
      events?: EventBus;
    },
  ) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parseWatchdogConfig(entry.config.watchdog);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[watchdog] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new WatchdogStore(this.options.dbPath);
      this.watchdogs.set(
        entry.name,
        new Watchdog({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.store,
          probes: this.options.probes ?? systemProbes(parsed.settings.commandTimeoutSeconds * 1000),
          events: this.options.events,
        }),
      );
    }
  }

  start(): string[] {
    for (const watchdog of this.watchdogs.values()) watchdog.start();
    return [...this.watchdogs.keys()];
  }

  /** Stop every watchdog, wait for ticks in progress, then close the store. */
  async stop(): Promise<void> {
    await Promise.all([...this.watchdogs.values()].map((watchdog) => watchdog.stop()));
    this.store?.close();
    this.store = null;
    this.watchdogs.clear();
  }

  get(project: string): Watchdog | undefined {
    return this.watchdogs.get(project);
  }

  getStore(): WatchdogStore | null {
    return this.store;
  }

  status(project: string): WatchdogProjectStatus {
    const watchdog = this.watchdogs.get(project);
    const settings = watchdog?.settings;
    return {
      project,
      enabled: watchdog !== undefined,
      running: watchdog?.running ?? false,
      mode: settings?.mode ?? null,
      actBlocked: watchdog ? watchdog.actBlocked : null,
      errors: this.problems.get(project) ?? [],
      intervalSeconds: settings?.intervalSeconds ?? null,
      lastTick: watchdog?.lastTick ?? null,
      lastError: watchdog?.lastError ?? null,
      slos: this.store && watchdog ? this.store.sloStatus(project) : [],
      playbooks: settings
        ? BUILTIN_PLAYBOOKS.map((p) => ({
            id: p.id,
            name: p.name,
            detector: p.detector,
            act: settings.playbooks[p.id].act,
            maxAttempts: settings.playbooks[p.id].maxAttempts,
            cooldownMinutes: settings.playbooks[p.id].cooldownMinutes,
            actionConfigured: p.steps.every((s) => !s.action || settings.actions[s.action] !== undefined),
          }))
        : [],
    };
  }
}
