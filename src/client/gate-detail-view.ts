/**
 * What the Gates section shows of one gate (GET /api/dashboard/gates/:id)
 * and its owner-only output, and the failures Home lists. Kept apart from
 * the components so tests check the same rules.
 */
import type { Gate, GateResult } from "../shared/types";
import type { GateDetailView, GateOutputView, GateStepState } from "../shared/dashboard-types";
import type { TriageClass } from "../shared/triage-types";
import { durationText, secondsBetween } from "./time";
import { adviceText, eta } from "./placement-view";

export const STEP_BADGE: Record<GateStepState, string> = {
  passed: "badge-success",
  failed: "badge-error",
  timed_out: "badge-error",
  running: "badge-warning",
  skipped: "badge-neutral",
  pending: "badge-neutral",
};

export const CLASS_BADGE: Record<TriageClass, string> = {
  code: "badge-error",
  infra: "badge-warning",
  flaky: "badge-neutral",
  "pre-existing": "badge-neutral",
};

/** The badge for a gate's status: passed, failed, running, queued, or a request suffix. */
export function gateBadge(status: string): string {
  switch (status) {
    case "passed":
      return "badge-success";
    case "failed":
    case "error":
    case "stuck":
      return "badge-error";
    case "running":
      return "badge-warning";
    default:
      return "badge-neutral";
  }
}

/** The detail's facts, label and value, in the order the panel shows them (empty ones left out). */
export function gateFacts(gate: GateDetailView): [string, string][] {
  const sha = gate.sha ? `${gate.sha.slice(0, 12)}${gate.base ? ` (base ${gate.base.slice(0, 12)})` : ""}` : null;
  const ran = secondsBetween(gate.startedAt, gate.finishedAt);
  const facts: [string, string | null][] = [
    ["Source", gate.source === "pipeline" ? "Lair pipeline" : gate.source === "triage" ? "a result triage received" : "the project's gate queue"],
    ["Pipeline", gate.pipeline],
    ["Track", gate.track],
    ["Branch", gate.branch],
    ["Commit", sha],
    ["Lane", gate.lane],
    ["Priority", gate.priority === null ? null : String(gate.priority)],
    ["Machine", gate.machine],
    ["Exit code", gate.rc === null ? null : String(gate.rc)],
    ["Duration", ran === null ? null : durationText(ran)],
  ];
  return facts.filter((f): f is [string, string] => f[1] !== null && f[1] !== "");
}

/** Placement's word on the gate: its advice or why it stays, and when it is expected to start and finish. */
export function placementLine(gate: GateDetailView, now: number = Date.now()): string | null {
  const p = gate.placement;
  if (!p || !p.job) return null;
  const parts = [adviceText(p.job, p.mode)];
  if (p.job.expectedStart) parts.push(`starts ${eta(p.job.expectedStart, now)}`);
  if (p.job.expectedFinish) parts.push(`finishes ${eta(p.job.expectedFinish, now)}`);
  return parts.filter((s) => s && s !== "-").join(" · ") || null;
}

/** "3 of 120 failing tests", "2 failing tests (from triage)" */
export function testsHeading(out: GateOutputView): string {
  const from = out.testsFrom === "triage" ? "as triage read them" : out.testsFrom === "log" ? "from the log's test output" : "";
  const count = `${out.tests.length}${out.testsTruncated ? "+" : ""} failing test${out.tests.length === 1 ? "" : "s"}`;
  return from ? `${count}, ${from}` : count;
}

/** The track a gate id names (<UTC stamp>-<track>-<sha>-<n>), else the id. */
export function trackOf(id: string): string {
  const m = /^\d{8}T\d{6}Z-([a-zA-Z0-9-]+)-[a-f0-9]+-\d+$/.exec(id);
  return m ? m[1] : id;
}

export interface FailedGate {
  id: string;
  track: string;
  finishedAt: string | undefined;
  failedSteps: string[];
}

/**
 * The gates that need a look: per track, the newest result, when it failed
 * and no run of that track is in the queue now (a re-run is on its way).
 */
export function latestFailures(results: readonly GateResult[], queue: readonly Gate[]): FailedGate[] {
  const rerunning = new Set(queue.filter((g) => g.status === "queued" || g.status === "running").map((g) => g.track ?? trackOf(g.id)));
  const newest = new Map<string, GateResult>();
  for (const result of results) {
    const track = trackOf(result.id);
    const known = newest.get(track);
    if (!known || (result.finishedAt ?? "") > (known.finishedAt ?? "")) newest.set(track, result);
  }
  return [...newest.entries()]
    .filter(([track, r]) => r.rc !== 0 && !rerunning.has(track))
    .map(([track, r]) => ({ id: r.id, track, finishedAt: r.finishedAt, failedSteps: r.failedSteps ?? [] }))
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
}

/** The owner-only output's URL (lines bounded by the server). */
export function outputEndpoint(id: string, lines = 200): string {
  return `/dashboard/gates/${encodeURIComponent(id)}/output?lines=${lines}`;
}
