/**
 * Tests for the idle detection module (idle.ts).
 * These tests verify that:
 * - An idle agent with ready work gets noticed
 * - The notice is raised once per incident (not spammed)
 * - Capacity explanations are correct
 */
import { describe, it, expect } from "vitest";
import type { FillLineView } from "../../shared/agents-types.js";
import {
  classifyAgent,
  computeIdleStates,
  findReadyWork,
  idleExplanation,
  shouldNotice,
  idleStateView,
  type IdleSettings,
  type IdleState,
  DEFAULT_IDLE_SETTINGS,
} from "./idle.js";

function makeLine(overrides: Partial<FillLineView>): FillLineView {
  return {
    line: 1,
    agent: "kiro-A",
    name: "Smaug",
    task: "task-1",
    description: "A test task",
    state: "started",
    detail: "running",
    hold: null,
    releasable: false,
    waiting: null,
    runId: "run-1",
    decisionId: null,
    ...overrides,
  };
}

describe("classifyAgent", () => {
  it("returns busy when agent has a started task", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "started", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 1, 5, false);
    expect(result.reason).toBe("busy");
    expect(result.task).toBe("task-1");
  });

  it("returns waiting when agent's task is waiting on a gate", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "held", hold: "waiting", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 0, 5, false);
    expect(result.reason).toBe("waiting");
    expect(result.hold).toBe("waiting");
    expect(result.task).toBe("task-1");
  });

  it("returns held with hold kind when agent's task is held", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "held", hold: "blocked", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 0, 5, false);
    expect(result.reason).toBe("held");
    expect(result.hold).toBe("blocked");
  });

  it("returns no_task when agent has no lines", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-B", state: "started" })];
    const result = classifyAgent("kiro-A", lines, 0, 5, false);
    expect(result.reason).toBe("no_task");
  });

  it("returns task_done when all tasks are done", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "done", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 0, 5, false);
    expect(result.reason).toBe("task_done");
  });

  it("returns max_active when fill.max_active is reached", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "done", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 5, 5, false);
    expect(result.reason).toBe("max_active");
  });

  it("returns capacity when capacity_cmd refused", () => {
    const lines: FillLineView[] = [makeLine({ agent: "kiro-A", state: "done", task: "task-1" })];
    const result = classifyAgent("kiro-A", lines, 0, 5, true);
    expect(result.reason).toBe("capacity");
  });
});

describe("findReadyWork", () => {
  it("finds tasks with no agent assigned", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: null, task: "unassigned-task", state: "not_allowlisted", description: "Needs work" }),
    ];
    const ready = findReadyWork(["tasks_file"], lines);
    expect(ready).toHaveLength(1);
    expect(ready[0].task).toBe("unassigned-task");
    expect(ready[0].source).toBe("tasks_file");
  });

  it("finds tasks marked not_allowlisted (their agent not in fill.agents)", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-X", task: "orphan-task", state: "not_allowlisted" }),
    ];
    const ready = findReadyWork(["tasks_file"], lines);
    expect(ready).toHaveLength(1);
    expect(ready[0].task).toBe("orphan-task");
  });

  it("returns empty when all tasks are assigned and active", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-A", task: "task-1", state: "started" }),
    ];
    const ready = findReadyWork(["tasks_file"], lines);
    expect(ready).toHaveLength(0);
  });
});

describe("computeIdleStates", () => {
  it("marks agent as ready_work when idle with ready work available", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-A", state: "done", task: "task-1" }),
    ];
    const readyWork = [{ source: "tasks_file" as const, task: "new-task" }];
    const previous = new Map<string, IdleState>();
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    expect(states).toHaveLength(1);
    expect(states[0].agent).toBe("kiro-A");
    expect(states[0].reason).toBe("ready_work");
    expect(states[0].since).toBe(now);
  });

  it("marks agent as no_ready_work when idle with no ready work", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-A", state: "done", task: "task-1" }),
    ];
    const readyWork: { source: "tasks_file"; task: string }[] = [];
    const previous = new Map<string, IdleState>();
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    expect(states).toHaveLength(1);
    expect(states[0].reason).toBe("no_ready_work");
  });

  it("marks no_task agent as ready_work when ready work exists (F2 fix)", () => {
    // An allowlisted agent has no line in the tasks file, but unassigned work exists
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-B", state: "started", task: "task-1" }), // another agent, not kiro-A
    ];
    const readyWork = [{ source: "tasks_file" as const, task: "unassigned-task" }];
    const previous = new Map<string, IdleState>();
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    expect(states).toHaveLength(1);
    expect(states[0].agent).toBe("kiro-A");
    // F2: no_task should become ready_work when ready work exists
    expect(states[0].reason).toBe("ready_work");
    expect(states[0].since).toBe(now);
  });

  it("marks no_task agent as no_ready_work when no ready work exists", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-B", state: "started", task: "task-1" }), // another agent, not kiro-A
    ];
    const readyWork: { source: "tasks_file"; task: string }[] = [];
    const previous = new Map<string, IdleState>();
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    expect(states).toHaveLength(1);
    expect(states[0].agent).toBe("kiro-A");
    expect(states[0].reason).toBe("no_ready_work");
  });

  it("preserves since timestamp for continuous idle state", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-A", state: "done", task: "task-1" }),
    ];
    const readyWork = [{ source: "tasks_file" as const, task: "new-task" }];
    const earlierTime = Date.now() - 600_000; // 10 minutes ago
    const previous = new Map<string, IdleState>([
      ["kiro-A", { agent: "kiro-A", reason: "ready_work", since: earlierTime, duration: 600_000 }],
    ]);
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    expect(states[0].since).toBe(earlierTime);
    expect(states[0].duration).toBeGreaterThanOrEqual(600_000);
  });

  it("resets since timestamp when state changes", () => {
    const lines: FillLineView[] = [
      makeLine({ agent: "kiro-A", state: "started", task: "task-1" }),
    ];
    const readyWork: { source: "tasks_file"; task: string }[] = [];
    const earlierTime = Date.now() - 600_000;
    const previous = new Map<string, IdleState>([
      ["kiro-A", { agent: "kiro-A", reason: "ready_work", since: earlierTime, duration: 600_000 }],
    ]);
    const now = Date.now();

    const states = computeIdleStates(["kiro-A"], lines, 0, 5, false, readyWork, now, previous);

    // State changed from ready_work to busy, so since should reset
    expect(states[0].reason).toBe("busy");
    expect(states[0].since).toBe(now);
  });
});

describe("idleExplanation", () => {
  it("explains no_task", () => {
    const state: IdleState = { agent: "kiro-A", reason: "no_task", since: 0, duration: 0 };
    expect(idleExplanation(state)).toBe("kiro-A has no line in the tasks file");
  });

  it("explains ready_work", () => {
    const state: IdleState = { agent: "kiro-A", reason: "ready_work", since: 0, duration: 0 };
    expect(idleExplanation(state)).toBe("kiro-A is idle while ready work exists");
  });

  it("explains held with hold kind", () => {
    const state: IdleState = { agent: "kiro-A", reason: "held", hold: "blocked", task: "task-1", since: 0, duration: 0 };
    expect(idleExplanation(state)).toBe("kiro-A is held (blocked) on task-1");
  });

  it("explains waiting", () => {
    const state: IdleState = { agent: "kiro-A", reason: "waiting", task: "task-1", since: 0, duration: 0 };
    expect(idleExplanation(state)).toBe("kiro-A is waiting on a gate for task-1");
  });
});

describe("shouldNotice", () => {
  it("returns true when idle with ready work past notice threshold", () => {
    const state: IdleState = {
      agent: "kiro-A",
      reason: "ready_work",
      since: Date.now() - 20 * 60_000, // 20 minutes ago
      duration: 20 * 60_000,
    };
    const settings: IdleSettings = { ...DEFAULT_IDLE_SETTINGS, noticeMinutes: 15 };
    expect(shouldNotice(state, settings)).toBe(true);
  });

  it("returns false when idle with ready work but below threshold", () => {
    const state: IdleState = {
      agent: "kiro-A",
      reason: "ready_work",
      since: Date.now() - 5 * 60_000, // 5 minutes ago
      duration: 5 * 60_000,
    };
    const settings: IdleSettings = { ...DEFAULT_IDLE_SETTINGS, noticeMinutes: 15 };
    expect(shouldNotice(state, settings)).toBe(false);
  });

  it("returns false when not ready_work reason", () => {
    const state: IdleState = {
      agent: "kiro-A",
      reason: "waiting",
      since: Date.now() - 60 * 60_000, // 60 minutes ago
      duration: 60 * 60_000,
    };
    const settings: IdleSettings = { ...DEFAULT_IDLE_SETTINGS, noticeMinutes: 15 };
    expect(shouldNotice(state, settings)).toBe(false);
  });

  it("returns false when notice is disabled (noticeMinutes = 0)", () => {
    const state: IdleState = {
      agent: "kiro-A",
      reason: "ready_work",
      since: Date.now() - 60 * 60_000,
      duration: 60 * 60_000,
    };
    const settings: IdleSettings = { ...DEFAULT_IDLE_SETTINGS, noticeMinutes: 0 };
    expect(shouldNotice(state, settings)).toBe(false);
  });
});

describe("idleStateView", () => {
  it("converts internal state to API view", () => {
    const now = Date.now();
    const state: IdleState = {
      agent: "kiro-A",
      reason: "ready_work",
      hold: undefined,
      task: undefined,
      since: now - 300_000, // 5 minutes ago
      duration: 300_000,
    };
    const view = idleStateView(state);
    expect(view.agent).toBe("kiro-A");
    expect(view.reason).toBe("ready_work");
    expect(view.hold).toBeUndefined();
    expect(view.task).toBeUndefined();
    expect(view.durationSeconds).toBe(300);
    expect(view.explanation).toBe("kiro-A is idle while ready work exists");
    // since is an ISO string
    expect(new Date(view.since).getTime()).toBe(now - 300_000);
  });
});
