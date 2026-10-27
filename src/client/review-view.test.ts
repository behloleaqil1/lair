import { describe, expect, it } from "vitest";
import type { PrReviewStatus, SlotAssignmentView } from "../shared/review-types";
import { assignmentLabel, findingLocation, mergeButtonState, parseFindingLines } from "./review-view";

describe("assignmentLabel", () => {
  const base: SlotAssignmentView = {
    slot: 0,
    state: "requested",
    channel: "agents",
    agent: null,
    runId: null,
    attempts: 0,
    maxAttempts: 3,
    detail: "waiting for a free reviewer (rev-b: busy)",
    notBefore: "2026-03-02T12:05:00.000Z",
    updatedAt: "2026-03-02T12:00:00.000Z",
  };

  it("names each step: requested, assigned to the agent, reviewed, failed", () => {
    expect(assignmentLabel(undefined)).toBeNull();
    expect(assignmentLabel(base)).toEqual({ badge: "badge-neutral", text: "requested", detail: base.detail });
    expect(assignmentLabel({ ...base, attempts: 1, detail: "retry" })?.text).toBe("requested: retry at 12:05 UTC");
    expect(
      assignmentLabel({ ...base, state: "assigned", agent: "rev-b", runId: "0123456789abcdef", attempts: 2 }),
    ).toMatchObject({ badge: "badge-warning", text: "assigned to rev-b (run 01234567, attempt 2 of 3)" });
    expect(assignmentLabel({ ...base, state: "reviewed", agent: "rev-b" })).toMatchObject({
      badge: "badge-success",
      text: "reviewed by rev-b",
    });
    expect(assignmentLabel({ ...base, state: "failed", detail: "no review after 3 run(s)" })).toEqual({
      badge: "badge-error",
      text: "failed",
      detail: "no review after 3 run(s)",
    });
  });
});

function status(overrides: Partial<PrReviewStatus>): PrReviewStatus {
  return {
    project: "demo",
    number: 7,
    title: "Double numbers",
    url: null,
    state: "open",
    draft: false,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    headRef: "agent/worker-a/double",
    baseRef: "main",
    defaultBranch: "main",
    author: { id: "worker-a", kind: "agent" },
    authorSource: "branch",
    hostUser: "example-bot",
    labels: [],
    risk: { tier: "amber", defaultTier: "amber", rules: [], files: [], size: { files: 1, additions: 1, deletions: 0 }, labels: [] },
    slots: [],
    reviews: [],
    findings: [],
    gate: [],
    holds: [],
    conditions: [],
    canMerge: true,
    reasons: [],
    plan: { method: "local", strategy: "ff-only", reason: "local by default", warnings: [], refusal: null },
    readOnly: false,
    evaluatedAt: "2026-03-02T12:00:00.000Z",
    ...overrides,
  };
}

describe("mergeButtonState", () => {
  it("enables the button only when the policy allows the merge, and says how it will merge", () => {
    expect(mergeButtonState(status({}), false)).toEqual({
      enabled: true,
      label: "Merge 0123456 (locally, ff-only)",
      reasons: [],
    });
    const refused = mergeButtonState(
      status({ canMerge: false, reasons: ["Gate at head: build: failed at 0123456", "Required reviews: 0/1"] }),
      false,
    );
    expect(refused.enabled).toBe(false);
    expect(refused.reasons).toEqual(["Gate at head: build: failed at 0123456", "Required reviews: 0/1"]);
    expect(mergeButtonState(status({}), true)).toMatchObject({ enabled: false, label: "Merging..." });
    expect(mergeButtonState(null, false).enabled).toBe(false);
  });
});

describe("parseFindingLines", () => {
  it("reads file:line findings, file findings and plain text", () => {
    expect(
      parseFindingLines("src/a.ts:12: off by one\nREADME.md: typo\nNote: needs a test\n\n", true),
    ).toEqual([
      { severity: "high", file: "src/a.ts", line: 12, text: "off by one", blocking: true },
      { severity: "high", file: "README.md", line: null, text: "typo", blocking: true },
      { severity: "high", file: null, line: null, text: "Note: needs a test", blocking: true },
    ]);
    expect(parseFindingLines("a.ts:3: nit", false)[0]).toMatchObject({ severity: "low", blocking: false });
    expect(findingLocation({ file: "src/a.ts", line: 12 })).toBe("src/a.ts:12");
    expect(findingLocation({ file: null, line: null })).toBe("—");
  });
});
