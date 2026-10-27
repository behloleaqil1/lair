/**
 * Placement: which machine runs each queued job of a project's own gate
 * queue (docs/configuration.md#placement). One Placement per project with
 * `placement.enabled`. Each tick:
 *
 * 1. every machine is probed, in parallel (argv only, with a timeout); a
 *    machine is up only after `min_up_seconds` of passing probes, and its
 *    load comes from `load_cmd`;
 * 2. the queue is read: the configured lanes' queued (`.req`) and running
 *    (`.req.run`) requests, each with its command and class;
 * 3. durations are learned: from the runs Lair saw start and end, and from
 *    the runner log's finished runs (history.ts);
 * 4. every job's start and finish is estimated on its lane, and the moves
 *    that make jobs finish sooner are chosen (estimate.ts);
 * 5. in act mode each move runs the project's `move_cmd`, then checks that
 *    the request landed; in observe mode it is recorded as advice.
 *
 * Placement never renames a request itself, never moves a running job, and
 * never moves work to or from a machine that is not up: jobs already on a
 * machine that went down stay with the project's own fallback.
 */
import { join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  PlacementAdvice,
  PlacementDuration,
  PlacementJob,
  PlacementLane,
  PlacementMachine,
  PlacementMachineState,
  PlacementStatus,
  PlacementTick,
} from "../../shared/placement-types.js";
import {
  actBlockedReason,
  buildMoveArgv,
  parsePlacementConfig,
  type MachineSettings,
  type PlacementSettings,
} from "./config.js";
import { classify, readQueue, type QueueJob } from "./queue.js";
import { SampleIndex, readResult, readRunnerLog, runnerLogPath } from "./history.js";
import { decide, planAll, servingLane, type Candidate, type DurationFn, type ModelJob, type ModelLane, type Plan } from "./estimate.js";
import { PlacementStore, moveForApi, type Sample, type StoredMove } from "./store.js";
import { systemPlacementProbes, type CommandOutput, type PlacementProbes } from "./probes.js";

/** The first bytes of a probe's or load command's output that are read */
const MAX_PROBE_OUTPUT = 4096;
/** A run whose request vanished without a result is forgotten after this */
const RUN_FORGET_MS = 6 * 3_600_000;
/** A claim time (ctime) older than this is not taken as a run's start */
const MAX_CTIME_AGE_MS = 7 * 86_400_000;
/** A result written this much before a run's start is an older run's */
const RESULT_SKEW_MS = 5 * 60_000;
/** History lines looked at before the set is cleared (each is looked at once per process) */
const MAX_HISTORY_IDS = 20_000;
/** A runner log line and the result it describes are written within this of each other */
const HISTORY_SKEW_MS = 10 * 60_000;
/** A failed run shorter than this share of its class's usual time is a fragment, not learned */
const FRAGMENT_SHARE = 0.5;
const DAY_MS = 86_400_000;
/** The longest history of moves read for the cool-downs (moves are kept 30 days) */
const MAX_ATTEMPT_WINDOW_MS = 30 * DAY_MS;
const OUTPUT_TAIL = 500;
/** Moves shown in the status */
const RECENT_MOVES = 20;

interface MachineRuntime {
  state: PlacementMachineState;
  passingSince: number | null;
  upSince: number | null;
  downSince: number | null;
  lastProbeAt: number | null;
  lastError: string | null;
  load: number | null;
  cpus: number | null;
}

interface Snapshot {
  machines: PlacementMachine[];
  lanes: PlacementLane[];
  jobs: PlacementJob[];
  durations: PlacementDuration[];
}

interface DurationModel {
  fn: DurationFn;
  table: PlacementDuration[];
}

export interface PlacementOptions {
  project: string;
  config: ProjectConfig;
  settings: PlacementSettings;
  store: PlacementStore;
  probes: PlacementProbes;
  events?: EventBus;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** "45 min", "2 h 5 min", "<1 min" */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * A load command's output: the first number is the 1-minute load, the last
 * one (when there are two or more) the cpu count. `sysctl -n vm.loadavg
 * hw.ncpu` and `cat /proc/loadavg; nproc` both print that.
 */
export function parseLoad(stdout: string): { load: number | null; cpus: number | null } {
  const numbers = stdout.slice(0, MAX_PROBE_OUTPUT).match(/\d+(?:\.\d+)?/g) ?? [];
  const load = numbers.length > 0 ? Number(numbers[0]) : null;
  const last = numbers.length >= 2 ? numbers[numbers.length - 1] : null;
  const cpus = last !== null && /^\d+$/.test(last) && Number(last) >= 1 ? Number(last) : null;
  return { load: load !== null && Number.isFinite(load) ? load : null, cpus };
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? trimmed.slice(-OUTPUT_TAIL) : trimmed;
}

export class Placement {
  readonly project: string;
  readonly settings: PlacementSettings;
  private config: ProjectConfig;
  private store: PlacementStore;
  private probes: PlacementProbes;
  private events?: EventBus;
  private machines = new Map<string, MachineRuntime>();
  /** Per gate: the advice last recorded in observe mode ("from>to") */
  private advice = new Map<string, string>();
  private queuedLastTick = new Set<string>();
  private lastTickAt: number | null = null;
  private historyChecked = new Set<string>();
  private historyMark: string | null = null;
  /** Jobs the per-job cap holds, already reported (placement.job_held) */
  private heldReported = new Set<string>();
  private recovered = false;
  private snapshot: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<PlacementTick> | null = null;
  private stopped = true;
  private abort = new AbortController();
  lastTick?: PlacementTick;
  lastError?: string;

  constructor(options: PlacementOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.probes = options.probes;
    this.events = options.events;
    for (const m of this.settings.machines) {
      this.machines.set(m.id, {
        state: "unknown",
        passingSince: null,
        upSince: null,
        downSince: null,
        lastProbeAt: null,
        lastError: null,
        load: null,
        cpus: m.cpus ?? null,
      });
    }
  }

  /** Why act mode is off for this project, or null when it is on. */
  get actBlocked(): string | null {
    return actBlockedReason(this.config, this.settings);
  }

  get running(): boolean {
    return !this.stopped;
  }

  private get gatesDir(): string {
    return this.config.gates_dir;
  }

  private laneOf(name: string) {
    return this.settings.lanes.find((l) => l.name === name);
  }

  private utilization(machine: string): number | null {
    const m = this.machines.get(machine);
    if (!m || m.load === null || m.cpus === null) return null;
    return m.load / m.cpus;
  }

  private factor(machine: string): number {
    const util = this.utilization(machine);
    return util === null ? 1 : Math.max(1, util);
  }

  // ============ 1. MACHINES ============

  private async run(argv: string[], timeoutMs: number): Promise<CommandOutput> {
    try {
      return await this.probes.runner.run(argv, { timeoutMs, signal: this.abort.signal });
    } catch (e) {
      return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  private async probeMachines(now: number): Promise<void> {
    const timeoutMs = this.settings.probeTimeoutSeconds * 1000;
    await Promise.all(
      this.settings.machines.map(async (m) => {
        const [probe, load] = await Promise.all([
          this.run(m.probe, timeoutMs),
          m.loadCmd ? this.run(m.loadCmd, timeoutMs) : Promise.resolve(null),
        ]);
        // A stop (or a reload) cut the probe short: that says nothing about the machine
        if (this.abort.signal.aborted) return;
        await this.updateMachine(m, probe, load, now);
      }),
    );
  }

  private async updateMachine(
    m: MachineSettings,
    probe: CommandOutput,
    load: CommandOutput | null,
    now: number,
  ): Promise<void> {
    const rt = this.machines.get(m.id) as MachineRuntime;
    const out = probe.stdout.slice(0, MAX_PROBE_OUTPUT).trimStart();
    const passed = probe.code === 0 && (m.expect === undefined || out.startsWith(m.expect));
    rt.lastProbeAt = now;
    if (passed) {
      rt.lastError = null;
      rt.passingSince ??= now;
      if (rt.state !== "up") {
        if (now - rt.passingSince >= m.minUpSeconds * 1000) {
          rt.state = "up";
          rt.upSince = now;
          rt.downSince = null;
          await this.events?.emit("placement.machine_up", {
            project: this.project,
            machine: m.id,
            passingSince: iso(rt.passingSince),
          });
        } else {
          rt.state = "starting";
        }
      }
      if (load && load.code === 0) {
        const parsed = parseLoad(load.stdout);
        rt.load = parsed.load;
        rt.cpus = m.cpus ?? parsed.cpus ?? rt.cpus;
      } else if (load) {
        rt.load = null;
      }
      return;
    }
    rt.lastError =
      probe.code === 0
        ? `the output does not start with ${JSON.stringify(m.expect)}`
        : probe.code === -1
          ? `no answer (${tail(probe.stderr) || "timed out"})`
          : `exited ${probe.code}${probe.stderr.trim() ? `: ${tail(probe.stderr)}` : ""}`;
    const wasUp = rt.state === "up";
    rt.passingSince = null;
    rt.upSince = null;
    rt.load = null;
    if (rt.state !== "down") rt.downSince = now;
    rt.state = "down";
    if (wasUp) {
      await this.events?.emit("placement.machine_down", {
        project: this.project,
        machine: m.id,
        error: rt.lastError,
      });
    }
  }

  // ============ 3. LEARNING ============

  /**
   * Learn one finished run (store.addSample keeps one sample per gate id). A
   * run that failed (rc not 0) in less than half the time its class usually
   * takes on that machine (the median of passed runs there, else on any
   * machine) is a fragment: a preflight that failed, a run killed when its
   * machine went away. It is not learned.
   */
  private learn(index: SampleIndex, sample: Sample): void {
    if (sample.rc !== 0) {
      const usual = index.reference(sample.class, sample.machine);
      if (usual !== null && sample.seconds < usual * FRAGMENT_SHARE) return;
    }
    if (this.store.addSample(this.project, sample)) index.addNewest(sample);
  }

  private sampleIndex(): SampleIndex {
    const index = new SampleIndex(this.settings.history.samples);
    for (const s of this.store.recentSamples(this.project)) index.add(s);
    return index;
  }

  /** Track the running jobs; a run that ended with a result becomes a duration sample. */
  private observeRuns(queue: QueueJob[], now: number, index: SampleIndex): void {
    const { store, project } = this;
    const runs = new Map(store.runs(project).map((r) => [r.gateId, r] as const));
    const queued = new Set(queue.filter((j) => j.status === "queued").map((j) => j.id));
    for (const job of queue) {
      if (job.status !== "running") continue;
      const lane = this.laneOf(job.lane);
      if (!lane) continue;
      const util = this.utilization(lane.machine);
      const f = util === null ? null : Math.max(1, util);
      const existing = runs.get(job.id);
      runs.delete(job.id);
      if (existing && existing.lane === job.lane) {
        store.putRun(project, {
          ...existing,
          lastSeenAt: now,
          loadSum: existing.loadSum + (f ?? 0),
          loadSamples: existing.loadSamples + (f === null ? 0 : 1),
        });
        continue;
      }
      // A new run: its claim (the rename to .run) set the file's ctime
      const sawQueued = this.queuedLastTick.has(job.id) && this.lastTickAt !== null;
      const earliest = sawQueued ? (this.lastTickAt as number) : now - MAX_CTIME_AGE_MS;
      const ctimeOk = job.ctimeMs !== null && job.ctimeMs <= now && job.ctimeMs >= earliest;
      store.putRun(project, {
        gateId: job.id,
        lane: job.lane,
        machine: lane.machine,
        class: job.class ?? "",
        startedAt: ctimeOk ? (job.ctimeMs as number) : now,
        lastSeenAt: now,
        loadSum: f ?? 0,
        loadSamples: f === null ? 0 : 1,
        startKnown: ctimeOk || sawQueued,
      });
    }
    for (const run of runs.values()) {
      if (queued.has(run.gateId)) {
        // Back in a queue (a runner put it back): it starts again later
        store.deleteRun(project, run.gateId);
        continue;
      }
      const result = readResult(this.probes.files, this.gatesDir, run.gateId, this.settings.history.durationPattern);
      if (result && result.finishedAtMs >= run.startedAt - RESULT_SKEW_MS) {
        const observed = Math.max(0, (Math.min(result.finishedAtMs, now) - run.startedAt) / 1000);
        let seconds: number | null = run.startKnown ? observed : null;
        if (result.logSeconds !== null) {
          const slack = 2 * this.settings.intervalSeconds + 120;
          // A log that says it ran much longer than Lair saw it run is an earlier run's (a shared result)
          if (!run.startKnown || result.logSeconds <= observed + slack) seconds = result.logSeconds;
          else seconds = null;
        }
        if (seconds !== null && seconds > 0) {
          this.learn(index, {
            gateId: run.gateId,
            class: run.class,
            machine: run.machine,
            seconds,
            factor: run.loadSamples > 0 ? run.loadSum / run.loadSamples : null,
            finishedAt: result.finishedAtMs,
            source: "observed",
            rc: result.rc,
          });
        }
        store.deleteRun(project, run.gateId);
      } else if (now - run.lastSeenAt > RUN_FORGET_MS) {
        store.deleteRun(project, run.gateId);
      }
    }
  }

  /**
   * Learn the runner log's finished runs that Lair did not see, each line
   * once. An id can have several lines (a run killed, then re-queued under
   * the same id); its result files hold its latest run only, so a line is
   * learned only when the result agrees with it (the same rc, written within
   * a few minutes of the line).
   */
  private learnHistory(index: SampleIndex): void {
    const history = this.settings.history;
    if (!history.runnerLog) return;
    const path = runnerLogPath(this.gatesDir, history.runnerLog);
    const st = this.probes.files.stat(path);
    if (!st || !st.isFile) return;
    const mark = `${st.size}:${st.mtimeMs}`;
    if (mark === this.historyMark) return;
    this.historyMark = mark;
    if (this.historyChecked.size > MAX_HISTORY_IDS) this.historyChecked.clear();
    for (const line of readRunnerLog(this.probes.files, path, history.columns)) {
      const key = `${line.id}\t${line.lane}\t${line.rc}\t${line.atMs ?? ""}`;
      if (this.historyChecked.has(key)) continue;
      this.historyChecked.add(key);
      const lane = this.laneOf(line.lane);
      if (!lane || this.store.hasPassedSample(this.project, line.id)) continue;
      const result = readResult(this.probes.files, this.gatesDir, line.id, history.durationPattern);
      if (!result || result.logSeconds === null || result.logSeconds <= 0) continue;
      if (result.rc !== line.rc) continue;
      if (line.atMs !== null && Math.abs(result.finishedAtMs - line.atMs) > HISTORY_SKEW_MS) continue;
      this.learn(index, {
        gateId: line.id,
        class: classify(line.command, this.settings.classes) ?? "",
        machine: lane.machine,
        seconds: result.logSeconds,
        factor: null,
        finishedAt: result.finishedAtMs,
        source: "history",
        rc: line.rc,
      });
    }
  }

  /**
   * Expected durations (SampleIndex.base): the median of the newest
   * `history.samples` passed runs of the class on the machine, else on any
   * machine, else of all its runs there, else on any machine, else of any
   * class on the machine, else `default_seconds`. A machine loaded above its
   * usual load while it runs gates runs them slower: the median is
   * multiplied by max(1, load factor now ÷ usual load factor), where the
   * usual factor is the median Lair measured during the runs it learned
   * (1 until it has some).
   */
  private durations(): DurationModel {
    const index = this.sampleIndex();
    const adjust = (machine: string) => Math.max(1, this.factor(machine) / index.usualFactor(machine));
    return {
      fn: (cls, machine) => (index.base(cls ?? "", machine) ?? this.settings.defaultSeconds) * adjust(machine),
      table: index.table(),
    };
  }

  // ============ 4. THE MODEL ============

  private model(queue: QueueJob[], now: number): { lanes: ModelLane[]; jobs: ModelJob[] } {
    const lanes: ModelLane[] = this.settings.lanes.map((l) => ({
      name: l.name,
      machine: l.machine,
      slots: l.slots,
      limits: l.limits,
      serves: l.serves,
      maxPriority: l.maxPriority,
      eligible: new Set(l.eligible),
      up: this.machines.get(l.machine)?.state === "up",
    }));
    const runs = new Map(this.store.runs(this.project).map((r) => [r.gateId, r] as const));
    const seen = new Set<string>();
    const jobs: ModelJob[] = [];
    // Running first: an id both running and queued (a race between runners) counts once, as running
    for (const job of [...queue.filter((j) => j.status === "running"), ...queue.filter((j) => j.status === "queued")]) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      const mj: ModelJob = {
        id: job.id,
        lane: job.lane,
        priority: job.priority,
        status: job.status,
        class: job.class,
        quiet: job.quiet,
        startedAt: job.status === "running" ? (runs.get(job.id)?.startedAt ?? now) : null,
        runsOn: job.lane,
      };
      if (mj.status === "queued") mj.runsOn = servingLane(lanes, mj)?.name ?? job.lane;
      jobs.push(mj);
    }
    return { lanes, jobs };
  }

  /** Why a queued job stays where it is, or null. */
  private heldReason(job: ModelJob, attempts: Map<string, StoredMove[]>, now: number): string | null {
    if (job.status !== "queued") return null;
    if (job.runsOn !== job.lane) return `taken by the ${job.runsOn} lane`;
    const lane = this.laneOf(job.lane);
    if (!lane) return null;
    if (lane.serves.length > 0) return `${job.lane} is a pseudo-lane`;
    const machine = this.machines.get(lane.machine);
    if (machine?.state !== "up") {
      return `${lane.machine} is ${machine?.state === "starting" ? "not up long enough yet" : (machine?.state ?? "unknown")}: its own fallback is in charge`;
    }
    const list = attempts.get(job.id) ?? [];
    const recent = list.filter((m) => m.createdAt >= now - DAY_MS).length;
    if (recent >= this.settings.maxMovesPerJob) {
      return `moved or tried ${recent} times in 24 h: held (max_moves_per_job is ${this.settings.maxMovesPerJob})`;
    }
    const last = list[list.length - 1];
    if (last) {
      // The cool-down doubles with every earlier move of the job in 24 hours
      const until = last.createdAt + this.cooldownMs(Math.max(0, recent - 1));
      if (until > now) {
        const what = last.status === "moved" ? `moved ${last.from}→${last.to}` : `move ${last.status}`;
        return `${what}; cool-down for ${formatSpan(until - now)}`;
      }
    }
    if (job.class === null) return "no class matches its command";
    return null;
  }

  /** The cool-down after a move that had `earlier` moves of the same job before it in 24 hours. */
  private cooldownMs(earlier: number): number {
    return this.settings.cooldownSeconds * 1000 * 2 ** earlier;
  }

  /** The moves and tries recent enough to hold a job (24 hours, or the longest cool-down). */
  private attempts(now: number): Map<string, StoredMove[]> {
    const window = Math.min(MAX_ATTEMPT_WINDOW_MS, Math.max(DAY_MS, this.cooldownMs(this.settings.maxMovesPerJob - 1)));
    return this.store.attemptsSince(this.project, now - window);
  }

  /** Report each job the per-job cap holds, once while it is held. */
  private async reportHeld(jobs: ModelJob[], attempts: Map<string, StoredMove[]>, now: number): Promise<void> {
    const held = new Set<string>();
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      const recent = (attempts.get(job.id) ?? []).filter((m) => m.createdAt >= now - DAY_MS).length;
      if (recent < this.settings.maxMovesPerJob) continue;
      held.add(job.id);
      if (this.heldReported.has(job.id)) continue;
      this.heldReported.add(job.id);
      await this.events?.emit("placement.job_held", {
        project: this.project,
        gateId: job.id,
        lane: job.lane,
        moves: recent,
        reason: `moved or tried ${recent} times in 24 h (max_moves_per_job is ${this.settings.maxMovesPerJob}): placement leaves it where it is`,
      });
    }
    for (const id of [...this.heldReported]) if (!held.has(id)) this.heldReported.delete(id);
  }

  private explain(c: Candidate, verb: string, now: number): string {
    const from = this.laneOf(c.from);
    const to = this.laneOf(c.to);
    const fromMachine = from?.machine ?? c.from;
    const toMachine = to?.machine ?? c.to;
    const parts: string[] = [];
    if (c.stuck) parts.push(`${c.from} never runs ${c.job.class ?? "it"}`);
    if (c.quiet) {
      const fu = this.utilization(fromMachine);
      const tu = this.utilization(toMachine);
      parts.push(`quiet re-check: ${toMachine} ${tu?.toFixed(1) ?? "?"}/cpu vs ${fromMachine} ${fu?.toFixed(1) ?? "?"}/cpu`);
    }
    parts.push(
      c.targetRunning === 0 && c.targetQueued === 0
        ? `${c.to} idle`
        : `${c.to} ${c.targetRunning}/${to?.slots ?? "?"} busy${c.targetQueued > 0 ? `, ${c.targetQueued} queued` : ""}`,
    );
    for (const machine of new Set([fromMachine, toMachine])) {
      const f = this.factor(machine);
      if (f >= 1.05) parts.push(`${machine} load ${f.toFixed(1)}×`);
    }
    return `${verb} ${c.job.id} ${c.from}→${c.to}: est. ${formatSpan(c.fromFinish - now)} → ${formatSpan(c.toFinish - now)}; ${parts.join(", ")}`;
  }

  // ============ 5. MOVES ============

  /** A request of `id` in `lane` (queued or already claimed there). */
  private landed(lane: string, priority: number, id: string): boolean {
    const dir = join(this.gatesDir, "queue");
    return [".req", ".req.run"].some(
      (suffix) => this.probes.files.stat(join(dir, `${lane}.${priority}.${id}${suffix}`))?.isFile === true,
    );
  }

  private moveVars(c: Candidate): Record<string, string> {
    const file = join(this.gatesDir, "queue", `${c.from}.${c.job.priority}.${c.job.id}.req`);
    return { id: c.job.id, from: c.from, to: c.to, file, priority: String(c.job.priority), project: this.project };
  }

  private async emitMove(type: "placement.moved" | "placement.would_move" | "placement.move_failed", move: StoredMove): Promise<void> {
    await this.events?.emit(type, {
      project: this.project,
      gateId: move.gateId,
      from: move.from,
      to: move.to,
      gainSeconds: move.gainSeconds,
      explanation: move.explanation,
      mode: move.mode,
      ...(move.error ? { error: move.error } : {}),
    });
  }

  /** Run move_cmd for one move, then check the request landed. */
  private async act(c: Candidate, now: number): Promise<"moved" | "failed" | "skipped" | "stopped"> {
    const vars = this.moveVars(c);
    // Right before it runs: still queued where it was (a runner may have claimed it meanwhile)
    if (!this.probes.files.stat(vars.file)?.isFile) return "skipped";
    const explanation = this.explain(c, "moved", now);
    const built = buildMoveArgv(this.settings.moveCmd ?? [], vars);
    if ("error" in built) {
      const failed = this.store.addMove(this.project, {
        gateId: c.job.id,
        from: c.from,
        to: c.to,
        priority: c.job.priority,
        mode: "act",
        status: "failed",
        gainSeconds: c.gainSeconds,
        explanation,
        argv: null,
        error: built.error,
        createdAt: now,
        completedAt: now,
      });
      await this.emitMove("placement.move_failed", failed);
      return "failed";
    }
    const move = this.store.addMove(this.project, {
      gateId: c.job.id,
      from: c.from,
      to: c.to,
      priority: c.job.priority,
      mode: "act",
      status: "moving",
      gainSeconds: c.gainSeconds,
      explanation,
      argv: built.argv,
      error: null,
      createdAt: now,
    });
    const out = await this.run(built.argv, this.settings.commandTimeoutSeconds * 1000);
    // Stopping: the command was cut short; the next start finds where the request is (recoverMoves)
    if (this.abort.signal.aborted) return "stopped";
    const at = this.probes.clock.now();
    const there = this.landed(c.to, c.job.priority, c.job.id);
    const left = this.probes.files.stat(vars.file) === null;
    if (out.code === 0 && there && left) {
      this.store.finishMove(move.id, "moved", at);
      await this.emitMove("placement.moved", { ...move, status: "moved", completedAt: at });
      return "moved";
    }
    const error =
      out.code !== 0
        ? `${built.argv[0]} exited ${out.code}${out.stderr.trim() || out.stdout.trim() ? `: ${tail(out.stderr || out.stdout)}` : ""}`
        : `${built.argv[0]} exited 0, but the request is ${there ? `also still in ${c.from}` : `not in ${c.to}`}`;
    this.store.finishMove(move.id, "failed", at, error);
    await this.emitMove("placement.move_failed", { ...move, status: "failed", error, completedAt: at });
    return "failed";
  }

  /** A move left "moving" by a stop or a crash: find where its request is. */
  private recoverMoves(queue: QueueJob[], now: number): void {
    for (const move of this.store.movesWithStatus(this.project, "moving")) {
      const at = queue.find((j) => j.id === move.gateId);
      if (at && at.lane === move.to) {
        this.store.finishMove(move.id, "moved", now);
      } else if (at && at.lane === move.from) {
        this.store.finishMove(move.id, "interrupted", now, `Lair stopped while the move ran; the request is still in ${move.from}`);
      } else {
        this.store.finishMove(move.id, "gone", now, "Lair stopped while the move ran; the request is in neither lane now");
      }
    }
  }

  // ============ THE TICK ============

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<PlacementTick> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<PlacementTick> {
    const { settings, store, project, probes } = this;
    const now = probes.clock.now();
    const summary: PlacementTick = { at: new Date(now).toISOString(), moves: 0, wouldMoves: 0, failures: 0 };

    await this.probeMachines(now);
    // Stopping (or reloading): a probe cut short is no evidence, so nothing is decided on it
    if (this.abort.signal.aborted) return summary;
    let queue = readQueue(probes.files, this.gatesDir, settings);
    if (!this.recovered) {
      this.recoverMoves(queue, now);
      this.recovered = true;
    }
    const learned = this.sampleIndex();
    this.observeRuns(queue, now, learned);
    this.learnHistory(learned);
    const durations = this.durations();
    let { lanes, jobs } = this.model(queue, now);
    let attempts = this.attempts(now);
    await this.reportHeld(jobs, attempts, now);

    const decision = decide({
      now,
      lanes,
      jobs,
      duration: durations.fn,
      minGainSeconds: settings.minGainSeconds,
      maxMoves: settings.maxMovesPerTick,
      quietMargin: settings.quietMargin,
      utilization: (m) => this.utilization(m),
      held: (job) => this.heldReason(job, attempts, now),
    });
    let plan: Plan = decision.plan;
    const advice = new Map<string, PlacementAdvice>();

    if (this.actBlocked === null) {
      for (const c of decision.moves) {
        if (this.abort.signal.aborted) break;
        const outcome = await this.act(c, now);
        if (outcome === "moved") summary.moves++;
        if (outcome === "stopped") break;
        if (outcome === "failed") {
          // Nothing is retried hot: this job waits for its cool-down, and the rest for the next tick
          summary.failures++;
          break;
        }
      }
      if (summary.moves > 0 || summary.failures > 0) {
        queue = readQueue(probes.files, this.gatesDir, settings);
        ({ lanes, jobs } = this.model(queue, now));
        attempts = this.attempts(now);
        plan = planAll(now, lanes, jobs, durations.fn);
      }
    } else {
      const current = new Set<string>();
      for (const c of decision.moves) {
        const explanation = this.explain(c, "would move", now);
        advice.set(c.job.id, {
          to: c.to,
          gainSeconds: Math.round(c.gainSeconds),
          explanation,
          quiet: c.quiet,
          stuck: c.stuck,
        });
        current.add(c.job.id);
        const key = `${c.from}>${c.to}`;
        if (this.advice.get(c.job.id) === key) continue;
        this.advice.set(c.job.id, key);
        const built = settings.moveCmd ? buildMoveArgv(settings.moveCmd, this.moveVars(c)) : null;
        const move = store.addMove(project, {
          gateId: c.job.id,
          from: c.from,
          to: c.to,
          priority: c.job.priority,
          mode: "observe",
          status: "would_move",
          gainSeconds: c.gainSeconds,
          explanation,
          argv: built && "argv" in built ? built.argv : null,
          error: built && "error" in built ? built.error : null,
          createdAt: now,
          completedAt: now,
        });
        summary.wouldMoves++;
        await this.emitMove("placement.would_move", move);
      }
      for (const id of [...this.advice.keys()]) if (!current.has(id)) this.advice.delete(id);
    }

    store.prune(project, now);
    this.snapshot = this.buildSnapshot(lanes, jobs, plan, advice, attempts, durations.table, now);
    this.queuedLastTick = new Set(queue.filter((j) => j.status === "queued").map((j) => j.id));
    this.lastTickAt = now;
    this.lastTick = summary;
    this.lastError = undefined;
    return summary;
  }

  private buildSnapshot(
    lanes: ModelLane[],
    jobs: ModelJob[],
    plan: Plan,
    advice: Map<string, PlacementAdvice>,
    attempts: Map<string, StoredMove[]>,
    durations: PlacementDuration[],
    now: number,
  ): Snapshot {
    const finite = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    return {
      machines: this.machineStatus(),
      lanes: lanes.map((lane) => {
        const mine = jobs.filter((j) => j.runsOn === lane.name);
        const running = mine.filter((j) => j.status === "running");
        return {
          name: lane.name,
          machine: lane.machine,
          slots: lane.slots,
          inUse: running.length,
          queued: mine.length - running.length,
          limits: Object.entries(lane.limits).map(([cls, limit]) => ({
            class: cls,
            limit,
            inUse: running.filter((j) => j.class === cls).length,
          })),
          serves: lane.serves,
        };
      }),
      jobs: jobs.map((job) => {
        const slot = plan.get(job.id);
        return {
          id: job.id,
          lane: job.lane,
          priority: job.priority,
          status: job.status,
          class: job.class,
          expectedStart: finite(slot?.start),
          expectedFinish: finite(slot?.finish),
          held: this.heldReason(job, attempts, now),
          advice: advice.get(job.id) ?? null,
        };
      }),
      durations,
    };
  }

  private machineStatus(): PlacementMachine[] {
    return this.settings.machines.map((m) => {
      const rt = this.machines.get(m.id) as MachineRuntime;
      const utilization = this.utilization(m.id);
      return {
        id: m.id,
        state: rt.state,
        passingSince: iso(rt.passingSince),
        upSince: iso(rt.upSince),
        downSince: iso(rt.downSince),
        lastProbeAt: iso(rt.lastProbeAt),
        lastError: rt.lastError,
        load: rt.load,
        cpus: rt.cpus,
        utilization: utilization === null ? null : Math.round(utilization * 100) / 100,
        factor: Math.round(this.factor(m.id) * 100) / 100,
      };
    });
  }

  /** The last tick's machines, lanes, jobs and durations (empty before the first tick). */
  view(): Snapshot {
    return this.snapshot ?? { machines: this.machineStatus(), lanes: [], jobs: [], durations: [] };
  }

  /** Tick now, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // A move a stop cut short is found again on the first tick
    this.recovered = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[placement] ${this.project}: tick failed:`, e);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  /** Stop ticking: commands in progress are cut short. Resolves once the tick in progress ended. */
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

/** Build a Placement from a project config; throws when `placement:` is invalid. */
export function createPlacement(options: Omit<PlacementOptions, "settings">): Placement {
  const parsed = parsePlacementConfig(options.config.placement);
  if (!parsed.ok) {
    throw new Error(`Invalid placement config for ${options.project}: ${parsed.errors.join("; ")}`);
  }
  return new Placement({ ...options, settings: parsed.settings });
}

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

/**
 * All projects' placements. The store (data/placement.db) is opened only
 * when at least one project enables placement.
 */
export class PlacementManager {
  private placements = new Map<string, Placement>();
  private problems = new Map<string, string[]>();
  private store: PlacementStore | null = null;
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private options: { dbPath: string; probes?: PlacementProbes; events?: EventBus }) {}

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parsePlacementConfig(config.placement);
    return parsed.ok ? [] : parsed.errors;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parsePlacementConfig(entry.config.placement);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[placement] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new PlacementStore(this.options.dbPath);
      this.placements.set(
        entry.name,
        new Placement({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.store,
          probes: this.options.probes ?? systemPlacementProbes(parsed.settings.commandTimeoutSeconds * 1000),
          events: this.options.events,
        }),
      );
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const placement of this.placements.values()) placement.start();
    return [...this.placements.keys()];
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  /**
   * Apply a project's new config: its placement stops (a command in progress
   * is cut short, and a move it cut short is found again by the next one),
   * then the new one starts. Other projects are not touched.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    const old = this.placements.get(entry.name);
    if (old) await old.stop();
    if (this.inPhase("stopped")) return;
    this.placements.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.placements.get(entry.name);
    if (!next) return;
    try {
      if (this.inPhase("started")) next.start();
    } catch (e) {
      await next.stop();
      this.placements.delete(entry.name);
      throw e;
    }
  }

  /** Stop every placement, wait for ticks in progress, then close the store. */
  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.placements.values()].map((p) => p.stop()));
    this.store?.close();
    this.store = null;
    this.placements.clear();
  }

  get(project: string): Placement | undefined {
    return this.placements.get(project);
  }

  status(project: string): PlacementStatus {
    const placement = this.placements.get(project);
    const view = placement?.view();
    return {
      project,
      enabled: placement !== undefined,
      running: placement?.running ?? false,
      mode: placement?.settings.mode ?? null,
      actBlocked: placement ? placement.actBlocked : null,
      errors: this.problems.get(project) ?? [],
      intervalSeconds: placement?.settings.intervalSeconds ?? null,
      lastTick: placement?.lastTick ?? null,
      lastError: placement?.lastError ?? null,
      machines: view?.machines ?? [],
      lanes: view?.lanes ?? [],
      jobs: view?.jobs ?? [],
      moves: this.store && placement ? this.store.recentMoves(project, RECENT_MOVES).map(moveForApi) : [],
      durations: view?.durations ?? [],
    };
  }
}
