/**
 * The infra monitor's detectors: pure functions of one tick's snapshot.
 * They never act; the service raises, withdraws and re-queues.
 *
 * A condition counts only once it has lasted down_threshold_seconds without
 * a break: a machine's probes failing round after round (its downSince), or
 * the other conditions seen on every tick since `held` says. A condition
 * that breaks starts again from zero, so a blip or a flapping machine is not
 * an outage.
 */
import type { LaneSettings, MachineSettings } from "./config.js";
import type { QueueEntry } from "./probes.js";
import type { InfraFinding, JobView, MachineView } from "./types.js";

export interface RunnerState {
  file: string;
  pid: number | null;
  alive: boolean;
}

export interface Snapshot {
  now: number;
  thresholdMs: number;
  machines: ReadonlyMap<string, MachineView>;
  machineSettings: ReadonlyMap<string, MachineSettings>;
  lanes: readonly LaneSettings[];
  running: readonly JobView[];
  queued: readonly QueueEntry[];
  /** Lanes with runner_pid_files: what each file says */
  runners: ReadonlyMap<string, RunnerState[]>;
}

/** Printable, one line, at most `max` characters (text from probes and files is untrusted). */
export function oneLine(text: string, max: number): string {
  const flat = [...text].map((ch) => (ch < " " || ch === "\u007f" ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

const iso = (ms: number) => new Date(ms).toISOString();

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "1 min" : `${m} min`;
}

function listFact(items: string[]): string {
  return oneLine(items.join(", "), 200);
}

/** A running job is on a down machine once the machine was seen up during it, or once it ran longer than the start grace. */
function jobCounts(job: JobView, machine: MachineSettings | undefined, now: number): boolean {
  if (job.machineSeenUp) return true;
  const grace = (machine?.startGraceSeconds ?? 0) * 1000;
  return now - job.claimedAt >= grace;
}

function machineDown(s: Snapshot): InfraFinding[] {
  const out: InfraFinding[] = [];
  for (const [id, m] of s.machines) {
    if (m.up !== false || m.downSince === null) continue;
    const downMs = s.now - m.downSince;
    if (downMs < s.thresholdMs) continue;
    const lanes = new Set(s.lanes.filter((l) => l.machine === id).map((l) => l.name));
    const running = s.running.filter((j) => lanes.has(j.lane) && jobCounts(j, s.machineSettings.get(id), s.now));
    const queued = s.queued.filter((q) => lanes.has(q.lane) && s.now - q.ctimeMs >= s.thresholdMs);
    // A machine that is down with nothing on it is not a problem (an on-demand server stopped when idle)
    if (running.length === 0 && queued.length === 0) continue;
    const error = m.lastError ? oneLine(m.lastError, 200) : null;
    const summary =
      running.length > 0
        ? `Machine ${id} has been down for ${minutes(downMs)} under ${running.length} running gate job(s)`
        : `Machine ${id} has been down for ${minutes(downMs)} while ${queued.length} gate job(s) wait in its lanes`;
    const oldestQueued = queued.reduce<number | null>((min, q) => (min === null || q.ctimeMs < min ? q.ctimeMs : min), null);
    out.push({
      key: `machine_down:${id}`,
      type: "machine_down",
      summary,
      evidence: [
        `machine ${id} has failed its probes since ${iso(m.downSince)}${error ? `: ${error}` : ""}`,
        ...running.slice(0, 5).map((j) => `running: ${j.id} (lane ${j.lane}, claimed ${iso(j.claimedAt)})`),
        ...(running.length > 5 ? [`... and ${running.length - 5} more running`] : []),
        ...(queued.length > 0 ? [`queued: ${queued.length} job(s) in lane(s) ${[...new Set(queued.map((q) => q.lane))].join(", ")}, waiting since ${iso(oldestQueued ?? s.now)}`] : []),
      ],
      facts: {
        machine: id,
        down_since: iso(m.downSince),
        down_seconds: Math.round(downMs / 1000),
        last_error: error,
        running_jobs: running.length,
        queued_jobs: queued.length,
        jobs: running.length > 0 ? listFact(running.map((j) => j.id)) : null,
      },
      machine: id,
      lane: null,
      jobs: running.map((j) => ({ id: j.id, lane: j.lane })),
    });
  }
  return out;
}

/** Conditions that must hold tick after tick: key -> the finding they make. */
function conditions(s: Snapshot): Map<string, InfraFinding> {
  const out = new Map<string, InfraFinding>();
  const laneOf = new Map(s.lanes.map((l) => [l.name, l]));

  // A running request whose process group is gone: nobody runs it any more
  for (const job of s.running) {
    if (job.pgid === null || job.groupAlive !== false) continue;
    const key = `job_lost:${job.id}`.slice(0, 200);
    out.set(key, {
      key,
      type: "job_lost",
      summary: oneLine(`Gate job ${job.id} in lane ${job.lane} has no process left (group ${job.pgid} is gone) but its request still says running`, 200),
      evidence: [
        `request ${job.id} is running in lane ${job.lane} (machine ${job.machine}), claimed ${iso(job.claimedAt)}`,
        `its process group ${job.pgid} (from its .pgid file) no longer exists`,
        "the runner that held it ended without finishing the request",
      ],
      facts: { gate: oneLine(job.id, 200), lane: job.lane, machine: job.machine, pgid: job.pgid, claimed_at: iso(job.claimedAt) },
      machine: job.machine,
      lane: job.lane,
      jobs: [],
    });
  }

  // More running requests than slots: two runners claim one slot
  const runningByLane = new Map<string, JobView[]>();
  for (const job of s.running) runningByLane.set(job.lane, [...(runningByLane.get(job.lane) ?? []), job]);
  for (const [lane, jobs] of runningByLane) {
    const settings = laneOf.get(lane);
    if (!settings || jobs.length <= settings.slots) continue;
    const key = `slot_overflow:${lane}`;
    out.set(key, {
      key,
      type: "slot_overflow",
      summary: `Lane ${lane} runs ${jobs.length} gate jobs in ${settings.slots} slot(s): more than one runner claims a slot`,
      evidence: [
        `lane ${lane} has ${settings.slots} slot(s) and ${jobs.length} running requests`,
        ...jobs.slice(0, 5).map((j) => `running: ${j.id} (claimed ${iso(j.claimedAt)}${j.pgid !== null ? `, group ${j.pgid}` : ""})`),
      ],
      facts: { lane, machine: settings.machine, slots: settings.slots, running_jobs: jobs.length, jobs: listFact(jobs.map((j) => j.id)) },
      machine: settings.machine,
      lane,
      jobs: [],
    });
  }

  // Jobs wait and no runner of the lane is alive
  for (const [lane, runners] of s.runners) {
    const queued = s.queued.filter((q) => q.lane === lane);
    if (queued.length === 0 || runners.some((r) => r.alive)) continue;
    const settings = laneOf.get(lane);
    const key = `dead_runner:${lane}`;
    out.set(key, {
      key,
      type: "dead_runner",
      summary: `No runner is alive for lane ${lane} while ${queued.length} gate job(s) wait in it`,
      evidence: [
        `lane ${lane}: ${queued.length} queued request(s)`,
        ...runners.map((r) => `${r.file}: ${r.pid === null ? "missing or no pid" : `pid ${r.pid} is not running`}`),
      ],
      facts: {
        lane,
        machine: settings?.machine ?? null,
        queued_jobs: queued.length,
        pid_files: listFact(runners.map((r) => r.file)),
        pids: listFact(runners.map((r) => (r.pid === null ? "-" : String(r.pid)))),
      },
      machine: settings?.machine ?? null,
      lane,
      jobs: [],
    });
  }
  return out;
}

/**
 * This tick's findings. `held` is since when each condition has held
 * without a break (from the last tick); the result's `held` replaces it.
 */
export function detect(s: Snapshot, held: ReadonlyMap<string, number>): { findings: InfraFinding[]; held: Map<string, number> } {
  const findings = machineDown(s);
  const nextHeld = new Map<string, number>();
  for (const [key, finding] of conditions(s)) {
    const since = held.get(key) ?? s.now;
    nextHeld.set(key, since);
    if (s.now - since >= s.thresholdMs) findings.push(finding);
  }
  return { findings, held: nextHeld };
}
