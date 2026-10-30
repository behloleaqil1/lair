/**
 * Types for the tracker module (src/server/tracker/).
 * Lair keeps GitHub issues, Projects boards and milestones in sync with its
 * tasks, runs and PRs.
 */

/** The status a task can have on a Projects board */
export type TrackerStatus = "backlog" | "ready" | "in_progress" | "in_review" | "done";

/** Operations the tracker can perform */
export type TrackerOp =
  | "move_to_backlog"
  | "move_to_ready"
  | "move_to_in_progress"
  | "move_to_in_review"
  | "move_to_done"
  | "set_agent"
  | "add_label"
  | "remove_label"
  | "add_comment"
  | "close_issue"
  | "create_issue"
  | "close_milestone";

/** A tracked link between a task and a GitHub issue */
export interface TrackerLink {
  task: string;
  issueNumber: number;
  issueUrl: string;
  projectItemId: string | null;
  status: TrackerStatus | null;
  agent: string | null;
  /** When the link was created */
  linkedAt: string;
  /** When last synced */
  syncedAt: string | null;
}

/** An operation the tracker would perform or has performed */
export interface TrackerWrite {
  id: string;
  task: string | null;
  issueNumber: number | null;
  op: TrackerOp;
  /** The value written (status name, label name, agent id, comment text) */
  value: string | null;
  /** observe: recorded but not sent; act: sent */
  mode: "observe" | "act";
  /** For observe: what would be sent */
  wouldSend: string | null;
  /** For act: the result */
  result: "success" | "error" | "rate_limited" | null;
  error: string | null;
  at: string;
}

/** The tracker's sync state for a project */
export interface TrackerSyncState {
  lastReconcileAt: string | null;
  lastEventAt: string | null;
  nextReconcileAt: string | null;
  driftFixedCount: number;
  errorCount: number;
  lastError: string | null;
  rateLimitResetAt: string | null;
}

/** A Projects v2 item on the board */
export interface ProjectItem {
  id: string;
  issueNumber: number;
  status: TrackerStatus | null;
  agent: string | null;
}

/** View of the tracker state for the API */
export interface TrackerStatusView {
  enabled: boolean;
  mode: "off" | "observe" | "act";
  repo: string | null;
  projectNumber: number | null;
  projectUrl: string | null;
  syncState: TrackerSyncState | null;
  links: TrackerLink[];
  recentWrites: TrackerWrite[];
  warnings: string[];
  errors: string[];
}
