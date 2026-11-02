/**
 * Staged review slots (docs/design/review-stages.md): a slot with ask_after
 * waits, unasked, until the gate passed at the head and/or every earlier slot
 * is approved there. ReviewService through ReviewManager.load (the real config
 * parse), a stand-in git host API and a recording assigner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GateResult } from "../../shared/policy-types.js";
import { generateNodeKeyPair, signGateResult } from "../gates/signature.js";
import { AUTO_REQUEST_MIN_INTERVAL_MS, ReviewManager, type ReviewService } from "./service.js";
import type { ReviewAssignment } from "./ports.js";
import { FakeClock, FakeGit, FakeRemote, fakeGitHubApi, type FakeFile, type Person } from "./testing/fakes.js";

const AGENT: Person = { name: "Fleet Agent", email: "12345+fleet@users.noreply.github.com" };
const MIGRATION: FakeFile = {
  filename: "db/migrations/0002_add_orders.sql",
  status: "added",
  additions: 1,
  deletions: 0,
  patch: "@@ -0,0 +1 @@\n+CREATE TABLE orders (id INTEGER PRIMARY KEY);",
};
const QUICK = { any_of: ["agent:quick-reviewer"] };
const strong = (askAfter?: string[]) => ({ any_of: ["agent:strong-reviewer"], ...(askAfter ? { ask_after: askAfter } : {}) });

let manager: ReviewManager | null = null;
let dir: string | null = null;
afterEach(() => {
  manager?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  manager = null;
  dir = null;
});

interface Setup {
  service: ReviewService;
  remote: FakeRemote;
  clock: FakeClock;
  head: string;
  assignments: ReviewAssignment[];
}

/** PR #3 (a migration: red tier) by worker-a; the gate is the host check `build`, `checks` its conclusion at the head */
function setup(red: unknown[], checks: string | null, gate?: Record<string, unknown>): Setup {
  dir = mkdtempSync(join(tmpdir(), "lair-review-stages-"));
  const remote = new FakeRemote();
  const base = remote.commit([], AGENT, "initial");
  remote.branches.set("main", base);
  remote.setChecks(base, [["build", "success"]]);
  const head = remote.commit([base], AGENT, "change");
  remote.openPull({ number: 3, title: "A change", headRef: "agent/worker-a/change", headSha: head, files: [MIGRATION] });
  if (checks) remote.setChecks(head, [["build", checks]]);
  const clock = new FakeClock(Date.parse("2026-03-02T12:00:00.000Z"));
  const assignments: ReviewAssignment[] = [];
  manager = new ReviewManager({
    dbPath: ":memory:",
    clock,
    git: new FakeGit(remote),
    fetch: fakeGitHubApi(remote),
    env: {},
    cwd: dir,
    decisions: { raise: async () => ({ id: "decision-1", channel: "inbox" }) },
    assigner: {
      async assign(assignment) {
        assignments.push(assignment);
        return { assigned: true, agent: assignment.reviewer, detail: "queued" };
      },
    },
  });
  manager.load([
    {
      name: "demo",
      config: {
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
          reviewers: { red },
          merge: { gate: gate ?? { source: "checks", required: ["build"] }, work_dir: join(dir, "work") },
        },
      },
    },
  ]);
  const service = manager.get("demo");
  if (!service) throw new Error(`the project did not load: ${manager.info("demo").errors.join("; ")}`);
  return { service, remote, clock, head, assignments };
}

/** Review as `agent` with the token of its newest assignment at `head` */
function review(s: Setup, agent: string, head: string, verdict: "approve" | "request_changes" = "approve") {
  const assignment = [...s.assignments].reverse().find((a) => a.reviewer === agent && a.headSha === head);
  return s.service.submitReview(
    3,
    { reviewer: { id: agent, kind: "agent" }, headSha: head, verdict, summary: "", findings: [] },
    { assignmentToken: assignment?.token ?? null, client: null },
  );
}

const asked = (s: Setup) => s.assignments.map((a) => `${a.reviewer}@${a.headSha.slice(0, 7)}`);

describe("staged review slots", () => {
  it("without ask_after every missing slot is asked at once, as before", async () => {
    const s = setup([QUICK, strong()], "failure");
    expect(await s.service.requestOpenPullRequests()).toEqual([3]);
    expect(asked(s)).toEqual([`quick-reviewer@${s.head.slice(0, 7)}`, `strong-reviewer@${s.head.slice(0, 7)}`]);
    const status = await s.service.status(3);
    expect(status.slots.map((slot) => slot.waiting)).toEqual([undefined, undefined]);
    expect(status.assignments?.map((a) => a.state)).toEqual(["requested", "requested"]);
  });

  it("ask_after gate: waits unasked while the gate fails, the scan asks once it passes, and only once", async () => {
    const s = setup([QUICK, strong(["gate"])], "failure");
    const h = s.head.slice(0, 7);
    await s.service.requestOpenPullRequests();
    expect(asked(s)).toEqual([`quick-reviewer@${h}`]);

    const waiting = await s.service.status(3);
    expect(waiting.slots[1].waiting).toBe(`waiting for the gate to pass at ${h}`);
    expect(waiting.slots[1].detail).toContain(`Not asked for yet: waiting for the gate to pass at ${h}`);
    expect(waiting.assignments?.find((a) => a.slot === 1)).toMatchObject({
      state: "waiting",
      attempts: 0,
      runId: null,
      detail: `waiting for the gate to pass at ${h}`,
    });

    // The owner's request skips it too, and says so
    const owner = await s.service.requestReviews(3);
    expect(owner).toEqual([
      { slot: "agent quick-reviewer", channel: "already requested", detail: `at ${h}` },
      { slot: "agent strong-reviewer", channel: "waiting", detail: `not asked for yet: waiting for the gate to pass at ${h}` },
    ]);
    expect(asked(s)).toEqual([`quick-reviewer@${h}`]);

    // A scan while it still fails asks nothing
    expect(await s.service.requestOpenPullRequests()).toEqual([]);
    expect(asked(s)).toHaveLength(1);

    s.remote.setChecks(s.head, [["build", "success"]]);
    expect(await s.service.requestOpenPullRequests()).toEqual([3]);
    expect(asked(s)).toEqual([`quick-reviewer@${h}`, `strong-reviewer@${h}`]);
    expect((await s.service.status(3)).assignments?.find((a) => a.slot === 1)?.state).toBe("requested");
    expect(await s.service.requestOpenPullRequests()).toEqual([]);
    expect(asked(s)).toHaveLength(2);

    // The strong reviewer's request_changes still blocks the merge
    await review(s, "quick-reviewer", s.head);
    await review(s, "strong-reviewer", s.head, "request_changes");
    const blocked = await s.service.status(3);
    expect(blocked.canMerge).toBe(false);
    expect(blocked.conditions.find((c) => c.id === "changes_requested")).toMatchObject({ ok: false });
  });

  it("ask_after earlier_slots: waits for the earlier slot's approval and is asked as soon as it arrives", async () => {
    const s = setup([QUICK, strong(["earlier_slots"])], "success");
    const h = s.head.slice(0, 7);
    await s.service.requestOpenPullRequests();
    expect(asked(s)).toEqual([`quick-reviewer@${h}`]);
    expect((await s.service.status(3)).slots[1].waiting).toBe(
      `waiting for an approval at ${h} of earlier slot 1 (agent quick-reviewer)`,
    );

    // A request for changes fills no slot: still waiting
    await review(s, "quick-reviewer", s.head, "request_changes");
    expect(await s.service.requestReviews(3, "auto", [1])).toEqual([
      expect.objectContaining({ slot: "agent strong-reviewer", channel: "waiting" }),
    ]);
    expect(asked(s)).toHaveLength(1);

    // The quick reviewer is asked again (the owner's request), approves, and the strong one is asked without a scan
    await s.service.requestReviews(3);
    await review(s, "quick-reviewer", s.head);
    await vi.waitFor(() => expect(asked(s)).toEqual([`quick-reviewer@${h}`, `quick-reviewer@${h}`, `strong-reviewer@${h}`]));
  });

  it("ask_after [gate, earlier_slots]: asked only when both hold", async () => {
    const s = setup([QUICK, strong(["gate", "earlier_slots"])], "failure");
    const h = s.head.slice(0, 7);
    await s.service.requestOpenPullRequests();
    expect((await s.service.status(3)).slots[1].waiting).toBe(
      `waiting for the gate to pass at ${h} and for an approval at ${h} of earlier slot 1 (agent quick-reviewer)`,
    );
    await review(s, "quick-reviewer", s.head);
    const after = await s.service.requestReviews(3, "auto", [1]);
    expect(after).toEqual([
      { slot: "agent strong-reviewer", channel: "waiting", detail: `not asked for yet: waiting for the gate to pass at ${h}` },
    ]);
    expect(asked(s)).toEqual([`quick-reviewer@${h}`]);

    s.remote.setChecks(s.head, [["build", "success"]]);
    await s.service.requestOpenPullRequests();
    expect(asked(s)).toEqual([`quick-reviewer@${h}`, `strong-reviewer@${h}`]);
  });

  it("a new head starts over: the slot asked at the old head waits at the new one", async () => {
    const s = setup([QUICK, strong(["gate"])], "success");
    await s.service.requestOpenPullRequests();
    expect(asked(s)).toHaveLength(2);

    const next = s.remote.commit([s.head], AGENT, "fix");
    s.remote.pushToPull(3, next);
    s.clock.advance(AUTO_REQUEST_MIN_INTERVAL_MS);
    await s.service.requestOpenPullRequests();
    const n = next.slice(0, 7);
    expect(asked(s).slice(2)).toEqual([`quick-reviewer@${n}`]);
    const status = await s.service.status(3);
    expect(status.headSha).toBe(next);
    expect(status.slots[1].waiting).toBe(`waiting for the gate to pass at ${n}`);
    expect(status.assignments?.find((a) => a.slot === 1)?.state).toBe("waiting");
  });

  it("a signed gate result for the head asks the waiting slot at once", async () => {
    const node = generateNodeKeyPair("node-1");
    const s = setup([QUICK, strong(["gate"])], null, {
      source: "signed",
      required: ["backend"],
      node_keys: { "node-1": node.publicKey },
      pipeline_versions: { backend: "v1" },
    });
    const h = s.head.slice(0, 7);
    await s.service.requestOpenPullRequests();
    expect(asked(s)).toEqual([`quick-reviewer@${h}`]);

    const result: GateResult = {
      id: "20260101T000000Z-example-abcdef12-1",
      pipelineId: "backend",
      commitSha: s.head,
      branch: "agent/worker-a/change",
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
    expect(s.service.addGateResult(signGateResult(result, node.privateKey, node.publicKey))).toBe(true);
    await vi.waitFor(() => expect(asked(s)).toEqual([`quick-reviewer@${h}`, `strong-reviewer@${h}`]));
  });
});
