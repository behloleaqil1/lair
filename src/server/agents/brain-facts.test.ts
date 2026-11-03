/**
 * Evidence v3's pure readers (docs/design/decision-brain.md §4.1): what a report line names, what a BLOCKED line
 * waits on, the task's state in one check's lines, and a limit's reset. A fact that cannot be read is null.
 */
import { describe, expect, it } from "vitest";
import type { FillLineView } from "../../shared/agents-types.js";
import { blockFacts, blockReason, blockerCleared, limitResetPassed, prOfLine, raiseFacts, readOrNull, taskStateOf } from "./brain-facts.js";

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
  it("prOfLine: a PR reference, never a bare issue number", () => {
    expect(prOfLine("- WAITING feat-login gate-1 by worker-a: PR #42 waits for review")).toBe(42);
    expect(prOfLine("opened pull request #7")).toBe(7);
    expect(prOfLine("see https://example.com/o/r/pull/913")).toBe(913);
    expect(prOfLine("PR 12 is ready")).toBe(12);
    expect(prOfLine("fixes #329")).toBeNull();
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
    expect(raiseFacts({ code: "repeated_failure", taskState: "open", pr: null, freshSessions: 1, now })).toEqual({
      task_state: "open",
      pr: null,
      fresh_sessions: 1,
    });
    expect(raiseFacts({ code: "provider_limit", taskState: null, pr: null, freshSessions: 0, limitResetsAt: "2026-03-02T11:00:00.000Z", now })).toEqual({
      task_state: null,
      pr: null,
      fresh_sessions: 0,
      limit_resets_at: "2026-03-02T11:00:00.000Z",
      limit_reset_passed: true,
    });
    expect(raiseFacts({ code: "blocked_reported", taskState: "open", pr: 12, freshSessions: 0, blockedReason: "waiting on PR #12", loadOk: true, now })).toEqual({
      task_state: "open",
      pr: 12,
      fresh_sessions: 0,
      block_class: "task",
      block_target: "pr",
      blocked_on_pr: 12,
      blocker_cleared: null,
    });
  });
});
