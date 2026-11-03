/**
 * The decision brain's read of a PR at its head (docs/design/decision-brain.md §4.1; ReviewManager.brainPrFacts,
 * which src/server/index.ts wires into the agents module): the ReviewManager on a real store, against the stand-in
 * git host API. Read only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { ReviewManager } from "./service.js";
import { ReviewStore } from "./store.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };

const managers: ReviewManager[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lair-review-brain-"));
  dirs.push(dir);
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  const old = remote.commit([base], AGENT, "login form");
  const head = remote.commit([old], AGENT, "review fixes");
  remote.openPull({ number: 12, headRef: "agent/worker-a/login", headSha: head, files: [] });
  const dbPath = join(dir, "review.db");
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
  const reviews = new ReviewManager({ dbPath, clock: new FakeClock(NOW), git: new FakeGit(remote), fetch: fakeGitHubApi(remote), env: {}, cwd: dir });
  managers.push(reviews);
  reviews.load([{ name: "demo", config }]);
  return { remote, reviews, dbPath, old, head, base };
}

function review(dbPath: string, headSha: string, reviewer: { id: string; kind: "agent" | "human" }, verdict: "approve" | "request_changes", at: string) {
  const store = new ReviewStore(dbPath);
  store.addReview({ project: "demo", pr: 12, headSha, reviewer, verdict, summary: "s", context: {}, findings: [], client: null, at });
  store.close();
}

describe("brainPrFacts: a PR as the decision brain reads it", () => {
  it("each reviewer's latest verdict at exactly the head; an older head's reviews do not count", async () => {
    const h = setup();
    review(h.dbPath, h.old, { id: "worker-b", kind: "agent" }, "approve", "2026-03-02T11:00:00.000Z");
    expect(await h.reviews.brainPrFacts("demo", 12)).toEqual({ state: "open", headSha: h.head, verdicts: [], gate: ["missing"], holds: [] });
    review(h.dbPath, h.head, { id: "worker-b", kind: "agent" }, "request_changes", "2026-03-02T11:10:00.000Z");
    expect((await h.reviews.brainPrFacts("demo", 12))!.verdicts).toEqual(["request_changes"]);
    // The same reviewer approves at the same head: its later verdict replaces the earlier one
    review(h.dbPath, h.head, { id: "worker-b", kind: "agent" }, "approve", "2026-03-02T11:20:00.000Z");
    expect((await h.reviews.brainPrFacts("demo", 12))!.verdicts).toEqual(["approve"]);
    // A person asks for changes: both stand
    review(h.dbPath, h.head, { id: "someone", kind: "human" }, "request_changes", "2026-03-02T11:30:00.000Z");
    expect((await h.reviews.brainPrFacts("demo", 12))!.verdicts.sort()).toEqual(["approve", "request_changes"]);
  });

  it("the required gate at the head, and the unreleased holds on this PR or every PR, with who added each", async () => {
    const h = setup();
    h.remote.setChecks(h.old, [["build", "success"]]);
    expect((await h.reviews.brainPrFacts("demo", 12))!.gate).toEqual(["missing"]);
    h.remote.setChecks(h.head, [["build", "failure"]]);
    expect((await h.reviews.brainPrFacts("demo", 12))!.gate).toEqual(["failed"]);
    h.remote.setChecks(h.head, [["build", "success"]]);
    expect((await h.reviews.brainPrFacts("demo", 12))!.gate).toEqual(["passed"]);

    const service = h.reviews.get("demo")!;
    await service.addHold(12, "a review fix round", "release-coordinator");
    await service.addHold(null, "release freeze", "owner", true);
    await service.addHold(13, "another PR", "worker-b");
    const released = await service.addHold(12, "was a mistake", "worker-a");
    await service.releaseHold(released.id, "owner");
    expect((await h.reviews.brainPrFacts("demo", 12))!.holds).toEqual([
      { byOwner: false, by: "release-coordinator" },
      { byOwner: true, by: "owner" },
    ]);
  });

  it("read only: the head it reads is not recorded; merged reads merged; an unknown project is null; a host failure rejects", async () => {
    const h = setup();
    const before = new ReviewStore(h.dbPath);
    expect(before.currentHead("demo", 12)).toBeNull();
    await h.reviews.brainPrFacts("demo", 12);
    expect(before.currentHead("demo", 12)).toBeNull();
    before.close();
    h.remote.push("main", h.head);
    expect((await h.reviews.brainPrFacts("demo", 12))!.state).toBe("merged");
    expect(await h.reviews.brainPrFacts("other", 12)).toBeNull();
    await expect(h.reviews.brainPrFacts("demo", 99)).rejects.toThrow();
  });
});
