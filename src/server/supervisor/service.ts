/**
 * The self-checks' runner: the server's checks and each project's, on a
 * schedule (supervisor.checks.interval_seconds, 60 s by default), off the
 * request path. A slow or failing measure never blocks anything:
 *
 * - each check runs with its own timeout (timeout_seconds): one still
 *   running then reports unknown, and while it hasn't settled the next
 *   rounds don't start it again;
 * - a check that throws reports unknown; the others are not touched;
 * - one round per scope at a time; scopes run apart.
 *
 * Results are kept in memory (the latest per check) and read by
 * GET /api/health/diagnostics and the ops API's diagnostics.run. A check
 * that fails for notice_minutes becomes one notice (notices.ts).
 */
import type { ProjectConfig } from "../../shared/types.js";
import type {
  CheckCounts,
  CheckId,
  CheckResult,
  DiagnosticsView,
  ProjectDiagnostics,
} from "../../shared/supervisor-types.js";
import { commandTimeouts, type CommandTimeoutLog } from "../core/command-timeouts.js";
import type { DecisionProducer } from "../decisions/types.js";
import { CHECKS, type CheckDefinition, type CheckSources, type Measured } from "./checks.js";
import {
  checkDisabled,
  checksOnlySettings,
  defaultSupervisorSettings,
  parseSupervisorConfig,
  type ChecksSettings,
  type SupervisorSettings,
} from "./config.js";
import type { RequestLatency } from "./latency.js";
import type { OsMeasures } from "./measures.js";
import { NOTICE_MODULE, Notices, noticeKey } from "./notices.js";

export const SERVER_SCOPE = "server";

/** How often the schedule looks for a scope that is due */
export const TICK_MS = 5000;
/** The first round waits this long after start, so the server's own start-up isn't measured as lag */
export const FIRST_ROUND_MS = 15_000;
/** diagnostics.run reruns a scope at most this often */
export const RERUN_MS = 10_000;

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface Clock {
  now(): number;
}

export interface SupervisorOptions {
  sources: CheckSources;
  defaultProject(): string;
  measures: OsMeasures;
  latency: RequestLatency;
  timeouts?: CommandTimeoutLog;
  clock?: Clock;
  log?: Pick<Console, "warn">;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; timedOut: boolean; error?: unknown };

/** `work`, or what kept it from settling within `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, timedOut: false, error });
      },
    );
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

export class Supervisor {
  private readonly clock: Clock;
  private readonly log: Pick<Console, "warn">;
  private readonly timeouts: CommandTimeoutLog;
  private readonly notices: Notices;
  /** Valid supervisor settings per loaded project */
  private settings = new Map<string, SupervisorSettings>();
  private problems = new Map<string, string[]>();
  private projectNames: string[] = [];
  /** project -> how many times its config was loaded */
  private generations = new Map<string, number>();
  /** scope -> check -> its latest result */
  private results = new Map<string, Map<CheckId, CheckResult>>();
  private lastRun = new Map<string, number>();
  private nextAt = new Map<string, number>();
  /** scope -> the round in progress */
  private rounds = new Map<string, Promise<void>>();
  /** scope\0check -> a measure that timed out and hasn't settled yet */
  private unsettled = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.log = options.log ?? console;
    this.timeouts = options.timeouts ?? commandTimeouts();
    this.notices = new Notices(this.log);
  }

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parseSupervisorConfig(config.supervisor);
    return parsed.ok ? [] : parsed.errors;
  }

  load(entries: ProjectEntry[]): void {
    for (const entry of entries) this.loadOne(entry);
  }

  private loadOne(entry: ProjectEntry): void {
    if (!this.projectNames.includes(entry.name)) this.projectNames.push(entry.name);
    this.generations.set(entry.name, (this.generations.get(entry.name) ?? 0) + 1);
    this.settings.delete(entry.name);
    this.problems.delete(entry.name);
    if (!entry.config) {
      if (entry.error) this.problems.set(entry.name, [entry.error]);
      return;
    }
    const parsed = parseSupervisorConfig(entry.config.supervisor);
    if (!parsed.ok) {
      this.problems.set(entry.name, parsed.errors);
      // The self-checks don't depend on the rest of the block: they run on a valid checks part, questions and digest off
      const checksOnly = checksOnlySettings(entry.config.supervisor);
      if (checksOnly) {
        this.settings.set(entry.name, checksOnly);
        this.log.warn(`[supervisor] ${entry.name}: its questions and digest are off: ${parsed.errors.join("; ")}`);
      } else {
        this.log.warn(`[supervisor] ${entry.name}: its checks don't run: ${parsed.errors.join("; ")}`);
      }
      return;
    }
    this.settings.set(entry.name, parsed.settings);
  }

  /**
   * A project's supervisor settings in effect (null: not loaded, or its checks
   * part is invalid). With problemsOf() not empty, these are the checks only.
   */
  settingsOf(project: string): SupervisorSettings | null {
    return this.settings.get(project) ?? null;
  }

  /** Counts the project's (re)loads: what was read from its config before a higher one is out of date. */
  generationOf(project: string): number {
    return this.generations.get(project) ?? 0;
  }

  /** Why a project's block is not in effect ([] when it is). */
  problemsOf(project: string): string[] {
    return this.problems.get(project) ?? [];
  }

  /** The projects loaded, in order. */
  projects(): string[] {
    return [...this.projectNames];
  }

  /** The Decision Inbox: failing checks raise their notices there. */
  useDecisions(decisions: DecisionProducer): void {
    this.notices.decisions = decisions;
    // Answers ("Noted") need nothing done; listening also keeps others from raising in this module's name over HTTP
    decisions.onResolved(NOTICE_MODULE, () => undefined);
  }

  /** The server's own checks follow the default project's settings (every default without a valid block). */
  private serverSettings(): ChecksSettings {
    let project: string | null = null;
    try {
      project = this.options.defaultProject();
    } catch {
      project = null;
    }
    return (project !== null ? this.settings.get(project)?.checks : undefined) ?? defaultSupervisorSettings().checks;
  }

  /** The scopes whose checks run now, with their settings. */
  private scopes(): { scope: string; settings: ChecksSettings }[] {
    const out: { scope: string; settings: ChecksSettings }[] = [];
    const server = this.serverSettings();
    if (server.enabled) out.push({ scope: SERVER_SCOPE, settings: server });
    for (const name of this.projectNames) {
      const s = this.settings.get(name)?.checks;
      if (s?.enabled) out.push({ scope: name, settings: s });
    }
    return out;
  }

  start(): string[] {
    if (this.phase !== "loaded") return [];
    this.phase = "started";
    // The server's own start-up blocked the event loop: that is not lag to report
    this.options.measures.resetEventLoopDelay?.();
    const first = this.clock.now() + FIRST_ROUND_MS;
    for (const { scope } of this.scopes()) this.nextAt.set(scope, first);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    return this.scopes().map((s) => s.scope);
  }

  /** Start every scope that is due (each in the background; a scope's round never overlaps the next). */
  tick(): void {
    if (this.phase !== "started") return;
    const now = this.clock.now();
    for (const { scope, settings } of this.scopes()) {
      if (this.rounds.has(scope)) continue;
      const due = this.nextAt.get(scope) ?? now;
      if (now < due) continue;
      this.nextAt.set(scope, now + settings.interval_seconds * 1000);
      this.round(scope, settings).catch((e: unknown) =>
        this.log.warn(`[supervisor] ${scope}: a round of checks failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`),
      );
    }
  }

  /** Run the scope's checks once; resolves when they all answered or timed out. */
  private round(scope: string, settings: ChecksSettings): Promise<void> {
    const running = this.rounds.get(scope);
    if (running) return running;
    const work = this.runRound(scope, settings).finally(() => this.rounds.delete(scope));
    this.rounds.set(scope, work);
    return work;
  }

  private async runRound(scope: string, settings: ChecksSettings): Promise<void> {
    const kind = scope === SERVER_SCOPE ? "server" : "project";
    const defs = CHECKS.filter((c) => c.scope === kind && !checkDisabled(settings, c.id));
    const previous = this.results.get(scope);
    // A project's config is read once per round, for every check of it
    let sources: CheckSources | null = this.options.sources;
    if (scope !== SERVER_SCOPE) {
      try {
        const config = this.options.sources.config(scope);
        sources = { ...this.options.sources, config: () => config };
      } catch {
        sources = null;
      }
    }
    const measured = await Promise.all(defs.map((def) => this.runCheck(def, scope, settings, sources, previous?.get(def.id))));
    if (this.phase === "stopped") return;
    const results = new Map<CheckId, CheckResult>();
    const project = scope === SERVER_SCOPE ? this.decisionProject() : scope;
    for (const result of measured) {
      if (!result) continue;
      if (project !== null) {
        const state = await this.notices.observe(project, result, settings, this.clock.now());
        result.failingSince = state.failingSince === null ? null : iso(state.failingSince);
        result.noticeId = state.noticeId;
      }
      results.set(result.id, result);
    }
    // A scope whose checks were turned off meanwhile keeps nothing
    if (!this.scopes().some((s) => s.scope === scope)) return;
    this.results.set(scope, results);
    this.lastRun.set(scope, this.clock.now());
    await this.reconcileNotices();
  }

  /** The project a server check's notice goes to: the default project. */
  private decisionProject(): string | null {
    try {
      return this.options.defaultProject();
    } catch {
      return null;
    }
  }

  /** Every project's open notices whose check doesn't run any more are withdrawn. */
  private async reconcileNotices(): Promise<void> {
    const active = new Map<string, Set<string>>();
    const add = (project: string, key: string) => {
      if (!active.has(project)) active.set(project, new Set());
      active.get(project)!.add(key);
    };
    const server = this.decisionProject();
    for (const { scope, settings } of this.scopes()) {
      const kind = scope === SERVER_SCOPE ? "server" : "project";
      const project = scope === SERVER_SCOPE ? server : scope;
      if (project === null) continue;
      for (const def of CHECKS) if (def.scope === kind && !checkDisabled(settings, def.id)) add(project, noticeKey(scope, def.id));
    }
    for (const project of this.projectNames) await this.notices.withdrawExcept(project, active.get(project) ?? new Set());
  }

  private async runCheck(
    def: CheckDefinition,
    scope: string,
    settings: ChecksSettings,
    sources: CheckSources | null,
    previous?: CheckResult,
  ): Promise<CheckResult | null> {
    const key = `${scope}\0${def.id}`;
    const started = this.clock.now();
    const timeoutMs = settings.timeout_seconds * 1000;
    const result = (m: Measured): CheckResult => ({
      id: def.id,
      scope,
      title: def.title,
      status: m.status,
      values: m.values,
      thresholds: m.thresholds,
      explanation: m.explanation,
      fix: m.fix,
      measuredAt: iso(this.clock.now()),
      durationMs: Math.max(0, this.clock.now() - started),
      failingSince: null,
      noticeId: null,
    });
    const unknown = (explanation: string): CheckResult =>
      result({ status: "unknown", values: previous?.values ?? {}, thresholds: previous?.thresholds ?? {}, explanation, fix: null });

    if (this.unsettled.has(key)) {
      return unknown(`Its previous measure is still running (it took longer than ${settings.timeout_seconds} s): not started again.`);
    }
    if (sources === null) return unknown("The project's config can't be read.");
    const work = Promise.resolve().then(() =>
      def.measure({
        now: this.clock.now(),
        settings,
        project: scope === SERVER_SCOPE ? null : scope,
        sources,
        measures: this.options.measures,
        latency: this.options.latency,
        timeouts: this.timeouts,
        previous,
      }),
    );
    const outcome = await within(work, timeoutMs);
    if (outcome.ok) return outcome.value === null ? null : result(outcome.value);
    if (outcome.timedOut) {
      this.unsettled.add(key);
      work.then(
        () => this.unsettled.delete(key),
        () => this.unsettled.delete(key),
      );
      return unknown(`Its measure took longer than ${settings.timeout_seconds} s; it is tried again on a later round.`);
    }
    const error = outcome.error;
    this.log.warn(`[supervisor] ${scope}: the ${def.id} check failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    return unknown(`Its measure failed (${error instanceof Error ? error.name : "an error"}); it is tried again on the next round.`);
  }

  /**
   * Run the server's checks and the project's (or every project's) now,
   * unless they ran less than RERUN_MS ago; resolves once they answered.
   */
  async runNow(project?: string): Promise<void> {
    const now = this.clock.now();
    const wanted = this.scopes().filter((s) => s.scope === SERVER_SCOPE || project === undefined || s.scope === project);
    await Promise.all(
      wanted.map(({ scope, settings }) => {
        const last = this.lastRun.get(scope);
        if (last !== undefined && now - last < RERUN_MS && !this.rounds.has(scope)) return Promise.resolve();
        return this.round(scope, settings);
      }),
    );
  }

  /** Apply a project's new config: its checks run with it from the next round (soon). */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.phase === "stopped") return;
    this.loadOne(entry);
    const on = this.scopes();
    for (const scope of [SERVER_SCOPE, entry.name]) {
      if (!on.some((s) => s.scope === scope)) {
        this.results.delete(scope);
        this.lastRun.delete(scope);
        this.notices.forget(scope);
      } else if (this.phase === "started") {
        this.nextAt.set(scope, Math.min(this.nextAt.get(scope) ?? Infinity, this.clock.now() + TICK_MS));
      }
    }
    // A check that no longer runs withdraws its open notice now
    await this.reconcileNotices();
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.rounds.values()].map((r) => r.catch(() => undefined)));
  }

  /** The latest results: the server's, and the project's (or every project's). */
  diagnostics(project?: string): DiagnosticsView {
    const order = (results: Map<CheckId, CheckResult> | undefined) =>
      CHECKS.map((c) => results?.get(c.id)).filter((r): r is CheckResult => r !== undefined);
    const server = this.serverSettings();
    const projects: ProjectDiagnostics[] = this.projectNames
      .filter((name) => project === undefined || name === project)
      .map((name) => {
        const last = this.lastRun.get(name);
        return {
          project: name,
          enabled: this.settings.get(name)?.checks.enabled ?? false,
          errors: this.problems.get(name) ?? [],
          lastRunAt: last === undefined ? null : iso(last),
          checks: order(this.results.get(name)),
        };
      });
    const serverChecks = order(this.results.get(SERVER_SCOPE));
    const counts: CheckCounts = { ok: 0, warning: 0, failing: 0, unknown: 0 };
    for (const r of [...serverChecks, ...projects.flatMap((p) => p.checks)]) counts[r.status]++;
    const last = this.lastRun.get(SERVER_SCOPE);
    return {
      enabled: server.enabled,
      intervalSeconds: server.interval_seconds,
      lastRunAt: last === undefined ? null : iso(last),
      server: serverChecks,
      projects,
      counts,
    };
  }
}
