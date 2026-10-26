import { describe, expect, it } from "vitest";
import type { PrReviewStatus } from "../shared/review-types";
import { findingLocation, mergeButtonState, parseFindingLines } from "./review-view";

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
