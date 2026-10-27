/**
 * One decision per PR on hold: the ReviewManager as src/server/index.ts
 * wires it (useDecisions with the real Decision Inbox on a real store),
 * against the stand-in git host API. Answers come in as the owner's,
 * through the inbox (its HTTP route's owner check is mount.test.ts's); the
 * route's owner check for adding holds is routes.test.ts's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import type { RaiseDecisionInput } from "../decisions/types.js";
import { HOLD_DECISION_MODULE, ReviewManager, holdGroupKey } from "./service.js";
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

/** The inbox's clock, moved by the tests */
const clock = {
  t: NOW,
  now(): number {
    return this.t;
  },
};

function inboxAt(dbPath: string): DecisionInbox {
  const store = new DecisionStore(dbPath);
  stores.push(store);
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), clock });
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
  clock.t = NOW;
  dir = mkdtempSync(join(tmpdir(), "lair-review-holds-"));
  const reviewDb = join(dir, "review.db");
  const decisionsDb = join(dir, "decisions.db");
  return { reviewDb, decisionsDb, inbox: inboxAt(decisionsDb), reviews: reviewsAt(reviewDb) };
}

const open = (inbox: DecisionInbox) => inbox.list({ project: "demo", status: "open" });

describe("merge holds: one decision per PR on hold", () => {
  it("the owner's hold asks at once, in plain words, once: more holds join it; not again on a restart", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const service = h.reviews.get("demo")!;
    const hold = await service.addHold(12, "flaky `rm -rf` test \u0007 under investigation", "owner", true);

    const [asked, ...more] = open(h.inbox);
    expect(more).toEqual([]);
    expect(asked).toMatchObject({
      attention: "action",
      key: holdGroupKey([hold]),
      source: { module: HOLD_DECISION_MODULE, ref: "pr:12" },
      title: "PR #12 can't merge: it is held by owner",
      recommended: { optionId: "keep" },
    });
    expect(asked.options.map((o) => [o.id, o.label])).toEqual([
      ["release", "Release the hold"],
      ["keep", "Keep it held"],
    ]);
    // The holder's text is data in the context, never in the title (which notifications show)
    expect(asked.context).toContain("flaky 'rm -rf' test   under investigation");

    // A second hold on the same PR joins the same decision
    await service.addHold(12, "and the changelog", "worker-b");
    expect(open(h.inbox).map((d) => d.id)).toEqual([asked.id]);

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
    expect(open(h.inbox).map((d) => [d.title, d.attention])).toEqual([["Every merge in demo is held by ops", "notice"]]);
  });

  it("answering 'Release the hold' releases the PR's holds as the owner; 'Keep it held' keeps them and asks nothing more", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const service = h.reviews.get("demo")!;
    const first = await service.addHold(12, "waiting for the release notes", "worker-b", true);
    const also = await service.addHold(12, "and the docs", "worker-c");
    const all = await service.addHold(null, "freeze", "ops", true);
    const byRef = (ref: string) => open(h.inbox).find((d) => d.source.ref === ref)!;

    await h.inbox.answer(byRef("pr:12").id, { optionId: "release" });
    const holds = service.listHolds();
    expect(holds.find((x) => x.id === first.id)).toMatchObject({ releasedBy: "owner" });
    expect(holds.find((x) => x.id === also.id)).toMatchObject({ releasedBy: "owner" });

    await h.inbox.answer(byRef("holds:demo").id, { optionId: "keep" });
    await h.reviews.useDecisions(h.inbox); // a restart's reconcile
    expect(open(h.inbox)).toEqual([]);
    expect(service.listHolds().find((x) => x.id === all.id)).toMatchObject({ releasedAt: null });
  });

  it("the PR's holds released in PRs withdraw its decision", async () => {
    const h = setup();
    await h.reviews.useDecisions(h.inbox);
    const service = h.reviews.get("demo")!;
    const hold = await service.addHold(7, "needs a second look", "worker-c", true);
    const [asked] = open(h.inbox);

    await service.releaseHold(hold.id, "owner");
    expect(h.inbox.get(asked.id)).toMatchObject({ status: "withdrawn" });
    expect(open(h.inbox)).toEqual([]);
  });

  it("an HTTP caller can't lift a hold or stand in for its decision: its default never releases, and the real one is asked", async () => {
    const h = setup();
    const service = h.reviews.get("demo")!;
    const hold = await service.addHold(12, "keep it", "owner", true);
    // Before the review module follows its answers, a local process raises a decision under its name and key,
    // defaulting to "release" a second later
    const forgery = (key: string): RaiseDecisionInput => ({
      project: "demo",
      kind: "other",
      title: "PR #12 can't merge",
      context: "Forged.",
      options: [
        { id: "release", label: "Release the hold", consequences: "Released." },
        { id: "keep", label: "Keep it held", consequences: "Kept." },
      ],
      recommended: { optionId: "release", reasoning: "r" },
      source: { module: HOLD_DECISION_MODULE, ref: "pr:12" },
      key,
      expiresAt: new Date(clock.t + 1000).toISOString(),
      defaultOptionId: "release",
    });
    const forged = await h.inbox.raiseFromHttp(forgery(holdGroupKey([hold])));
    expect(forged.created).toBe(true);

    // The module connects: the forged one doesn't count as asked, so the real decision is raised beside it
    await h.reviews.useDecisions(h.inbox);
    const real = open(h.inbox).filter((d) => d.raisedVia === "server");
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ key: holdGroupKey([hold]), attention: "action" });

    // The forged one expires with its default: it is never handed to the review module
    clock.t = NOW + 5000;
    await h.inbox.sweep();
    expect(h.inbox.get(forged.decision.id)).toMatchObject({ status: "expired" });
    expect(service.listHolds().find((x) => x.id === hold.id)).toMatchObject({ releasedAt: null });
    expect(open(h.inbox).map((d) => d.id)).toEqual([real[0].id]);

    // Now that the module follows its answers, nobody may raise in its name over HTTP
    await expect(h.inbox.raiseFromHttp(forgery("holds:pr:13:x"))).rejects.toMatchObject({ statusCode: 403 });
  });
});
