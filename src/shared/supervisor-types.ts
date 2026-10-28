/**
 * The supervisor's self-checks and its ops API (src/server/supervisor/),
 * shared by the server's routes and the Home view's Health panel.
 * docs/configuration.md#supervisor-self-checks-and-the-ops-api
 */

/** ok and warning are measured; unknown: it could not be measured this round (a timeout, an error, no value here) */
export type CheckStatus = "ok" | "warning" | "failing" | "unknown";

export const CHECK_IDS = [
  "event_loop_lag",
  "request_latency",
  "open_files",
  "disk_free",
  "store_size",
  "command_timeouts",
  "module_errors",
  "watcher_mode",
  "infra_holds",
  "machines",
  "gate_queue_age",
  "retention",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

/** A measured value: a number, a short word or name, or null when it is not known */
export type CheckValue = number | string | boolean | null;

/**
 * One check's latest result. Its words are Lair's own: never a line of a
 * log or of a command's output.
 */
export interface CheckResult {
  id: CheckId;
  /** "server" for a check of Lair itself, else the project's name */
  scope: string;
  title: string;
  status: CheckStatus;
  values: Record<string, CheckValue>;
  thresholds: Record<string, number>;
  /** One line: what was measured and what it means */
  explanation: string;
  /** What to do about it, when it is not ok */
  fix: string | null;
  measuredAt: string;
  durationMs: number;
  /** Since when it has been failing (ISO), while it is */
  failingSince: string | null;
  /** The open notice it raised in the Decision Inbox, if any */
  noticeId: string | null;
}

export interface CheckCounts {
  ok: number;
  warning: number;
  failing: number;
  unknown: number;
}

export interface ProjectDiagnostics {
  project: string;
  /** supervisor.checks.enabled for this project */
  enabled: boolean;
  /** Its supervisor: block is invalid (its checks don't run) */
  errors: string[];
  lastRunAt: string | null;
  checks: CheckResult[];
}

/** GET /api/health/diagnostics (owner only) */
export interface DiagnosticsView {
  /** The server's own checks run (the default project's supervisor.checks.enabled) */
  enabled: boolean;
  intervalSeconds: number;
  lastRunAt: string | null;
  server: CheckResult[];
  projects: ProjectDiagnostics[];
  counts: CheckCounts;
}

/** An ops API token, as the owner's list shows it: never the token itself. */
export interface OpsTokenView {
  id: string;
  /** run: minted for one supervisor run; session: an owner's interactive session */
  kind: "run" | "session";
  label: string;
  /** The projects its calls may name; "*" for every project */
  projects: string[] | "*";
  /** Only read tools in this version */
  scope: "read";
  runId: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  calls: number;
}

export type OpsCallOutcome = "ok" | "refused" | "error";

/** One audited ops API call (data/supervisor.db) */
export interface OpsAuditEntry {
  id: string;
  at: string;
  /** The token's id, or "-" for a token Lair does not know */
  tokenId: string;
  /** The token's label: "run <id>" or the owner's session label */
  who: string;
  tool: string;
  /** The arguments, redacted and cut to a few hundred characters */
  args: string;
  outcome: OpsCallOutcome;
  /** Why it was refused or failed, in Lair's own words */
  detail: string | null;
  durationMs: number;
}

// ============ CHAT AND DIGEST (S1-2) ============

/** pending: its supervisor run is looking; no_answer: the run ended, timed out or never started, with the reason */
export type TurnState = "pending" | "answered" | "no_answer";

/** chat: the owner's questions; digest: one daily digest */
export type ConversationKind = "chat" | "digest";

/** One tool call an answer cites: an ops tool, its arguments and what it showed */
export interface EvidenceItem {
  tool: string;
  args: Record<string, unknown>;
  note: string;
}

/** One question and its answer */
export interface ConversationTurn {
  id: string;
  /** 1 for the first question of the conversation */
  seq: number;
  question: string;
  askedAt: string;
  state: TurnState;
  /** The agents module's run that answers it (null: it never started) */
  runId: string | null;
  agent: string | null;
  /** When it is closed without an answer, if none came */
  deadlineAt: string;
  /**
   * The answer, Markdown as Lair keeps it: no HTML, links only to the
   * dashboard's routes and to the repository's host (agent output: the
   * dashboard renders it as untrusted)
   */
  answer: string | null;
  evidence: EvidenceItem[];
  answeredAt: string | null;
  /** Why there is no answer (no_answer) */
  reason: string | null;
}

export interface ConversationView {
  id: string;
  project: string;
  kind: ConversationKind;
  /** The local date a digest is for (YYYY-MM-DD) */
  digestDate: string | null;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  /** The repository's web address, the one host answers may link to (null: none) */
  repoUrl: string | null;
}

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  /** Its first question, cut */
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Its latest question's state */
  state: TurnState;
}

export interface ChatLimits {
  maxRunsPerDay: number;
  minIntervalSeconds: number;
  maxConversationTurns: number;
  answerTimeoutMinutes: number;
}

/** GET /api/supervisor/chat (owner only) */
export interface ChatStatusView {
  project: string;
  /** supervisor.chat.enabled */
  enabled: boolean;
  digest: { enabled: boolean; time: string };
  /** The agent supervisor runs start on (supervisor.agent, else the dragon on ai.roles.supervise's first profile) */
  agent: string | null;
  /** Why a question can't be asked now (the block's errors, no agent, the agents module off) */
  problem: string | null;
  limits: ChatLimits;
  /** Supervisor runs (questions and digests) started in the last 24 hours */
  runsToday: number;
  /** The earliest the next run may start (min_interval_seconds), when that is later than now */
  nextRunAt: string | null;
  conversations: ConversationSummary[];
  repoUrl: string | null;
}

/** GET /api/supervisor/digest (owner only) */
export interface DigestView {
  project: string;
  enabled: boolean;
  /** HH:MM, local time */
  time: string;
  latest: ConversationView | null;
}
