/**
 * SQLite store for the tracker module.
 * Persists links between tasks and issues, sync state, and write history.
 */
import Database from "better-sqlite3";
import type { TrackerLink, TrackerOp, TrackerStatus, TrackerSyncState, TrackerWrite } from "../../shared/tracker-types.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  -- Links between tasks and GitHub issues
  CREATE TABLE IF NOT EXISTS tracker_links (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    project_item_id TEXT,
    status TEXT,
    agent TEXT,
    linked_at TEXT NOT NULL,
    synced_at TEXT,
    PRIMARY KEY (project, task)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_links_issue ON tracker_links(project, issue_number);

  -- Sync state per project
  CREATE TABLE IF NOT EXISTS tracker_sync (
    project TEXT PRIMARY KEY,
    last_reconcile_at TEXT,
    last_event_at TEXT,
    next_reconcile_at TEXT,
    drift_fixed_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    rate_limit_reset_at TEXT
  );

  -- Write history (for audit and observe mode)
  CREATE TABLE IF NOT EXISTS tracker_writes (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    task TEXT,
    issue_number INTEGER,
    op TEXT NOT NULL,
    value TEXT,
    mode TEXT NOT NULL,
    would_send TEXT,
    result TEXT,
    error TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_writes_project ON tracker_writes(project, at DESC);
`;

export class TrackerStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  // ============ Links ============

  getLink(project: string, task: string): TrackerLink | null {
    const row = this.db
      .prepare(
        `SELECT task, issue_number, issue_url, project_item_id, status, agent, linked_at, synced_at
         FROM tracker_links WHERE project = ? AND task = ?`
      )
      .get(project, task) as LinkRow | undefined;
    return row ? mapLinkRow(row) : null;
  }

  getLinkByIssue(project: string, issueNumber: number): TrackerLink | null {
    const row = this.db
      .prepare(
        `SELECT task, issue_number, issue_url, project_item_id, status, agent, linked_at, synced_at
         FROM tracker_links WHERE project = ? AND issue_number = ?`
      )
      .get(project, issueNumber) as LinkRow | undefined;
    return row ? mapLinkRow(row) : null;
  }

  listLinks(project: string): TrackerLink[] {
    const rows = this.db
      .prepare(
        `SELECT task, issue_number, issue_url, project_item_id, status, agent, linked_at, synced_at
         FROM tracker_links WHERE project = ? ORDER BY linked_at DESC`
      )
      .all(project) as LinkRow[];
    return rows.map(mapLinkRow);
  }

  upsertLink(
    project: string,
    link: Omit<TrackerLink, "linkedAt" | "syncedAt"> & { linkedAt?: string; syncedAt?: string | null }
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tracker_links (project, task, issue_number, issue_url, project_item_id, status, agent, linked_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, task) DO UPDATE SET
           issue_number = excluded.issue_number,
           issue_url = excluded.issue_url,
           project_item_id = excluded.project_item_id,
           status = excluded.status,
           agent = excluded.agent,
           synced_at = excluded.synced_at`
      )
      .run(
        project,
        link.task,
        link.issueNumber,
        link.issueUrl,
        link.projectItemId,
        link.status,
        link.agent,
        link.linkedAt ?? now,
        link.syncedAt ?? null
      );
  }

  updateLinkStatus(project: string, task: string, status: TrackerStatus | null, agent: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tracker_links SET status = ?, agent = ?, synced_at = ? WHERE project = ? AND task = ?`)
      .run(status, agent, now, project, task);
  }

  updateLinkProjectItem(project: string, task: string, projectItemId: string | null): void {
    this.db
      .prepare(`UPDATE tracker_links SET project_item_id = ? WHERE project = ? AND task = ?`)
      .run(projectItemId, project, task);
  }

  deleteLink(project: string, task: string): void {
    this.db.prepare(`DELETE FROM tracker_links WHERE project = ? AND task = ?`).run(project, task);
  }

  // ============ Sync state ============

  getSyncState(project: string): TrackerSyncState | null {
    const row = this.db
      .prepare(
        `SELECT last_reconcile_at, last_event_at, next_reconcile_at, drift_fixed_count, error_count, last_error, rate_limit_reset_at
         FROM tracker_sync WHERE project = ?`
      )
      .get(project) as SyncRow | undefined;
    return row ? mapSyncRow(row) : null;
  }

  upsertSyncState(project: string, state: Partial<TrackerSyncState>): void {
    const existing = this.getSyncState(project);
    const merged: TrackerSyncState = {
      lastReconcileAt: state.lastReconcileAt ?? existing?.lastReconcileAt ?? null,
      lastEventAt: state.lastEventAt ?? existing?.lastEventAt ?? null,
      nextReconcileAt: state.nextReconcileAt ?? existing?.nextReconcileAt ?? null,
      driftFixedCount: state.driftFixedCount ?? existing?.driftFixedCount ?? 0,
      errorCount: state.errorCount ?? existing?.errorCount ?? 0,
      lastError: state.lastError ?? existing?.lastError ?? null,
      rateLimitResetAt: state.rateLimitResetAt ?? existing?.rateLimitResetAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO tracker_sync (project, last_reconcile_at, last_event_at, next_reconcile_at, drift_fixed_count, error_count, last_error, rate_limit_reset_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project) DO UPDATE SET
           last_reconcile_at = excluded.last_reconcile_at,
           last_event_at = excluded.last_event_at,
           next_reconcile_at = excluded.next_reconcile_at,
           drift_fixed_count = excluded.drift_fixed_count,
           error_count = excluded.error_count,
           last_error = excluded.last_error,
           rate_limit_reset_at = excluded.rate_limit_reset_at`
      )
      .run(
        project,
        merged.lastReconcileAt,
        merged.lastEventAt,
        merged.nextReconcileAt,
        merged.driftFixedCount,
        merged.errorCount,
        merged.lastError,
        merged.rateLimitResetAt
      );
  }

  incrementDriftFixed(project: string): void {
    this.db.prepare(`UPDATE tracker_sync SET drift_fixed_count = drift_fixed_count + 1 WHERE project = ?`).run(project);
  }

  incrementErrorCount(project: string, error: string): void {
    this.db
      .prepare(`UPDATE tracker_sync SET error_count = error_count + 1, last_error = ? WHERE project = ?`)
      .run(error, project);
  }

  clearErrors(project: string): void {
    this.db.prepare(`UPDATE tracker_sync SET error_count = 0, last_error = NULL WHERE project = ?`).run(project);
  }

  // ============ Writes ============

  recordWrite(project: string, write: Omit<TrackerWrite, "id" | "at">): string {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tracker_writes (id, project, task, issue_number, op, value, mode, would_send, result, error, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, project, write.task, write.issueNumber, write.op, write.value, write.mode, write.wouldSend, write.result, write.error, at);
    return id;
  }

  listRecentWrites(project: string, limit = 50): TrackerWrite[] {
    const rows = this.db
      .prepare(
        `SELECT id, task, issue_number, op, value, mode, would_send, result, error, at
         FROM tracker_writes WHERE project = ? ORDER BY at DESC LIMIT ?`
      )
      .all(project, limit) as WriteRow[];
    return rows.map(mapWriteRow);
  }

  /** Clean up old writes (keep last N days) */
  cleanupWrites(project: string, keepDays: number): number {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM tracker_writes WHERE project = ? AND at < ?`).run(project, cutoff);
    return result.changes;
  }
}

// ============ Row types ============

interface LinkRow {
  task: string;
  issue_number: number;
  issue_url: string;
  project_item_id: string | null;
  status: string | null;
  agent: string | null;
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
}

interface WriteRow {
  id: string;
  task: string | null;
  issue_number: number | null;
  op: string;
  value: string | null;
  mode: string;
  would_send: string | null;
  result: string | null;
  error: string | null;
  at: string;
}

function mapLinkRow(row: LinkRow): TrackerLink {
  return {
    task: row.task,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    projectItemId: row.project_item_id,
    status: row.status as TrackerStatus | null,
    agent: row.agent,
    linkedAt: row.linked_at,
    syncedAt: row.synced_at,
  };
}

function mapSyncRow(row: SyncRow): TrackerSyncState {
  return {
    lastReconcileAt: row.last_reconcile_at,
    lastEventAt: row.last_event_at,
    nextReconcileAt: row.next_reconcile_at,
    driftFixedCount: row.drift_fixed_count,
    errorCount: row.error_count,
    lastError: row.last_error,
    rateLimitResetAt: row.rate_limit_reset_at,
  };
}

function mapWriteRow(row: WriteRow): TrackerWrite {
  return {
    id: row.id,
    task: row.task,
    issueNumber: row.issue_number,
    op: row.op as TrackerOp,
    value: row.value,
    mode: row.mode as "observe" | "act",
    wouldSend: row.would_send,
    result: row.result as "success" | "error" | "rate_limited" | null,
    error: row.error,
    at: row.at,
  };
}
