/**
 * The PRs view's readiness: from the review module's evaluation when it is
 * on, from the gate alone (and labelled so) when it is off.
 */
import { describe, expect, it } from "vitest";
import type { PullRequest } from "../shared/types";
import type { PrReviewStatus } from "../shared/review-types";
import {
  MAX_CHECKS_PER_PASS,
  READINESS_MAX_AGE_MS,
  needsCheck,
  prsToCheck,
  readinessOf,
  readyGroupTitle,
  type ReadinessCheck,
} from "./pr-readiness";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEW_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = Date.parse("2026-03-02T12:00:00.000Z");

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "Double numbers",
    headRefName: "agent/worker-a/double",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    updatedAt: "2026-03-02T11:00:00.000Z",
    // A gate passed at the head: what the view used to call "Merge Ready" on its own
    latestGate: { id: "20260302T110000Z-double-01234567-1", lane: "heavy", priority: 0, status: "completed" },
    mergeReady: true,
    ...overrides,
  };
}

function status(overrides: Partial<PrReviewStatus> = {}): PrReviewStatus {
  return {
    project: "demo",
    number: 7,
    title: "Double numbers",
    url: null,
    state: "open",
    draft: false,
    headSha: HEAD,
    headRef: "agent/worker-a/double",
    baseRef: "main",
    defaultBranch: "main",
    author: { id: "worker-a", kind: "agent" },
    authorSource: "branch",
    hostUser: "example-bot",
    labels: [],
    risk: { tier: "red", defaultTier: "amber", rules: [], files: [], size: { files: 1, additions: 1, deletions: 0 }, labels: [] },
    slots: [],
    reviews: [],
    findings: [],
    gate: [],
    holds: [],
    conditions: [],
    canMerge: true,
    reasons: [],
    autoMergeStatus: "auto",
    plan: { method: "local", strategy: "ff-only", reason: "local by default", warnings: [], refusal: null },
    readOnly: false,
    evaluatedAt: "2026-03-02T12:00:00.000Z",
    ...overrides,
  };
}

const checked = (s: PrReviewStatus | null, extra: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  headSha: HEAD,
  checkedAt: NOW,
  status: s,
  error: null,
  ...extra,
});

describe("PR readiness with the review module on", () => {
  it("is Merge ready only when the review module's evaluation at the head allows the merge", () => {
    expect(readyGroupTitle(true)).toBe("Merge ready");
    expect(readinessOf(pr(), true, checked(status()))).toEqual({
      group: "ready",
      label: "Merge ready",
      tier: "red",
      checkedAt: NOW,
    });
  });

  it("waits with the review module's first reason when it does not allow the merge, even with a passed gate", () => {
    const rejected = status({
      canMerge: false,
      reasons: ["Changes requested at the head by worker-b", "Open blocking findings: 1"],
    });
    expect(readinessOf(pr({ mergeReady: true }), true, checked(rejected))).toEqual({
      group: "waiting",
      label: "Waiting: Changes requested at the head by worker-b",
      tier: "red",
      checkedAt: NOW,
    });
    // Refused without a reason: still waiting, never ready
    expect(readinessOf(pr(), true, checked(status({ canMerge: false, reasons: [] })))).toMatchObject({
      group: "waiting",
      label: "Waiting: the review module does not allow a merge yet",
    });
    // A reason is one bounded line
    const long = readinessOf(pr(), true, checked(status({ canMerge: false, reasons: [`a\n${"x".repeat(1000)}`] })));
    expect(long.label.length).toBeLessThanOrEqual("Waiting: ".length + 300);
    expect(long.label).not.toContain("\n");
  });

  it("waits until the review module has answered for this head, and shows a failed evaluation", () => {
    expect(readinessOf(pr(), true, undefined)).toMatchObject({
      group: "waiting",
      label: "Waiting: checking with the review module",
      checkedAt: null,
    });
    // A push since the evaluation: its answer was about another commit
    expect(readinessOf(pr({ headRefOid: NEW_HEAD }), true, checked(status()))).toMatchObject({
      group: "waiting",
      label: "Waiting: checking with the review module",
    });
    // The review module evaluated a different head than the PR list shows
    expect(readinessOf(pr(), true, checked(status({ headSha: NEW_HEAD })))).toMatchObject({
      group: "waiting",
      label: "Waiting: the review module evaluated fedcba9, not the head 0123456; checking again",
    });
    expect(readinessOf(pr(), true, checked(null, { error: "PR #7 not found" }))).toEqual({
      group: "waiting",
      label: "Waiting: PR #7 not found",
      tier: null,
      checkedAt: NOW,
    });
  });
});

describe("PR readiness without the review module", () => {
  it("calls a passed gate 'Gate passed', never merge ready, since nothing checked reviews", () => {
    expect(readyGroupTitle(false)).toBe("Gate passed");
    expect(readinessOf(pr({ mergeReady: true }), false)).toEqual({
      group: "ready",
      label: "Gate passed",
      tier: null,
      checkedAt: null,
    });
    expect(readinessOf(pr({ mergeReady: false }), false)).toMatchObject({ group: "waiting", label: "Gate not passed" });
    expect(readinessOf(pr({ mergeReady: false, latestGate: undefined }), false)).toMatchObject({
      group: "waiting",
      label: "No gate",
    });
    // An evaluation lying around (from before review.enabled was turned off) is not used
    expect(readinessOf(pr({ mergeReady: false }), false, checked(status()))).toMatchObject({ group: "waiting" });
  });
});

describe("when the PRs view asks the review module", () => {
  it("asks for a PR new to the view, after a push, and once its evaluation is older than the limit", () => {
    expect(needsCheck(pr(), undefined, NOW)).toBe(true);
    const fresh = checked(status(), { checkedAt: NOW });
    expect(needsCheck(pr(), fresh, NOW + 10_000)).toBe(false);
    expect(needsCheck(pr(), fresh, NOW + READINESS_MAX_AGE_MS - 1)).toBe(false);
    expect(needsCheck(pr(), fresh, NOW + READINESS_MAX_AGE_MS)).toBe(true);
    expect(needsCheck(pr({ headRefOid: NEW_HEAD }), fresh, NOW + 10_000)).toBe(true);
    // A failed evaluation is retried on the same schedule
    expect(needsCheck(pr(), checked(null, { error: "timeout" }), NOW + 10_000)).toBe(false);
  });

  it("skips PRs being asked about, asks for all on Re-check, and asks for a bounded number per pass", () => {
    const prs = [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3, headRefOid: NEW_HEAD })];
    const checks = { 1: checked(status()), 3: checked(status()) };
    // 1 is fresh, 2 was never asked, 3 was pushed since
    expect(prsToCheck(prs, checks, NOW + 1000).map((p) => p.number)).toEqual([2, 3]);
    expect(prsToCheck(prs, checks, NOW + 1000, { inFlight: new Set([2]) }).map((p) => p.number)).toEqual([3]);
    expect(prsToCheck(prs, checks, NOW + 1000, { force: true }).map((p) => p.number)).toEqual([1, 2, 3]);
    const many = Array.from({ length: MAX_CHECKS_PER_PASS + 5 }, (_, i) => pr({ number: i + 1 }));
    expect(prsToCheck(many, {}, NOW)).toHaveLength(MAX_CHECKS_PER_PASS);
  });
});
