/**
 * A waiting agent's PR (agents.fill.wake.events, G3: docs/design/ai-spend.md §4.5): ReviewStore.reviewedOrMergedAfter,
 * which the server wires into the agents module's state check (src/server/index.ts, ReviewManager.wakeFacts), on a
 * real store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewManager } from "./service.js";
import { ReviewStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-review-wake-"));
  dirs.push(dir);
  return dir;
}

function addReview(store: ReviewStore, pr: number, at: string, project = "demo") {
  store.addReview({
    project,
    pr,
    headSha: HEAD,
    reviewer: { id: "worker-b", kind: "agent" },
    verdict: "request_changes",
    summary: "one thing to fix",
    context: {},
    findings: [],
    client: null,
    at,
  });
}

function addMerge(store: ReviewStore, pr: number, at: string) {
  store.recordMerge({
    project: "demo",
    pr,
    headSha: HEAD,
    method: "local",
    strategy: "ff-only",
    resultSha: HEAD,
    initiatedBy: "owner",
    at,
    commitsChecked: 1,
    conditions: {},
    client: null,
  });
}

describe("G3: a PR reviewed or merged after a wait began", () => {
  it("the first review of that PR after the time, or its merge, whichever came first; earlier ones, other PRs and other projects don't count", () => {
    const store = new ReviewStore(join(freshDir(), "review.db"));
    addReview(store, 42, "2026-03-02T12:00:00.000Z"); // before
    addReview(store, 41, "2026-03-02T12:05:00.000Z"); // another PR
    addReview(store, 42, "2026-03-02T12:06:00.000Z", "other"); // another project
    const after = (since: string) => store.reviewedOrMergedAfter("demo", 42, since);
    expect(after("2026-03-02T12:01:00.000Z")).toBeNull();
    addMerge(store, 42, "2026-03-02T12:20:00.000Z");
    expect(after("2026-03-02T12:01:00.000Z")).toEqual({ event: "review.merged", at: "2026-03-02T12:20:00.000Z" });
    addReview(store, 42, "2026-03-02T12:10:00.000Z");
    expect(after("2026-03-02T12:01:00.000Z")).toEqual({ event: "review.submitted", at: "2026-03-02T12:10:00.000Z" });
    expect(after("2026-03-02T12:10:00.000Z")).toEqual({ event: "review.merged", at: "2026-03-02T12:20:00.000Z" });
    expect(after("2026-03-02T12:20:00.000Z")).toBeNull();
    store.close();
  });

  it("ReviewManager.wakeFacts, as the server wires it: in ms, from the store the review module writes", () => {
    const dir = freshDir();
    const manager = new ReviewManager({
      dbPath: join(dir, "review.db"),
      env: {},
      cwd: dir,
      agentCheckMs: 0,
      autoRequestMs: 0,
      fetch: async () => {
        throw new Error("no network in this test");
      },
    });
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
    const since = Date.parse("2026-03-02T12:01:00.000Z");
    expect(manager.wakeFacts("demo", 42, since)).toBeNull();
    const store = new ReviewStore(join(dir, "review.db"));
    addReview(store, 42, "2026-03-02T12:07:30.000Z");
    store.close();
    expect(manager.wakeFacts("demo", 42, since)).toEqual({ event: "review.submitted", at: Date.parse("2026-03-02T12:07:30.000Z") });
    expect(manager.wakeFacts("demo", 43, since)).toBeNull();
    manager.close();
  });
});
