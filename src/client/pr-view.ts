/**
 * The PRs section (the old PRs and Reviews views): one row per open pull
 * request with its readiness, and a PR's detail from the review module's
 * evaluation. Kept apart from the components so tests check the same rules.
 */
import type { PullRequest } from "../shared/types";
import type { MergeHold, PrReviewStatus, PrSummary, ReviewFinding, SlotStatus, Tier } from "../shared/review-types";
import { readinessOf, type Readiness, type ReadinessCheck } from "./pr-readiness";
import { assignmentLabel, mergeButtonState, type MergeButtonState } from "./review-view";

export interface PrRow {
  number: number;
  title: string;
  branch: string;
  headSha: string;
  updatedAt: string | null;
  tier: Tier | null;
  readiness: Readiness;
  /** The gate result at the head, when the project's gate queue has one (without the review module) */
  gateId: string | null;
}

const MAX_REASON = 300;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

/**
 * A PR's readiness with the review module on: its last evaluation at this
 * head (the list has it), else the one this page asked for, else "checking".
 */
export function summaryReadiness(pr: PrSummary, check?: ReadinessCheck): Readiness {
  const checkedAt = pr.evaluatedAt ? Date.parse(pr.evaluatedAt) : null;
  const asPr = { number: pr.number, headRefOid: pr.headSha } as PullRequest;
  // This page's own evaluation at this head, newer than the list's (after "Re-check all"), wins
  if (check && check.headSha === pr.headSha && (check.status || check.error) && (checkedAt === null || check.checkedAt > checkedAt)) {
    return readinessOf(asPr, true, check);
  }
  if (pr.canMerge === true) return { group: "ready", label: "Merge ready", tier: pr.tier, checkedAt };
  if (pr.canMerge === false) {
    return {
      group: "waiting",
      label: `Waiting: ${oneLine(pr.reasons[0] ?? "the review module does not allow a merge yet")}`,
      tier: pr.tier,
      checkedAt,
    };
  }
  return readinessOf(asPr, true, check);
}

/** The review module's PR list as rows. */
export function reviewRows(prs: readonly PrSummary[], checks: Readonly<Record<number, ReadinessCheck | undefined>>): PrRow[] {
  return prs.map((pr) => {
    const readiness = summaryReadiness(pr, checks[pr.number]);
    return {
      number: pr.number,
      title: pr.title,
      branch: pr.headRef,
      headSha: pr.headSha,
      updatedAt: pr.updatedAt,
      tier: readiness.tier ?? pr.tier,
      readiness,
      gateId: null,
    };
  });
}

/** The git host's PR list (without the review module): only whether the gate passed at the head. */
export function hostRows(prs: readonly PullRequest[]): PrRow[] {
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    headSha: pr.headRefOid,
    updatedAt: pr.updatedAt || null,
    tier: null,
    readiness: readinessOf(pr, false),
    gateId: pr.latestGate?.id ?? null,
  }));
}

/** The PRs of the review list that need an evaluation from this page: not evaluated at their head yet. */
export function unevaluated(prs: readonly PrSummary[]): { number: number; headRefOid: string }[] {
  return prs.filter((pr) => pr.canMerge === null).map((pr) => ({ number: pr.number, headRefOid: pr.headSha }));
}

/**
 * The PRs to evaluate in one pass: with "Re-check all" (`force`), every open
 * one; otherwise those not evaluated at their head yet.
 */
export function prsToEvaluate(prs: readonly PrSummary[], force: boolean): { number: number; headRefOid: string }[] {
  return force ? prs.map((pr) => ({ number: pr.number, headRefOid: pr.headSha })) : unevaluated(prs);
}

/** What "Re-check all" asks before it evaluates every open PR again (each evaluation asks the git host several times). */
export function recheckAllQuestion(count: number): string {
  return `Evaluate all ${count} open pull request${count === 1 ? "" : "s"} again? Each evaluation asks the git host several times; the list shows the new readiness as each one answers.`;
}

export interface SlotView {
  label: string;
  filled: boolean;
  /** Who holds the slot: the reviewer whose review fills it, else the agent assigned to it */
  holder: string | null;
  request: { badge: string; text: string; detail: string } | null;
  detail: string;
}

export interface PrDetailModel {
  tier: Tier;
  rules: PrReviewStatus["risk"]["rules"];
  size: string;
  slots: SlotView[];
  /** Every required review is there */
  reviewsComplete: boolean;
  openFindings: ReviewFinding[];
  blockingFindings: number;
  holds: MergeHold[];
  merge: MergeButtonState;
  author: string;
}

function holderOf(slot: SlotStatus, assigned: string | null): string | null {
  if (slot.satisfiedBy) {
    const r = slot.satisfiedBy.reviewer;
    return `${r.id} (${r.kind}${r.model ? `, ${r.model}` : ""})`;
  }
  return assigned ? `${assigned} (assigned)` : null;
}

/** A PR's detail from the review module's evaluation. */
export function prDetail(status: PrReviewStatus, busy = false): PrDetailModel {
  const slots = status.slots.map((slot, index): SlotView => {
    const assignment = status.assignments?.find((a) => a.slot === index);
    return {
      label: slot.label,
      filled: slot.satisfiedBy !== null,
      holder: holderOf(slot, assignment?.state === "assigned" ? assignment.agent : null),
      request: assignmentLabel(assignment),
      detail: slot.detail,
    };
  });
  const open = status.findings.filter((f) => f.status === "open" && !f.superseded);
  const author = status.author
    ? `${status.author.id} (${status.author.kind}${status.author.model ? `, ${status.author.model}` : ""})`
    : "unknown";
  return {
    tier: status.risk.tier,
    rules: status.risk.rules,
    size: `${status.risk.size.files} file(s), +${status.risk.size.additions} −${status.risk.size.deletions}`,
    slots,
    reviewsComplete: slots.every((s) => s.filled),
    openFindings: open,
    blockingFindings: open.filter((f) => f.blocking).length,
    holds: status.holds.filter((h) => h.releasedAt === null),
    merge: mergeButtonState(status, busy),
    author,
  };
}
