/**
 * Cleanup store: removals and cycles in SQLite (data/cleanup.db).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cleanup_removals (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    bytes_freed INTEGER NOT NULL,
    removed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cleanup_removals_project ON cleanup_removals(project, removed_at);

  CREATE TABLE IF NOT EXISTS cleanup_cycles (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    entries_removed INTEGER NOT NULL DEFAULT 0,
    bytes_freed INTEGER NOT NULL DEFAULT 0,
    entries_skipped INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cleanup_cycles_project ON cleanup_cycles(project, started_at);
`;

export interface CleanupRemoval {
  id: string;
  project: string;
  path: string;
  kind: "worktree" | "dir" | "file";
  reason: string;
  bytesFreed: number;
  removedAt: number;
}

export interface CleanupCycle {
  id: string;
  project: string;
  startedAt: number;
  finishedAt: number | null;
  entriesRemoved: number;
  bytesFreed: number;
  entriesSkipped: number;
  mode: "observe" | "act";
}

interface RemovalRow {
  id: string;
  project: string;
  path: string;
  kind: string;
  reason: string;
  bytes_freed: number;
  removed_at: number;
}

interface CycleRow {
  id: string;
  project: string;
  started_at: number;
  finished_at: number | null;
  entries_removed: number;
  bytes_freed: number;
  entries_skipped: number;
  mode: string;
}

function toRemoval(row: RemovalRow): CleanupRemoval {
  return {
    id: row.id,
    project: row.project,
    path: row.path,
    kind: row.kind as "worktree" | "dir" | "file",
    reason: row.reason,
    bytesFreed: row.bytes_freed,
    removedAt: row.removed_at,
  };
}

function toCycle(row: CycleRow): CleanupCycle {
  return {
    id: row.id,
    project: row.project,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    entriesRemoved: row.entries_removed,
    bytesFreed: row.bytes_freed,
    entriesSkipped: row.entries_skipped,
    mode: row.mode as "observe" | "act",
  };
}

export class CleanupStore {
  private db: Database.Database;

  constructor(dbPath: string = "data/cleanup.db") {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Removals

  recordRemoval(removal: Omit<CleanupRemoval, "id">): CleanupRemoval {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cleanup_removals (id, project, path, kind, reason, bytes_freed, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, removal.project, removal.path, removal.kind, removal.reason, removal.bytesFreed, removal.removedAt);
    return { id, ...removal };
  }

  getRecentRemovals(project: string, limit: number = 100): CleanupRemoval[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cleanup_removals
         WHERE project = ?
         ORDER BY removed_at DESC
         LIMIT ?`,
      )
      .all(project, limit) as RemovalRow[];
    return rows.map(toRemoval);
  }

  wasRemoved(project: string, path: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM cleanup_removals WHERE project = ? AND path = ? LIMIT 1`)
      .get(project, path) as { id: string } | undefined;
    return row !== undefined;
  }

  getRemovalsByPaths(project: string, paths: string[]): Map<string, CleanupRemoval> {
    if (paths.length === 0) return new Map();
    const placeholders = paths.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM cleanup_removals WHERE project = ? AND path IN (${placeholders})`,
      )
      .all(project, ...paths) as RemovalRow[];
    const map = new Map<string, CleanupRemoval>();
    for (const row of rows) {
      map.set(row.path, toRemoval(row));
    }
    return map;
  }

  // Cycles

  startCycle(project: string, mode: "observe" | "act"): CleanupCycle {
    const id = randomUUID();
    const startedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO cleanup_cycles (id, project, started_at, mode)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, project, startedAt, mode);
    return {
      id,
      project,
      startedAt,
      finishedAt: null,
      entriesRemoved: 0,
      bytesFreed: 0,
      entriesSkipped: 0,
      mode,
    };
  }

  finishCycle(
    cycleId: string,
    entriesRemoved: number,
    bytesFreed: number,
    entriesSkipped: number,
  ): void {
    this.db
      .prepare(
        `UPDATE cleanup_cycles
         SET finished_at = ?, entries_removed = ?, bytes_freed = ?, entries_skipped = ?
         WHERE id = ?`,
      )
      .run(Date.now(), entriesRemoved, bytesFreed, entriesSkipped, cycleId);
  }

  getRecentCycles(project: string, limit: number = 20): CleanupCycle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cleanup_cycles
         WHERE project = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(project, limit) as CycleRow[];
    return rows.map(toCycle);
  }

  getLastCompletedCycle(project: string): CleanupCycle | null {
    const row = this.db
      .prepare(
        `SELECT * FROM cleanup_cycles
         WHERE project = ? AND finished_at IS NOT NULL
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get(project) as CycleRow | undefined;
    return row ? toCycle(row) : null;
  }

  getIncompleteCycles(project: string): CleanupCycle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cleanup_cycles
         WHERE project = ? AND finished_at IS NULL
         ORDER BY started_at DESC`,
      )
      .all(project) as CycleRow[];
    return rows.map(toCycle);
  }

  markCycleIncomplete(cycleId: string): void {
    // Mark as finished with 0 work to indicate it was interrupted
    this.db
      .prepare(
        `UPDATE cleanup_cycles
         SET finished_at = started_at, entries_skipped = -1
         WHERE id = ? AND finished_at IS NULL`,
      )
      .run(cycleId);
  }

  // Summary stats

  getTotalBytesFreed(project: string, sinceMs?: number): number {
    let query = `SELECT COALESCE(SUM(bytes_freed), 0) as total FROM cleanup_removals WHERE project = ?`;
    const params: (string | number)[] = [project];
    if (sinceMs !== undefined) {
      query += ` AND removed_at >= ?`;
      params.push(sinceMs);
    }
    const row = this.db.prepare(query).get(...params) as { total: number };
    return row.total;
  }

  getTotalEntriesRemoved(project: string, sinceMs?: number): number {
    let query = `SELECT COUNT(*) as count FROM cleanup_removals WHERE project = ?`;
    const params: (string | number)[] = [project];
    if (sinceMs !== undefined) {
      query += ` AND removed_at >= ?`;
      params.push(sinceMs);
    }
    const row = this.db.prepare(query).get(...params) as { count: number };
    return row.count;
  }
}
