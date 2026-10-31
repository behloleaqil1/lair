/**
 * The host-services service: one HostServices instance per project.
 *
 * Each tick, for every service on every configured machine:
 * 1. Probe it (argv, no shell, with a timeout). Exit 0 in time is up; a
 *    timeout is unknown (never up); anything else is down.
 * 2. Act mode: a down service is started, then probed again after
 *    start_delay_seconds. After a start Lair waits start_grace_seconds before
 *    it counts the service as down again, and the wait before the next start
 *    doubles (up to backoff_max_seconds). The counts reset only after the
 *    service has stayed up for stable_seconds, so a service that comes up and
 *    dies again is not restarted every tick. A timed-out probe never starts it.
 * 3. One decision per outage: after max_start_attempts starts without a
 *    stable recovery (start_failed, or flapping when it came up in between),
 *    or after escalate_after_probes failed probes with no start path (observe
 *    mode or a read_only project: not_started; a probe that times out:
 *    probe_timeout). A stable recovery withdraws it.
 * 4. Lane holds: while a service is not up, the pipeline lanes in its
 *    needed_by are held. In act mode the pipeline manager does not dispatch
 *    their jobs (holdFor); in observe mode holds are only reported.
 *
 * Events (on change only): host-service.up, host-service.down,
 * host-service.starting, host-service.decision. No event, status or decision
 * carries a probe's output or a command's arguments: only the program's name.
 */
import { basename, join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { EventType } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { isSafeProjectName } from "../config.js";
import type { DecisionProducer, DecisionResolution, RaiseDecisionInput } from "../decisions/types.js";
import { actBlockedReason, parseHostServicesConfig } from "./config.js";
import type {
  EscalationCode,
  HostServicesSettings,
  LaneHold,
  ProbeResult,
  ServiceConfig,
  ServiceStatus,
  StoredServiceState,
  TickSummary,
} from "./types.js";
import { DECISION_MODULE } from "./types.js";
import { HostServicesStore, freshState } from "./store.js";
import { systemHostServicesProbes, type CommandOutput, type HostServicesProbes } from "./probes.js";

/** The class of this module's decisions (decisions/structure.ts, policy C12) */
export const DECISION_CLASS = "host-services.service_down";

/** The program's base name: what logs, events and decisions may show of a command */
export function programName(argv: readonly string[]): string {
  return (basename(argv[0] ?? "") || "?").slice(0, 40);
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

export interface HostServicesOptions {
  project: string;
  config: ProjectConfig;
  settings: HostServicesSettings;
  store: HostServicesStore;
  probes: HostServicesProbes;
  events?: EventBus;
  /** Delay before the first tick after start() (default 1 s; tests tick by hand) */
  firstTickDelayMs?: number;
}

export class HostServices {
  readonly project: string;
  readonly settings: HostServicesSettings;
  private config: ProjectConfig;
  private store: HostServicesStore;
  private probes: HostServicesProbes;
  private events?: EventBus;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<TickSummary[]> | null = null;
  private stopped = true;
  private abort = new AbortController();
  lastTicks?: TickSummary[];
  lastError?: string;
  private decisions?: DecisionProducer;
  private unsubscribe?: () => void;
  private firstTickDelayMs: number;

  constructor(options: HostServicesOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.probes = options.probes;
    this.events = options.events;
    this.firstTickDelayMs = options.firstTickDelayMs ?? 1000;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Why act mode is off for this project, or null when it is on. */
  get actBlocked(): string | null {
    return actBlockedReason(this.config, this.settings);
  }

  /** Holds stop pipeline jobs only while the module runs in act mode on a writable project */
  get enforcing(): boolean {
    return this.running && this.actBlocked === null;
  }

  /** The store's last read or write problem, or null */
  get storeProblem(): string | null {
    return this.store.problem;
  }

  private get aborted(): boolean {
    return this.abort.signal.aborted;
  }

  private iso(ms = this.probes.clock.now()): string {
    return new Date(ms).toISOString();
  }

  /** Connect the Decision Inbox: one decision per outage Lair cannot fix, withdrawn on a stable recovery. */
  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    this.listen();
  }

  private listen(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.decisions?.onResolved(DECISION_MODULE, (r) => this.followAnswer(r), {
      project: this.project,
    });
  }

  /**
   * The owner's answer. "retry" clears the outage's counts (act mode starts the
   * service again, with the same backoff; a new decision needs the same number
   * of failures again). "leave" keeps them: no start and no new decision until
   * the service has stayed up for stable_seconds.
   */
  async followAnswer(resolution: DecisionResolution): Promise<void> {
    await this.store.restore();
    const s = this.store.byDecisionKey(resolution.decision.key);
    // An answer to an older decision, or one already withdrawn, changes nothing
    if (!s || s.decisionId !== resolution.decision.id) return;
    s.decisionId = null;
    if (resolution.optionId === "retry") {
      s.starts = 0;
      s.failedProbes = 0;
      s.escalated = false;
      s.recoveredAfterStart = false;
      if (s.state === "failing") s.state = s.lastProbe?.up ? "up" : "down";
    }
    await this.store.save();
  }

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<TickSummary[]> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<TickSummary[]> {
    await this.store.restore();
    this.store.prune(this.settings.machines);
    const summaries: TickSummary[] = [];
    const at = this.iso();
    for (const [machine, configs] of this.settings.machines) {
      if (this.aborted) break;
      const summary: TickSummary = { machine, at, services: configs.length, up: 0, down: 0, started: 0, decisions: 0 };
      for (const config of configs) {
        if (this.aborted) break;
        await this.checkService(machine, config, summary);
      }
      summaries.push(summary);
    }
    await this.store.save();
    if (!this.aborted) {
      this.lastTicks = summaries;
      this.lastError = undefined;
    }
    return summaries;
  }

  private async checkService(machine: string, config: ServiceConfig, summary: TickSummary): Promise<void> {
    const s = this.store.getOrInit(machine, config.name);
    const result = await this.probe(config);
    if (this.aborted) return; // stopped mid-probe: not an observation
    await this.observe(machine, config, s, result);
    if (s.state === "up") {
      summary.up++;
      return;
    }
    summary.down++;
    const blocked = this.actBlocked;
    const now = this.probes.clock.now();

    if (blocked === null && s.state === "down") {
      if (s.starts >= this.settings.maxStartAttempts) {
        // Out of starts without a stable recovery: stop starting, ask once
        s.state = "failing";
        if (await this.escalate(machine, config, s, s.recoveredAfterStart ? "flapping" : "start_failed")) summary.decisions++;
        return;
      }
      if (now >= this.nextStartMs(s)) {
        const up = await this.startService(machine, config, s);
        summary.started++;
        if (up) {
          summary.down--;
          summary.up++;
        }
      }
      return;
    }
    if (s.state === "failing") {
      // Gave up earlier (e.g. before the inbox was connected): one decision must exist
      if (!s.escalated && (await this.escalate(machine, config, s, s.recoveredAfterStart ? "flapping" : "start_failed"))) {
        summary.decisions++;
      }
      return;
    }
    // No start path: observe mode or a read_only project, or a probe that times out
    const noStart = blocked !== null || s.state === "unknown";
    if (noStart && !s.escalated && s.failedProbes >= this.settings.escalateAfterProbes) {
      if (await this.escalate(machine, config, s, blocked !== null ? "not_started" : "probe_timeout")) summary.decisions++;
    }
  }

  /** Record a probe result: state, counts, and the up/down events (on change only). */
  private async observe(machine: string, config: ServiceConfig, s: StoredServiceState, result: ProbeResult): Promise<void> {
    const first = s.lastProbe === null;
    const wasUp = s.state === "up";
    s.lastProbe = result;
    if (result.up) {
      s.lastUpAt = result.checkedAt;
      if (!wasUp) {
        s.state = "up";
        s.upSince = result.checkedAt;
        s.outageStartedAt = null;
        if (s.starts > 0) s.recoveredAfterStart = true;
        await this.emit("host-service.up", { machine, service: config.name });
      }
      const upForMs = Date.parse(result.checkedAt) - Date.parse(s.upSince ?? result.checkedAt);
      const outageLeft = s.starts > 0 || s.failedProbes > 0 || s.escalated || s.decisionId !== null;
      if (outageLeft && upForMs >= this.settings.stableSeconds * 1000) {
        // A stable recovery: the outage is over
        s.starts = 0;
        s.failedProbes = 0;
        s.recoveredAfterStart = false;
        s.escalated = false;
        if (s.decisionId) {
          await this.withdraw(s, `${config.name} on ${machine} has stayed up for ${duration(this.settings.stableSeconds)}.`);
        }
      }
      return;
    }
    s.upSince = null;
    s.failedProbes++;
    if (wasUp || first) {
      s.outageStartedAt = result.checkedAt;
      await this.emit("host-service.down", {
        machine,
        service: config.name,
        cause: result.timedOut ? "probe_timeout" : "probe_failed",
      });
    }
    // Lair gave up: only an answer or a stable recovery changes that
    if (s.state === "failing") return;
    // A slow start: it has start_grace_seconds to come up before it counts as down
    if (s.state === "starting" && this.inGrace(s)) return;
    s.state = result.timedOut ? "unknown" : "down";
  }

  private inGrace(s: StoredServiceState): boolean {
    if (!s.lastStart) return false;
    return this.probes.clock.now() < Date.parse(s.lastStart.at) + this.settings.startGraceSeconds * 1000;
  }

  /** When act mode may start the service next: the grace after the first start, doubling per start, capped. */
  private nextStartMs(s: StoredServiceState): number {
    if (s.starts === 0 || !s.lastStart) return 0;
    const wait = Math.min(
      this.settings.startGraceSeconds * 1000 * 2 ** (s.starts - 1),
      this.settings.backoffMaxSeconds * 1000,
    );
    return Date.parse(s.lastStart.at) + wait;
  }

  private async run(argv: string[], timeoutSeconds: number): Promise<CommandOutput> {
    try {
      return await this.probes.runner.run(argv, { timeoutMs: timeoutSeconds * 1000, signal: this.abort.signal });
    } catch {
      return { code: -1, stdout: "", stderr: "", timedOut: false };
    }
  }

  private async probe(config: ServiceConfig): Promise<ProbeResult> {
    const out = await this.run(config.probe, this.settings.probeTimeoutSeconds);
    const timedOut = out.timedOut === true;
    // A timeout is never up, whatever the command printed or returned
    return { up: out.code === 0 && !timedOut, code: timedOut ? -1 : out.code, timedOut, checkedAt: this.iso() };
  }

  /** Run the start command, then probe again. Returns whether the service is up after it. */
  private async startService(machine: string, config: ServiceConfig, s: StoredServiceState): Promise<boolean> {
    const at = this.iso();
    s.starts++;
    s.lastStart = { at, code: null, timedOut: false };
    s.state = "starting";
    // Saved before it runs: a restart inside the grace or the backoff never starts it early
    await this.store.save();
    await this.emit("host-service.starting", { machine, service: config.name, attempt: s.starts });
    const out = await this.run(config.start, this.settings.startTimeoutSeconds);
    if (this.aborted) return false; // stopped during the start: it counts, and its grace still applies
    const timedOut = out.timedOut === true;
    s.lastStart = { at, code: timedOut ? -1 : out.code, timedOut };
    if (timedOut || out.code !== 0) {
      console.warn(
        `[host-services] ${this.project}: the start of ${config.name} on ${machine} (${programName(config.start)}) ${timedOut ? "timed out" : `exited with ${out.code}`}`,
      );
      // The start itself failed: no grace to wait for; the backoff spaces the next one
      s.state = "down";
      return false;
    }
    await this.probes.clock.sleep(this.settings.startDelaySeconds * 1000, this.abort.signal);
    if (this.aborted) return false;
    const again = await this.probe(config);
    if (this.aborted) return false;
    await this.observe(machine, config, s, again);
    return again.up;
  }

  /** Raise this outage's one decision. Returns whether a new one was created. */
  private async escalate(machine: string, config: ServiceConfig, s: StoredServiceState, code: EscalationCode): Promise<boolean> {
    if (!this.decisions) return false;
    const input = decisionInput({
      project: this.project,
      machine,
      config,
      state: s,
      code,
      settings: this.settings,
      blocked: this.actBlocked,
    });
    try {
      const result = await this.decisions.raise(input);
      s.escalated = true;
      s.decisionId = result.decision.status === "open" ? result.decision.id : null;
      if (result.created) {
        await this.emit("host-service.decision", { machine, service: config.name, decisionId: result.decision.id, code });
      }
      return result.created;
    } catch (e) {
      // Tried again next tick
      this.lastError = `a decision for ${config.name} on ${machine} could not be raised: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    }
  }

  private async withdraw(s: StoredServiceState, reason: string): Promise<void> {
    const id = s.decisionId;
    s.decisionId = null;
    if (!id || !this.decisions) return;
    try {
      await this.decisions.withdraw(id, { module: DECISION_MODULE, reason });
    } catch {
      // Answered or withdrawn already
    }
  }

  private async emit(type: EventType, data: Record<string, unknown>): Promise<void> {
    try {
      await this.events?.emit(type, { project: this.project, ...data });
    } catch {
      // A listener's failure is not the service's
    }
  }

  private holdReason(machine: string, config: ServiceConfig, s: StoredServiceState): string {
    const since = s.outageStartedAt ? ` since ${s.outageStartedAt}` : "";
    switch (s.state) {
      case "unknown":
        return `${config.name} on ${machine} does not answer its probe${since}`;
      case "starting":
        return `${config.name} on ${machine} is starting${since}`;
      case "failing":
        return `${config.name} on ${machine} is down${since}; Lair stopped starting it after ${s.starts} start(s)`;
      default:
        return `${config.name} on ${machine} is down${since}`;
    }
  }

  /** The lanes held now: those of every service whose last probe was not up. */
  getHeldLanes(): LaneHold[] {
    const holds: LaneHold[] = [];
    const enforced = this.enforcing;
    for (const [machine, configs] of this.settings.machines) {
      for (const config of configs) {
        const s = this.store.get(machine, config.name);
        if (!s?.lastProbe || s.state === "up") continue;
        for (const lane of config.neededBy) {
          holds.push({
            lane,
            reason: this.holdReason(machine, config, s),
            heldAt: s.outageStartedAt ?? s.lastProbe.checkedAt,
            service: config.name,
            machine,
            enforced,
          });
        }
      }
    }
    return holds;
  }

  /**
   * Why a pipeline job named by any of `names` (its lane, its pipeline, or
   * `<pipeline>.<lane>`) must wait now, or null. Act mode only: in observe
   * mode, or once stopped, nothing is held.
   */
  holdFor(names: readonly string[]): string | null {
    if (!this.enforcing) return null;
    return this.getHeldLanes().find((h) => names.includes(h.lane))?.reason ?? null;
  }

  /** Whether a lane is held, whether that is enforced, and why. */
  isLaneHeld(lane: string): { held: boolean; enforced: boolean; reason: string | null } {
    const hold = this.getHeldLanes().find((h) => h.lane === lane);
    return hold ? { held: true, enforced: hold.enforced, reason: hold.reason } : { held: false, enforced: this.enforcing, reason: null };
  }

  private serviceStatus(machine: string, config: ServiceConfig): ServiceStatus {
    const s = this.store.get(machine, config.name) ?? freshState(machine, config.name);
    const waiting =
      this.actBlocked === null &&
      (s.state === "down" || s.state === "starting") &&
      s.starts > 0 &&
      s.starts < this.settings.maxStartAttempts;
    return {
      machine,
      name: config.name,
      state: s.state,
      lastProbe: s.lastProbe,
      lastUpAt: s.lastUpAt,
      upSince: s.upSince,
      outageStartedAt: s.outageStartedAt,
      failedProbes: s.failedProbes,
      starts: s.starts,
      lastStart: s.lastStart,
      nextStartAt: waiting ? this.iso(this.nextStartMs(s)) : null,
      holds: s.lastProbe && s.state !== "up" ? [...config.neededBy] : [],
      decisionId: s.decisionId,
    };
  }

  /** Status of all services for a machine. */
  getServiceStatuses(machine: string): ServiceStatus[] {
    return (this.settings.machines.get(machine) ?? []).map((config) => this.serviceStatus(machine, config));
  }

  /** Status of all services for all machines. */
  getAllServiceStatuses(): Map<string, ServiceStatus[]> {
    const result = new Map<string, ServiceStatus[]>();
    for (const machine of this.settings.machines.keys()) result.set(machine, this.getServiceStatuses(machine));
    return result;
  }

  /** Tick now, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.decisions && !this.unsubscribe) this.listen();
    if (this.aborted) this.abort = new AbortController();
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[host-services] ${this.project}: tick failed: ${this.lastError}`);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, this.firstTickDelayMs);
    this.timer.unref();
  }

  /** Stop ticking: a probe or start in flight is killed; its start still counts. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.store.flush();
  }
}

/** The decision for an outage Lair cannot fix (class host-services.service_down, policy C12). */
export function decisionInput(o: {
  project: string;
  machine: string;
  config: ServiceConfig;
  state: StoredServiceState;
  code: EscalationCode;
  settings: HostServicesSettings;
  blocked: string | null;
}): RaiseDecisionInput {
  const { machine, config, state: s, code, settings, blocked } = o;
  const key = `${machine}:${config.name}`;
  const since = s.outageStartedAt ?? s.lastProbe?.checkedAt ?? "the first probe";
  const probe = programName(config.probe);
  const startProgram = programName(config.start);
  const stable = duration(settings.stableSeconds);
  const enforced = blocked === null;
  const lanes = config.neededBy;

  let title: string;
  let what: string;
  switch (code) {
    case "start_failed":
      title = `${config.name} on ${machine} is down and Lair could not start it`;
      what = `Lair ran its start command (\`${startProgram}\`) ${s.starts} time(s) since ${since}, waiting longer each time, and the probe (\`${probe}\`) still fails. Lair has stopped starting it.`;
      break;
    case "flapping":
      title = `${config.name} on ${machine} keeps going down after it starts`;
      what = `It came up after a start and went down again before it had stayed up for ${stable}. Lair started it ${s.starts} time(s) since ${since} (\`${startProgram}\`) and has stopped starting it.`;
      break;
    case "not_started":
      title = `${config.name} on ${machine} is down and Lair is not starting it`;
      what = `The probe (\`${probe}\`) failed ${s.failedProbes} time(s) since ${since}. Not acting: ${blocked ?? "no start path"}.`;
      break;
    case "probe_timeout":
      title = `${config.name} on ${machine} does not answer its probe`;
      what = `The probe (\`${probe}\`) timed out ${s.failedProbes} time(s) since ${since} (probe_timeout_seconds ${settings.probeTimeoutSeconds}). Lair cannot tell whether it is up, so it does not start it.`;
      break;
  }
  const heldLine =
    lanes.length === 0
      ? "No pipeline lane needs it."
      : enforced
        ? `**Held while it is not up:** ${lanes.join(", ")}.`
        : `**Would be held in act mode:** ${lanes.join(", ")}.`;
  const lastStart =
    (code === "start_failed" || code === "flapping") && s.lastStart
      ? `Last start: ${s.lastStart.timedOut ? "timed out" : `exit code ${s.lastStart.code ?? "unknown"}`}.`
      : "";
  const context = [what, heldLine, lastStart, `Lair withdraws this decision once ${config.name} has stayed up for ${stable}.`]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const startsAgain = code === "start_failed" || code === "flapping";
  const retry = startsAgain
    ? {
        label: "Start it again",
        consequences:
          "Lair clears the start count and starts it again while it is down, waiting longer between starts each time; it asks again if that fails too.",
      }
    : {
        label: "Ask again later",
        consequences:
          code === "not_started"
            ? `Lair clears the count and asks again after ${settings.escalateAfterProbes} more failed probes. It starts nothing: ${blocked ?? "no start path"}.`
            : `Lair clears the count and asks again after ${settings.escalateAfterProbes} more failed probes. It starts the service only when the probe answers that it is down.`,
      };
  const reasoning: Record<EscalationCode, string> = {
    start_failed: "Starting it again did not bring it up; the cause needs a look first.",
    flapping: "It does not stay up after a start; starting it again repeats that.",
    not_started: "Lair does not start services in this mode; start it yourself and Lair notices when it is back.",
    probe_timeout: "A probe that hangs usually means the service is stuck; restart it by hand and its lanes are released when the probe passes.",
  };

  return {
    project: o.project,
    kind: "other",
    attention: "action",
    title,
    context,
    options: [
      { id: "retry", label: retry.label, consequences: retry.consequences, effect: "reversible" },
      {
        id: "leave",
        label: "Leave it to me",
        consequences: `Lair does not start it or ask again until it has stayed up for ${stable}.${enforced && lanes.length > 0 ? " Its lanes stay held while it is not up." : ""}`,
        effect: "reversible",
      },
    ],
    recommended: { optionId: "leave", reasoning: reasoning[code] },
    source: { module: DECISION_MODULE, ref: key },
    key,
    blocks: enforced ? lanes.map((lane) => `lane:${lane}`) : [],
    links: [],
    class: DECISION_CLASS,
    evidence: {
      code,
      facts: {
        machine,
        service: config.name,
        state: s.state,
        starts: s.starts,
        failed_probes: s.failedProbes,
        probe_code: s.lastProbe?.code ?? null,
        probe_timed_out: s.lastProbe?.timedOut ?? false,
        lanes_needing_it: lanes.length,
        act: enforced,
      },
      cause_cleared: false,
      linked_issue: null,
    },
  };
}

/** Build a HostServices from a project config; throws when config is invalid. */
export function createHostServices(
  options: Omit<HostServicesOptions, "settings" | "store" | "probes"> & {
    store?: HostServicesStore;
    probes?: HostServicesProbes;
  },
): HostServices {
  const parsed = parseHostServicesConfig(options.config.host_services);
  if (!parsed.ok) {
    throw new Error(`Invalid host_services config for ${options.project}: ${parsed.errors.join("; ")}`);
  }
  return new HostServices({
    ...options,
    settings: parsed.settings,
    store: options.store ?? new HostServicesStore(),
    probes: options.probes ?? systemHostServicesProbes(parsed.settings.probeTimeoutSeconds * 1000),
  });
}

export interface HostServicesProjectStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  actBlocked: string | null;
  /** Whether lane holds stop pipeline jobs now (act mode, running) */
  holdsEnforced: boolean;
  errors: string[];
  intervalSeconds: number | null;
  lastTicks: TickSummary[] | null;
  lastError: string | null;
  services: Map<string, ServiceStatus[]>;
  heldLanes: LaneHold[];
}

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

/** All projects' host-services. */
export class HostServicesManager {
  private services = new Map<string, HostServices>();
  /** Kept across reloads: the counts, the backoff and the open decision carry over */
  private stores = new Map<string, HostServicesStore>();
  private problems = new Map<string, string[]>();
  private decisions?: DecisionProducer;
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(
    private options: {
      probes?: HostServicesProbes;
      events?: EventBus;
      /** Lair's data directory: states go to <dataDir>/host-services/<project>.json (none: memory only) */
      dataDir?: string;
      /** Delay before each project's first tick (default 1 s) */
      firstTickDelayMs?: number;
    } = {},
  ) {}

  private storeFor(project: string): HostServicesStore {
    let store = this.stores.get(project);
    if (!store) {
      const dir = this.options.dataDir;
      store = new HostServicesStore(dir && isSafeProjectName(project) ? join(dir, "host-services", `${project}.json`) : undefined);
      this.stores.set(project, store);
    }
    return store;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parseHostServicesConfig(entry.config.host_services);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[host-services] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.services.set(
        entry.name,
        new HostServices({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.storeFor(entry.name),
          probes: this.options.probes ?? systemHostServicesProbes(parsed.settings.probeTimeoutSeconds * 1000),
          events: this.options.events,
          firstTickDelayMs: this.options.firstTickDelayMs,
        }),
      );
    }
  }

  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  start(): string[] {
    this.phase = "started";
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  /** Apply a project's new host_services block: the old instance stops (killing a probe or start in flight), its store carries over. */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    const old = this.services.get(entry.name);
    if (old) await old.stop();
    // The server may have stopped while the old instance did
    if (this.inPhase("stopped")) return;
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (!next) return;
    try {
      if (this.decisions) next.useDecisions(this.decisions);
      if (this.inPhase("started")) next.start();
    } catch (e) {
      await next.stop();
      this.services.delete(entry.name);
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.services.values()].map((s) => s.stop()));
    await Promise.all([...this.stores.values()].map((s) => s.flush()));
    this.services.clear();
  }

  get(project: string): HostServices | undefined {
    return this.services.get(project);
  }

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    for (const service of this.services.values()) service.useDecisions(decisions);
  }

  /** For the pipeline manager: why a job of `project` named by `names` must wait, or null. */
  holdFor(project: string, names: readonly string[]): string | null {
    return this.services.get(project)?.holdFor(names) ?? null;
  }

  /** Whether a lane of a project is held by a service that is not up. */
  isLaneHeld(project: string, lane: string): { held: boolean; enforced: boolean; reason: string | null } {
    const service = this.services.get(project);
    return service ? service.isLaneHeld(lane) : { held: false, enforced: false, reason: null };
  }

  /** All held lanes across all projects. */
  getAllHeldLanes(): Map<string, LaneHold[]> {
    const result = new Map<string, LaneHold[]>();
    for (const [project, service] of this.services) result.set(project, service.getHeldLanes());
    return result;
  }

  status(project: string): HostServicesProjectStatus {
    const service = this.services.get(project);
    return {
      project,
      enabled: service !== undefined,
      running: service?.running ?? false,
      mode: service?.settings.mode ?? null,
      actBlocked: service ? service.actBlocked : null,
      holdsEnforced: service?.enforcing ?? false,
      errors: this.problems.get(project) ?? [],
      intervalSeconds: service?.settings.intervalSeconds ?? null,
      lastTicks: service?.lastTicks ?? null,
      lastError: service ? (service.lastError ?? service.storeProblem) : null,
      services: service?.getAllServiceStatuses() ?? new Map(),
      heldLanes: service?.getHeldLanes() ?? [],
    };
  }
}
