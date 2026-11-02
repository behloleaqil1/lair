/**
 * Idle detection (idle.ts), on lines shaped as fill.ts shows them. The
 * acceptance tests (acceptance.test.ts, "idle detection") drive the same
 * through fill's real check, tasks file and queue file.
 */
import { describe, expect, it } from "vitest";
import type { FillLineView } from "../../shared/agents-types.js";
import {
  classifyAgent,
  computeIdleStates,
  findReadyWork,
  idleExplanation,
  idleStateView,
  shouldNotice,
  type IdleInput,
  type IdleState,
} from "./idle.js";

const MIN = 60_000;
const NOW = Date.parse("2026-01-01T12:00:00Z");

function line(overrides: Partial<FillLineView>): FillLineView {
  return {
    line: 1,
    agent: "worker-a",
    name: "A",
    task: "task-1",
    description: "A task",
    state: "started",
    detail: "",
    hold: null,
    releasable: false,
    waiting: null,
    runId: null,
    decisionId: null,
    ...overrides,
  };
}

const unassigned = (task: string, ready = true): FillLineView =>
  line({ agent: null, name: "", task, state: "unassigned", ready, detail: ready ? "no agent assigned" : "not ready" });

function input(lines: FillLineView[], more: Partial<IdleInput> = {}): IdleInput {
  return { lines, busy: new Set(), activeCount: 0, maxActive: 5, capacityRefused: false, readOnly: false, ...more };
}

describe("classifyAgent", () => {
  it("an active run is busy, whatever its lines say (a run with no line, an owner's run)", () => {
    expect(classifyAgent("worker-a", input([line({ state: "started" })]))).toEqual({ reason: "busy", task: "task-1" });
    expect(classifyAgent("worker-a", input([], { busy: new Set(["worker-a"]) }))).toEqual({ reason: "busy" });
    // A held line before its started one in file order is still busy (the started line wins)
    const lines = [line({ task: "t-held", state: "held", hold: "backoff" }), line({ task: "t-run", state: "started" })];
    expect(classifyAgent("worker-a", input(lines)).reason).toBe("busy");
    // Ids compare case-insensitively, as fill's do
    expect(classifyAgent("Worker-A", input([], { busy: new Set(["worker-a"]) })).reason).toBe("busy");
  });

  it("a wait comes first, then max_active, then capacity, then any other hold", () => {
    const held = (hold: FillLineView["hold"], task: string) => line({ task, state: "held", hold });
    expect(classifyAgent("worker-a", input([held("blocked", "a"), held("waiting", "b")]))).toEqual({ reason: "waiting", hold: "waiting", task: "b" });
    expect(classifyAgent("worker-a", input([held("blocked", "a"), held("max_active", "b")]))).toEqual({ reason: "max_active", hold: "max_active", task: "b" });
    expect(classifyAgent("worker-a", input([held("capacity_load", "a")]))).toEqual({ reason: "capacity", hold: "capacity_load", task: "a" });
    expect(classifyAgent("worker-a", input([held("paused", "a")]))).toEqual({ reason: "held", hold: "paused", task: "a" });
    expect(classifyAgent("worker-a", input([held("read_only", "a")]))).toEqual({ reason: "held", hold: "read_only", task: "a" });
  });

  it("with nothing of its own: read_only, max_active and capacity_cmd explain it before no_task, task_done, no_ready_work", () => {
    const done = [line({ state: "done" })];
    expect(classifyAgent("worker-a", input(done, { readOnly: true }))).toEqual({ reason: "held", hold: "read_only" });
    expect(classifyAgent("worker-a", input(done, { activeCount: 2, maxActive: 2 }))).toEqual({ reason: "max_active" });
    expect(classifyAgent("worker-a", input(done, { capacityRefused: true }))).toEqual({ reason: "capacity" });
    expect(classifyAgent("worker-a", input(done))).toEqual({ reason: "task_done", task: "task-1" });
    expect(classifyAgent("worker-a", input([line({ agent: "worker-b" })]))).toEqual({ reason: "no_task" });
    expect(classifyAgent("worker-a", input([line({ state: "claimed" })]))).toEqual({ reason: "no_ready_work" });
    // A malformed line has no agent: it isn't the agent's line
    expect(classifyAgent("worker-a", input([line({ agent: null, task: null, state: "malformed" })]))).toEqual({ reason: "no_task" });
  });
});

describe("findReadyWork", () => {
  it("only open unassigned lines are ready work: never not_allowlisted, done, claimed, not-ready or malformed lines", () => {
    const lines = [
      unassigned("open-1"),
      unassigned("waiting-1", false),
      line({ agent: null, task: "done-1", state: "done" }),
      line({ agent: null, task: "claimed-1", state: "claimed" }),
      line({ agent: "outside-agent", task: "theirs-1", state: "not_allowlisted" }),
      line({ agent: null, task: null, state: "malformed", detail: "longer than 2000 characters: ..." }),
      unassigned("open-2"),
    ];
    expect(findReadyWork(["tasks_file"], lines)).toEqual([
      { source: "tasks_file", task: "open-1" },
      { source: "tasks_file", task: "open-2" },
    ]);
    expect(findReadyWork([], lines)).toEqual([]);
  });
});

describe("computeIdleStates", () => {
  const agents = ["worker-a", "worker-b"];

  it("an agent with nothing of its own is ready_work while ready work exists, with its cause and the ready tasks", () => {
    const lines = [line({ state: "done" }), unassigned("free-1")];
    const ready = findReadyWork(["tasks_file"], lines);
    const [a, b] = computeIdleStates(agents, input(lines), ready, NOW, new Map());
    expect(a).toMatchObject({ agent: "worker-a", reason: "ready_work", cause: "task_done", readyTasks: ["free-1"], since: NOW, duration: 0 });
    // No line at all is the plainest case
    expect(b).toMatchObject({ agent: "worker-b", reason: "ready_work", cause: "no_task", readyTasks: ["free-1"] });
    expect(idleExplanation(b)).toBe("worker-b has no line in the tasks file, while ready work exists: unassigned free-1");
  });

  it("without ready work it keeps its own reason; busy, waiting and held agents never become ready_work", () => {
    expect(computeIdleStates(agents, input([line({ state: "done" })]), [], NOW, new Map()).map((s) => s.reason)).toEqual(["task_done", "no_task"]);
    const lines = [line({ state: "held", hold: "waiting" }), line({ agent: "worker-b", task: "t-b", state: "held", hold: "no_done" }), unassigned("free-1")];
    const ready = findReadyWork(["tasks_file"], lines);
    expect(computeIdleStates(agents, input(lines), ready, NOW, new Map()).map((s) => s.reason)).toEqual(["waiting", "held"]);
    expect(computeIdleStates(agents, input([unassigned("free-1")], { activeCount: 5 }), ready, NOW, new Map()).map((s) => s.reason)).toEqual([
      "max_active",
      "max_active",
    ]);
    expect(computeIdleStates(agents, input([unassigned("free-1")], { readOnly: true }), ready, NOW, new Map()).map((s) => s.reason)).toEqual([
      "held",
      "held",
    ]);
  });

  it("since carries over while the reason stays, and starts again when it changes", () => {
    const lines = [unassigned("free-1")];
    const ready = findReadyWork(["tasks_file"], lines);
    const first = computeIdleStates(["worker-a"], input(lines), ready, NOW, new Map());
    const previous = new Map(first.map((s) => [s.agent, s]));
    const [later] = computeIdleStates(["worker-a"], input(lines), ready, NOW + 7 * MIN, previous);
    expect(later).toMatchObject({ reason: "ready_work", since: NOW, duration: 7 * MIN });
    const [busy] = computeIdleStates(["worker-a"], input(lines, { busy: new Set(["worker-a"]) }), ready, NOW + 8 * MIN, previous);
    expect(busy).toMatchObject({ reason: "busy", since: NOW + 8 * MIN, duration: 0 });
  });
});

describe("shouldNotice and the view", () => {
  const state = (reason: IdleState["reason"], duration: number): IdleState => ({ agent: "worker-a", reason, since: NOW, duration, readyTasks: ["free-1"] });

  it("only ready_work, only past notice_minutes, and never with notices off", () => {
    expect(shouldNotice(state("ready_work", 15 * MIN), { noticeMinutes: 15 })).toBe(true);
    expect(shouldNotice(state("ready_work", 15 * MIN - 1), { noticeMinutes: 15 })).toBe(false);
    expect(shouldNotice(state("ready_work", 600 * MIN), { noticeMinutes: 0 })).toBe(false);
    for (const reason of ["busy", "waiting", "held", "max_active", "capacity", "no_task", "task_done", "no_ready_work"] as const) {
      expect(shouldNotice(state(reason, 600 * MIN), { noticeMinutes: 15 })).toBe(false);
    }
  });

  it("the view carries the reason, the ready tasks and a plain explanation", () => {
    expect(idleStateView({ ...state("ready_work", 90_000), cause: "no_task" })).toEqual({
      agent: "worker-a",
      reason: "ready_work",
      since: new Date(NOW).toISOString(),
      durationSeconds: 90,
      readyTasks: ["free-1"],
      explanation: "worker-a has no line in the tasks file, while ready work exists: unassigned free-1",
    });
    expect(idleStateView({ agent: "worker-a", reason: "held", hold: "paused", task: "t-1", since: NOW, duration: 0 }).explanation).toBe(
      "worker-a is held (paused) on t-1",
    );
  });
});
