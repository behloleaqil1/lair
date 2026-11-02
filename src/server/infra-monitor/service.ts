/**
 * The infrastructure monitor: one InfraMonitor per project with
 * `infra_monitor.enabled: true` (docs/configuration.md#infrastructure-monitor).
 *
 * Every interval_seconds, one tick:
 * 1. read the gate queue of the configured lanes (async, bounded) and each
 *    running request's process group;
 * 2. probe every configured machine (argv, with a timeout; a timeout or a
 *    missing `expect` is a failure);
 * 3. read the lanes' runner pid files;
 * 4. detect (detectors.ts) and keep the findings, each until its cause has
 *    been gone for down_threshold_seconds plus one interval;
 * 5. act mode only: raise one Decision Inbox notice per finding, withdraw it
 *    once the finding is gone, and, with requeue_cmd, re-queue each running
 *    job of a down machine once onto a lane whose machine is up, through the
 *    ledger (bounded attempts with backoff, kept across restarts).
 *
 * Observe mode writes nothing: no notice, no command but the probes, no
 * ledger. Its findings and the re-queues it would run are in the status.
 */
import { join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { actBlockedReason, buildRequeueArgv, parseInfraMonitorConfig, type InfraMonitorSettings, type LaneSettings, type MachineSettings } from "./config.js";
import { detect, oneLine, type RunnerState } from "./detectors.js";
import { RequeueLedger } from "./ledger.js";
import { NOTICE_MODULE, noticeFor } from "./notices.js";
import { groupAlive, pidAlive, readQueue, readRunnerPids, systemInfraProbes, type InfraProbes, type QueueEntry } from "./probes.js";
import type { FindingView, InfraFinding, InfraMonitorStatus, InfraMonitorTick, JobView, MachineView, PlannedRequeue, RequeueRecord } from "./types.js";

/** At most this many re-queues run in one tick */
export const MAX_REQUEUES_PER_TICK = 4;
/** The longest wait between two attempts of one re-queue */
const MAX_BACKOFF_MS = 6 * 3_600_000;

type Log = Pick<Console, "warn" | "log">;

export interface InfraMonitorOptions {
  project: string;
  config: ProjectConfig;
  settings: InfraMonitorSettings;
  probes: InfraProbes;
  ledger: RequeueLedger;
  events?: EventBus;
  log?: Log;
  /** Delay of the first tick after start() (default 1 s) */
  firstTickMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class InfraMonitor {
  readonly project: string;
  readonly settings: InfraMonitorSettings;
  private readonly config: ProjectConfig;
  private readonly probes: InfraProbes;
  private readonly ledger: RequeueLedger;
  private readonly events?: EventBus;
  private readonly log: Log;
  private readonly firstTickMs: number;
  private decisions?: DecisionProducer;

  private machines = new Map<string, MachineView>();
  private jobs = new Map<string, JobView>();
  private held = new Map<string, number>();
  private findings = new Map<string, FindingView>();
  /** key -> when an open notice with no finding behind it was first seen (after a restart or reload) */
  private orphans = new Map<string, number>();
  private planned: PlannedRequeue[] = [];

  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<InfraMonitorTick | null> | null = null;
  private stopped = true;
  private abort = new AbortController();
  private startedAt: number | null = null;
  private lastFinishedAt: number | null = null;
  lastTick: InfraMonitorTick | null = null;
  lastError: string | null = null;

  constructor(options: InfraMonitorOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.probes = options.probes;
    this.ledger = options.ledger;
    this.events = options.events;
    this.log = options.log ?? console;
    this.firstTickMs = options.firstTickMs ?? 1000;
    // In the order of the config; "not probed yet" until the first tick
    for (const m of this.settings.machines) {
      const lanes = this.settings.lanes.filter((l) => l.machine === m.id).map((l) => l.name);
      this.machines.set(m.id, { id: m.id, up: null, downSince: null, upSince: null, lastProbeAt: null, lastError: null, lanes });
    }
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.settings.requeueBackoffSeconds * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Why act mode does nothing, or null when it acts. */
  get actBlocked(): string | null {
    return actBlockedReason(this.config, this.settings);
  }

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
  }

  private get thresholdMs(): number {
    return this.settings.downThresholdSeconds * 1000;
  }

  /** A finding's notice stays until its cause has been gone this long: no withdraw-and-raise on a flap. */
  private get clearMs(): number {
    return this.thresholdMs + this.settings.intervalSeconds * 1000;
  }

  private lane(name: string): LaneSettings | undefined {
    return this.settings.lanes.find((l) => l.name === name);
  }

  // ============ PROBES ============

  private async probeMachine(machine: MachineSettings, now: number): Promise<void> {
    let error: string | null = null;
    for (const probe of machine.probes) {
      const out = await this.probes.runner.run(probe.argv, {
        timeoutMs: this.settings.probeTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });
      if (this.abort.signal.aborted) return;
      if (out.timedOut) error = `probe ${probe.argv[0]} timed out after ${this.settings.probeTimeoutSeconds} s`;
      else if (out.code !== 0) error = `probe ${probe.argv[0]} exited ${out.code}: ${oneLine(out.stderr || out.stdout, 300) || "no output"}`;
      else if (probe.expect !== null && !out.stdout.includes(probe.expect)) error = `probe ${probe.argv[0]} did not print "${probe.expect}"`;
      if (error) break;
    }
    const prev = this.machines.get(machine.id);
    const lanes = this.settings.lanes.filter((l) => l.machine === machine.id).map((l) => l.name);
    this.machines.set(
      machine.id,
      error === null
        ? { id: machine.id, up: true, downSince: null, upSince: prev?.up === true ? prev.upSince : now, lastProbeAt: now, lastError: null, lanes }
        : {
            id: machine.id,
            up: false,
            downSince: prev?.up === false && prev.downSince !== null ? prev.downSince : now,
            upSince: null,
            lastProbeAt: now,
            lastError: error,
            lanes,
          },
    );
  }

  private updateJobs(running: QueueEntry[]): void {
    const next = new Map<string, JobView>();
    for (const entry of running) {
      const lane = this.lane(entry.lane);
      if (!lane) continue;
      // The same run while it stays in its lane (a runner may touch its request, which moves the ctime on)
      const prev = this.jobs.get(entry.id);
      const same = prev !== undefined && prev.lane === entry.lane ? prev : null;
      next.set(entry.id, {
        id: entry.id,
        lane: entry.lane,
        machine: lane.machine,
        claimedAt: same ? Math.min(same.claimedAt, entry.ctimeMs) : entry.ctimeMs,
        machineSeenUp: (same?.machineSeenUp ?? false) || this.machines.get(lane.machine)?.up === true,
        pgid: entry.pgid,
        groupAlive: entry.pgid === null ? null : groupAlive(entry.pgid),
      });
    }
    this.jobs = next;
  }

  private async readRunners(): Promise<Map<string, RunnerState[]>> {
    const out = new Map<string, RunnerState[]>();
    for (const lane of this.settings.lanes) {
      if (lane.runnerPidFiles.length === 0) continue;
      const pids = await readRunnerPids(this.config.gates_dir, lane.runnerPidFiles);
      out.set(lane.name, pids.map((p) => ({ ...p, alive: p.pid !== null && pidAlive(p.pid) })));
    }
    return out;
  }

  // ============ FINDINGS ============

  /** Keep this tick's findings; a finding gone for clearMs is dropped. Returns the dropped ones. */
  private reconcile(current: InfraFinding[], now: number): FindingView[] {
    const seen = new Set<string>();
    for (const finding of current) {
      seen.add(finding.key);
      const prev = this.findings.get(finding.key);
      this.findings.set(finding.key, { ...finding, since: prev?.since ?? now, clearingSince: null, noticeId: prev?.noticeId ?? null });
      if (!prev) {
        this.log.warn(`[infra-monitor] ${this.project}: ${finding.summary}`);
        void this.events?.emit("infra_monitor.finding", { project: this.project, key: finding.key, type: finding.type, summary: finding.summary, mode: this.settings.mode });
      }
    }
    const dropped: FindingView[] = [];
    for (const [key, view] of this.findings) {
      if (seen.has(key)) continue;
      const clearingSince = view.clearingSince ?? now;
      if (now - clearingSince >= this.clearMs) {
        this.findings.delete(key);
        dropped.push(view);
        void this.events?.emit("infra_monitor.cleared", { project: this.project, key, type: view.type });
      } else {
        this.findings.set(key, { ...view, clearingSince });
      }
    }
    return dropped;
  }

  // ============ ACT: NOTICES ============

  private async syncNotices(dropped: FindingView[], now: number, tick: InfraMonitorTick): Promise<void> {
    const inbox = this.decisions;
    if (!inbox) {
      if (this.findings.size > 0) this.lastError = "no Decision Inbox: notices can't be raised";
      return;
    }
    for (const view of this.findings.values()) {
      try {
        const latest = inbox.find(this.project, NOTICE_MODULE, view.key);
        if (latest?.status === "open") {
          view.noticeId = latest.id;
          continue;
        }
        view.noticeId = null;
        if (view.clearingSince !== null) continue;
        // The owner noted this occurrence: not again until it clears and comes back
        if (latest?.status === "answered") {
          const answered = Date.parse(latest.answeredAt ?? latest.closedAt ?? latest.createdAt);
          if (answered >= view.since) continue;
        }
        const { decision, created } = await inbox.raise(noticeFor(this.project, view, Math.ceil(this.clearMs / 60_000)));
        view.noticeId = decision.id;
        if (created) tick.noticesRaised++;
      } catch (e) {
        this.lastError = `notice ${view.key} could not be raised: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const withdraw = async (id: string, key: string, reason: string) => {
      try {
        await inbox.withdraw(id, { module: NOTICE_MODULE, reason });
        tick.noticesWithdrawn++;
      } catch (e) {
        this.lastError = `notice ${key} could not be withdrawn: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    for (const view of dropped) {
      const latest = inbox.find(this.project, NOTICE_MODULE, view.key);
      if (latest?.status === "open") await withdraw(latest.id, view.key, `The problem has been gone for ${Math.ceil(this.clearMs / 60_000)} min.`);
    }
    // Open notices with no finding behind them (raised before a restart or a reload): withdrawn once they stay so
    const open = inbox.openOf(this.project, NOTICE_MODULE);
    const openKeys = new Set(open.map((d) => d.key));
    for (const key of this.orphans.keys()) if (!openKeys.has(key) || this.findings.has(key)) this.orphans.delete(key);
    for (const decision of open) {
      if (this.findings.has(decision.key)) continue;
      const since = this.orphans.get(decision.key) ?? now;
      this.orphans.set(decision.key, since);
      if (now - since >= this.clearMs) {
        this.orphans.delete(decision.key);
        await withdraw(decision.id, decision.key, `The problem has not been seen for ${Math.ceil(this.clearMs / 60_000)} min.`);
      }
    }
  }

  // ============ ACT: RE-QUEUE ============

  /** The re-queue of a job of a down machine: where to and the argv, or why not. */
  private plan(job: { id: string; lane: string }, downMachine: string): PlannedRequeue {
    const base = { id: job.id, from: job.lane };
    if (!this.settings.requeueCmd) return { ...base, to: null, argv: null, reason: "infra_monitor.requeue_cmd is not set" };
    const targets = this.lane(job.lane)?.requeueTo ?? [];
    if (targets.length === 0) return { ...base, to: null, argv: null, reason: `lane ${job.lane} has no requeue_to` };
    const to = targets.find((name) => {
      const machine = this.lane(name)?.machine;
      return machine !== undefined && machine !== downMachine && this.machines.get(machine)?.up === true;
    });
    if (!to) return { ...base, to: null, argv: null, reason: `no lane of ${targets.join(", ")} has a machine that is up` };
    const built = buildRequeueArgv(this.settings.requeueCmd, { id: job.id, from: job.lane, to });
    if ("error" in built) return { ...base, to, argv: null, reason: built.error };
    return { ...base, to, argv: built.argv, reason: null };
  }

  private async requeues(now: number, tick: InfraMonitorTick): Promise<void> {
    if (!this.settings.requeueCmd) return;
    await this.ledger.load();
    if (this.ledger.error) {
      this.lastError = this.ledger.error;
      return;
    }
    for (const plan of this.planned) {
      if (tick.requeues >= MAX_REQUEUES_PER_TICK || this.abort.signal.aborted) return;
      if (!plan.to || !plan.argv) continue;
      const prev = this.ledger.get(this.project, plan.id);
      if (prev && (prev.status === "moved" || prev.status === "gave_up" || prev.attempts >= this.settings.requeueMaxAttempts)) continue;
      if (prev && prev.nextAttemptAt !== null && now < prev.nextAttemptAt) continue;
      const attempts = (prev?.attempts ?? 0) + 1;
      const record: RequeueRecord = {
        project: this.project,
        id: plan.id,
        from: plan.from,
        to: plan.to,
        attempts,
        status: "running",
        lastAttemptAt: now,
        // If this attempt never finishes (a restart), the next waits as after a failure
        nextAttemptAt: now + this.backoffMs(attempts),
        lastError: null,
        argv: plan.argv,
      };
      try {
        // Kept before the command runs: a restart in the middle counts this attempt
        await this.ledger.put(record, now);
      } catch (e) {
        this.lastError = `re-queue of ${plan.id} not run: the ledger can't be written: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      tick.requeues++;
      const out = await this.probes.runner.run(plan.argv, {
        timeoutMs: this.settings.requeueTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });
      // Stopped mid-command: the record stays "running", read as a failed attempt after the restart
      if (this.abort.signal.aborted) return;
      const ok = out.code === 0 && !out.timedOut;
      const done = this.probes.clock.now();
      record.status = ok ? "moved" : record.attempts >= this.settings.requeueMaxAttempts ? "gave_up" : "failed";
      record.nextAttemptAt = record.status === "failed" ? done + this.backoffMs(record.attempts) : null;
      record.lastError = ok
        ? null
        : out.timedOut
          ? `timed out after ${this.settings.requeueTimeoutSeconds} s`
          : `exited ${out.code}: ${oneLine(out.stderr || out.stdout, 300) || "no output"}`;
      try {
        await this.ledger.put(record, done);
      } catch (e) {
        this.lastError = `the re-queue of ${plan.id} finished (${record.status}) but the ledger can't be written: ${e instanceof Error ? e.message : String(e)}`;
      }
      this.log.warn(`[infra-monitor] ${this.project}: re-queue of ${plan.id} from ${plan.from} to ${plan.to}: ${record.status}${record.lastError ? ` (${record.lastError})` : ""}`);
      void this.events?.emit("infra_monitor.requeued", {
        project: this.project,
        id: plan.id,
        from: plan.from,
        to: plan.to,
        result: record.status,
        attempts: record.attempts,
        error: record.lastError,
      });
    }
  }

  // ============ THE TICK ============

  /** One tick; ticks never overlap (a call during one returns it). */
  tick(): Promise<InfraMonitorTick | null> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<InfraMonitorTick | null> {
    const now = this.probes.clock.now();
    const tick: InfraMonitorTick = {
      at: iso(now),
      durationMs: 0,
      machinesProbed: 0,
      machinesDown: 0,
      runningJobs: 0,
      queuedJobs: 0,
      findings: 0,
      noticesRaised: 0,
      noticesWithdrawn: 0,
      requeues: 0,
    };
    try {
      let queue: QueueEntry[];
      try {
        queue = await readQueue(this.config.gates_dir, new Set(this.settings.lanes.map((l) => l.name)));
      } catch (e) {
        // Nothing is known: no finding is added or dropped, no notice withdrawn
        this.lastError = `the gate queue can't be read: ${e instanceof Error ? e.message : String(e)}`;
        return null;
      }
      await Promise.all(this.settings.machines.map((m) => this.probeMachine(m, now)));
      if (this.abort.signal.aborted) return null;
      const running = queue.filter((q) => q.status === "running");
      const queued = queue.filter((q) => q.status === "queued");
      this.updateJobs(running);
      const runners = await this.readRunners();
      const { findings, held } = detect(
        {
          now,
          thresholdMs: this.thresholdMs,
          machines: this.machines,
          machineSettings: new Map(this.settings.machines.map((m) => [m.id, m])),
          lanes: this.settings.lanes,
          running: [...this.jobs.values()],
          queued,
          runners,
        },
        this.held,
      );
      this.held = held;
      const dropped = this.reconcile(findings, now);
      this.planned = [...this.findings.values()]
        .filter((f) => f.type === "machine_down" && f.clearingSince === null && f.machine !== null)
        .flatMap((f) => f.jobs.map((job) => this.plan(job, f.machine as string)));

      this.lastError = null;
      if (this.actBlocked === null) {
        await this.syncNotices(dropped, now, tick);
        await this.requeues(now, tick);
      }

      tick.machinesProbed = this.settings.machines.length;
      tick.machinesDown = [...this.machines.values()].filter((m) => m.up === false).length;
      tick.runningJobs = running.length;
      tick.queuedJobs = queued.length;
      tick.findings = this.findings.size;
      tick.durationMs = this.probes.clock.now() - now;
      this.lastTick = tick;
      this.lastFinishedAt = this.probes.clock.now();
      return tick;
    } catch (e) {
      this.lastError = `tick failed: ${e instanceof Error ? e.message : String(e)}`;
      this.log.warn(`[infra-monitor] ${this.project}: ${this.lastError}`);
      return null;
    }
  }

  // ============ LIFECYCLE ============

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.startedAt = this.probes.clock.now();
    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(() => void loop(), this.firstTickMs);
    this.timer.unref();
  }

  /** Stop: a probe or re-queue in progress is killed; the tick ends at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
  }

  /** Withdraw this project's open notices (the monitor stops raising them: turned off or observe). */
  async withdrawAll(reason: string): Promise<void> {
    const inbox = this.decisions;
    if (!inbox) return;
    for (const decision of inbox.openOf(this.project, NOTICE_MODULE)) {
      try {
        await inbox.withdraw(decision.id, { module: NOTICE_MODULE, reason });
      } catch (e) {
        this.log.warn(`[infra-monitor] ${this.project}: notice ${decision.key} could not be withdrawn: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  status(): InfraMonitorStatus {
    const now = this.probes.clock.now();
    // The last tick that finished, or when the first one was due
    const since = this.lastFinishedAt ?? (this.startedAt === null ? null : this.startedAt + this.firstTickMs);
    return {
      project: this.project,
      enabled: true,
      running: this.running,
      mode: this.settings.mode,
      actBlocked: this.actBlocked,
      intervalSeconds: this.settings.intervalSeconds,
      lastTick: this.lastTick,
      lastError: this.lastError,
      stale: this.running && since !== null && now - since > 3 * this.settings.intervalSeconds * 1000,
      machines: [...this.machines.values()].map((m) => ({ ...m, lanes: [...m.lanes] })),
      jobs: [...this.jobs.values()].map((j) => ({ ...j })),
      findings: [...this.findings.values()].map((f) => ({ ...f, evidence: [...f.evidence], facts: { ...f.facts }, jobs: f.jobs.map((j) => ({ ...j })) })),
      plannedRequeues: this.planned.map((p) => ({ ...p, argv: p.argv ? [...p.argv] : null })),
      requeues: this.ledger.list(this.project),
    };
  }
}

// ============ MANAGER ============

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface InfraMonitorManagerOptions {
  probes?: InfraProbes;
  events?: EventBus;
  /** The re-queue ledger file; null keeps it in memory (tests) */
  ledgerPath?: string | null;
  log?: Log;
  firstTickMs?: number;
}

/** Every project's infra monitor. */
export class InfraMonitorManager {
  private monitors = new Map<string, InfraMonitor>();
  private problems = new Map<string, string[]>();
  private decisions?: DecisionProducer;
  private phase: "loaded" | "started" | "stopped" = "loaded";
  readonly ledger: RequeueLedger;

  constructor(private readonly options: InfraMonitorManagerOptions = {}) {
    this.ledger = new RequeueLedger(options.ledgerPath === undefined ? join(process.cwd(), "data", "infra-monitor-requeues.json") : options.ledgerPath);
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parseInfraMonitorConfig(entry.config.infra_monitor);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        (this.options.log ?? console).warn(`[infra-monitor] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      const monitor = new InfraMonitor({
        project: entry.name,
        config: entry.config,
        settings: parsed.settings,
        probes: this.options.probes ?? systemInfraProbes(),
        ledger: this.ledger,
        events: this.options.events,
        log: this.options.log,
        firstTickMs: this.options.firstTickMs,
      });
      if (this.decisions) monitor.useDecisions(this.decisions);
      this.monitors.set(entry.name, monitor);
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const monitor of this.monitors.values()) monitor.start();
    return [...this.monitors.keys()];
  }

  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.phase === "stopped") return;
    const old = this.monitors.get(entry.name);
    if (old) await old.stop();
    this.monitors.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.monitors.get(entry.name);
    // The old instance raised notices and the new one won't: its notices are withdrawn, not left open
    if (old && old.actBlocked === null && (!next || next.actBlocked !== null)) {
      await old.withdrawAll("The infrastructure monitor no longer raises notices for this project (turned off, observe mode or read_only).");
    }
    if (next && this.phase === "started") next.start();
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.monitors.values()].map((m) => m.stop()));
    this.monitors.clear();
  }

  get(project: string): InfraMonitor | undefined {
    return this.monitors.get(project);
  }

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    for (const monitor of this.monitors.values()) monitor.useDecisions(decisions);
  }

  status(project: string): InfraMonitorStatus {
    const monitor = this.monitors.get(project);
    if (monitor) return monitor.status();
    return {
      project,
      enabled: false,
      running: false,
      mode: null,
      actBlocked: null,
      intervalSeconds: null,
      lastTick: null,
      lastError: this.problems.get(project)?.join("; ") ?? null,
      stale: false,
      machines: [],
      jobs: [],
      findings: [],
      plannedRequeues: [],
      requeues: [],
    };
  }
}
