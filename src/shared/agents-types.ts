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
 * - completed: the process exited 0, or the agent reported the task DONE
 * - failed: the attempt failed (crashed, dead on start, hung, provider error); a
 *   follow-up run carries the task on unless the chain was escalated
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

export type StopReason = "hung" | "failover" | "lost_claim" | "fresh_session";

/** One way to run an agent: an adapter (CLI), a model, and the provider it bills. */
export interface AgentProfile {
  adapter: string;
  model?: string;
  provider: string;
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
  | "hung"
  | "lost_claim"
  | "restart_same_session"
  | "fresh_session"
  | "escalated"
  | "failover"
  | "budget_warning"
  | "budget_exceeded"
  | "budget_override"
  | "decision";

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
}
