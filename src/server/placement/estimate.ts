/**
 * The estimates and the move decisions: pure functions over one snapshot of
 * the lanes, their jobs and the learned durations, so the same numbers back
 * the Gates view and the moves.
 *
 * A lane runs its jobs in its own order (priority digit, then id) on `slots`
 * runners, at most `limits.<class>` of a class at a time, and a job never
 * starts before the one ahead of it (a runner takes the head of its queue,
 * as the usual runners do). A running job ends after its expected duration,
 * counted from when it started, but always has at least a tenth of it left
 * (so one past its duration is expected to need a tenth of it more). A
 * pseudo-lane (`serves`) runs the jobs it takes from the lanes it
 * serves, beside their own runners.
 */
import { laneOrder } from "./queue.js";

export interface ModelLane {
  name: string;
  machine: string;
  slots: number;
  limits: Record<string, number>;
  serves: string[];
  maxPriority?: number;
  eligible: ReadonlySet<string>;
  /** Its machine is up (probes passing for min_up_seconds) */
  up: boolean;
  /** On-demand routing: lanes to overflow to */
  overflowTo: string[];
  /** On-demand routing: move to overflow lanes when they finish sooner */
  preferWhenFaster: boolean;
  /** On-demand routing: minimum gain in seconds for prefer_when_faster */
  routingMinGainSeconds?: number;
  /** On-demand: its machine is stopped and the guard allows a start (a job moved here starts it) */
  onDemandAvailable: boolean;
  /** On-demand: boot time added to the estimates while the machine is not up (seconds) */
  bootSeconds: number;
  /** On-demand: cost per hour, breaks a tie between two equally good moves (null: free) */
  costPerHour: number | null;
}

export interface ModelJob {
  id: string;
  /** The lane its request file is in */
  lane: string;
  priority: number;
  status: "queued" | "running";
  class: string | null;
  quiet: boolean;
  /** Running: when it started (ms) */
  startedAt: number | null;
  /** The lane whose runner runs it: its own, or the pseudo-lane that takes it */
  runsOn: string;
  /** Queued in an on-demand lane that can't run it (guard refused, state unknown, machine stopped under it): why it goes back */
  back: string | null;
}

/** A job's expected duration (seconds, load included) on a machine. */
export type DurationFn = (cls: string | null, machine: string) => number;

export interface Slot {
  start: number;
  finish: number;
}

export type Plan = Map<string, Slot>;

/** A running job past its expected duration is expected to need this share of it more */
const OVERDUE_SHARE = 0.1;

/** The pseudo-lane that takes a queued job in `lane`, if one does. */
export function servingLane(
  lanes: readonly ModelLane[],
  job: { lane: string; priority: number; class: string | null },
): ModelLane | undefined {
  if (job.class === null) return undefined;
  return lanes.find(
    (l) =>
      l.up &&
      l.serves.includes(job.lane) &&
      (l.maxPriority === undefined || job.priority <= l.maxPriority) &&
      l.eligible.has(job.class as string),
  );
}

/** One lane's starts and finishes, for the jobs it runs. */
export function simulateLane(now: number, lane: ModelLane, jobs: readonly ModelJob[], duration: DurationFn): Plan {
  const out: Plan = new Map();
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued").sort(laneOrder);
  const intervals: { cls: string | null; finish: number }[] = [];
  const free: number[] = [];
  for (const job of running) {
    const total = duration(job.class, lane.machine) * 1000;
    const started = job.startedAt ?? now;
    const elapsed = Math.max(0, now - started);
    const finish = now + Math.max(total - elapsed, total * OVERDUE_SHARE);
    out.set(job.id, { start: started, finish });
    free.push(finish);
    intervals.push({ cls: job.class, finish });
  }
  const slots = Math.max(lane.slots, running.length);
  while (free.length < slots) free.push(now);

  let previousStart = now;
  for (const job of queued) {
    const length = duration(job.class, lane.machine) * 1000;
    const limit = job.class !== null ? lane.limits[job.class] : undefined;
    const sameClass = intervals.filter((i) => i.cls === job.class);
    const candidates = [previousStart, ...free, ...sameClass.map((i) => i.finish)]
      .filter((t) => t >= previousStart)
      .sort((a, b) => a - b);
    let start = Infinity;
    for (const t of candidates) {
      if (!free.some((f) => f <= t)) continue;
      if (limit !== undefined && sameClass.filter((i) => i.finish > t).length >= limit) continue;
      start = t;
      break;
    }
    if (!Number.isFinite(start)) {
      // A class this lane never runs (limit 0): it does not hold up the jobs behind it
      out.set(job.id, { start: Infinity, finish: Infinity });
      continue;
    }
    // Any runner free by then will do; take the one that became free last
    let slot = -1;
    for (let i = 0; i < free.length; i++) {
      if (free[i] <= start && (slot < 0 || free[i] > free[slot])) slot = i;
    }
    const finish = start + length;
    free[slot] = finish;
    intervals.push({ cls: job.class, finish });
    out.set(job.id, { start, finish });
    previousStart = start;
  }
  return out;
}

/** Every up lane's plan. Jobs on a lane whose machine is not up get no estimate. */
export function planAll(now: number, lanes: readonly ModelLane[], jobs: readonly ModelJob[], duration: DurationFn): Plan {
  const out: Plan = new Map();
  for (const lane of lanes) {
    // A lane is plannable if: up, or on-demand available (stopped + guard ok)
    if (!lane.up && !lane.onDemandAvailable) continue;
    const mine = jobs.filter((j) => j.runsOn === lane.name);
    for (const [id, slot] of simulateLane(now, lane, mine, duration)) {
      // For on-demand machines not yet running, add boot time to estimates
      if (!lane.up && lane.onDemandAvailable && lane.bootSeconds > 0) {
        const bootMs = lane.bootSeconds * 1000;
        out.set(id, { start: slot.start + bootMs, finish: slot.finish + bootMs });
      } else {
        out.set(id, slot);
      }
    }
  }
  return out;
}

/**
 * Check if a lane is available for routing: either up, or on-demand available.
 */
export function isLaneAvailable(lane: ModelLane): boolean {
  return lane.up || lane.onDemandAvailable;
}

export interface Candidate {
  job: ModelJob;
  from: string;
  to: string;
  /** Expected finish (ms) where it is and where it would go */
  fromFinish: number;
  toFinish: number;
  /** fromFinish - toFinish, in seconds (0 when it can't run where it is: see `stuck`) */
  gainSeconds: number;
  /** The gain less what it costs the jobs of the same or a more urgent priority on both lanes */
  netSeconds: number;
  quiet: boolean;
  /** Its own lane can never run it (a class limit of 0 there): any lane that can is a gain */
  stuck: boolean;
  /** The target lane before the move: its running and queued jobs */
  targetRunning: number;
  targetQueued: number;
  /** Queued jobs in the source lane before the move that don't start now */
  sourceWaiting: number;
  /**
   * An on-demand move: `overflow` (overflow_to, the job waits), `faster`
   * (prefer_when_faster), `back` (out of an on-demand lane that can't run it,
   * see ModelJob.back); null for any other move
   */
  route: "overflow" | "faster" | "back" | null;
}

export interface DecideOptions {
  now: number;
  lanes: readonly ModelLane[];
  jobs: readonly ModelJob[];
  duration: DurationFn;
  minGainSeconds: number;
  maxMoves: number;
  quietMargin: number;
  /** A machine's load per cpu, or null when unknown */
  utilization: (machine: string) => number | null;
  /** Why a queued job must stay where it is (cool-down, ...), or null */
  held: (job: ModelJob) => string | null;
}

export interface Decision {
  moves: Candidate[];
  /** The estimates before any move */
  plan: Plan;
}

function relocate(lanes: readonly ModelLane[], jobs: readonly ModelJob[], job: ModelJob, to: string): ModelJob[] {
  const moved: ModelJob = { ...job, lane: to };
  moved.runsOn = servingLane(lanes, moved)?.name ?? to;
  return jobs.map((j) => (j === job ? moved : j));
}

function replan(
  now: number,
  lanes: readonly ModelLane[],
  jobs: readonly ModelJob[],
  duration: DurationFn,
  base: Plan,
  affected: ReadonlySet<string>,
): Plan {
  const out: Plan = new Map(base);
  for (const lane of lanes) {
    if (!isLaneAvailable(lane) || !affected.has(lane.name)) continue;
    for (const [id, slot] of simulateLane(
      now,
      lane,
      jobs.filter((j) => j.runsOn === lane.name),
      duration,
    )) {
      // Add boot time for on-demand machines not yet running (the only place a trial adds it)
      if (!lane.up && lane.onDemandAvailable && lane.bootSeconds > 0) {
        const bootMs = lane.bootSeconds * 1000;
        out.set(id, { start: slot.start + bootMs, finish: slot.finish + bootMs });
      } else {
        out.set(id, slot);
      }
    }
  }
  return out;
}

/**
 * The moves, best first, at most `maxMoves`. Each is chosen on the state the
 * moves before it leave:
 * - a job queued in an on-demand lane that can't run it (`ModelJob.back`:
 *   guard refused, state unknown, the machine stopped under it) goes back,
 *   before any other move, to an up lane whose `overflowTo` lists that lane
 *   (else to any up lane that runs its class): the one it finishes soonest on;
 * - a quiet re-check (prefer_quiet, loads known) goes to the least-loaded
 *   eligible machine when its load per cpu is at least `quietMargin` below
 *   the current one's, whatever the times (min_gain and the net rule don't
 *   apply). Without such a machine it is placed by time as below, but only
 *   on machines no busier than its own;
 * - a job its own lane can never run (a class limit of 0 there) goes to the
 *   lane that can run it soonest, before any move by time, a quiet re-check
 *   too (whatever the loads: anywhere it can run beats where it can't);
 * - any other queued job goes where it is expected to finish at least
 *   `minGainSeconds` sooner, when the move also saves that much in all
 *   (what it costs the jobs of the same or a more urgent priority on both
 *   lanes counted); the job that gains most goes first.
 * A lane on a stopped on-demand machine (`onDemandAvailable`: a move there
 * starts a paid machine, its boot time is in the estimate) is a target only
 * through routing: the source lane's `overflowTo` lists it, or the source
 * lane has `preferWhenFaster`. It needs a free slot, and a gain above 0 of
 * at least the routing's `min_gain_seconds` (else `minGainSeconds`), in all
 * too; without `preferWhenFaster` the job must also be waiting (not about
 * to start on its own lane). These moves go before moves by time.
 * Of two equally good moves, the one to the cheaper lane (`costPerHour`) wins.
 * Never a running job, a job a pseudo-lane takes, a job without a class, a
 * held job, or (but for a move back) a job on a lane whose machine is
 * neither up nor an available on-demand one; never to such a lane, to one
 * that does not list the job's class in `eligible`, or to a pseudo-lane.
 */
export function decide(options: DecideOptions): Decision {
  const { now, lanes, duration } = options;
  const byName = new Map(lanes.map((l) => [l.name, l] as const));
  const initial = planAll(now, lanes, options.jobs, duration);
  let jobs = [...options.jobs];
  let plan = initial;
  const moves: Candidate[] = [];
  const movedIds = new Set<string>();

  type Choice = { candidate: Candidate; score: number; jobs: ModelJob[]; plan: Plan };
  const cost = (lane: string) => byName.get(lane)?.costPerHour ?? 0;
  // The higher score; of two equal ones, the cheaper target
  const better = (best: Choice | null, next: Choice): Choice =>
    !best ||
    next.score > best.score ||
    (next.score === best.score && cost(next.candidate.to) < cost(best.candidate.to))
      ? next
      : best;

  while (moves.length < options.maxMoves) {
    let best: Choice | null = null;

    // `job` from where it would finish at `fromFinish` (Infinity: it can't run there) to `to`
    const trial = (job: ModelJob, fromFinish: number, to: ModelLane) => {
      const stuck = !Number.isFinite(fromFinish);
      const trialJobs = relocate(lanes, jobs, job, to.name);
      const movedJob = trialJobs.find((j) => j.id === job.id && j.lane === to.name) as ModelJob;
      const affected = new Set([job.lane, movedJob.runsOn]);
      const trialPlan = replan(now, lanes, trialJobs, duration, plan, affected);
      const toFinish = trialPlan.get(job.id)?.finish ?? Infinity;
      let net = (fromFinish - toFinish) / 1000;
      for (const other of jobs) {
        if (other === job || other.priority > job.priority) continue;
        if (!affected.has(other.runsOn)) continue;
        const before = plan.get(other.id)?.finish;
        const after = trialPlan.get(other.id)?.finish;
        if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after)) continue;
        net += (before - after) / 1000;
      }
      const candidate: Candidate = {
        job,
        from: job.lane,
        to: to.name,
        fromFinish,
        toFinish,
        gainSeconds: stuck ? 0 : (fromFinish - toFinish) / 1000,
        netSeconds: stuck ? 0 : net,
        quiet: false,
        stuck,
        targetRunning: jobs.filter((j) => j.runsOn === to.name && j.status === "running").length,
        targetQueued: jobs.filter((j) => j.runsOn === to.name && j.status === "queued").length,
        sourceWaiting: jobs.filter(
          (j) => j.runsOn === job.lane && j.status === "queued" && (plan.get(j.id)?.start ?? Infinity) > now,
        ).length,
        route: null,
      };
      return { candidate, jobs: trialJobs, plan: trialPlan };
    };

    for (const job of jobs) {
      if (job.status !== "queued" || job.runsOn !== job.lane || job.class === null) continue;
      if (movedIds.has(job.id)) continue;
      const from = byName.get(job.lane);
      if (!from || from.serves.length > 0) continue;
      if (options.held(job)) continue;
      const cls = job.class;
      const runsIt = (l: ModelLane) => l.name !== job.lane && l.serves.length === 0 && l.eligible.has(cls);

      if (job.back !== null) {
        // Back where it came from: a lane that overflows to its lane, else any up lane that runs it
        const up = lanes.filter((l) => runsIt(l) && l.up);
        const sources = up.filter((l) => l.overflowTo.includes(job.lane));
        for (const to of sources.length > 0 ? sources : up) {
          const result = trial(job, plan.get(job.id)?.finish ?? Infinity, to);
          const c = result.candidate;
          if (!Number.isFinite(c.toFinish)) continue;
          // Not a move by time: it goes back whatever the gain, the soonest finish first
          c.gainSeconds = 0;
          c.netSeconds = 0;
          c.stuck = false;
          c.route = "back";
          best = better(best, { ...result, score: 1e13 - (c.toFinish - now) / 1000 });
        }
        continue;
      }

      // Not planned: its machine is neither up nor an available on-demand one
      const fromSlot = plan.get(job.id);
      if (!fromSlot) continue;
      let targets = lanes.filter((l) => runsIt(l) && l.up);
      // A move to a stopped on-demand machine starts it: only through routing
      const starting = lanes.filter(
        (l) => runsIt(l) && !l.up && l.onDemandAvailable && (from.overflowTo.includes(l.name) || from.preferWhenFaster),
      );
      if (targets.length === 0 && starting.length === 0) continue;
      const stuck = !Number.isFinite(fromSlot.finish);

      const fromUtil = options.utilization(from.machine);
      // A job its lane never runs goes wherever it can run, quiet re-check or not
      if (job.quiet && fromUtil !== null && !stuck) {
        // Quiet re-check: the least-loaded eligible machine, by load per cpu
        let quietest: { lane: ModelLane; util: number } | null = null;
        for (const lane of targets) {
          const util = options.utilization(lane.machine);
          if (util === null) continue;
          if (!quietest || util < quietest.util) quietest = { lane, util };
        }
        if (quietest && fromUtil - quietest.util >= options.quietMargin) {
          const result = trial(job, fromSlot.finish, quietest.lane);
          if (Number.isFinite(result.candidate.toFinish)) {
            result.candidate.quiet = true;
            // Quiet moves first, the quietest gap first
            best = better(best, { ...result, score: 1e12 + (fromUtil - quietest.util) * 1e6 });
            continue;
          }
        }
        // No machine quiet enough: placed by time, but never on a busier machine
        // (one whose load is unknown counts as busier)
        targets = targets.filter((l) => {
          const util = options.utilization(l.machine);
          return quietest === null ? true : util !== null && util <= fromUtil;
        });
      }

      for (const to of starting) {
        if (jobs.filter((j) => j.runsOn === to.name && j.status === "running").length >= to.slots) continue;
        const result = trial(job, fromSlot.finish, to);
        const { gainSeconds, netSeconds, toFinish } = result.candidate;
        if (!Number.isFinite(toFinish)) continue;
        let score: number;
        if (stuck) {
          score = 1e11 - (toFinish - now) / 1000;
        } else {
          // Never start a paid machine for nothing
          const minGain = from.routingMinGainSeconds ?? options.minGainSeconds;
          if (gainSeconds <= 0 || gainSeconds < minGain || netSeconds < minGain) continue;
          // An overflow is for a job that waits; prefer_when_faster also moves one about to start
          if (!from.preferWhenFaster && fromSlot.start <= now) continue;
          score = 1e10 + gainSeconds;
        }
        result.candidate.route = from.overflowTo.includes(to.name) && fromSlot.start > now ? "overflow" : "faster";
        best = better(best, { ...result, score });
      }

      for (const to of targets) {
        const result = trial(job, fromSlot.finish, to);
        const { gainSeconds, netSeconds, toFinish } = result.candidate;
        if (!Number.isFinite(toFinish)) continue;
        let score: number;
        if (stuck) {
          // Any lane that can run it gains everything: the one that runs it soonest first
          score = 1e11 - (toFinish - now) / 1000;
        } else {
          if (gainSeconds < options.minGainSeconds || netSeconds < options.minGainSeconds) continue;
          score = gainSeconds;
        }
        best = better(best, { ...result, score });
      }
    }
    if (!best) break;
    moves.push(best.candidate);
    movedIds.add(best.candidate.job.id);
    jobs = best.jobs;
    plan = best.plan;
  }
  return { moves, plan: initial };
}
