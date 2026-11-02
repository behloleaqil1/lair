/**
 * AI spend's record of a review run (docs/design/ai-spend.md §4.2): ReviewStore.reviewDuring, which the server wires
 * into the agents module's classes (src/server/index.ts, ReviewManager.spendReview), on a real store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReviewStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

describe("AI spend: a review run's record", () => {
  it("a review by the run's agent of the head during the run counts; another agent's, another head's or a later one doesn't", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-review-spend-"));
    dirs.push(dir);
    const store = new ReviewStore(join(dir, "review.db"));
    const review = (reviewer: string, headSha: string, at: string) =>
      store.addReview({
        project: "demo",
        pr: 42,
        headSha,
        reviewer: { id: reviewer, kind: "agent" },
        verdict: "approve",
        summary: "looks right",
        context: {},
        findings: [],
        client: null,
        at,
      });
    review("worker-b", HEAD, "2026-03-02T12:05:00.000Z");
    review("worker-c", "1234567890abcdef1234567890abcdef12345678", "2026-03-02T12:06:00.000Z");
    const during = (reviewer: string, from: string, to: string) => store.reviewDuring("demo", 42, HEAD.slice(0, 8), reviewer, from, to);
    expect(during("worker-b", "2026-03-02T12:00:00.000Z", "2026-03-02T12:10:00.000Z")).toEqual({ recorded: true, headSha: HEAD });
    expect(during("worker-c", "2026-03-02T12:00:00.000Z", "2026-03-02T12:10:00.000Z")).toEqual({ recorded: false, headSha: null });
    expect(during("worker-b", "2026-03-02T12:06:00.000Z", "2026-03-02T12:10:00.000Z").recorded).toBe(false);
    expect(store.reviewDuring("demo", 43, HEAD.slice(0, 8), "worker-b", "2026-03-02T12:00:00.000Z", "2026-03-02T12:10:00.000Z").recorded).toBe(false);
    store.close();
  });
});
