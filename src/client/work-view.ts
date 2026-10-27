/**
 * The Work section: one row per agent, whether Lair's agents module runs it
 * or the project's own launcher does (the old Dragons and Agents views), and
 * the agent's detail. Kept apart from the components so tests check the
 * same rules.
 */
import type { Dragon, DragonStats, QueueLine } from "../shared/types";
import type {
  AgentEventView,
  AgentRunView,
  AgentState,
  AgentsStatusView,
  AgentView,
  BudgetScopeView,
  ClaimView,
  FillLineView,
  FillWaitingView,
  ProviderUnreachableView,
} from "../shared/agents-types";
import { modelLabel, runningLabel } from "./dragon-view";
import { linkTo } from "./router";
import { relativeTime } from "./time";

export const AGENT_STATE_BADGE: Record<AgentState, string> = {
  idle: "badge-neutral",
  starting: "badge-neutral",
  working: "badge-success",
  waiting_on_lock: "badge-warning",
  hung: "badge-error",
  stopping: "badge-warning",
  never_started: "badge-error",
  failed_over: "badge-warning",
  over_budget: "badge-error",
  failed: "badge-error",
};

/** Agent states that need someone to look */
const ATTENTION: readonly AgentState[] = ["hung", "never_started", "over_budget", "failed"];

const RUN_ACTIVE = new Set(["queued", "waiting_lock", "running", "stopping"]);

export function label(state: string): string {
  return state.replace(/_/g, " ");
}

export interface WorkRow {
  id: string;
  name: string;
  /** "working", "waiting on lock", "Running", "Idle" */
  state: string;
  badge: string;
  /** One line on the state */
  detail: string | null;
  task: string | null;
  model: string | null;
  machine: string | null;
  lastLogTime: string | null;
  /** Lair's agents module knows this agent */
  managed: boolean;
  /** Its state needs someone to look (hung, never started, over budget, failed) */
  attention: boolean;
  /** Tasks it reported done in the last 7 days */
  done: number | null;
}

function fillLinesOf(status: AgentsStatusView | null, agent: string): FillLineView[] {
  return status?.fill?.enabled ? status.fill.lines.filter((l) => l.agent === agent) : [];
}

/**
 * Every agent, by id: the dragons the project lists (dragons.txt, the YAML
 * dragons:) and the agents Lair's agents module knows, merged. The agents
 * module's state wins: it supervises the run.
 */
export function workRows(dragons: readonly Dragon[], status: AgentsStatusView | null): WorkRow[] {
  const agents = status?.enabled ? status.agents : [];
  const ids = [...new Set([...dragons.map((d) => d.id), ...agents.map((a) => a.id)])];
  return ids.map((id) => {
    const dragon = dragons.find((d) => d.id === id) ?? null;
    const agent = agents.find((a) => a.id === id) ?? null;
    if (agent) {
      const active = agent.run && RUN_ACTIVE.has(agent.run.state) ? agent.run : null;
      return {
        id,
        name: dragon?.name ?? id,
        state: label(agent.state),
        badge: AGENT_STATE_BADGE[agent.state] ?? "badge-neutral",
        detail: agent.detail || null,
        task: active?.task ?? agent.claims[0]?.task ?? dragon?.task ?? null,
        model: active?.profile.model ?? (dragon?.model ? modelLabel(dragon) : null) ?? agent.profiles[0]?.model ?? null,
        machine: dragon?.machine ?? null,
        lastLogTime: dragon?.lastLogTime ?? null,
        managed: true,
        attention: ATTENTION.includes(agent.state),
        done: dragon?.stats?.doneCount ?? null,
      };
    }
    const d = dragon as Dragon;
    const running = runningLabel(d);
    return {
      id,
      name: d.name,
      state: running.text,
      badge: running.badge,
      detail: running.detail,
      task: d.task || null,
      model: d.model ? modelLabel(d) : null,
      machine: d.machine ?? null,
      lastLogTime: d.lastLogTime ?? null,
      managed: false,
      attention: false,
      done: d.stats?.doneCount ?? null,
    };
  });
}

/** One line on what a run waits for, or null when it waits for nothing. */
export function waitingText(run: AgentRunView | undefined, now: number = Date.now()): string | null {
  if (!run) return null;
  if (run.waitingLock) {
    const w = run.waitingLock;
    const holder =
      w.holderPid === null ? "no holder pid" : `held by pid ${w.holderPid}${w.holderAlive ? ", alive" : ", not alive"}`;
    return `Waiting on lock ${w.lock} since ${relativeTime(w.since, now)} (${holder})`;
  }
  if (run.state === "queued") {
    const at = Date.parse(run.notBefore);
    return Number.isFinite(at) && at > now
      ? `Queued: starts ${relativeTime(run.notBefore, now)}${run.detail ? ` (${run.detail})` : ""}`
      : `Queued: starts on the next check${run.detail ? ` (${run.detail})` : ""}`;
  }
  return null;
}

/** A tasks_file line of this agent, as the detail lists it. */
export interface FillItem {
  line: number;
  task: string | null;
  description: string | null;
  state: string;
  badge: string;
  detail: string;
  /** Held for the owner: the owner can release it */
  releasable: boolean;
  hold: string | null;
  /** What its last run waits on, and since when ("Waiting on gate-123 since 5 min ago"), else null */
  waiting: string | null;
  /** The hold's open decision (#/decisions/<id>), when it needs the owner's answer, else null */
  decisionHref: string | null;
}

/** A paused line is the owner's own choice: it reads so, and Release starts it again. */
export const PAUSED_BY_YOU = "Paused by you";

/** A fill line's state in words: "held: no done", "started", or "Paused by you". */
export function fillStateText(state: string, hold: string | null): string {
  if (hold === "paused") return PAUSED_BY_YOU;
  return hold ? `${label(state)}: ${label(hold)}` : label(state);
}

/** The link to the open decision of a line's hold, or null. */
export function fillDecisionHref(line: Pick<FillLineView, "decisionId">): string | null {
  return line.decisionId ? linkTo("decisions", line.decisionId) : null;
}

/**
 * A WAITING line's wait in one line: what it names, since when, whether its
 * gate is still in the gate queue (a live wait), and when fill starts it
 * again without it.
 */
export function fillWaitingText(waiting: FillWaitingView | null, now: number = Date.now()): string | null {
  if (!waiting) return null;
  const on = waiting.wake ? `Waiting on ${waiting.wake}` : "Waiting on nothing it named";
  const parts = [`${on} since ${relativeTime(waiting.since, now)}`];
  const q = waiting.queued;
  if (q) parts.push(`${q.requeuedFrom ? `re-queued as ${q.gate}, ` : ""}still ${q.status} in ${q.lane} since ${relativeTime(q.since, now)}`);
  if (waiting.refused) parts.push(`not used: ${waiting.refused}`);
  if (waiting.fallbackAt) parts.push(`fill starts it again ${relativeTime(waiting.fallbackAt, now)} without it`);
  return parts.join("; ");
}

/** A provider whose starts wait after transient errors, in one line. */
export function unreachableText(u: ProviderUnreachableView, now: number = Date.now()): string {
  const who = u.fleet ? "every agent waits" : `${u.agents.join(", ")} wait${u.agents.length === 1 ? "s" : ""}`;
  const failures = `${u.failures} transient failure${u.failures === 1 ? "" : "s"}`;
  const runs = `${u.waiting} run${u.waiting === 1 ? "" : "s"} waiting`;
  return `Provider ${u.provider} unreachable since ${relativeTime(u.since, now)} (${failures}): ${who}, ${runs}; next try ${relativeTime(u.nextTryAt, now)}`;
}

const FILL_BADGE: Record<string, string> = {
  started: "badge-success",
  done: "badge-neutral",
  held: "badge-warning",
  claimed: "badge-neutral",
  not_allowlisted: "badge-neutral",
  malformed: "badge-error",
};

export function fillItem(line: FillLineView, now: number = Date.now()): FillItem {
  return {
    line: line.line,
    task: line.task,
    description: line.description,
    state: fillStateText(line.state, line.hold),
    badge: line.hold === "paused" ? "badge-neutral" : (FILL_BADGE[line.state] ?? "badge-neutral"),
    detail: line.detail,
    releasable: line.releasable,
    hold: line.hold,
    waiting: fillWaitingText(line.waiting ?? null, now),
    decisionHref: fillDecisionHref(line),
  };
}

export interface RunSummary {
  id: string;
  task: string;
  state: string;
  badge: string;
  adapter: string;
  model: string | null;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  attempt: number;
  session: string;
  pid: number | null;
  /** "2 restarts in the same session, 1 fresh session, 0 start retries" */
  recoveries: string;
  exitCode: number | null;
  lastError: string | null;
  detail: string;
  /** Still running or about to: a fresh session can replace it */
  active: boolean;
}

const RUN_BADGE: Record<string, string> = {
  queued: "badge-neutral",
  waiting_lock: "badge-warning",
  running: "badge-success",
  stopping: "badge-warning",
  completed: "badge-neutral",
  failed: "badge-error",
  never_started: "badge-error",
  lost_claim: "badge-warning",
  superseded: "badge-neutral",
};

export function runSummary(run: AgentRunView): RunSummary {
  const parts = [
    `${run.sameSessionRestarts} restart(s) in the same session`,
    `${run.freshSessions} fresh session(s)`,
    `${run.startRetries} start retr${run.startRetries === 1 ? "y" : "ies"}`,
  ];
  return {
    id: run.id,
    task: run.task,
    state: label(run.state),
    badge: RUN_BADGE[run.state] ?? "badge-neutral",
    adapter: run.profile.adapter,
    model: run.profile.model ?? null,
    requestedAt: run.requestedAt,
    startedAt: run.spawnedAt ?? null,
    endedAt: run.endedAt ?? null,
    attempt: run.attempt,
    session: `${run.sessionMode} ${run.sessionId.slice(0, 8)}`,
    pid: run.pid ?? null,
    recoveries: parts.join(", "),
    exitCode: run.exitCode ?? null,
    lastError: run.lastError ?? null,
    detail: run.detail,
    active: RUN_ACTIVE.has(run.state),
  };
}

export interface AgentDetailModel {
  id: string;
  name: string;
  state: string;
  badge: string;
  stateDetail: string | null;
  managed: boolean;
  task: string | null;
  /** The task's description (its tasks_file line) */
  description: string | null;
  /** Standing instructions from the dragon's config */
  instructions: string | null;
  adapter: string | null;
  model: string | null;
  machine: string | null;
  /** "claude/opus → codex/gpt" */
  profiles: string | null;
  run: RunSummary | null;
  /** What the current run waits for */
  waiting: string | null;
  claims: ClaimView[];
  /** Tasks fill holds for this agent */
  holds: FillItem[];
  /** Every tasks_file line of this agent */
  fill: FillItem[];
  budget: BudgetScopeView | null;
  recoveries: AgentEventView[];
  /** Its latest runs, newest first */
  recentRuns: RunSummary[];
  stats: DragonStats | null;
  lastLogTime: string | null;
  /** The newest reports it wrote to the queue file, newest first */
  reports: QueueLine[];
}

/** At most this many recent runs and reports are listed */
export const RECENT_LIMIT = 10;

/** An agent's detail, from its dragon (if listed), the agents module's status and runs, and its queue lines. */
export function agentDetail(
  id: string,
  dragons: readonly Dragon[],
  status: AgentsStatusView | null,
  runs: readonly AgentRunView[],
  queueLines: readonly QueueLine[] = [],
  now: number = Date.now(),
): AgentDetailModel | null {
  const dragon = dragons.find((d) => d.id === id) ?? null;
  const agent: AgentView | null = status?.enabled ? (status.agents.find((a) => a.id === id) ?? null) : null;
  if (!dragon && !agent) return null;
  const row = workRows(dragon ? [dragon] : [], agent && status ? { ...status, agents: [agent] } : null)[0];
  const fill = fillLinesOf(status, id).map((line) => fillItem(line, now));
  const task = row.task;
  const current = fill.find((f) => f.task !== null && f.task === task) ?? null;
  const description = current?.description ?? null;
  const profiles = agent?.profiles.map((p) => `${p.adapter}${p.model ? `/${p.model}` : ""}`).join(" → ") || null;
  return {
    id,
    name: row.name,
    state: row.state,
    badge: row.badge,
    stateDetail: row.detail,
    managed: row.managed,
    task,
    description,
    instructions: dragon?.instructions ?? null,
    adapter: agent?.run?.profile.adapter ?? dragon?.adapter ?? agent?.profiles[0]?.adapter ?? null,
    model: row.model,
    machine: row.machine,
    profiles,
    run: agent?.run ? runSummary(agent.run) : null,
    // The run's own wait (a lock, a start time), else what fill says its task waits on
    waiting: waitingText(agent?.run, now) ?? current?.waiting ?? fill.find((f) => f.waiting !== null)?.waiting ?? null,
    claims: agent?.claims ?? [],
    holds: fill.filter((f) => f.hold !== null),
    fill,
    budget: agent?.budget ?? null,
    recoveries: (agent?.recoveries ?? []).slice(0, RECENT_LIMIT),
    recentRuns: runs
      .filter((r) => r.agent === id)
      .slice(0, RECENT_LIMIT)
      .map(runSummary),
    stats: dragon?.stats ?? null,
    lastLogTime: dragon?.lastLogTime ?? null,
    reports: [...queueLines].reverse().slice(0, RECENT_LIMIT),
  };
}

/** The Work section's counts for Home: agents working, and those that need someone to look. */
export function workCounts(rows: readonly WorkRow[]): { total: number; busy: number; attention: number } {
  return {
    total: rows.length,
    busy: rows.filter((r) => r.badge === "badge-success" || r.state === "Running").length,
    attention: rows.filter((r) => r.attention).length,
  };
}
