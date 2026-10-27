/**
 * View logic for the Reviews view, kept out of the component so it can be
 * tested without a DOM.
 */
import type {
  FindingSeverity,
  GateStatus,
  PrReviewStatus,
  ReviewFinding,
  SlotAssignmentState,
  SlotAssignmentView,
  Tier,
} from "../shared/review-types";

export const ASSIGNMENT_BADGE: Record<SlotAssignmentState, string> = {
  requested: "badge-neutral",
  assigned: "badge-warning",
  reviewed: "badge-success",
  failed: "badge-error",
  stale: "badge-neutral",
};

/**
 * A slot's request at the head, in a few words: "requested", "assigned to
 * <agent>", "reviewed by <agent>", "failed" or "stale", with the attempt and
 * the run when an agent's run took it; null when it wasn't asked for.
 */
export function assignmentLabel(a: SlotAssignmentView | undefined): { badge: string; text: string; detail: string } | null {
  if (!a) return null;
  const attempt = a.maxAttempts && a.attempts > 0 ? `, attempt ${a.attempts} of ${a.maxAttempts}` : "";
  const run = a.runId ? `run ${a.runId.slice(0, 8)}` : "";
  let text: string;
  switch (a.state) {
    case "assigned":
      text = `assigned to ${a.agent ?? "an agent"}${run ? ` (${run}${attempt})` : attempt ? ` (${attempt.slice(2)})` : ""}`;
      break;
    case "reviewed":
      text = a.agent ? `reviewed by ${a.agent}` : "reviewed";
      break;
    case "requested":
      text = a.notBefore && a.attempts > 0 ? `requested: retry at ${a.notBefore.slice(11, 16)} UTC` : "requested";
      break;
    default:
      text = a.state;
  }
  return { badge: ASSIGNMENT_BADGE[a.state], text, detail: a.detail };
}

export interface MergeButtonState {
  enabled: boolean;
  label: string;
  /** Why it is disabled: one line per failed condition */
  reasons: string[];
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function mergeButtonState(status: PrReviewStatus | null, busy: boolean): MergeButtonState {
  if (!status) return { enabled: false, label: "Merge", reasons: ["Select a PR"] };
  const how =
    status.plan.method === "local" ? `locally, ${status.plan.strategy}` : `on the host, ${status.plan.strategy}`;
  if (busy) return { enabled: false, label: "Merging...", reasons: [] };
  const label = `Merge ${shortSha(status.headSha)} (${how})`;
  if (status.canMerge) return { enabled: true, label, reasons: [] };
  return {
    enabled: false,
    label,
    reasons: status.reasons.length > 0 ? status.reasons : ["The policy does not allow this merge"],
  };
}

export function findingLocation(f: Pick<ReviewFinding, "file" | "line">): string {
  if (!f.file) return "—";
  return f.line ? `${f.file}:${f.line}` : f.file;
}

export interface DraftFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  text: string;
  blocking: boolean;
}

/**
 * Findings typed into the review form, one per line: `path:line: text`,
 * `path: text`, or just `text`. A path needs a "/" or "." so "Note: ..." stays
 * text. They block when the verdict is request_changes.
 */
export function parseFindingLines(input: string, blocking: boolean): DraftFinding[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): DraftFinding => {
      const located = /^([^\s:]*[./][^\s:]*)(?::(\d+))?:\s+(.+)$/.exec(line);
      if (located) {
        return {
          severity: blocking ? "high" : "low",
          file: located[1],
          line: located[2] ? Number(located[2]) : null,
          text: located[3],
          blocking,
        };
      }
      return { severity: blocking ? "high" : "low", file: null, line: null, text: line, blocking };
    });
}

export const TIER_BADGE: Record<Tier, string> = {
  red: "badge-error",
  amber: "badge-warning",
  green: "badge-success",
};

export const GATE_BADGE: Record<GateStatus, string> = {
  passed: "badge-success",
  failed: "badge-error",
  pending: "badge-warning",
  missing: "badge-neutral",
};
