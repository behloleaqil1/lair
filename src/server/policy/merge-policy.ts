/**
 * Merge policy over reviews: a PR may merge only when the required gate
 * passed at its exact head, the required reviews exist at that head with no
 * open blocking findings, the branch is mergeable (and up to date when the
 * policy says so), and no hold applies. Every condition is reported, so a
 * refusal always says which one failed.
 */
import type {
  GateCheck,
  MergeCondition,
  MergeHold,
  ReviewerRef,
  ReviewFinding,
  SlotStatus,
  Verdict,
} from "../../shared/review-types.js";

export interface MergePolicyInput {
  pr: {
    state: "open" | "closed" | "merged";
    draft: boolean;
    headSha: string;
    baseRef: string;
    /** null: the host has not computed it yet */
    mergeable: boolean | null;
    /** Commits on the target branch that the PR lacks; null when unknown */
    behindBy: number | null;
  };
  defaultBranch: string | null;
  requireUpToDate: boolean;
  /** Each required gate's result at the head */
  gate: GateCheck[];
  slots: SlotStatus[];
  /** Each reviewer's latest verdict at the head (checks included) */
  verdictsAtHead: { reviewer: ReviewerRef; verdict: Verdict }[];
  /** Open, blocking findings that no later review replaced */
  openBlocking: ReviewFinding[];
  holds: MergeHold[];
  /** The default branch is red (e.g. its latest gate failed) and the PR is not exempt */
  defaultBranchRed: string | null;
}

export interface MergePolicyResult {
  allowed: boolean;
  conditions: MergeCondition[];
  /** One line per failed condition */
  reasons: string[];
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function location(f: ReviewFinding): string {
  if (!f.file) return "";
  return f.line ? `${f.file}:${f.line} ` : `${f.file} `;
}

export function evaluateMergePolicy(input: MergePolicyInput): MergePolicyResult {
  const { pr } = input;
  const head = short(pr.headSha);
  const conditions: MergeCondition[] = [];

  conditions.push(
    pr.state !== "open"
      ? { id: "open", ok: false, label: "Open", detail: `the PR is ${pr.state}` }
      : pr.draft
        ? { id: "open", ok: false, label: "Open", detail: "the PR is a draft" }
        : { id: "open", ok: true, label: "Open", detail: "open, not a draft" },
  );

  conditions.push(
    input.defaultBranch === null
      ? { id: "target", ok: false, label: "Target branch", detail: "the default branch is unknown (set review.default_branch)" }
      : pr.baseRef !== input.defaultBranch
        ? {
            id: "target",
            ok: false,
            label: "Target branch",
            detail: `targets ${pr.baseRef}, not the default branch ${input.defaultBranch}`,
          }
        : { id: "target", ok: true, label: "Target branch", detail: `targets ${pr.baseRef}` },
  );

  const notPassed = input.gate.filter((g) => g.status !== "passed" || g.sha !== pr.headSha);
  conditions.push(
    input.gate.length === 0
      ? { id: "gate", ok: false, label: "Gate at head", detail: "no required gate is configured" }
      : notPassed.length > 0
        ? {
            id: "gate",
            ok: false,
            label: "Gate at head",
            detail: notPassed
              .map((g) =>
                g.sha !== pr.headSha
                  ? `${g.name}: result is for ${short(g.sha)}, not the head ${head}`
                  : `${g.name}: ${g.status} at ${head}${g.detail ? ` (${g.detail})` : ""}`,
              )
              .join("; "),
          }
        : {
            id: "gate",
            ok: true,
            label: "Gate at head",
            detail: `${input.gate.map((g) => g.name).join(", ")} passed at ${head}`,
          },
  );

  const missing = input.slots.filter((s) => s.satisfiedBy === null);
  conditions.push(
    missing.length > 0
      ? {
          id: "reviews",
          ok: false,
          label: "Required reviews",
          detail: `${input.slots.length - missing.length}/${input.slots.length} at ${head}; missing: ${missing
            .map((s) => s.detail)
            .join("; ")}`,
        }
      : {
          id: "reviews",
          ok: true,
          label: "Required reviews",
          detail:
            input.slots.length === 0
              ? "none required for this tier"
              : input.slots.map((s) => `${s.label}: ${s.satisfiedBy!.reviewer.id}`).join("; "),
        },
  );

  const objections = input.verdictsAtHead.filter((v) => v.verdict === "request_changes");
  conditions.push(
    objections.length > 0
      ? {
          id: "changes_requested",
          ok: false,
          label: "No changes requested",
          detail: `changes requested at ${head} by ${objections.map((v) => v.reviewer.id).join(", ")}`,
        }
      : { id: "changes_requested", ok: true, label: "No changes requested", detail: "no reviewer requested changes at the head" },
  );

  conditions.push(
    input.openBlocking.length > 0
      ? {
          id: "findings",
          ok: false,
          label: "No open blocking findings",
          detail: `${input.openBlocking.length} open: ${input.openBlocking
            .slice(0, 3)
            .map((f) => `${location(f)}${f.text} (${f.reviewer.id})`)
            .join("; ")}${input.openBlocking.length > 3 ? "; ..." : ""}`,
        }
      : { id: "findings", ok: true, label: "No open blocking findings", detail: "none open" },
  );

  conditions.push(
    pr.mergeable === true
      ? { id: "mergeable", ok: true, label: "Mergeable", detail: "no conflicts with the target branch" }
      : {
          id: "mergeable",
          ok: false,
          label: "Mergeable",
          detail:
            pr.mergeable === false
              ? "conflicts with the target branch"
              : "the host has not computed mergeability yet; refresh in a moment",
        },
  );

  conditions.push(
    !input.requireUpToDate
      ? { id: "up_to_date", ok: true, label: "Up to date", detail: "not required (review.merge.require_up_to_date: false)" }
      : pr.behindBy === 0
        ? { id: "up_to_date", ok: true, label: "Up to date", detail: "contains the target branch's tip" }
        : {
            id: "up_to_date",
            ok: false,
            label: "Up to date",
            detail:
              pr.behindBy === null
                ? "could not compare with the target branch"
                : `${pr.behindBy} commit(s) behind the target branch: update the branch`,
          },
  );

  const holdReasons = input.holds.map((h) => `${h.reason} (hold ${h.id} by ${h.createdBy})`);
  if (input.defaultBranchRed) holdReasons.unshift(input.defaultBranchRed);
  conditions.push(
    holdReasons.length > 0
      ? { id: "holds", ok: false, label: "No hold", detail: holdReasons.join("; ") }
      : { id: "holds", ok: true, label: "No hold", detail: "no hold applies" },
  );

  const failed = conditions.filter((c) => !c.ok);
  return {
    allowed: failed.length === 0,
    conditions,
    reasons: failed.map((c) => `${c.label}: ${c.detail}`),
  };
}
