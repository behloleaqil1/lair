/**
 * Evidence v3's pure readers (docs/design/decision-brain.md §4.1): what a report line names, what a BLOCKED line
 * waits on, the task's state in one check's lines, and a limit's reset. A fact that cannot be read is null.
 */
import { describe, expect, it } from "vitest";
import type { FillLineView } from "../../shared/agents-types.js";
import { blockFacts, blockerCleared, limitResetPassed, prOfLine, raiseFacts, taskStateOf } from "./brain-facts.js";

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
    expect(raiseFacts({ code: "blocked_reported", taskState: "open", pr: 12, freshSessions: 0, blockedLine: "waiting on PR #12", loadOk: true, now })).toEqual({
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
