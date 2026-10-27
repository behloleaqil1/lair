/**
 * What the Gates view shows, apart from the component so tests check the
 * same rules: the lanes come from the queue (any lane a request file names),
 * and the recent results are those of the last 24 hours, newest first.
 */
import type { Gate, GateResult } from "../shared/types";
import { laneNames } from "../shared/gate-lanes";

export const RESULT_WINDOW_HOURS = 24;

/** The queue's lanes: heavy, light and remote first, then the others (quick, actions, ...) by name. */
export function queueLanes(queue: readonly Gate[]): string[] {
  return laneNames(queue);
}

/** A lane's requests: running first, then queued, then any other status; each by priority. */
export function laneGates(queue: readonly Gate[], lane: string): Gate[] {
  const rank = (g: Gate) => (g.status === "running" ? 0 : g.status === "queued" ? 1 : 2);
  return queue.filter((g) => g.lane === lane).sort((a, b) => rank(a) - rank(b) || a.priority - b.priority);
}

/** The badge for a request's status: running, queued, or another suffix (superseded, stuck, ...). */
export function statusBadge(status: string): string {
  if (status === "running") return "badge-success";
  if (status === "queued") return "badge-neutral";
  if (status === "superseded") return "badge-neutral";
  return "badge-warning";
}

/**
 * Results finished within the last `hours` (default 24) at `now`, newest
 * first. A result without a finish time is not recent: it can't be placed.
 */
export function recentResults(
  results: readonly GateResult[],
  now: number = Date.now(),
  hours: number = RESULT_WINDOW_HOURS,
): GateResult[] {
  const cutoff = now - hours * 60 * 60 * 1000;
  const timed = results
    .map((result) => ({ result, at: result.finishedAt ? Date.parse(result.finishedAt) : NaN }))
    .filter(({ at }) => Number.isFinite(at) && at >= cutoff);
  timed.sort((a, b) => b.at - a.at || (a.result.id < b.result.id ? 1 : a.result.id > b.result.id ? -1 : 0));
  return timed.map(({ result }) => result);
}

/** "5 min ago", "3 h ago" for a finish time. */
export function ago(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "-";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}
