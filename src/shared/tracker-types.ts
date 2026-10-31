/**
 * Types of the tracker module (src/server/tracker/): Lair keeps GitHub
 * issues, Projects boards and milestones in step with its tasks, runs and
 * pull requests. See docs/design/tracker.md.
 */

/** A task's column on a Projects board */
export type TrackerStatus = "backlog" | "ready" | "in_progress" | "in_review" | "done";

/** observe: records what it would change and sends nothing; act: changes GitHub */
export type TrackerMode = "observe" | "act";

/** The changes the tracker makes on GitHub (each one is a row of its audit) */
export type TrackerOp =
  | "create_issue"
  | "add_to_board"
  | "set_status"
  | "set_agent"
  | "add_label"
  | "remove_label"
  | "add_comment"
  | "close_issue"
  | "close_milestone"
  | "reopen_milestone"
  /** The owner asked for a reconcile now (value: the owner session id) */
  | "sync_requested";

/** A task and the GitHub issue that tracks it */
export interface TrackerLink {
  task: string;
  /** owner/name of the issue's repository */
  repo: string;
  issueNumber: number;
  issueUrl: string;
  /** The issue's item on the repository's board (null: not on it yet) */
  projectItemId: string | null;
  /** The column Lair wants (a reconcile moves the card back to it) */
  status: TrackerStatus | null;
  /** The Agent field Lair wants */
  agent: string | null;
  /** The blocked reason commented on the issue (a hash), null when not blocked */
  blockedKey: string | null;
  /** Lair closed or wants to close the issue */
  closedAs: "completed" | "not_planned" | null;
  /** GitHub shows the issue closed */
  closedSynced: boolean;
  linkedAt: string;
  syncedAt: string | null;
}

/** One change the tracker made, would make (observe), or could not make */
export interface TrackerWrite {
  id: string;
  task: string | null;
  repo: string | null;
  issueNumber: number | null;
  op: TrackerOp;
  /** The value written (status option, label, agent id, a comment's first line) */
  value: string | null;
  mode: TrackerMode;
  /** observe: what would have been sent (JSON, redacted) */
  wouldSend: string | null;
  result: "success" | "error" | "rate_limited" | "skipped" | "would_send";
  error: string | null;
  /** How many times the same observe row was seen (observe rows are kept once) */
  count: number;
  at: string;
}

/** The tracker's state for a project */
export interface TrackerSyncState {
  lastReconcileAt: string | null;
  lastEventAt: string | null;
  nextReconcileAt: string | null;
  driftFixedCount: number;
  errorCount: number;
  lastError: string | null;
  /** GitHub said to wait until then: no request is sent before it */
  rateLimitResetAt: string | null;
  /** Writes stop until the owner fixes this (a missing scope, a refused token) */
  needsOwner: string | null;
}

/** A tracked repository and its board */
export interface TrackerRepoView {
  repo: string;
  default: boolean;
  board: { owner: string; number: number; loaded: boolean; title: string | null; url: string | null } | null;
  /** Why its board could not be read (the last attempt) */
  error: string | null;
}

/** A create that was sent and not yet matched to its issue (found again by its marker) */
export interface TrackerPendingCreate {
  task: string;
  repo: string;
  since: string;
}

/** GET /api/tracker/status */
export interface TrackerStatusView {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: TrackerMode | null;
  repos: TrackerRepoView[];
  /** The token's scopes as GitHub reports them (null: not reported, e.g. a fine-grained token, or not checked yet) */
  scopes: { checked: boolean; granted: string[] | null; missing: string[] };
  syncState: TrackerSyncState | null;
  links: TrackerLink[];
  pending: TrackerPendingCreate[];
  recentWrites: TrackerWrite[];
  /** Jobs waiting in the tracker's queue, and jobs dropped because it was full (a reconcile catches up) */
  queue: { waiting: number; dropped: number };
  warnings: string[];
  /** Config errors (the tracker did not start) */
  errors: string[];
}
