/**
 * Agents module API types (src/server/agents/, docs/design/autonomy.md §6):
 * agent runs with pid-owned claims and locks, session recovery, failover and
 * budgets. Shared by the server routes and the Agents view.
 */

/**
 * One run: one attempt to start and supervise an agent process for a task.
 * - queued: waiting to start (backoff, budget, or a free profile)
 * - waiting_lock: a launch lock is held by a live process
 * - running: the agent process is alive
 * - stopping: Lair asked the process to stop (hung, failover, lost claim, fresh session)
 * - completed: the process exited 0, or, when its exit status was lost (it
 *   ended while Lair was restarting), the agent's own queue line for the task
 *   reported it DONE, WAITING or BLOCKED (the run's detail says which)
 * - failed: the attempt failed (crashed, dead on start, hung, provider error, an
 *   exit status lost with no such line); a follow-up run carries the task on
 *   unless the chain was escalated
 * - never_started: no live agent process within agents.start_timeout_minutes
 * - lost_claim: the run lost its claim on the task and stopped
 * - superseded: another live run had claimed the task when this one tried to start
 */
export type AgentRunState =
  | "queued"
  | "waiting_lock"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "never_started"
  | "lost_claim"
  | "superseded";

/** An agent's state, derived from its latest run and its budget. */
export type AgentState =
  | "idle"
  | "starting"
  | "working"
  | "waiting_on_lock"
  | "hung"
  | "stopping"
  | "never_started"
  | "failed_over"
  | "over_budget"
  | "failed";

/** new: the first session; resume: the same session again; fresh: a new session, the old one moved aside */
export type SessionMode = "new" | "resume" | "fresh";

export type StopReason = "hung" | "failover" | "lost_claim" | "fresh_session" | "server_shutdown";

/** What started a run's chain, when not the owner or another module: "fill" (agents.fill) */
export type RunOrigin = "fill";

/** One way to run an agent: an adapter (CLI), a model, and the provider it bills. */
export interface AgentProfile {
  adapter: string;
  model?: string;
  provider: string;
  /** The ai.profiles id it came from, when it came from one */
  profile?: string;
  /** That profile's extra start arguments (options.args), when it has any */
  args?: string[];
}

/** What a run waiting on a lock is waiting for. Never a silent wait. */
export interface LockWait {
  lock: string;
  path: string;
  holderPid: number | null;
  holderStartedAt: string | null;
  holderAlive: boolean;
  since: string;
  detail: string;
}

export interface AgentRunView {
  id: string;
  project: string;
  task: string;
  agent: string;
  /** The first run of this task's chain of attempts */
  chainId: string;
  previousRunId?: string;
  attempt: number;
  profileIndex: number;
  profile: AgentProfile;
  sessionId: string;
  sessionMode: SessionMode;
  sameSessionRestarts: number;
  freshSessions: number;
  startRetries: number;
  state: AgentRunState;
  detail: string;
  stopReason?: StopReason;
  waitingLock?: LockWait;
  pid?: number;
  pidStartedAt?: string;
  requestedAt: string;
  notBefore: string;
  spawnedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  logPath?: string;
  lastError?: string;
  /** Set when agents.fill started the run's chain */
  origin?: RunOrigin;
}

/** A task's claim: exactly one run owns it, through a pid and that process's start time. */
export interface ClaimView {
  task: string;
  runId: string;
  agent: string;
  ownerPid: number;
  ownerStartedAt: string;
  /** From the latest process snapshot; null before the first tick */
  ownerAlive: boolean | null;
  claimedAt: string;
}

export type AgentEventKind =
  | "requested"
  | "started"
  | "completed"
  | "claim_released"
  | "lock_broken"
  | "never_started"
  | "dead_on_start"
  | "crashed"
  | "exit_unknown"
  | "hung"
  | "lost_claim"
  | "restart_same_session"
  | "fresh_session"
  | "escalated"
  | "failover"
  | "budget_warning"
  | "budget_exceeded"
  | "budget_override"
  | "decision"
  | "fill_started"
  | "fill_held"
  | "fill_done"
  | "fill_conflict"
  | "fill_released"
  | "fill_paused"
  | "fill_waiting"
  | "fill_blocked"
  | "fill_woken"
  | "fill_weak"
  | "fill_wake_absent"
  | "fill_gate_queued"
  | "fill_gate_gone"
  | "transient"
  | "transient_cleared"
  | "run_adopted"
  | "run_lost";

/** Recovery and audit record: what happened, why, and the evidence. */
export interface AgentEventView {
  id: string;
  kind: AgentEventKind;
  agent?: string;
  task?: string;
  runId?: string;
  /** The lock, provider or budget scope it is about */
  subject?: string;
  summary: string;
  evidence: string[];
  data: Record<string, unknown>;
  at: string;
}

export type BudgetMetric = "daily_tokens" | "daily_cost" | "monthly_tokens" | "monthly_cost";

export interface BudgetLine {
  metric: BudgetMetric;
  /** UTC day (2026-01-31) or month (2026-01) */
  period: string;
  used: number;
  soft?: number;
  hard?: number;
  level: "ok" | "soft" | "hard";
}

export interface BudgetScopeView {
  scope: "project" | "agent";
  agent?: string;
  lines: BudgetLine[];
  /** A hard limit is reached: no new runs */
  blocked: boolean;
}

export interface LockView {
  name: string;
  path: string;
  hold: "launch" | "run";
  exists: boolean;
  /** lair: pid and start time; pid: a pid only (legacy); none: no pid (legacy) */
  format: "lair" | "pid" | "none" | null;
  holderPid: number | null;
  holderStartedAt: string | null;
  holderAlive: boolean | null;
  /** How many times Lair broke this lock */
  breaks: number;
  detail: string;
}

export interface AgentView {
  id: string;
  state: AgentState;
  detail: string;
  /** The active run, else the latest one */
  run?: AgentRunView;
  profiles: AgentProfile[];
  claims: ClaimView[];
  recoveries: AgentEventView[];
  budget: BudgetScopeView | null;
}

export interface AgentsTickSummary {
  at: string;
  started: number;
  ended: number;
  recovered: number;
  locksBroken: number;
  claimsReleased: number;
  neverStarted: number;
  failovers: number;
  escalations: number;
  warnings: number;
}

export interface AgentsStatusView {
  project: string;
  enabled: boolean;
  running: boolean;
  /** read_only projects: nothing is started, stopped, released or broken */
  readOnly: boolean;
  errors: string[];
  intervalSeconds: number | null;
  lastTick: AgentsTickSummary | null;
  lastError: string | null;
  agents: AgentView[];
  claims: ClaimView[];
  locks: LockView[];
  projectBudget: BudgetScopeView | null;
  /** agents.fill, whenever the module runs for the project */
  fill?: FillStatusView;
  /** Providers Lair holds new starts on: their runs died of transient errors (agents.transient_patterns) */
  unreachable?: ProviderUnreachableView[];
}

/**
 * A provider whose runs died of a transient network or provider error, with
 * nothing on it working since: starts on it wait (only those of the agents
 * whose runs died, until the outage is the fleet's), a fallback on another
 * provider is used when there is one, and one start tries it per backoff
 * step (60 s doubling, up to 15 min).
 */
export interface ProviderUnreachableView {
  provider: string;
  /** The first transient failure of this outage */
  since: string;
  /** Transient failures in this outage */
  failures: number;
  /** When the next start may try it */
  nextTryAt: string;
  /** The log line that matched (the agent CLI's output: data) */
  line: string;
  /** Every agent's starts wait: two agents' runs died of it close together, or a retry failed too */
  fleet: boolean;
  /** The agents whose runs died of it */
  agents: string[];
  /** Active runs on it that wait */
  waiting: number;
}

/**
 * A tasks_file line at fill's last check:
 * - started: a run of the line's agent on its task is active (fill started it, now or before)
 * - done: done_pattern matched a queue line written since the task's last start
 * - held: it would start but doesn't, for the reason in `detail`
 * - claimed: another agent's run, or another claim, holds the task
 * - not_allowlisted: its agent is not in agents.fill.agents, so fill never starts it
 * - malformed: the line doesn't parse; `detail` says why
 */
export type FillLineState = "started" | "done" | "held" | "claimed" | "not_allowlisted" | "malformed";

/**
 * Why a line is held:
 * - owner: the task's last run ended other than completed (escalated, stopped, its claim lost)
 * - no_done: its runs exited 0 without progress fill.max_completions_without_done times in a row
 *   (no done line, or a WAITING line on nothing that came: see waiting)
 * - backoff: its last run exited 0 without reporting it done; it starts again after a backoff
 * - waiting: its last run ended on a WAITING line. On a wake file that isn't there yet it starts
 *   again once the file appears; on nothing (no wake, a refused one, or a result already there when
 *   the run ended) it counts as a run without progress and starts again after the fallback and backoff
 * - waited_too_long: its runs have been waiting longer than fill.wake.max_wait_minutes in a row (time
 *   while the gate it waits on was still in the gate queue doesn't count), or longer than
 *   fill.wake.max_queue_wait_minutes in all
 * - blocked: its last run ended on a BLOCKED line: it needs someone else first
 * - busy, read_only, max_active, capacity, prompt (a refused prompt file), refused (the run request,
 *   or done_pattern)
 * - paused: you chose to leave it ("Keep it paused" on its decision, or "Leave the task unclaimed" on
 *   its run's escalation): nothing waits for you, and fill starts it again once you release it
 * owner, no_done, blocked, waiting, waited_too_long and paused are the owner's to release (POST
 * /api/agents/fill/release, or the decision); a waiting one also ends by itself.
 * owner, no_done, blocked, waited_too_long and refused need the owner (FILL_OWNER_HOLDS): each has
 * exactly one open Decision Inbox item while it lasts (`decisionId`).
 */
export type FillHold =
  | "paused"
  | "owner"
  | "no_done"
  | "backoff"
  | "waiting"
  | "waited_too_long"
  | "blocked"
  | "busy"
  | "read_only"
  | "max_active"
  | "capacity"
  | "conflict"
  | "prompt"
  | "refused";

export interface FillLineView {
  /** 1-based line number in tasks_file */
  line: number;
  agent: string | null;
  name: string | null;
  task: string | null;
  description: string | null;
  state: FillLineState;
  detail: string;
  /** Why it is held (state "held"), else null */
  hold: FillHold | null;
  /** The owner can release this hold (owner, no_done, blocked, waiting, waited_too_long and paused holds) */
  releasable: boolean;
  /** A waiting line: what it waits on (null without one) and since when its run ended */
  waiting: FillWaitingView | null;
  runId: string | null;
  /** The open Decision Inbox item of a hold that needs the owner (FILL_OWNER_HOLDS), when it has one */
  decisionId: string | null;
}

/** The holds that need the owner: each has exactly one open decision while it lasts. */
export const FILL_OWNER_HOLDS: readonly FillHold[] = ["owner", "no_done", "blocked", "waited_too_long", "refused"];

export interface FillWaitingView {
  /** What the WAITING line named (a gate id, say), when the pattern captures it */
  wake: string | null;
  since: string;
  /** When fill starts it again without the wake (no wake, or one refused), else null */
  fallbackAt: string | null;
  /** Why the captured wake isn't used, if it isn't */
  refused: string | null;
  /** The gate it waits on is still in the gate queue (it, or the id it was re-queued as): the wait is alive */
  queued?: FillQueuedGateView | null;
}

export interface FillQueuedGateView {
  /** The gate id whose request is in the queue */
  gate: string;
  /** The id the waiting line named, when the request is a re-queue of it under a new id (wake.requeue_marker) */
  requeuedFrom: string | null;
  lane: string;
  /** queued: <lane>.<pri>.<id>.req; running: .req.run */
  status: "queued" | "running";
  /** When the request file was written */
  since: string;
}

export interface FillStatusView {
  enabled: boolean;
  /** The fill loop is running */
  running: boolean;
  tasksFile: string | null;
  agents: string[];
  maxActive: number;
  /** Active runs whose chain fill started */
  active: number;
  intervalSeconds: number;
  lastCheck: string | null;
  lastError: string | null;
  lines: FillLineView[];
}

/**
 * A file in the project's prompts_dir, offered by the Agents view's "Load a
 * prompt" select (GET /api/agents/prompts, owner only). Its name only, never
 * a path.
 */
export interface PromptFileView {
  /** The file's basename in prompts_dir */
  name: string;
  size: number;
  modifiedAt: string;
  /** Larger than a run's prompt may be: listed, but it can't be loaded */
  tooLarge: boolean;
}

/** One prompt file's text (GET /api/agents/prompts/:name, owner only). */
export interface PromptFileText {
  name: string;
  size: number;
  text: string;
}
