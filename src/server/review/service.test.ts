/**
 * ReviewService against a stand-in git host API: required reviewers per
 * tier, the test integrity check blocking in the red tier, gate and branch
 * conditions, holds, signed gate results, and asking for missing reviewers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { GateResult } from "../../shared/policy-types.js";
import { generateNodeKeyPair, signGateResult } from "../gates/signature.js";
import { ReviewManager, type ReviewService } from "./service.js";
import type { DecisionRequest, ReviewAssignment } from "./ports.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };

let manager: ReviewManager | null = null;
let dir: string | null = null;

afterEach(() => {
  manager?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  manager = null;
  dir = null;
});

const MIGRATION: FakeFile = {
  filename: "db/migrations/0002_add_orders.sql",
  status: "added",
  additions: 3,
  deletions: 0,
  patch: "@@ -0,0 +1,3 @@\n+CREATE TABLE orders (\n+  id INTEGER PRIMARY KEY\n+);",
};

const README: FakeFile = {
  filename: "docs/usage.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n # Usage\n-Old text\n+New text",
};

/** A test that builds a fake, calls the fake and asserts on the fake: nothing real is wired in. */
const SELF_ASSERTING_SOURCE = [
  'import { expect, it, vi } from "vitest";',
  'import { FakeStore } from "./fakes";',
  "",
  'it("saves the order", () => {',
  "  const store = new FakeStore();",
  "  const save = vi.fn();",
  '  save({ id: 1 });',
  "  expect(save).toHaveBeenCalledWith({ id: 1 });",
  "  expect(store.items).toEqual([]);",
  "});",
].join("\n");

const SELF_ASSERTING: FakeFile = {
  filename: "src/orders/orders.test.ts",
  status: "added",
  additions: 10,
  deletions: 0,
  patch: `@@ -0,0 +1,10 @@\n${SELF_ASSERTING_SOURCE.split("\n").map((l) => `+${l}`).join("\n")}`,
  content: SELF_ASSERTING_SOURCE,
};

function config(review: Record<string, unknown>): ProjectConfig {
  return {
    name: "demo",
    repo: "/home/user/demo",
    github: "example-org/demo",
    queue_file: "/home/user/demo/work/queue.md",
    agents_dir: "/home/user/demo/work/agents",
    gates_dir: "/home/user/demo/work/gates",
    machines: {},
    read_only: false,
    review,
  };
}

interface Setup {
  service: ReviewService;
  remote: FakeRemote;
  base: string;
  head: string;
  decisions: DecisionRequest[];
  assignments: ReviewAssignment[];
}

function setup(review: Record<string, unknown>, files: FakeFile[], labels: string[] = []): Setup {
  dir = mkdtempSync(join(tmpdir(), "lair-review-service-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  remote.setChecks(base, [["build", "success"]]);
  const head = remote.commit([base], AGENT, "change");
  remote.openPull({ number: 3, title: "A change", headRef: "agent/kiro-a/change", headSha: head, files, labels });
  remote.setChecks(head, [["build", "success"]]);
  const decisions: DecisionRequest[] = [];
  const assignments: ReviewAssignment[] = [];
  manager = new ReviewManager({
    dbPath: ":memory:",
    clock: new FakeClock(NOW),
    git: new FakeGit(remote),
    fetch: fakeGitHubApi(remote),
    env: {},
    cwd: dir,
    decisions: {
      async raise(request) {
        decisions.push(request);
        return { id: `decision-${decisions.length}`, channel: "inbox" };
      },
    },
    assigner: {
      async assign(assignment) {
        assignments.push(assignment);
        return { assigned: true, agent: assignment.reviewer ?? "kiro-c", detail: "queued" };
      },
    },
  });
  manager.load([
    {
      name: "demo",
      config: config({
        enabled: true,
        authors: { branch_pattern: "^agent/(?<agent>[A-Za-z0-9_-]+)/", models: { "kiro-a": "model-one" } },
        merge: { gate: { source: "checks", required: ["build"] }, work_dir: join(dir, "work") },
        ...review,
      }),
    },
  ]);
  return { service: manager.get("demo")!, remote, base, head, decisions, assignments };
}

function condition(status: { conditions: { id: string; ok: boolean; detail: string }[] }, id: string) {
  return status.conditions.find((c) => c.id === id)!;
}

describe("required reviewers per tier", () => {
  it("a migration is red: a peer is not enough, the designated reviewer agent is", async () => {
    const { service, head } = setup(
      { reviewers: { red: [{ any_of: ["human", "agent:lead-reviewer"] }], amber: ["peer"], green: ["self"] } },
      [MIGRATION],
    );
    const before = await service.status(3);
    expect(before.risk.tier).toBe("red");
    expect(before.risk.rules).toEqual([
      expect.objectContaining({ id: "migrations", tier: "red", reasons: ["kind migration: db/migrations/0002_add_orders.sql"] }),
    ]);
    expect(before.slots.map((s) => s.label)).toEqual(["a human or agent lead-reviewer"]);

    await service.submitReview(3, {
      reviewer: { id: "kiro-b", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    const peerOnly = await service.status(3);
    expect(peerOnly.canMerge).toBe(false);
    expect(peerOnly.slots[0].detail).toContain("kiro-b: not a human");

    await service.submitReview(3, {
      reviewer: { id: "lead-reviewer", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    const ready = await service.status(3);
    expect(ready.slots[0].satisfiedBy?.reviewer.id).toBe("lead-reviewer");
    expect(ready.canMerge).toBe(true);
  });

  it("one reviewer fills one slot, and different_model rejects the author's model", async () => {
    const { service, head } = setup(
      { reviewers: { red: ["human", { any_of: ["peer"], different_model: true }] } },
      [MIGRATION],
    );
    const approve = (id: string, kind: "human" | "agent", model?: string) =>
      service.submitReview(3, {
        reviewer: model ? { id, kind, model } : { id, kind },
        headSha: head,
        verdict: "approve",
        summary: "",
        findings: [],
      });
    await approve("owner", "human");
    const onlyHuman = await service.status(3);
    // The human fills the human slot; it can't also be the peer
    expect(onlyHuman.slots.map((s) => s.satisfiedBy?.reviewer.id ?? null)).toEqual(["owner", null]);

    await approve("kiro-b", "agent", "model-one");
    const sameModel = await service.status(3);
    expect(sameModel.slots[1].satisfiedBy).toBeNull();
    expect(sameModel.slots[1].detail).toContain("uses the author's model model-one");

    await approve("kiro-c", "agent", "model-two");
    const done = await service.status(3);
    expect(done.slots.map((s) => s.satisfiedBy?.reviewer.id)).toEqual(["owner", "kiro-c"]);
    expect(done.canMerge).toBe(true);
  });

  it("green needs the author's self-check; an unknown author is explained", async () => {
    const { service, head, remote } = setup({}, [README]);
    const status = await service.status(3);
    expect(status.risk.tier).toBe("green");
    expect(status.slots[0].label).toBe("the author's self-check");
    await service.submitReview(3, {
      reviewer: { id: "kiro-a", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "self-check",
      findings: [],
    });
    expect((await service.status(3)).canMerge).toBe(true);

    // A PR whose branch names no agent: self and peer can't be judged
    const other = remote.commit([head], AGENT, "more");
    remote.openPull({ number: 4, headRef: "feature/no-agent", headSha: other, files: [README] });
    remote.setChecks(other, [["build", "success"]]);
    const unknown = await service.status(4);
    expect(unknown.author).toBeNull();
    expect(unknown.slots[0].detail).toContain("the PR's author is unknown");
    service.setAuthor(4, { id: "kiro-d", kind: "agent" });
    expect((await service.status(4)).author).toEqual({ id: "kiro-d", kind: "agent" });
  });
});

describe("test integrity check in the policy", () => {
  it("blocks a red-tier PR whose test asserts only on its own fakes, with file:line", async () => {
    const { service, head } = setup({}, [MIGRATION, SELF_ASSERTING]);
    await service.submitReview(3, {
      reviewer: { id: "owner", kind: "human" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    const status = await service.status(3);
    expect(status.risk.tier).toBe("red");
    const finding = status.findings.find((f) => f.rule === "self-asserting-test")!;
    expect(finding).toMatchObject({
      reviewer: { id: "lair:test-integrity", kind: "check" },
      file: "src/orders/orders.test.ts",
      line: 8,
      blocking: true,
      status: "open",
      headSha: head,
    });
    expect(finding.text).toContain("./fakes (test helper or fake)");
    expect(status.canMerge).toBe(false);
    expect(condition(status, "findings").detail).toContain("src/orders/orders.test.ts:8");

    // The author can't wave it through; a human can, with a reason
    await expect(service.resolveFinding(finding.id, { id: "kiro-a", kind: "agent" }, "dismissed", "fine")).rejects.toThrow(
      "author",
    );
    await expect(service.resolveFinding(finding.id, { id: "kiro-b", kind: "agent" }, "dismissed", "fine")).rejects.toThrow(
      "Only a human",
    );
    const dismissed = await service.resolveFinding(finding.id, { id: "owner", kind: "human" }, "dismissed", "Smoke test");
    expect(dismissed).toMatchObject({ status: "dismissed", resolvedBy: "owner" });
    expect((await service.status(3)).canMerge).toBe(true);
  });

  it("records the same finding as advisory in the green tier", async () => {
    const { service, head } = setup({}, [SELF_ASSERTING]);
    await service.submitReview(3, {
      reviewer: { id: "kiro-a", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    const status = await service.status(3);
    expect(status.risk.tier).toBe("green");
    expect(status.findings).toEqual([expect.objectContaining({ rule: "self-asserting-test", blocking: false })]);
    expect(status.canMerge).toBe(true);
  });
});

describe("merge conditions", () => {
  it("refuses with the failed gate, conflicts and a branch behind its base, naming each", async () => {
    const { service, remote, base, head } = setup({}, [README]);
    await service.submitReview(3, {
      reviewer: { id: "kiro-a", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    remote.setChecks(head, [["build", "failure"]]);
    remote.pulls.get(3)!.mergeable = false;
    const moved = remote.commit([base], AGENT, "someone else's merge");
    remote.branches.set("main", moved);
    remote.setChecks(moved, [["build", "success"]]);

    const status = await service.status(3);
    expect(status.canMerge).toBe(false);
    expect(condition(status, "gate")).toMatchObject({ ok: false });
    expect(condition(status, "gate").detail).toContain(`build: failed at ${head.slice(0, 7)}`);
    expect(condition(status, "mergeable").detail).toBe("conflicts with the target branch");
    expect(condition(status, "up_to_date").detail).toContain("1 commit(s) behind");
    expect(status.reasons).toHaveLength(3);

    const refused = await service.merge(3, { confirm: true, headSha: head, by: "owner" });
    expect(refused.merged).toBe(false);
    expect(refused.reasons).toEqual(status.reasons);
    expect(remote.branches.get("main")).toBe(moved);
  });

  it("holds every merge while the default branch is red, except a PR labelled revert", async () => {
    const { service, remote, base, head } = setup({}, [README]);
    await service.submitReview(3, {
      reviewer: { id: "kiro-a", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    remote.setChecks(base, [["build", "failure"]]);
    const red = await service.status(3);
    expect(condition(red, "holds").detail).toContain(`the default branch main is red at ${base.slice(0, 7)}`);
    expect(red.canMerge).toBe(false);

    remote.pulls.get(3)!.labels = ["revert"];
    expect(condition(await service.status(3), "holds").ok).toBe(true);
  });

  it("accepts a signed gate result at the head and rejects one with a bad signature", async () => {
    const node = generateNodeKeyPair("node-1");
    const { service, head } = setup(
      {
        merge: {
          gate: {
            source: "signed",
            required: ["backend"],
            node_keys: { "node-1": node.publicKey },
            pipeline_versions: { backend: "v1" },
          },
          hold_when_default_red: false,
        },
      },
      [README],
    );
    await service.submitReview(3, {
      reviewer: { id: "kiro-a", kind: "agent" },
      headSha: head,
      verdict: "approve",
      summary: "",
      findings: [],
    });
    expect((await service.status(3)).gate).toEqual([expect.objectContaining({ name: "backend", status: "missing" })]);

    const result: GateResult = {
      id: "20260101T000000Z-example-abcdef12-1",
      pipelineId: "backend",
      commitSha: head,
      branch: "agent/kiro-a/change",
      projectId: "demo",
      nodeId: "node-1",
      status: "passed",
      steps: [
        {
          name: "test",
          status: "passed",
          exitCode: 0,
          durationMs: 5000,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
        },
      ],
      selectedSteps: ["test"],
      durationMs: 5000,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      pipelineVersion: "v1",
    };
    const forged = signGateResult({ ...result, id: "forged" }, generateNodeKeyPair("node-1").privateKey, node.publicKey);
    service.addGateResult(forged);
    const rejected = await service.status(3);
    expect(rejected.gate[0]).toMatchObject({ status: "failed" });
    expect(rejected.gate[0].detail).toContain("Invalid signature");

    service.addGateResult(signGateResult(result, node.privateKey, node.publicKey));
    const passed = await service.status(3);
    expect(passed.gate[0]).toMatchObject({ name: "backend", status: "passed", sha: head });
    expect(passed.canMerge).toBe(true);
  });
});

describe("asking for missing reviewers", () => {
  it("assigns agents, asks a human through the Decision Inbox, and asks once per head", async () => {
    const { service, head, decisions, assignments } = setup(
      { reviewers: { red: ["human", "agent:lead-reviewer", { any_of: ["peer"], different_model: true }] } },
      [MIGRATION],
    );
    const first = await service.requestReviews(3);
    expect(first.map((o) => o.channel)).toEqual(["decision", "assigner", "assigner"]);
    expect(decisions).toEqual([
      expect.objectContaining({ project: "demo", kind: "other", question: `Review PR #3 (red tier) at ${head.slice(0, 7)}` }),
    ]);
    expect(assignments).toEqual([
      expect.objectContaining({ reviewer: "lead-reviewer", role: "review", headSha: head, tier: "red" }),
      expect.objectContaining({ reviewer: null, exclude: ["kiro-a"], differentModelFrom: "model-one" }),
    ]);

    const again = await service.requestReviews(3);
    expect(again.map((o) => o.channel)).toEqual(["already requested", "already requested", "already requested"]);
    expect(decisions).toHaveLength(1);
    expect(assignments).toHaveLength(2);
  });
});
