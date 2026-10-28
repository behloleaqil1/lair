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
