/**
 * Idle detection and side tasks (docs/design/ROADMAP.md N9, never-idle):
 * no agent idles while ready work exists.
 *
 * On each fill check, for every allowlisted agent:
 * 1. Is it idle? (no active run, no open task in the tasks file)
 * 2. If idle, is there ready work? (tasks file, backlog, tracker issues)
 * 3. If ready work exists, how long has it been idle?
 * 4. Idle past fill.idle.notice_minutes -> one notice per agent
 *
 * Side tasks:
 * - An agent whose task is waiting on a gate may run ONE side task from
 *   fill.side_queue, bounded to finish before its gate usually ends
 * - The main task resumes first when its gate lands
 *
 * Capacity explanation:
 * - Every agent's idle reason is computed: max_active, capacity, holds,
 *   launcher, or "no ready work"
 */
import type { FillLineView, FillHold, IdleReason, IdleStateView } from "../../shared/agents-types.js";

export type { IdleReason };

/** Internal idle state, kept in memory across checks */
export interface IdleState {
  agent: string;
  reason: IdleReason;
  /** The hold kind when reason is "held" */
  hold?: FillHold;
  /** The task it would work on, when held or waiting */
  task?: string;
  /** When it became idle (ms), for notice timing */
  since: number;
  /** How long it has been idle (ms) */
  duration: number;
}

export interface ReadyWork {
  source: "tasks_file" | "backlog" | "tracker";
  task: string;
  description?: string;
  priority?: number;
}

/** Settings for the idle detection (fill.idle in config). */
export interface IdleSettings {
  /** Idle past this raises one notice per agent (minutes); 0 = off */
  noticeMinutes: number;
  /** Check for ready work from these sources */
  readySources: ("tasks_file" | "backlog" | "tracker")[];
}

export const DEFAULT_IDLE_SETTINGS: IdleSettings = {
  noticeMinutes: 15,
  readySources: ["tasks_file"],
};

/**
 * Classify one agent's state from the fill lines.
 * Returns the idle reason and, when appropriate, the task and hold.
 */
export function classifyAgent(
  agent: string,
  lines: FillLineView[],
  activeCount: number,
  maxActive: number,
  capacityRefused: boolean,
): { reason: IdleReason; hold?: FillHold; task?: string } {
  // Find this agent's lines
  const agentLines = lines.filter((l) => l.agent?.toLowerCase() === agent.toLowerCase());

  if (agentLines.length === 0) {
    return { reason: "no_task" };
  }

  // Check each line's state
  for (const line of agentLines) {
    if (line.state === "started") {
      // Agent is working, not idle
      return { reason: "busy", task: line.task ?? undefined };
    }
    if (line.state === "held" && line.hold === "waiting") {
      return { reason: "waiting", task: line.task ?? undefined, hold: "waiting" };
    }
    if (line.state === "held" && line.hold) {
      return { reason: "held", task: line.task ?? undefined, hold: line.hold };
    }
    if (line.state === "done") {
      continue; // Check other lines
    }
    if (line.state === "claimed") {
      // Another agent has this task
      continue;
    }
    if (line.state === "not_allowlisted") {
      continue;
    }
    if (line.state === "malformed") {
      continue;
    }
  }

  // Agent has no active work - check why it isn't starting
  if (activeCount >= maxActive) {
    return { reason: "max_active" };
  }
  if (capacityRefused) {
    return { reason: "capacity" };
  }

  // All tasks done or not available
  const allDone = agentLines.every((l) => l.state === "done" || l.state === "malformed" || l.state === "not_allowlisted");
  if (allDone) {
    return { reason: "task_done" };
  }

  // No obvious reason - will check for ready work
  return { reason: "no_ready_work" };
}

/**
 * Find ready work from the available sources.
 * Ready work is a task that:
 * - Is not assigned to any agent (unassigned state), OR
 * - Has an agent not in fill.agents (not_allowlisted state)
 * - Is not done
 * - Has no unmet dependencies (in the plan)
 */
export function findReadyWork(
  sources: IdleSettings["readySources"],
  tasksFileLines: FillLineView[],
  _backlogTasks?: { task: string; description?: string; priority?: number }[],
  _trackerIssues?: { task: string; description?: string; priority?: number }[],
): ReadyWork[] {
  const ready: ReadyWork[] = [];

  if (sources.includes("tasks_file")) {
    // Tasks in the tasks file that are unassigned OR not_allowlisted (ready for any agent)
    for (const line of tasksFileLines) {
      if ((line.state === "unassigned" || line.state === "not_allowlisted") && line.task) {
        ready.push({
          source: "tasks_file",
          task: line.task,
          description: line.description ?? undefined,
        });
      }
    }
  }

  // TODO: Add backlog and tracker sources in future PRs
  // These require reading the plan sources (planner module integration)

  return ready;
}

/**
 * Compute the idle states for all allowlisted agents.
 */
export function computeIdleStates(
  allowedAgents: string[],
  lines: FillLineView[],
  activeCount: number,
  maxActive: number,
  capacityRefused: boolean,
  readyWork: ReadyWork[],
  now: number,
  previousStates: Map<string, IdleState>,
): IdleState[] {
  const states: IdleState[] = [];
  const hasReadyWork = readyWork.length > 0;

  for (const agent of allowedAgents) {
    const { reason, hold, task } = classifyAgent(agent, lines, activeCount, maxActive, capacityRefused);

    // Determine if this is a "ready_work" idle (the problem case) or "no_ready_work"
    let finalReason = reason;
    if (reason === "task_done") {
      // Agent's tasks are done - check if ready work exists
      finalReason = hasReadyWork ? "ready_work" : "no_ready_work";
    } else if (reason === "no_ready_work" && hasReadyWork) {
      finalReason = "ready_work";
    }

    // Track since when this agent has been in this state
    const previous = previousStates.get(agent);
    const since = previous && previous.reason === finalReason ? previous.since : now;

    states.push({
      agent,
      reason: finalReason,
      hold,
      task,
      since,
      duration: now - since,
    });
  }

  return states;
}

/**
 * Human-readable explanation of why an agent is idle.
 */
export function idleExplanation(state: IdleState): string {
  switch (state.reason) {
    case "no_task":
      return `${state.agent} has no line in the tasks file`;
    case "task_done":
      return `${state.agent}'s task${state.task ? ` (${state.task})` : ""} is done, with no next task`;
    case "max_active":
      return `${state.agent} is held: fill.max_active reached`;
    case "capacity":
      return `${state.agent} is held: capacity_cmd refused`;
    case "busy":
      return `${state.agent} is working on ${state.task ?? "a task"}`;
    case "held":
      return `${state.agent} is held (${state.hold ?? "unknown"}) on ${state.task ?? "a task"}`;
    case "waiting":
      return `${state.agent} is waiting on a gate for ${state.task ?? "a task"}`;
    case "no_ready_work":
      return `${state.agent} is idle: no ready work exists`;
    case "ready_work":
      return `${state.agent} is idle while ready work exists`;
  }
}

/**
 * Check if an idle state should trigger a notice.
 */
export function shouldNotice(state: IdleState, settings: IdleSettings): boolean {
  if (settings.noticeMinutes <= 0) return false;
  if (state.reason !== "ready_work") return false;
  return state.duration >= settings.noticeMinutes * 60_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Convert an internal IdleState to the API view.
 */
export function idleStateView(state: IdleState): IdleStateView {
  return {
    agent: state.agent,
    reason: state.reason,
    hold: state.hold,
    task: state.task,
    since: iso(state.since),
    durationSeconds: Math.round(state.duration / 1000),
    explanation: idleExplanation(state),
  };
}
