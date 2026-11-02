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
  | "sync_requested"
  /** A proposed link: would_link (not made), or made (value: "auto", or "owner <session id>"); in Lair's store only */
  | "link_issue";

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
  /** would_close: a removed task line whose issue close_removed_tasks (off) would close; would_link: a proposed link not made (auto_link off, observe mode, or ambiguous) */
  result: "success" | "error" | "rate_limited" | "skipped" | "would_send" | "would_close" | "would_link";
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

/** A linked task's PR that was closed without merging (seen by the last reconcile): the task's card is left where it is */
export interface TrackerUnmergedPull {
  task: string;
  /** The PR: its repository and number */
  prRepo: string;
  pr: number;
}

/** A linked task whose line is not in the tasks file (removed or commented out by hand) */
export interface TrackerRemovedTask {
  task: string;
  repo: string;
  issueNumber: number;
  /** Reconciles in a row that did not find its line (counted since the tracker started) */
  missedReconciles: number;
  /** waiting: missed fewer than 2 reconciles; would_close: close_removed_tasks is off, so its issue stays open; closing: a later reconcile closes it (one closes at most 10) */
  action: "waiting" | "would_close" | "closing";
}

/** Why a reconcile proposes an issue for a task */
export type TrackerLinkReason =
  /** The open issue's title or body names the task id */
  | "mentions_task"
  /** An open PR of the task (its branch ends with the task id, or its body names it) closes the issue */
  | "pull_closes"
  /** The issue's title is close to the title Lair would give the task */
  | "similar_title";

export interface TrackerLinkCandidate {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  reasons: TrackerLinkReason[];
  /** similar_title: the similarity (0 to 1) */
  score: number | null;
  /** pull_closes: the PR */
  pr: number | null;
}

/** An unlinked task and the issues the last reconcile found for it */
export interface TrackerLinkProposal {
  task: string;
  candidates: TrackerLinkCandidate[];
  /** would_link: one candidate, waiting for the owner (or auto_link in act mode); ambiguous: more than one candidate, or the issue is proposed for another task too: never linked automatically */
  action: "would_link" | "ambiguous";
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
  /** PRs of linked tasks closed without merging (the last reconcile) */
  closedUnmerged: TrackerUnmergedPull[];
  /** Linked tasks whose line left the tasks file and whose issue is still open */
  removedTasks: TrackerRemovedTask[];
  /** Unlinked tasks and the issues the last reconcile proposes for them (POST /api/tracker/links accepts one) */
  proposals: TrackerLinkProposal[];
  warnings: string[];
  /** Config errors (the tracker did not start) */
  errors: string[];
}
