/**
 * Planner types (docs/design/planner.md), shared by the server
 * (src/server/planner/) and the dashboard's Planner view.
 */

export type PlannerMode = "observe" | "act";

export const PLANNER_OPS = ["add", "finish", "reassign", "reword", "drop", "unblock"] as const;
export type PlannerOp = (typeof PLANNER_OPS)[number];

export type SourceKind = "markdown_plan" | "backlog_file" | "owner_messages" | "queue_events";

export interface SourceFileView {
  path: string;
  ok: boolean;
  error: string | null;
  bytes: number;
  lines: number;
  /** More lines than max_lines: the rest were not read */
  truncated: boolean;
}

/** A source and how its files parsed at the last cycle. */
export interface SourceStatusView {
  name: string;
  kind: SourceKind;
  ok: boolean;
  files: SourceFileView[];
  /** Plan and backlog sources: tasks found, open, done, without an id, with an id seen before */
  tasks: number;
  open: number;
  done: number;
  withoutId: number;
  duplicates: number;
  /** Owner messages (unanswered) or queue events read this cycle */
  items: number;
}

/** A task in a plan or backlog file. */
export interface PlanTaskView {
  source: string;
  file: string;
  line: number;
  /** null: the line has no id (shown, never matched against the tasks file) */
  id: string | null;
  text: string;
  done: boolean;
  section: string | null;
  phase: string | null;
  dependsOn: string[];
  /** Open, and every dependency is done */
  ready: boolean;
  /** Dependencies not done yet (or unknown) */
  waitingOn: string[];
  details: string[];
}

export interface TasksLineView {
  line: number;
  /** null: an unassigned line, ready work for any agent */
  agent: string | null;
  name: string;
  task: string;
  description: string;
}

export type TriggerKind = "done_no_next" | "blocked" | "idle" | "owner_message" | "plan_changed" | "owner_retry";

export interface TriggerView {
  kind: TriggerKind;
  at: string;
  agent: string | null;
  task: string | null;
  detail: string;
}

export type BlockedClass = "environment" | "task" | "owner";

export interface BlockedView {
  task: string;
  agent: string | null;
  reason: string;
  class: BlockedClass;
  /** The pattern that matched, or "default" (a task problem) */
  rule: string;
  at: string;
  /** Planner runs spent on it */
  attempts: number;
  /** What Lair did: a decision, a planner run, waiting for one, left to the owner */
  route: string;
}

export type PlannerRunState = "running" | "done" | "failed";

export interface PlannerRunView {
  id: string;
  state: PlannerRunState;
  agent: string;
  /** The agents module's run (its chain's first run) */
  agentRunId: string | null;
  task: string;
  triggers: TriggerView[];
  requestedAt: string;
  endedAt: string | null;
  detail: string;
  proposals: number;
  applied: number;
  pending: number;
  rejected: number;
  /** Verification state: "pending", "running", "done", "failed", or null if not configured */
  verifierState: VerifierState | null;
  /** The verifier agent's run id */
  verifierRunId: string | null;
}

export type VerifierState = "pending" | "running" | "done" | "failed" | "skipped";

export type ProposalStatus = "pending" | "applied" | "rejected" | "declined";

/** Verifier verdicts: approve, reject, unsure (explicitly deferred), or unverified (never checked) */
export type VerifierVerdict = "approve" | "reject" | "unsure" | "unverified";

export interface ProposalView {
  id: string;
  runId: string;
  index: number;
  op: string;
  task: string;
  agent: string | null;
  text: string | null;
  reason: string;
  status: ProposalStatus;
  /** Why it was refused or declined */
  refusal: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** The verifier's verdict, if verification ran */
  verifierVerdict: VerifierVerdict | null;
  /** The verifier's reason for its verdict */
  verifierReason: string | null;
  /** Evidence the verifier cited (e.g., "gh pr view 194: MERGED 2026-10-23") */
  verifierEvidence: string[] | null;
}

/**
 * deterministic: the planner's own rules; proposal: an accepted proposal;
 * external: someone else edited the tasks file; restored: Lair put back what
 * it last wrote (act mode, a change while a planner run was active)
 */
export type ChangeSource = "deterministic" | "proposal" | "external" | "restored";
/** applied: written to the tasks file; planned: observe mode, not written; failed: not written */
export type ChangeOutcome = "applied" | "planned" | "failed";

export interface ChangeView {
  id: string;
  at: string;
  source: ChangeSource;
  outcome: ChangeOutcome;
  op: string;
  task: string | null;
  agent: string | null;
  reason: string;
  /** "-<line> <text>" and "+<line> <text>" lines */
  diff: string[];
  runId: string | null;
  proposalId: string | null;
}

/** GET /api/planner/status (owner only: its errors and warnings name paths on this machine). */
export interface PlannerStatusView {
  project: string;
  enabled: boolean;
  mode: PlannerMode | null;
  running: boolean;
  /** Planner runs are paused (failures in a row, or the owner chose it) */
  paused: boolean;
  lastCycle: string | null;
  lastError: string | null;
  errors: string[];
  warnings: string[];
  counts: {
    sources: number;
    sourcesFailing: number;
    openTasks: number;
    readyTasks: number;
    pending: number;
    runs: number;
  };
  activeRun: { id: string; requestedAt: string } | null;
}

/** GET /api/planner/overview (owner only): what the planner sees. */
export interface PlannerOverviewView extends PlannerStatusView {
  tasksFile: string | null;
  lines: TasksLineView[];
  doneTasks: string[];
  malformed: { line: number; reason: string }[];
  sources: SourceStatusView[];
  openTasks: PlanTaskView[];
  triggers: TriggerView[];
  blocked: BlockedView[];
  idleAgents: string[];
  allowlist: string[];
  agent: {
    id: string;
    promptFile: string;
    minIntervalSeconds: number;
    debounceSeconds: number;
    maxProposals: number;
    maxRunsPerDay: number;
    /** Planner runs started in the last 24 hours */
    runsInDay: number;
    /** When a run could start, given the pending triggers (null: none pending) */
    nextRunAt: string | null;
  } | null;
  pausedReason: string | null;
}
