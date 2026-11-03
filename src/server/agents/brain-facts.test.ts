/**
 * Evidence v3's pure readers (docs/design/decision-brain.md §4.1): what a report line names, what a BLOCKED line
 * waits on, the task's state in one check's lines, and a limit's reset. A fact that cannot be read is null.
 */
import { describe, expect, it, vi } from "vitest";
import type { FillLineView } from "../../shared/agents-types.js";
import {
  blockFacts,
  blockReason,
  blockerCleared,
  gateAtHead,
  headFacts,
  holdOnPr,
  limitResetPassed,
  nextMove,
  PR_FACTS_BACKOFF_MS,
  prOfLine,
  PrReader,
  raiseFacts,
  readOrNull,
  readPr,
  reviewAtHead,
  taskStateOf,
  type PrHeadView,
} from "./brain-facts.js";

const line = (over: Partial<FillLineView>): FillLineView => ({
  line: 1,
  agent: "worker-a",
  name: "Alice",
  task: "feat-login",
  description: "Login form",
  state: "held",
  detail: "",
  hold: null,
  releasable: false,
  waiting: null,
  runId: null,
  decisionId: null,
  ...over,
});

describe("evidence v3 readers", () => {
  it("prOfLine: a PR reference of the project's repository, never a bare issue number, a plan step or a link", () => {
    expect(prOfLine("- WAITING feat-login gate-1 by worker-a: PR #42 waits for review")).toBe(42);
    expect(prOfLine("opened pull request #7")).toBe(7);
    expect(prOfLine("PR#8 [abcdef1]")).toBe(8);
    // A link may be another repository's PR, and "PR 4" a step of a plan: read at a head, either would be the wrong PR
    expect(prOfLine("see https://example.com/vendor/sdk/pull/913")).toBeNull();
    expect(prOfLine("needs PR 4 of the plan")).toBeNull();
    expect(prOfLine("fixes #329")).toBeNull();
    expect(prOfLine("PR #12abc")).toBeNull();
    expect(prOfLine("no reference")).toBeNull();
  });

  it("blockedFacts: the planner's class first, then a PR or load reference; anything else is unknown", () => {
    expect(blockFacts("waiting on PR #12 to merge")).toEqual({ block_class: "task", block_target: "pr", blocked_on_pr: 12 });
    expect(blockFacts("needs the owner's approval")).toEqual({ block_class: "owner", block_target: "unknown", blocked_on_pr: null });
    expect(blockFacts("host load too high to run the suite")).toEqual({ block_class: "environment", block_target: "host_load", blocked_on_pr: null });
    expect(blockFacts("docker daemon is not running")).toEqual({ block_class: "environment", block_target: "environment", blocked_on_pr: null });
    expect(blockFacts("something odd happened")).toEqual({ block_class: "task", block_target: "unknown", blocked_on_pr: null });
    // "load" as a verb is not the machine's load
    expect(blockFacts("the fixtures fail to load, waiting on design")).toEqual({ block_class: "task", block_target: "unknown", blocked_on_pr: null });
    expect(blockFacts("load average 9.1 on the runner")).toMatchObject({ block_target: "host_load" });
  });

  it("blockReason: only the reason is read, never the task id or the agent's name", () => {
    // A task id that holds 'load' or 'account' changes nothing
    expect(blockFacts(blockReason("- BLOCKED load-test-suite by worker-a 12:01Z: something odd happened", undefined))).toEqual({
      block_class: "task",
      block_target: "unknown",
      blocked_on_pr: null,
    });
    expect(blockFacts(blockReason("- BLOCKED account-settings by worker-a: waiting on PR #12", undefined))).toEqual({
      block_class: "task",
      block_target: "pr",
      blocked_on_pr: 12,
    });
    // A bus report's summary is its reason
    expect(blockReason("- BLOCKED feat-login by worker-a: mirrored text", "needs the owner")).toBe("needs the owner");
  });

  it("readOrNull: a reader that throws is a fact that cannot be read", () => {
    expect(readOrNull(() => 3)).toBe(3);
    expect(
      readOrNull(() => {
        throw new Error("SQLITE_BUSY");
      }),
    ).toBeNull();
  });

  it("blockerCleared: only a load block reads cleared here; owner, unknown, PR and environment are null", () => {
    expect(blockerCleared("environment", "host_load", true)).toBe(true);
    expect(blockerCleared("environment", "host_load", false)).toBe(false);
    expect(blockerCleared("environment", "host_load", null)).toBeNull();
    expect(blockerCleared("owner", "host_load", true)).toBeNull();
    expect(blockerCleared("task", "unknown", true)).toBeNull();
    expect(blockerCleared("task", "pr", true)).toBeNull();
    expect(blockerCleared("environment", "environment", true)).toBeNull();
    expect(blockerCleared(undefined, undefined, true)).toBeNull();
  });

  it("taskStateOf: done is closed, only another agent's line is reassigned, no line is undefined", () => {
    expect(taskStateOf([line({})], "feat-login", "worker-a")).toBe("open");
    expect(taskStateOf([line({ state: "done" })], "feat-login", "worker-a")).toBe("closed");
    expect(taskStateOf([line({ agent: "worker-c", state: "not_allowlisted" })], "feat-login", "worker-a")).toBe("reassigned");
    expect(taskStateOf([line({ agent: null, state: "unassigned" })], "feat-login", "worker-a")).toBe("open");
    expect(taskStateOf([line({ task: "feat-search" })], "feat-login", "worker-a")).toBeUndefined();
    expect(taskStateOf([], "feat-login", "worker-a")).toBeUndefined();
  });

  it("limitResetPassed: from the reset time, null without one", () => {
    const now = Date.parse("2026-03-02T12:00:00Z");
    expect(limitResetPassed("2026-03-02T11:59:00Z", now)).toBe(true);
    expect(limitResetPassed("2026-03-02T12:01:00Z", now)).toBe(false);
    expect(limitResetPassed(null, now)).toBeNull();
    expect(limitResetPassed("soon", now)).toBeNull();
  });

  it("raiseFacts: each code gets its own facts, and no prose", () => {
    const now = Date.parse("2026-03-02T12:00:00Z");
    const noHead = { review_at_head: null, gate_at_head: null, hold_on_pr: null, next_move: null };
    expect(raiseFacts({ code: "repeated_failure", taskState: "open", pr: null, freshSessions: 1, now })).toEqual({
      task_state: "open",
      pr: null,
      fresh_sessions: 1,
      ...noHead,
    });
    expect(raiseFacts({ code: "provider_limit", taskState: null, pr: null, freshSessions: 0, limitResetsAt: "2026-03-02T11:00:00.000Z", now })).toEqual({
      task_state: null,
      pr: null,
      fresh_sessions: 0,
      ...noHead,
      limit_resets_at: "2026-03-02T11:00:00.000Z",
      limit_reset_passed: true,
    });
    expect(raiseFacts({ code: "blocked_reported", taskState: "open", pr: 12, freshSessions: 0, blockedReason: "waiting on PR #12", loadOk: true, now })).toEqual({
      task_state: "open",
      pr: 12,
      fresh_sessions: 0,
      // A PR that was not read: nothing is known at its head
      ...noHead,
      block_class: "task",
      block_target: "pr",
      blocked_on_pr: 12,
      blocker_cleared: null,
    });
    // Read: the run's PR at its head, and the PR the block waits on (merged: cleared)
    const open = view({ verdicts: ["request_changes"], gate: ["missing"] });
    expect(
      raiseFacts({ code: "blocked_reported", taskState: "open", pr: 12, freshSessions: 0, blockedReason: "waiting on PR #9", prView: open, blockedPrView: view({ state: "merged" }), now }),
    ).toMatchObject({ review_at_head: "request_changes", gate_at_head: "none", hold_on_pr: "none", next_move: "agent", block_target: "pr", blocked_on_pr: 9, blocker_cleared: true });
  });

  it("LOAD_REFERENCE: only a phrase that means the machine's load; a load test or cpu profiling is not one", () => {
    for (const reason of ["load per cpu is 2.3", "load average 9.1", "host load too high", "the runner load is above the limit", "high system load on the box", "machine load was too high"]) {
      expect(blockFacts(reason).block_target, reason).toBe("host_load");
    }
    for (const reason of [
      "the load test is over budget",
      "cpu profiling handed over to the owner",
      "a cpu-heavy step runs over the limit",
      "the page loads too slowly",
      "the page load is above the 3 s budget",
      "the high load test scenario fails",
      "the load is too high for the fixture",
      "load > 4 items per page",
    ]) {
      expect(blockFacts(reason).block_target, reason).not.toBe("host_load");
    }
  });
});

const view = (over: Partial<PrHeadView> = {}): PrHeadView => ({
  state: "open",
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  verdicts: [],
  gate: ["missing"],
  holds: [],
  ...over,
});

describe("evidence v3 at a PR's head", () => {
  it("reviewAtHead: changes requested by anyone wins, then an approval; nothing read is null", () => {
    expect(reviewAtHead(view({ verdicts: ["approve", "request_changes"] }))).toBe("request_changes");
    expect(reviewAtHead(view({ verdicts: ["approve"] }))).toBe("approve");
    expect(reviewAtHead(view())).toBe("none");
    expect(reviewAtHead(null)).toBeNull();
    expect(reviewAtHead(view({ headSha: null }))).toBeNull();
  });

  it("gateAtHead: a failure wins, then a gate still running, then every one passed; no gate required is null", () => {
    expect(gateAtHead(view({ gate: ["passed", "failed", "pending"] }))).toBe("fail");
    expect(gateAtHead(view({ gate: ["passed", "pending"] }))).toBe("queued");
    expect(gateAtHead(view({ gate: ["passed", "passed"] }))).toBe("pass");
    expect(gateAtHead(view({ gate: ["passed", "missing"] }))).toBe("none");
    expect(gateAtHead(view({ gate: null }))).toBeNull();
    expect(gateAtHead(view({ gate: [] }))).toBeNull();
    expect(gateAtHead(null)).toBeNull();
  });

  it("holdOnPr: a role, never a name: the owner's browser wins, then any other caller, then an agent's own word", () => {
    expect(holdOnPr(view({ holds: [{ byOwner: false, by: "worker-a" }, { byOwner: true, by: "someone" }] }), ["worker-a"])).toBe("owner");
    expect(holdOnPr(view({ holds: [{ byOwner: false, by: "worker-a" }, { byOwner: false, by: "release-bot" }] }), ["worker-a"])).toBe("orchestrator");
    // Only the signed-in browser makes a hold the owner's: the word "owner" from any caller does not
    expect(holdOnPr(view({ holds: [{ byOwner: false, by: "owner" }] }), ["worker-a"])).toBe("orchestrator");
    expect(holdOnPr(view({ holds: [{ byOwner: false, by: "worker-a" }] }), ["worker-a"])).toBe("agent");
    expect(holdOnPr(view(), ["worker-a"])).toBe("none");
    expect(holdOnPr(null, ["worker-a"])).toBeNull();
  });

  it("nextMove: the spec's order (null first: no PR, a failing gate, an owner's or an unread hold)", () => {
    const at = (review: "approve" | "request_changes" | "none" | null, gate: "pass" | "fail" | "queued" | "none" | null, hold: "owner" | "orchestrator" | "policy" | "agent" | "none" | null, pr: number | null = 12) =>
      nextMove({ pr, state: "open", review, gate, hold });
    // A merged, closed or unread PR has no next move on it
    for (const state of ["merged", "closed", null] as const) expect(nextMove({ pr: 12, state, review: "request_changes", gate: "none", hold: "none" })).toBeNull();
    expect(at("request_changes", "none", "none", null)).toBeNull();
    expect(at("request_changes", "fail", "none")).toBeNull();
    expect(at("request_changes", "none", "owner")).toBeNull();
    expect(at("request_changes", "none", null)).toBeNull();
    expect(at("none", "queued", "none")).toBe("other");
    expect(at("request_changes", "none", "orchestrator")).toBe("other");
    expect(at("request_changes", "none", "policy")).toBe("other");
    expect(at("request_changes", "none", "agent")).toBe("other");
    expect(at("approve", "pass", "none")).toBe("other");
    expect(at("request_changes", "pass", "none")).toBe("agent");
    expect(at(null, "none", "none")).toBe("agent");
    expect(at("approve", null, "none")).toBeNull();
    expect(at(null, null, "none")).toBeNull();
    expect(at("none", "pass", "none")).toBeNull();
  });

  it("headFacts: without a PR every fact is null, whatever was read", () => {
    expect(headFacts(null, view({ verdicts: ["approve"], gate: ["passed"] }), [])).toEqual({ review_at_head: null, gate_at_head: null, hold_on_pr: null, next_move: null });
    expect(headFacts(12, null, [])).toEqual({ review_at_head: null, gate_at_head: null, hold_on_pr: null, next_move: null });
    // Closed over a request for changes: the facts are what was read, and no one moves next
    expect(headFacts(12, view({ state: "closed", verdicts: ["request_changes"] }), [])).toEqual({ review_at_head: "request_changes", gate_at_head: "none", hold_on_pr: "none", next_move: null });
  });

  it("PrReader: bounded; after a failure or a timeout every read is null for a minute (one wait, not one per decision); one read per PR per batch", async () => {
    let t = 0;
    let calls = 0;
    let answer: () => Promise<PrHeadView | null> = async () => view();
    const reader = new PrReader("demo", () => ({ pr: () => (calls++, answer()) }), () => t, 20);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await reader.read(12)).toEqual(view());
      answer = () => new Promise<PrHeadView>(() => undefined);
      expect(await reader.read(12)).toBeNull();
      expect(calls).toBe(2);
      // Backing off: no read at all
      answer = async () => view();
      t += PR_FACTS_BACKOFF_MS - 1;
      expect(await reader.read(13)).toBeNull();
      expect(calls).toBe(2);
      t += 1;
      expect(await reader.read(13)).toEqual(view());
      answer = () => Promise.reject(new Error("401 Bad credentials"));
      expect(await reader.read(13)).toBeNull();
      t += PR_FACTS_BACKOFF_MS;
      expect(await reader.read(13)).toBeNull();
      // Logged once per error, with the PR and never more than the error's first line
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        "[agents] demo: could not read PR #12 for a decision's facts (null for a minute): no answer within 20 ms",
        "[agents] demo: could not read PR #13 for a decision's facts (null for a minute): 401 Bad credentials",
      ]);
    } finally {
      warn.mockRestore();
    }
    t += PR_FACTS_BACKOFF_MS;
    answer = async () => view();
    const batch = reader.batch();
    calls = 0;
    await Promise.all([batch(12), batch(12), batch(null), batch(14)]);
    expect(calls).toBe(2);
    // No source wired: null, nothing read
    expect(await new PrReader("demo", () => undefined, () => 0).read(12)).toBeNull();
  });

  it("blockerCleared for a PR: merged or closed is cleared, open is not, unread is null", () => {
    expect(blockerCleared("task", "pr", null, view({ state: "merged" }))).toBe(true);
    expect(blockerCleared("task", "pr", null, view({ state: "closed" }))).toBe(true);
    expect(blockerCleared("task", "pr", null, view())).toBe(false);
    expect(blockerCleared("task", "pr", null, view({ state: null }))).toBeNull();
    expect(blockerCleared("task", "pr", null, null)).toBeNull();
    // Only a person clears an owner block, whatever the PR
    expect(blockerCleared("owner", "pr", null, view({ state: "merged" }))).toBeNull();
  });

  it("readPr: a source that throws, rejects or does not answer in time is null; no PR reads nothing", async () => {
    let calls = 0;
    const ok = { pr: async () => (calls++, view()) };
    expect(await readPr(ok, "demo", 12)).toEqual(view());
    expect(await readPr(ok, "demo", null)).toBeNull();
    expect(await readPr(undefined, "demo", 12)).toBeNull();
    expect(calls).toBe(1);
    expect(await readPr({ pr: () => Promise.reject(new Error("502 from the host")) }, "demo", 12)).toBeNull();
    expect(
      await readPr(
        {
          pr: () => {
            throw new Error("sync");
          },
        },
        "demo",
        12,
      ),
    ).toBeNull();
    expect(await readPr({ pr: () => new Promise<PrHeadView>(() => undefined) }, "demo", 12, 20)).toBeNull();
  });
});
