/**
 * The tracker's store, in its own file (data/tracker.db): the links between
 * tasks and issues, the creates that were sent and not yet matched to their
 * issue, the state of each project's sync, and the audit of every write.
 *
 * Its schema version is kept in its own table, never in PRAGMA user_version
 * (which other stores use): a file whose user_version is set belongs to
 * another store and is refused, and so is one written by a newer Lair.
 */
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  TrackerLink,
  TrackerOp,
  TrackerPendingCreate,
  TrackerStatus,
  TrackerSyncState,
  TrackerWrite,
} from "../../shared/tracker-types.js";

export const TRACKER_SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tracker_links (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    project_item_id TEXT,
    status TEXT,
    agent TEXT,
    blocked_key TEXT,
    closed_as TEXT,
    closed_synced INTEGER NOT NULL DEFAULT 0,
    linked_at TEXT NOT NULL,
    synced_at TEXT,
    PRIMARY KEY (project, task)
  );
  CREATE INDEX IF NOT EXISTS tracker_links_issue ON tracker_links(project, repo, issue_number);

  CREATE TABLE IF NOT EXISTS tracker_pending (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    repo TEXT NOT NULL,
    marker TEXT NOT NULL,
    since TEXT NOT NULL,
    PRIMARY KEY (project, task)
  );

  CREATE TABLE IF NOT EXISTS tracker_sync (
    project TEXT PRIMARY KEY,
    last_reconcile_at TEXT,
    last_event_at TEXT,
    next_reconcile_at TEXT,
    drift_fixed_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    rate_limit_reset_at TEXT,
    needs_owner TEXT
  );

  CREATE TABLE IF NOT EXISTS tracker_writes (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    task TEXT,
    repo TEXT,
    issue_number INTEGER,
    op TEXT NOT NULL,
    value TEXT,
    mode TEXT NOT NULL,
    would_send TEXT,
    result TEXT NOT NULL,
    error TEXT,
    dedupe_key TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tracker_writes_recent ON tracker_writes(project, at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS tracker_writes_dedupe ON tracker_writes(project, dedupe_key) WHERE dedupe_key IS NOT NULL;
`;

export class TrackerStoreError extends Error {}

export interface WriteInput {
  task: string | null;
  repo: string | null;
  issueNumber: number | null;
  op: TrackerOp;
  value: string | null;
  mode: "observe" | "act";
  wouldSend: string | null;
  result: TrackerWrite["result"];
  error: string | null;
  /** Rows with the same key are kept once (observe): the row's time and count are updated */
  dedupeKey?: string | null;
}

export type LinkPatch = Partial<Omit<TrackerLink, "task" | "linkedAt">>;

const LINK_COLUMNS = `task, repo, issue_number, issue_url, project_item_id, status, agent, blocked_key, closed_as, closed_synced, linked_at, synced_at`;

export class TrackerStore {
  private readonly db: Database.Database;

  /** Opens (or creates) the tracker's own database file; ":memory:" for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  private migrate(): void {
    const userVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (userVersion !== 0) {
      throw new TrackerStoreError(`this database belongs to another store (user_version ${userVersion}): the tracker keeps its own file`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS tracker_schema (version INTEGER NOT NULL)`);
    const row = this.db.prepare(`SELECT version FROM tracker_schema`).get() as { version: number } | undefined;
    if (row && row.version > TRACKER_SCHEMA_VERSION) {
      throw new TrackerStoreError(
        `the tracker store was written by a newer Lair (schema ${row.version}, this one knows ${TRACKER_SCHEMA_VERSION}): update Lair, or move the file aside`,
      );
    }
    this.db.transaction(() => {
      this.db.exec(SCHEMA);
      if (!row) this.db.prepare(`INSERT INTO tracker_schema (version) VALUES (?)`).run(TRACKER_SCHEMA_VERSION);
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  // ============ Links ============

  getLink(project: string, task: string): TrackerLink | null {
    const row = this.db.prepare(`SELECT ${LINK_COLUMNS} FROM tracker_links WHERE project = ? AND task = ?`).get(project, task) as LinkRow | undefined;
    return row ? linkOf(row) : null;
  }

  getLinkByIssue(project: string, repo: string, issueNumber: number): TrackerLink | null {
    const row = this.db
      .prepare(`SELECT ${LINK_COLUMNS} FROM tracker_links WHERE project = ? AND lower(repo) = lower(?) AND issue_number = ?`)
      .get(project, repo, issueNumber) as LinkRow | undefined;
    return row ? linkOf(row) : null;
  }

  listLinks(project: string): TrackerLink[] {
    const rows = this.db.prepare(`SELECT ${LINK_COLUMNS} FROM tracker_links WHERE project = ? ORDER BY linked_at DESC, task`).all(project) as LinkRow[];
    return rows.map(linkOf);
  }

  /** Records the link and drops the task's pending create, at once. */
  addLink(project: string, link: TrackerLink): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tracker_links (project, ${LINK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, task) DO NOTHING`,
        )
        .run(
          project,
          link.task,
          link.repo,
          link.issueNumber,
          link.issueUrl,
          link.projectItemId,
          link.status,
          link.agent,
          link.blockedKey,
          link.closedAs,
          link.closedSynced ? 1 : 0,
          link.linkedAt,
          link.syncedAt,
        );
      this.db.prepare(`DELETE FROM tracker_pending WHERE project = ? AND task = ?`).run(project, link.task);
    })();
  }

  updateLink(project: string, task: string, patch: LinkPatch, at: string): void {
    const columns: Record<keyof LinkPatch, string> = {
      repo: "repo",
      issueNumber: "issue_number",
      issueUrl: "issue_url",
      projectItemId: "project_item_id",
      status: "status",
      agent: "agent",
      blockedKey: "blocked_key",
      closedAs: "closed_as",
      closedSynced: "closed_synced",
      syncedAt: "synced_at",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof LinkPatch, unknown][]) {
      if (value === undefined || key === "syncedAt") continue;
      sets.push(`${columns[key]} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    sets.push("synced_at = ?");
    values.push(at);
    this.db.prepare(`UPDATE tracker_links SET ${sets.join(", ")} WHERE project = ? AND task = ?`).run(...values, project, task);
  }

  // ============ Pending creates ============

  getPending(project: string, task: string): (TrackerPendingCreate & { marker: string }) | null {
    const row = this.db.prepare(`SELECT task, repo, marker, since FROM tracker_pending WHERE project = ? AND task = ?`).get(project, task) as
      | { task: string; repo: string; marker: string; since: string }
      | undefined;
    return row ?? null;
  }

  /** Before a create is sent: if it lands and its answer is lost, the issue is found again by its marker. */
  addPending(project: string, task: string, repo: string, marker: string, since: string): void {
    this.db
      .prepare(`INSERT INTO tracker_pending (project, task, repo, marker, since) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, task) DO NOTHING`)
      .run(project, task, repo, marker, since);
  }

  deletePending(project: string, task: string): void {
    this.db.prepare(`DELETE FROM tracker_pending WHERE project = ? AND task = ?`).run(project, task);
  }

  listPending(project: string): TrackerPendingCreate[] {
    return this.db.prepare(`SELECT task, repo, since FROM tracker_pending WHERE project = ? ORDER BY since`).all(project) as TrackerPendingCreate[];
  }

  // ============ Sync state ============

  getState(project: string): TrackerSyncState | null {
    const row = this.db.prepare(`SELECT * FROM tracker_sync WHERE project = ?`).get(project) as SyncRow | undefined;
    return row ? syncOf(row) : null;
  }

  patchState(project: string, patch: Partial<Omit<TrackerSyncState, "driftFixedCount" | "errorCount">>): void {
    this.ensureState(project);
    const columns: Record<string, string> = {
      lastReconcileAt: "last_reconcile_at",
      lastEventAt: "last_event_at",
      nextReconcileAt: "next_reconcile_at",
      lastError: "last_error",
      rateLimitResetAt: "rate_limit_reset_at",
      needsOwner: "needs_owner",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(value);
    }
    if (sets.length > 0) this.db.prepare(`UPDATE tracker_sync SET ${sets.join(", ")} WHERE project = ?`).run(...values, project);
  }

  private ensureState(project: string): void {
    this.db.prepare(`INSERT INTO tracker_sync (project) VALUES (?) ON CONFLICT (project) DO NOTHING`).run(project);
  }

  incrementDriftFixed(project: string): void {
    this.ensureState(project);
    this.db.prepare(`UPDATE tracker_sync SET drift_fixed_count = drift_fixed_count + 1 WHERE project = ?`).run(project);
  }

  noteError(project: string, error: string): void {
    this.ensureState(project);
    this.db.prepare(`UPDATE tracker_sync SET error_count = error_count + 1, last_error = ? WHERE project = ?`).run(error.slice(0, 500), project);
  }

  clearErrors(project: string): void {
    this.ensureState(project);
    this.db.prepare(`UPDATE tracker_sync SET error_count = 0, last_error = NULL WHERE project = ?`).run(project);
  }

  // ============ The audit of writes ============

  recordWrite(project: string, write: WriteInput, at: string): void {
    const key = write.dedupeKey ?? null;
    this.db
      .prepare(
        `INSERT INTO tracker_writes (id, project, task, repo, issue_number, op, value, mode, would_send, result, error, dedupe_key, count, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (project, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO UPDATE SET count = count + 1, at = excluded.at, would_send = excluded.would_send`,
      )
      .run(
        randomUUID(),
        project,
        write.task,
        write.repo,
        write.issueNumber,
        write.op,
        write.value,
        write.mode,
        write.wouldSend,
        write.result,
        write.error,
        key,
        at,
      );
  }

  listWrites(project: string, limit = 50): TrackerWrite[] {
    const rows = this.db
      .prepare(`SELECT * FROM tracker_writes WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as WriteRow[];
    return rows.map(writeOf);
  }

  /** Drops audit rows older than `before` (ISO). */
  cleanupWrites(project: string, before: string): number {
    return this.db.prepare(`DELETE FROM tracker_writes WHERE project = ? AND at < ?`).run(project, before).changes;
  }
}

interface LinkRow {
  task: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  project_item_id: string | null;
  status: string | null;
  agent: string | null;
  blocked_key: string | null;
  closed_as: string | null;
  closed_synced: number;
  linked_at: string;
  synced_at: string | null;
}

interface SyncRow {
  last_reconcile_at: string | null;
  last_event_at: string | null;
  next_reconcile_at: string | null;
  drift_fixed_count: number;
  error_count: number;
  last_error: string | null;
  rate_limit_reset_at: string | null;
  needs_owner: string | null;
}

interface WriteRow {
  id: string;
  task: string | null;
  repo: string | null;
  issue_number: number | null;
  op: string;
  value: string | null;
  mode: string;
  would_send: string | null;
  result: string;
  error: string | null;
  count: number;
  at: string;
}

function linkOf(row: LinkRow): TrackerLink {
  return {
    task: row.task,
    repo: row.repo,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    projectItemId: row.project_item_id,
    status: row.status as TrackerStatus | null,
    agent: row.agent,
    blockedKey: row.blocked_key,
    closedAs: row.closed_as as TrackerLink["closedAs"],
    closedSynced: row.closed_synced === 1,
    linkedAt: row.linked_at,
    syncedAt: row.synced_at,
  };
}

function syncOf(row: SyncRow): TrackerSyncState {
  return {
    lastReconcileAt: row.last_reconcile_at,
    lastEventAt: row.last_event_at,
    nextReconcileAt: row.next_reconcile_at,
    driftFixedCount: row.drift_fixed_count,
    errorCount: row.error_count,
    lastError: row.last_error,
    rateLimitResetAt: row.rate_limit_reset_at,
    needsOwner: row.needs_owner,
  };
}

function writeOf(row: WriteRow): TrackerWrite {
  return {
    id: row.id,
    task: row.task,
    repo: row.repo,
    issueNumber: row.issue_number,
    op: row.op as TrackerOp,
    value: row.value,
    mode: row.mode as TrackerWrite["mode"],
    wouldSend: row.would_send,
    result: row.result as TrackerWrite["result"],
    error: row.error,
    count: row.count,
    at: row.at,
  };
}
