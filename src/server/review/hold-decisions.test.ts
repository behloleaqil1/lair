/**
 * One decision per merge hold: the ReviewManager as src/server/index.ts
 * wires it (useDecisions with the real Decision Inbox on a real store),
 * against the stand-in git host API. Answers come in as the owner's,
 * through the inbox (its HTTP route's owner check is mount.test.ts's).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { HOLD_DECISION_MODULE, ReviewManager, holdDecisionKey } from "./service.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };

const managers: ReviewManager[] = [];
const stores: DecisionStore[] = [];
let dir: string | null = null;

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function config(): ProjectConfig {
  return {
    name: "demo",
    repo: "/home/user/demo",
    github: "example-org/demo",
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: false,
    review: {
      enabled: true,
      authors: { branch_pattern: "agent/{agent}/**" },
      merge: { gate: { source: "checks", required: ["build"] }, work_dir: join(dir!, "work") },
    },
  };
}

function inboxAt(dbPath: string): DecisionInbox {
  const store = new DecisionStore(dbPath);
  stores.push(store);
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: { now: () => NOW } });
}

function reviewsAt(dbPath: string): ReviewManager {
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  const manager = new ReviewManager({
    dbPath,
    clock: new FakeClock(NOW),
    git: new FakeGit(remote),
    fetch: fakeGitHubApi(remote),
    env: {},
    cwd: dir!,
  });
  managers.push(manager);
  manager.load([{ name: "demo", config: config() }]);
  return manager;
}

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lair-review-holds-"));
  const reviewDb = join(dir, "review.db");
  const decisionsDb = join(dir, "decisions.db");
  return { reviewDb, decisionsDb, inbox: inboxAt(decisionsDb), reviews: reviewsAt(reviewDb) };
}

const open = (inbox: DecisionInbox) => inbox.list({ project: "demo", status: "open" });

describe("merge holds: one decision per hold", () => {
  it("a hold asks the owner at once, in plain words, once: not again on a restart or when the inbox is opened again", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const hold = await h.reviews.get("demo")!.addHold(12, "flaky `rm -rf` test \u0007 under investigation", "worker-b");

    const [asked, ...more] = open(h.inbox);
    expect(more).toEqual([]);
    expect(asked).toMatchObject({
      attention: "action",
      key: holdDecisionKey(hold.id),
      source: { module: HOLD_DECISION_MODULE, ref: "pr:12" },
      title: "PR #12 can't merge: it is held by worker-b",
      recommended: { optionId: "keep" },
    });
    expect(asked.options.map((o) => [o.id, o.label])).toEqual([
      ["release", "Release the hold"],
      ["keep", "Keep it held"],
    ]);
    // The holder's reason is data in the context, never in the title (which notifications show)
    expect(asked.context).toContain("flaky 'rm -rf' test   under investigation");

    // Lair restarts: the same stores, a new review module and inbox
    h.reviews.close();
    const reviews = reviewsAt(h.reviewDb);
    const inbox = inboxAt(h.decisionsDb);
    await reviews.useDecisions(inbox);
    await reviews.useDecisions(inbox);
    expect(open(inbox).map((d) => d.id)).toEqual([asked.id]);
  });

  it("a hold added while the inbox wasn't connected gets its decision once it is", async () => {
    const h = setup();
    await h.reviews.get("demo")!.addHold(null, "release freeze", "ops");
    expect(open(h.inbox)).toEqual([]);
    await h.reviews.useDecisions(h.inbox);
    expect(open(h.inbox).map((d) => d.title)).toEqual(["Every merge in demo is held by ops"]);
  });

  it("answering 'Release the hold' releases it as the owner; 'Keep it held' keeps it and asks nothing more", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const service = h.reviews.get("demo")!;
    const first = await service.addHold(12, "waiting for the release notes", "worker-b");
    const second = await service.addHold(null, "freeze", "ops");
    const byKey = (key: string) => open(h.inbox).find((d) => d.key === key)!;

    await h.inbox.answer(byKey(holdDecisionKey(first.id)).id, { optionId: "release" });
    expect(service.listHolds().find((x) => x.id === first.id)).toMatchObject({ releasedBy: "owner" });

    const keep = byKey(holdDecisionKey(second.id));
    await h.inbox.answer(keep.id, { optionId: "keep" });
    await h.reviews.useDecisions(h.inbox); // a restart's reconcile
    expect(open(h.inbox)).toEqual([]);
    expect(service.listHolds().find((x) => x.id === second.id)).toMatchObject({ releasedAt: null });
  });

  it("a hold released in PRs withdraws its decision", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const service = h.reviews.get("demo")!;
    const hold = await service.addHold(7, "needs a second look", "worker-c");
    const [asked] = open(h.inbox);

    await service.releaseHold(hold.id, "owner");
    expect(h.inbox.get(asked.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "The hold was released (by owner)." });
    expect(open(h.inbox)).toEqual([]);
  });
});
