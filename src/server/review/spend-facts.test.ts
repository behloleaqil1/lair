/**
 * AI spend's record of a review run (docs/design/ai-spend.md §4.2): ReviewStore.reviewDuring, which the server wires
 * into the agents module's classes (src/server/index.ts, ReviewManager.spendReview), on a real store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewManager } from "./service.js";
import { ReviewStore } from "./store.js";
import { FakeClock } from "./testing/fakes.js";

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

describe("AI spend: ReviewManager.spendReview, as the classifier reads it", () => {
  it("with no review yet it is pending for 5 minutes after the run's end, then idle; a review recorded in those 5 minutes counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-review-spend-"));
    dirs.push(dir);
    const ended = Date.parse("2026-03-02T12:10:00.000Z");
    const clock = new FakeClock(ended + 1_000);
    const manager = new ReviewManager({ dbPath: join(dir, "review.db"), clock, env: {}, cwd: dir, agentCheckMs: 0, autoRequestMs: 0, fetch: async () => {
      throw new Error("no network in this test");
    } });
    const config = {
      name: "demo",
      repo: dir,
      github: "example-org/demo",
      queue_file: join(dir, "queue.md"),
      agents_dir: join(dir, "agents"),
      gates_dir: join(dir, "gates"),
      machines: {},
      read_only: false,
      review: { enabled: true, merge: { gate: { source: "checks", required: ["build"] }, work_dir: join(dir, "work") } },
    } as unknown as ProjectConfig;
    manager.load([{ name: "demo", config }]);
    const run = { agent: "worker-b", requestedAt: ended - 10 * 60_000, endedAt: ended };
    const look = () => manager.spendReview("demo", run, 42, HEAD.slice(0, 8));
    expect(look()).toEqual({ verdict: "pending", headSha: null });
    clock.t = ended + 4 * 60_000;
    expect(look()?.verdict).toBe("pending");
    clock.t = ended + 5 * 60_000;
    expect(look()).toEqual({ verdict: "idle", headSha: null });

    // Posted 3 minutes after the end (a slow submit): productive, whenever it is read
    const store = new ReviewStore(join(dir, "review.db"));
    store.addReview({
      project: "demo",
      pr: 42,
      headSha: HEAD,
      reviewer: { id: "worker-b", kind: "agent" },
      verdict: "approve",
      summary: "looks right",
      context: {},
      findings: [],
      client: null,
      at: new Date(ended + 3 * 60_000).toISOString(),
    });
    store.close();
    clock.t = ended + 60 * 60_000;
    expect(look()).toEqual({ verdict: "productive", headSha: HEAD });
    manager.close();
  });
});
