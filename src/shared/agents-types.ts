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

/**
 * What started a run's chain: "fill" (agents.fill), "review" (the review module's agent assigner), "planner" and
 * "verifier" (the planner), "supervisor" (the supervisor's chat and digest), "owner" (POST /api/agents/runs). A run
 * recorded before its module set one has none: the AI spend record then goes by the task id's prefix.
 */
export type RunOrigin = "fill" | "review" | "planner" | "verifier" | "supervisor" | "owner";

/**
 * How an ended run's usage is read from its log (agent_adapters.<id>.usage_parser, docs/design/ai-spend.md §4.1):
 * claude-stream-json / claude-json: the CLI's own `result` events (tokens, cost, turns); request-lines: lines matching
 * the adapter's request_pattern (requests only); patterns: agents.usage_patterns, read while the run works; none.
 */
export type UsageParserKind = "claude-stream-json" | "claude-json" | "request-lines" | "patterns" | "none";

/** A run's class (docs/design/ai-spend.md §4.2); `unclassified` while its module hasn't recorded its result yet */
export type SpendClass = "productive" | "idle" | "no_result" | "unclassified";

/** GET /api/agents/spend: the window ("today" is the UTC day) and the grouping */
export const SPEND_WINDOWS = ["today", "7d", "30d", "1y"] as const;
export type SpendWindow = (typeof SPEND_WINDOWS)[number];
export const SPEND_GROUPS = ["project", "agent", "task", "reason", "origin", "provider"] as const;
export type SpendGroupBy = (typeof SPEND_GROUPS)[number];
/** The unit a waste share is shown in first: cost when any was reported, then requests, then minutes, then runs */
export type SpendUnit = "cost" | "requests" | "minutes" | "runs";

/**
 * Spend summed over runs. `reported: false` when no run of them reported tokens and cost: both are null then ("not
 * reported"), never estimated. requests and turns are null when no run had them. `reportedRuns`: how many of the runs
 * reported tokens and cost; fewer than `runs` (and more than 0) means tokens and cost cover only those runs.
 */
export interface SpendTotalsView {
  runs: number;
  minutes: number;
  requests: number | null;
  turns: number | null;
  tokens: number | null;
  cost: number | null;
  reported: boolean;
  reportedRuns: number;
}

/** (idle + no_result) / (productive + idle + no_result), per unit; null where the unit has nothing */
export interface SpendWasteShare {
  cost: number | null;
  tokens: number | null;
  requests: number | null;
  turns: number | null;
  minutes: number | null;
  runs: number | null;
}

export interface SpendGroupView {
  key: string;
  totals: SpendTotalsView;
  productive: SpendTotalsView;
  idle: SpendTotalsView;
  noResult: SpendTotalsView;
  /** Runs with no class yet: in the totals, in no waste share */
  unclassified: SpendTotalsView;
  waste: SpendWasteShare;
  reloads: number;
  lairRestarts: number;
}

export interface SpendReasonView {
  class: SpendClass;
  reason: string;
  totals: SpendTotalsView;
}

export interface SpendTaskView {
  task: string;
  /** Runs since its last completion (a DONE or READY run, or any productive run of a module's task) */
  attempts: number;
  noResult: number;
  chains: number;
  lastEndedAt: string;
}

export interface SpendReviewHeadView {
  pr: number;
  /** The head's first 8 characters */
  head: string;
  runs: number;
  reviews: number;
  failed: number;
}

export interface SpendPlannerView {
  /** Planner runs requested in the window, and those with an applied proposal */
  runs: number;
  runsWithApplied: number;
  proposals: { applied: number; declined: number; rejected: number; pending: number };
  verdicts: { approve: number; reject: number; unsure: number; unverified: number };
  /** The planner's and its verifier's reported cost per applied proposal: null when none applied or no cost was reported */
  costPerApplied: number | null;
  /** Planner runs with no applied proposal, of all */
  wasteShare: number | null;
}

/** Guard ids, as each guard's guard_would and guard_did events carry them in data.guard (docs/design/ai-spend.md §4.5) */
export const SPEND_GUARDS = [
  "quota",
  "task_no_result_cap",
  "wake_events",
  "hung_repeat",
  "budget",
  "planner_prefilter_closed",
  "planner_handled_messages",
  "planner_skip_unchanged",
  "planner_recheck_on_change",
] as const;
export type SpendGuardId = (typeof SPEND_GUARDS)[number];

export interface SpendGuardView {
  guard: SpendGuardId;
  /** The config key of its mode */
  key: string;
  mode: "off" | "observe" | "act";
  would: number;
  did: number;
}

/** GET /api/agents/spend: numbers, ids and enums only (never a prompt, a log line or a blocker's text) */
export interface SpendReportView {
  project: string;
  window: SpendWindow;
  by: SpendGroupBy;
  from: string;
  to: string;
  /** runs: the per-run rows; aggregates: the daily aggregates (and the runs of days not aggregated yet), no per-task detail */
  source: "runs" | "aggregates";
  unit: SpendUnit;
  totals: SpendTotalsView;
  productive: SpendTotalsView;
  idle: SpendTotalsView;
  noResult: SpendTotalsView;
  /** Runs whose class waits on their module's record: in no share */
  unclassified: SpendTotalsView;
  waste: SpendWasteShare;
  /** The waste share in `unit` */
  wasteShare: number | null;
  /** By `by`, the most waste in `unit` first (at most 200) */
  groups: SpendGroupView[];
  reasons: SpendReasonView[];
  reloads: number;
  lairRestarts: number;
  /** The 10 tasks with the most attempts without a completion (null for a window past the per-run rows) */
  topTasks: SpendTaskView[] | null;
  /** Heads reviewed more than once (null for a window past the per-run rows) */
  reviewsPerHead: SpendReviewHeadView[] | null;
  planner: SpendPlannerView | null;
  guards: SpendGuardView[];
}

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
  | "fill_report_refused"
  | "fill_report_waiting"
  | "fill_gate_queued"
  | "fill_gate_gone"
  | "fill_idle_notice"
  | "fill_idle_resolved"
  | "fill_unmatched"
  | "transient"
  | "transient_cleared"
  /** A provider's fleet quota cooldown (G1 act): its state, kept on each event, so the newest one says where it stands */
  | "quota"
  /** A start on a provider in a quota cooldown worked, or the owner chose "Try now": the cooldown is over */
  | "quota_cleared"
  | "run_adopted"
  | "run_lost"
  | "stopped_for_shutdown"
  /** A guard in observe mode reached a verdict and changed nothing (docs/design/ai-spend.md §4.5) */
  | "guard_would"
  /** A guard in act mode did what it describes */
  | "guard_did"
  /** An ended run's usage was read but refused (over a cap, unreadable): the run's spend row says not reported */
  | "usage_refused"
  /** The spend of the UTC day that just ended (also agents.spend.daily on the event bus): numbers, enums, task ids */
  | "spend_daily"
  /** agents.spend's first enable classified the runs of the days before (its start and its end) */
  | "spend_backfill";

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

/**
 * Token and cost limits count the agents ledger. Request and minute limits (AI spend G5, docs/design/ai-spend.md
 * §4.5) count the spend records of ended runs, for adapters that report no tokens
 */
export type BudgetMetric =
  | "daily_tokens"
  | "daily_cost"
  | "monthly_tokens"
  | "monthly_cost"
  | "daily_requests"
  | "daily_minutes"
  | "monthly_requests"
  | "monthly_minutes";

export interface BudgetLine {
  metric: BudgetMetric;
  /** UTC day (2026-01-31) or month (2026-01) */
  period: string;
  used: number;
  soft?: number;
  hard?: number;
  level: "ok" | "soft" | "hard";
  /**
   * A request or minute line's budgets.guard_mode (G5): its hard limit holds new runs only in `act`; `observe` records
   * what it would hold, `off` nothing. Unset on token and cost lines, whose hard limits always hold new runs
   */
  guard?: "off" | "observe" | "act";
}

export interface BudgetScopeView {
  scope: "project" | "agent";
  agent?: string;
  lines: BudgetLine[];
  /** A hard limit that holds new runs is reached: no new runs */
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
  /**
   * agents.spend.enabled (docs/design/ai-spend.md §4.4): Home's AI spend panel and an agent's Spend line show only
   * while it is on. Their data comes from the owner-only GET /api/agents/spend; this says only whether there is any
   */
  spendEnabled?: boolean;
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
 * - unassigned: the line names no agent (`|<name>|<task>|<description>`), so fill never starts it; `ready`
 *   says whether it is ready work for any agent (fill.idle). An unassigned task that is done, or has an
 *   active run or a claim, is `done` or `claimed` instead
 * - malformed: the line doesn't parse; `detail` says why
 */
export type FillLineState = "started" | "done" | "held" | "claimed" | "not_allowlisted" | "unassigned" | "malformed";

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
 * - busy, read_only, max_active, capacity, capacity_load (load too high for local agent),
 *   capacity_memory (memory pressure/low), capacity_heavy (heavy work limit), prompt (a refused
 *   prompt file), refused (the run request, or done_pattern)
 * - conflict: a live process this server has no run for holds one of the task's run prompt files on its
 *   command line (a run of the task it doesn't know): fill starts the task once that process has ended
 * - no_result_cap, hung_repeat: an AI spend guard in act mode parked it (docs/design/ai-spend.md G2, G4): its no-result
 *   runs, or its hangs, reached the guard's limit within its window, in any chain; one decision asks what next
 * - paused: you chose to leave it ("Keep it paused" on its decision, or "Leave the task unclaimed" on
 *   its run's escalation): nothing waits for you, and fill starts it again once you release it
 * owner, no_done, blocked, waiting, waited_too_long, no_result_cap, hung_repeat and paused are the owner's to release (POST
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
  | "capacity_load"
  | "capacity_memory"
  | "capacity_heavy"
  | "capacity_probe"
  | "conflict"
  | "prompt"
  | "refused"
  | "report_refused"
  | "no_result_cap"
  | "hung_repeat";

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
  /**
   * Unassigned lines only: true when it is ready work for any agent (open: not done in the queue, no
   * active run or claim on its task, its last run not waiting or blocked); `detail` says why not
   */
  ready?: boolean;
}

/** The holds that need the owner: each has exactly one open decision while it lasts. */
export const FILL_OWNER_HOLDS: readonly FillHold[] = ["owner", "no_done", "blocked", "waited_too_long", "refused", "no_result_cap", "hung_repeat"];

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
  /** Idle states for agents in the allowlist (fill.agents) */
  idle?: IdleStateView[];
  /** done_match task_id: per line, its last run's latest report line that names no task it can be about */
  unmatchedReports: FillUnmatchedReportView[];
  /** What in the fill block can make fill close or change a task a line wasn't about (also on Home → Health) */
  warnings: string[];
  /** Current capacity state (native capacity checks) */
  capacity?: FillCapacityView;
}

/**
 * Why an allowlisted agent is or isn't working, at fill's last check (fill.idle): never unexplained.
 * - busy: it has an active run (fill's or anyone's)
 * - waiting: its line waits on a gate
 * - held: its line is held for another reason (`hold`), or the project is read_only
 * - max_active: fill.max_active is reached (its line is held so, or nothing more could start)
 * - capacity: a capacity check holds its line, or capacity_cmd refused every start
 * - no_task: it has no line in the tasks file, and no ready work exists
 * - task_done: its lines are done, and no ready work exists
 * - no_ready_work: its lines are claimed by other runs, and no ready work exists
 * - ready_work: idle (no line, its lines done or claimed) while ready work exists: the case a notice is for
 */
export type IdleReason =
  | "busy"
  | "waiting"
  | "held"
  | "max_active"
  | "capacity"
  | "no_task"
  | "task_done"
  | "no_ready_work"
  | "ready_work";

/** The idle state of one allowlisted agent. */
export interface IdleStateView {
  agent: string;
  reason: IdleReason;
  /** The hold of its line when it is held, waiting, at max_active or capacity */
  hold?: FillHold;
  /** Its line's task, when it has one in this state */
  task?: string;
  /** When it entered this state (kept across a restart only while its notice is open) */
  since: string;
  /** How long it has been in this state (seconds) */
  durationSeconds: number;
  /** ready_work: the ready tasks (unassigned lines' ids, at most 10) */
  readyTasks?: string[];
  /** Plain sentence: why */
  explanation: string;
}

/** A DONE, WAITING or BLOCKED line an agent wrote on a run that names no task it can be about: it counts for no task. */
export interface FillUnmatchedReportView {
  /** The agent that wrote the line (by its attribution) */
  agent: string;
  /** The task of the run it wrote it on */
  openTask: string;
  runId: string;
  /** The task id the line names, as the pattern reads it ("" when it names none) */
  reportedTask: string;
  kind: "done" | "waiting" | "blocked";
  /** The queue line as written (data, cut at 300 characters) */
  line: string;
  /** When fill first saw it */
  at: string;
}

/** Current capacity state from native checks */
export interface FillCapacityView {
  /** Current system load (1-minute average) */
  load?: number;
  /** Number of CPUs */
  cpus?: number;
  /** Load per CPU */
  loadPerCpu?: number;
  /** Configured load_per_cpu_max */
  loadPerCpuMax?: number;
  /** Whether load is over the limit */
  loadOverLimit: boolean;
  /** Current memory state */
  memory?: {
    /** Total memory in bytes */
    total: number;
    /** Available memory in bytes */
    available: number;
    /** Available as percentage of total */
    availablePct: number;
    /** Whether memory is under the minimum */
    underMin: boolean;
    /** Configured available_min_pct */
    availableMinPct?: number;
    /** Memory pressure in percent, when pressure_max is set */
    pressurePct?: number;
    /** Configured pressure_max */
    pressureMax?: number;
  };
  /** Heavy work state */
  heavyWork?: {
    /** Number of currently active heavy work items */
    active: number;
    /** Configured max_active */
    maxActive: number;
    /** Whether heavy work is at the limit */
    atLimit: boolean;
  };
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
