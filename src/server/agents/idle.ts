/**
 * Idle detection (docs/design/orchestration.md D1, observe mode): after each
 * fill check, why each allowlisted agent is or isn't working, and whether it
 * idles while ready work exists. Pure: fill.ts passes the check's lines and
 * the agents with an active run, keeps the states between checks, and raises
 * and withdraws the notice (fill_idle_notice / fill_idle_resolved).
 *
 * Ready work is an unassigned tasks_file line (an empty agent field) that
 * fill found open (FillLineView.ready): not done in the queue, no active run
 * or claim on its task, its last run not waiting or blocked. A line assigned
 * to an agent fill doesn't run is that agent's, never ready work: it may be
 * at work outside Lair, where fill can't see it. A malformed line (too long,
 * a bad id, a duplicate) is never ready work.
 */
import type { FillHold, FillLineView, IdleReason, IdleStateView } from "../../shared/agents-types.js";
import type { IdleReadySource } from "./config.js";

export type { IdleReason };

/** An agent's state, kept in memory between checks. */
export interface IdleState {
  agent: string;
  reason: IdleReason;
  /** ready_work: why it has nothing of its own (no_task, task_done or no_ready_work) */
  cause?: "no_task" | "task_done" | "no_ready_work";
  hold?: FillHold;
  task?: string;
  /** When it entered this state (ms) */
  since: number;
  /** How long it has been in it (ms) */
  duration: number;
  /** ready_work: the ready tasks' ids */
  readyTasks?: string[];
}

export interface ReadyWork {
  source: IdleReadySource;
  task: string;
}

/** fill.idle, as fill.ts reads it. */
export interface IdleSettings {
  /** An agent in ready_work this long raises one notice (minutes); 0 = off */
  noticeMinutes: number;
  readySources: IdleReadySource[];
}

/** What one check knows besides the lines. */
export interface IdleInput {
  lines: FillLineView[];
  /** The agents (lowercase) with an active run of any origin */
  busy: ReadonlySet<string>;
  /** Active runs fill started, and fill.max_active */
  activeCount: number;
  maxActive: number;
  /** capacity_cmd refused this check: no line could start */
  capacityRefused: boolean;
  /** The project is read_only: fill starts nothing */
  readOnly: boolean;
}

const MAX_READY_SHOWN = 10;

const isCapacityHold = (hold: FillHold) => hold === "capacity" || hold.startsWith("capacity_");

/**
 * One agent's state from the check: an active run first (whatever its lines
 * say), then its lines' holds (a wait, fill's limits, any other hold), then
 * what would keep it from new work (read_only, max_active, capacity_cmd).
 * Left with nothing of its own (no line, its lines done or claimed by other
 * runs), it is no_task, task_done or no_ready_work; computeIdleStates turns
 * that into ready_work when ready work exists.
 */
export function classifyAgent(agent: string, input: IdleInput): { reason: IdleReason; hold?: FillHold; task?: string } {
  const lower = agent.toLowerCase();
  const own = input.lines.filter((l) => l.agent !== null && l.agent.toLowerCase() === lower);
  const started = own.find((l) => l.state === "started");
  if (started || input.busy.has(lower)) return { reason: "busy", task: started?.task ?? undefined };

  const held = own.filter((l): l is FillLineView & { hold: FillHold } => l.state === "held" && l.hold !== null);
  const first = (match: (hold: FillHold) => boolean) => held.find((l) => match(l.hold));
  const shown = (l: FillLineView & { hold: FillHold }) => ({ hold: l.hold, task: l.task ?? undefined });
  const waiting = first((h) => h === "waiting");
  if (waiting) return { reason: "waiting", ...shown(waiting) };
  const max = first((h) => h === "max_active");
  if (max) return { reason: "max_active", ...shown(max) };
  const capacity = first(isCapacityHold);
  if (capacity) return { reason: "capacity", ...shown(capacity) };
  if (held[0]) return { reason: "held", ...shown(held[0]) };

  if (input.readOnly) return { reason: "held", hold: "read_only" };
  if (input.activeCount >= input.maxActive) return { reason: "max_active" };
  if (input.capacityRefused) return { reason: "capacity" };
  if (own.length === 0) return { reason: "no_task" };
  const done = own.filter((l) => l.state === "done");
  if (done.length === own.length) return { reason: "task_done", task: done[done.length - 1].task ?? undefined };
  return { reason: "no_ready_work" };
}

/** The ready work in the sources fill.idle names: the open unassigned lines of the tasks file. */
export function findReadyWork(sources: IdleReadySource[], lines: FillLineView[]): ReadyWork[] {
  if (!sources.includes("tasks_file")) return [];
  return lines.flatMap((l) =>
    l.state === "unassigned" && l.ready === true && l.task !== null ? [{ source: "tasks_file" as const, task: l.task }] : [],
  );
}

/**
 * Every allowlisted agent's state. `since` carries over from `previous`
 * while the reason stays the same (fill seeds it with an open notice's
 * episode after a restart), else it is `now`.
 */
export function computeIdleStates(
  agents: string[],
  input: IdleInput,
  readyWork: ReadyWork[],
  now: number,
  previous: ReadonlyMap<string, Pick<IdleState, "reason" | "since">>,
): IdleState[] {
  const readyTasks = readyWork.slice(0, MAX_READY_SHOWN).map((w) => w.task);
  return agents.map((agent) => {
    const { reason, hold, task } = classifyAgent(agent, input);
    const idle = reason === "no_task" || reason === "task_done" || reason === "no_ready_work";
    const state: IdleState =
      idle && readyWork.length > 0
        ? { agent, reason: "ready_work", cause: reason, task, readyTasks, since: now, duration: 0 }
        : { agent, reason, hold, task, since: now, duration: 0 };
    const before = previous.get(agent);
    if (before && before.reason === state.reason && before.since <= now) state.since = before.since;
    state.duration = now - state.since;
    return state;
  });
}

const CAUSE: Record<NonNullable<IdleState["cause"]>, (s: IdleState) => string> = {
  no_task: (s) => `${s.agent} has no line in the tasks file`,
  task_done: (s) => `${s.agent}'s task${s.task ? ` ${s.task}` : ""} is done`,
  no_ready_work: (s) => `${s.agent}'s tasks are claimed by other runs`,
};

/** A plain sentence for the state (fill's words and ids only: never a line's description). */
export function idleExplanation(state: IdleState): string {
  const on = state.task ? ` on ${state.task}` : "";
  switch (state.reason) {
    case "busy":
      return `${state.agent} is working${on}`;
    case "waiting":
      return `${state.agent} is waiting on a gate${on}`;
    case "held":
      return state.hold === "read_only" && !state.task
        ? `${state.agent} is held: the project is read_only, so fill starts nothing`
        : `${state.agent} is held (${state.hold ?? "unknown"})${on}`;
    case "max_active":
      return `${state.agent} is held: fill.max_active is reached${on}`;
    case "capacity":
      return `${state.agent} is held: no capacity (${state.hold ?? "capacity_cmd"})${on}`;
    case "no_task":
      return `${state.agent} has no line in the tasks file; no ready work exists`;
    case "task_done":
      return `${CAUSE.task_done(state)}, with no next task; no ready work exists`;
    case "no_ready_work":
      return `${CAUSE.no_ready_work(state)}; no ready work exists`;
    case "ready_work": {
      const why = state.cause ? CAUSE[state.cause](state) : `${state.agent} is idle`;
      const tasks = state.readyTasks ?? [];
      return `${why}, while ready work exists: ${tasks.length > 0 ? `unassigned ${tasks.join(", ")}` : "unassigned tasks"}`;
    }
  }
}

/** The state is idle while ready work exists, for fill.idle.notice_minutes or more (and notices are on). */
export function shouldNotice(state: IdleState, settings: Pick<IdleSettings, "noticeMinutes">): boolean {
  if (settings.noticeMinutes <= 0) return false;
  if (state.reason !== "ready_work") return false;
  return state.duration >= settings.noticeMinutes * 60_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function idleStateView(state: IdleState): IdleStateView {
  return {
    agent: state.agent,
    reason: state.reason,
    ...(state.hold ? { hold: state.hold } : {}),
    ...(state.task ? { task: state.task } : {}),
    since: iso(state.since),
    durationSeconds: Math.round(state.duration / 1000),
    ...(state.readyTasks ? { readyTasks: state.readyTasks } : {}),
    explanation: idleExplanation(state),
  };
}
