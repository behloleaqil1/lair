/**
 * Merge readiness for the PRs view, kept out of the component so it can be
 * tested without a DOM.
 *
 * With the review module on for the project (`review.enabled`), a PR is
 * "Merge ready" only when the review module's own evaluation of that PR at
 * its current head allows a merge (`canMerge`: tier, required vs present
 * reviews, open blocking findings, the gate at the head, holds). Any other
 * PR waits, with the first reason the review module gives.
 *
 * Without the review module nothing checks reviews, so the view only says
 * which PRs have a passed gate ("Gate passed"), never that they are ready.
 *
 * Evaluating a PR calls the git host several times (as in the Reviews view),
 * so a PR is evaluated when it is new to the view, when its head changes,
 * when its evaluation is older than READINESS_MAX_AGE_MS, or on request, not
 * on the dashboard's 10 s timer.
 */
import type { PullRequest } from "../shared/types";
import type { PrReviewStatus, Tier } from "../shared/review-types";

/** Re-evaluate a PR whose last evaluation is older than this */
export const READINESS_MAX_AGE_MS = 5 * 60_000;
/** At most this many PRs are evaluated in one pass */
export const MAX_CHECKS_PER_PASS = 20;
/** Reasons are shown on one line */
const MAX_REASON_CHARS = 300;

/** A PR's evaluation by the review module, as the view last fetched it. */
export interface ReadinessCheck {
  /** The PR head (from the PR list) the evaluation was asked for */
  headSha: string;
  /** When it was fetched (ms since the epoch) */
  checkedAt: number;
  status: PrReviewStatus | null;
  /** Why the evaluation failed, when it did */
  error: string | null;
}

export interface Readiness {
  group: "ready" | "waiting";
  /** "Merge ready", "Gate passed", or "Waiting: <reason>" (review module) / the gate state (without it) */
  label: string;
  /** The review module's risk tier, when it evaluated this head */
  tier: Tier | null;
  /** When the evaluation shown was fetched */
  checkedAt: number | null;
}

/** The title of the ready group. */
export function readyGroupTitle(reviewEnabled: boolean): string {
  return reviewEnabled ? "Merge ready" : "Gate passed";
}

/** Should the view ask the review module about this PR now? */
export function needsCheck(
  pr: Pick<PullRequest, "headRefOid">,
  check: ReadinessCheck | undefined,
  now: number,
  maxAgeMs: number = READINESS_MAX_AGE_MS,
): boolean {
  if (!check) return true;
  if (check.headSha !== pr.headRefOid) return true;
  return now - check.checkedAt >= maxAgeMs;
}

/** The PRs to evaluate in this pass: all of them when `force`, else those that need it; at most `limit`. */
export function prsToCheck<T extends Pick<PullRequest, "number" | "headRefOid">>(
  prs: readonly T[],
  checks: Readonly<Record<number, ReadinessCheck | undefined>>,
  now: number,
  options: { force?: boolean; inFlight?: ReadonlySet<number>; limit?: number } = {},
): T[] {
  const limit = options.limit ?? MAX_CHECKS_PER_PASS;
  return prs
    .filter((pr) => !options.inFlight?.has(pr.number))
    .filter((pr) => options.force === true || needsCheck(pr, checks[pr.number], now))
    .slice(0, Math.max(0, limit));
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
}

function waiting(reason: string, tier: Tier | null = null, checkedAt: number | null = null): Readiness {
  return { group: "waiting", label: `Waiting: ${oneLine(reason)}`, tier, checkedAt };
}

/** Where a PR goes in the view, and what it says. */
export function readinessOf(pr: PullRequest, reviewEnabled: boolean, check?: ReadinessCheck): Readiness {
  if (!reviewEnabled) {
    if (pr.mergeReady) return { group: "ready", label: "Gate passed", tier: null, checkedAt: null };
    return { group: "waiting", label: pr.latestGate ? "Gate not passed" : "No gate", tier: null, checkedAt: null };
  }
  // Nothing asked yet, or asked for an older head: the answer we have is not about this commit
  if (!check || check.headSha !== pr.headRefOid) return waiting("checking with the review module");
  if (check.error !== null) return waiting(check.error, null, check.checkedAt);
  const status = check.status;
  if (!status) return waiting("checking with the review module");
  if (status.headSha !== pr.headRefOid) {
    return waiting(
      `the review module evaluated ${status.headSha.slice(0, 7)}, not the head ${pr.headRefOid.slice(0, 7)}; checking again`,
      null,
      check.checkedAt,
    );
  }
  const tier = status.risk.tier;
  if (status.canMerge === true) return { group: "ready", label: "Merge ready", tier, checkedAt: check.checkedAt };
  return waiting(status.reasons[0] ?? "the review module does not allow a merge yet", tier, check.checkedAt);
}
