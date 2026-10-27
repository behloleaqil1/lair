/**
 * What the Gates and Machines views show of placement
 * (/api/placement/status), apart from the components so tests check the
 * same rules.
 */
import type {
  PlacementJob,
  PlacementLane,
  PlacementMachine,
  PlacementMove,
  PlacementStatus,
} from "../shared/placement-types";

/** The placement view of each job, by gate id. */
export function jobsById(status: PlacementStatus | null | undefined): Map<string, PlacementJob> {
  return new Map((status?.jobs ?? []).map((job) => [job.id, job] as const));
}

/** "34 min", "2 h 5 min", "<1 min" */
export function span(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 1) return "<1 min";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** An expected time: "in 12 min", "now" (due), or "-" when unknown. */
export function eta(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "-";
  const seconds = (at - now) / 1000;
  if (seconds < 60) return "now";
  return `in ${span(seconds)}`;
}

/**
 * A queued job's placement column: the advice ("would move to remote: −34
 * min", "moving to remote: −34 min" in act mode), else why it stays, else "-".
 */
export function adviceText(job: PlacementJob | undefined, mode: PlacementStatus["mode"]): string {
  if (!job) return "-";
  if (job.advice) {
    const verb = mode === "act" ? "moving to" : "would move to";
    const quiet = job.advice.quiet ? " (quiet re-check)" : "";
    // A quiet re-check may finish later on the quieter machine: "+12 min"
    const sign = job.advice.gainSeconds >= 0 ? "−" : "+";
    return `${verb} ${job.advice.to}: ${sign}${span(job.advice.gainSeconds)}${quiet}`;
  }
  return job.held ?? "-";
}

function clock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString() : "?";
}

/** "up since 10:02", "down since 09:58", "starting (passing since 10:01)", "not probed yet" */
export function machineState(m: PlacementMachine): string {
  switch (m.state) {
    case "up":
      return `up since ${clock(m.upSince)}`;
    case "down":
      return `down since ${clock(m.downSince)}`;
    case "starting":
      return `starting (passing since ${clock(m.passingSince)})`;
    default:
      return "not probed yet";
  }
}

export function machineBadge(m: PlacementMachine): string {
  if (m.state === "up") return "badge-success";
  if (m.state === "down") return "badge-error";
  return "badge-warning";
}

/** "3.1 on 10 cpus (3.1×)", "-" without load_cmd */
export function machineLoad(m: PlacementMachine): string {
  if (m.load === null) return "-";
  const cpus = m.cpus !== null ? ` on ${m.cpus} cpus` : "";
  const factor = m.factor > 1 ? ` (${m.factor.toFixed(1)}×)` : "";
  return `${m.load.toFixed(2)}${cpus}${factor}`;
}

/** "1/2 in use, 3 queued; big 1/1" */
export function laneSlots(lane: PlacementLane): string {
  const limits = lane.limits.map((l) => `${l.class} ${l.inUse}/${l.limit}`).join(", ");
  const base = `${lane.inUse}/${lane.slots} in use, ${lane.queued} queued`;
  return limits ? `${base}; ${limits}` : base;
}

/** The latest moves, newest first, at most `limit`. */
export function latestMoves(status: PlacementStatus | null | undefined, limit = 10): PlacementMove[] {
  return [...(status?.moves ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

export function moveBadge(move: PlacementMove): string {
  if (move.status === "moved") return "badge-success";
  if (move.status === "failed" || move.status === "interrupted") return "badge-error";
  if (move.status === "would_move") return "badge-neutral";
  return "badge-warning";
}

/** "observe (would move)", "act", or why act mode is off */
export function modeText(status: PlacementStatus): string {
  if (!status.enabled) return "off";
  if (status.mode === "act" && status.actBlocked === null) return "act: moves jobs";
  return `observe: advice only${status.actBlocked && status.mode === "act" ? ` (${status.actBlocked})` : ""}`;
}
