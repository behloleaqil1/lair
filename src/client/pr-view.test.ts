/**
 * The PRs section (pr-view.ts), from the shapes GET /api/review/prs,
 * /api/review/prs/:n and /api/prs return.
 */
import { describe, expect, it } from "vitest";
import type { PullRequest } from "../shared/types";
import type { PrReviewStatus, PrSummary } from "../shared/review-types";
import { hostRows, prDetail, reviewRows, summaryReadiness, unevaluated } from "./pr-view";

const HEAD = "a".repeat(40);

const summary = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 7,
  title: "Add login",
  headSha: HEAD,
  headRef: "feat/login",
  baseRef: "main",
  draft: false,
  updatedAt: "2026-10-27T10:00:00Z",
  tier: "amber",
  canMerge: null,
  reasons: [],
  evaluatedAt: null,
  ...over,
});

function status(over: Partial<PrReviewStatus> = {}): PrReviewStatus {
  return {
    project: "demo",
    number: 7,
    title: "Add login",
    url: null,
    state: "open",
    draft: false,
    headSha: HEAD,
    headRef: "feat/login",
    baseRef: "main",
    defaultBranch: "main",
    author: { id: "kiro-A", kind: "agent", model: "opus" },
    authorSource: "branch",
    hostUser: null,
    labels: [],
    risk: { tier: "red", defaultTier: "amber", rules: [], files: [], size: { files: 3, additions: 40, deletions: 2 }, labels: [] },
    slots: [
      {
        slot: { anyOf: [{ kind: "human" }], differentModel: false },
        label: "a human",
        satisfiedBy: { reviewId: "r1", reviewer: { id: "owner", kind: "human" } },
        detail: "approved at the head",
      },
      { slot: { anyOf: [{ kind: "peer" }], differentModel: true }, label: "a peer on another model", satisfiedBy: null, detail: "missing" },
    ],
    assignments: [
      {
        slot: 1,
        state: "assigned",
        channel: "agents",
        agent: "codex-B",
        runId: "9f9f9f9f-0000",
        attempts: 1,
        maxAttempts: 3,
        detail: "reviewing",
        notBefore: null,
        updatedAt: "2026-10-27T10:00:00Z",
      },
    ],
    reviews: [],
    findings: [
      {
        id: "f1",
        reviewId: "r1",
        pr: 7,
        headSha: HEAD,
        reviewer: { id: "owner", kind: "human" },
        severity: "high",
        file: "src/a.ts",
        line: 3,
        text: "unchecked input",
        blocking: true,
        rule: null,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
        resolvedClient: null,
        superseded: false,
      },
    ],
    gate: [],
    holds: [
      { id: "h1", project: "demo", pr: 7, reason: "release freeze", createdBy: "ops", createdAt: "x", releasedAt: null, releasedBy: null },
      { id: "h2", project: "demo", pr: 7, reason: "old", createdBy: "ops", createdAt: "x", releasedAt: "y", releasedBy: "owner" },
    ],
    conditions: [],
    canMerge: false,
    reasons: ["a required review is missing"],
    autoMergeStatus: "auto",
    plan: { method: "host", strategy: "squash", refusal: null, reason: "default", warnings: [] },
    readOnly: false,
    evaluatedAt: "2026-10-27T10:00:00Z",
    ...over,
  };
}

describe("PR rows", () => {
  it("takes the review module's last evaluation at the head when it has one", () => {
    expect(summaryReadiness(summary({ canMerge: true, evaluatedAt: "2026-10-27T10:00:00Z" }))).toMatchObject({
      group: "ready",
      label: "Merge ready",
      tier: "amber",
    });
    expect(summaryReadiness(summary({ canMerge: false, reasons: ["gate pending at the head"] })).label).toBe("Waiting: gate pending at the head");
    expect(summaryReadiness(summary()).label).toBe("Waiting: checking with the review module");
  });

  it("uses this page's own evaluation for a PR not evaluated at its head yet", () => {
    const check = { headSha: HEAD, checkedAt: 1, status: status({ canMerge: true }), error: null };
    const [row] = reviewRows([summary()], { 7: check });
    expect(row.readiness).toMatchObject({ group: "ready", label: "Merge ready", tier: "red" });
    expect(unevaluated([summary(), summary({ number: 8, canMerge: true })])).toEqual([{ number: 7, headRefOid: HEAD }]);
  });

  it("without the review module, only says whether the gate passed at the head", () => {
    const pr: PullRequest = {
      number: 9,
      title: "Docs",
      headRefName: "docs",
      headRefOid: HEAD,
      mergeable: "MERGEABLE",
      updatedAt: "2026-10-27T09:00:00Z",
      latestGate: { id: "g-1", lane: "heavy", priority: 0, status: "completed" },
      mergeReady: true,
    };
    expect(hostRows([pr])[0]).toMatchObject({ number: 9, branch: "docs", gateId: "g-1", tier: null, readiness: { label: "Gate passed" } });
    expect(hostRows([{ ...pr, latestGate: undefined, mergeReady: false }])[0].readiness.label).toBe("No gate");
  });
});

describe("PR detail", () => {
  it("says who holds each required review, the open findings, live holds and why it can't merge", () => {
    const d = prDetail(status());
    expect(d.tier).toBe("red");
    expect(d.slots.map((s) => [s.label, s.filled, s.holder])).toEqual([
      ["a human", true, "owner (human)"],
      ["a peer on another model", false, "codex-B (assigned)"],
    ]);
    expect(d.slots[1].request?.text).toBe("assigned to codex-B (run 9f9f9f9f, attempt 1 of 3)");
    expect(d.reviewsComplete).toBe(false);
    expect(d.blockingFindings).toBe(1);
    expect(d.holds.map((h) => h.id)).toEqual(["h1"]);
    expect(d.merge).toMatchObject({ enabled: false, reasons: ["a required review is missing"] });
    expect(d.author).toBe("kiro-A (agent, opus)");
    expect(d.size).toBe("3 file(s), +40 −2");
  });

  it("enables the merge only when the policy allows it at this head", () => {
    expect(prDetail(status({ canMerge: true, reasons: [] })).merge).toMatchObject({ enabled: true, label: "Merge aaaaaaa (on the host, squash)" });
    expect(prDetail(status({ canMerge: true, reasons: [] }), true).merge.enabled).toBe(false);
  });
});
