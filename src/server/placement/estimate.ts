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
  /** On-demand: machine is available (stopped + guard ok) */
  onDemandAvailable: boolean;
  /** On-demand: boot time to add to estimates (seconds) */
  bootSeconds: number;
  /** Lane the job originally came from, for move-back */
  originalLane?: string;
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
      // Add boot time for on-demand machines not yet running
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
 * - ON-DEMAND OVERFLOW: a job in a lane with overflow_to configured goes to
 *   an on-demand lane when that lane is available (stopped + guard ok) and
 *   has a free slot.
 * - ON-DEMAND PREFER_WHEN_FASTER: a job moves to an on-demand lane when
 *   it would finish sooner there (including boot time) by at least
 *   min_gain_seconds.
 * - ON-DEMAND MOVE-BACK: a job in an on-demand lane that is unavailable
 *   (guard refused, unknown state) moves back to the lane it came from.
 * Never a running job, a job a pseudo-lane takes, a job without a class, a
 * held job, or a job on a lane whose machine is not up; never to a lane that
 * is not up or on-demand available, does not list the job's class in
 * `eligible`, or is a pseudo-lane.
 */
export function decide(options: DecideOptions): Decision {
  const { now, lanes, duration } = options;
  const byName = new Map(lanes.map((l) => [l.name, l] as const));
  const initial = planAll(now, lanes, options.jobs, duration);
  let jobs = [...options.jobs];
  let plan = initial;
  const moves: Candidate[] = [];
  const movedIds = new Set<string>();

  while (moves.length < options.maxMoves) {
    let best: { candidate: Candidate; score: number; jobs: ModelJob[]; plan: Plan } | null = null;
    for (const job of jobs) {
      if (job.status !== "queued" || job.runsOn !== job.lane || job.class === null) continue;
      if (movedIds.has(job.id)) continue;
      const from = byName.get(job.lane);
      if (!from || from.serves.length > 0) continue;
      // The source lane must be up or on-demand available
      if (!from.up && !from.onDemandAvailable) continue;
      if (options.held(job)) continue;
      const fromSlot = plan.get(job.id);
      if (!fromSlot) continue;
      const cls = job.class;

      // Determine valid targets: up or on-demand available, not a pseudo-lane, class is eligible
      let targets = lanes.filter(
        (l) =>
          l.name !== job.lane &&
          isLaneAvailable(l) &&
          l.serves.length === 0 &&
          l.eligible.has(cls),
      );

      // ON-DEMAND MOVE-BACK: if the source is an on-demand lane that is unavailable,
      // and there's a job queued there, move it back to its overflow source
      if (from.onDemandAvailable === false && !from.up && from.originalLane) {
        const backLane = byName.get(from.originalLane);
        if (backLane && isLaneAvailable(backLane) && backLane.eligible.has(cls)) {
          targets = [backLane];
        }
      }

      if (targets.length === 0) continue;
      const stuck = !Number.isFinite(fromSlot.finish);

      // Check if this is an overflow scenario
      const overflowTargets = from.overflowTo.length > 0
        ? targets.filter((t) => from.overflowTo.includes(t.name))
        : [];

      const trial = (to: ModelLane, _isOverflow = false) => {
        const trialJobs = relocate(lanes, jobs, job, to.name);
        const movedJob = trialJobs.find((j) => j.id === job.id && j.lane === to.name) as ModelJob;
        const affected = new Set([job.lane, movedJob.runsOn]);
        const trialPlan = replan(now, lanes, trialJobs, duration, plan, affected);
        let toFinish = trialPlan.get(job.id)?.finish ?? Infinity;

        // Add boot time for on-demand machines not yet running
        if (!to.up && to.onDemandAvailable && to.bootSeconds > 0) {
          toFinish += to.bootSeconds * 1000;
        }

        let net = (fromSlot.finish - toFinish) / 1000;
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
          fromFinish: fromSlot.finish,
          toFinish,
          gainSeconds: stuck ? 0 : (fromSlot.finish - toFinish) / 1000,
          netSeconds: stuck ? 0 : net,
          quiet: false,
          stuck,
          targetRunning: jobs.filter((j) => j.runsOn === to.name && j.status === "running").length,
          targetQueued: jobs.filter((j) => j.runsOn === to.name && j.status === "queued").length,
        };
        return { candidate, jobs: trialJobs, plan: trialPlan };
      };

      const fromUtil = options.utilization(from.machine);
      // A job its lane never runs goes wherever it can run, quiet re-check or not
      if (job.quiet && fromUtil !== null && !stuck) {
        // Quiet re-check: the least-loaded eligible machine, by load per cpu
        let quietest: { lane: ModelLane; util: number } | null = null;
        for (const lane of targets) {
          // Skip on-demand machines not running for quiet checks (load unknown)
          if (!lane.up) continue;
          const util = options.utilization(lane.machine);
          if (util === null) continue;
          if (!quietest || util < quietest.util) quietest = { lane, util };
        }
        if (quietest && fromUtil - quietest.util >= options.quietMargin) {
          const result = trial(quietest.lane);
          if (Number.isFinite(result.candidate.toFinish)) {
            result.candidate.quiet = true;
            // Quiet moves first, the quietest gap first
            const score = 1e12 + (fromUtil - quietest.util) * 1e6;
            if (!best || score > best.score) best = { ...result, score };
            continue;
          }
        }
        // No machine quiet enough: placed by time, but never on a busier machine
        // (one whose load is unknown counts as busier)
        targets = targets.filter((l) => {
          if (!l.up) return false; // Skip non-running on-demand for quiet
          const util = options.utilization(l.machine);
          return quietest === null ? true : util !== null && util <= fromUtil;
        });
      }

      // OVERFLOW: check overflow targets first
      for (const to of overflowTargets) {
        // Check if overflow lane has a free slot
        const running = jobs.filter((j) => j.runsOn === to.name && j.status === "running").length;
        if (running >= to.slots) continue; // No free slot

        const result = trial(to, true);
        const { gainSeconds, toFinish } = result.candidate;
        if (!Number.isFinite(toFinish)) continue;

        // For overflow, check if prefer_when_faster is set
        if (from.preferWhenFaster) {
          const minGain = from.routingMinGainSeconds ?? options.minGainSeconds;
          if (gainSeconds < minGain) continue;
        }

        // Overflow with free slot: higher priority than regular moves
        const score = 1e10 + gainSeconds;
        if (!best || score > best.score) best = { ...result, score };
      }

      for (const to of targets) {
        // Skip if already handled as overflow
        if (overflowTargets.some((t) => t.name === to.name)) continue;

        const result = trial(to);
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
        if (!best || score > best.score) best = { ...result, score };
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
