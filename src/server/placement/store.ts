/**
 * Placement store (data/placement.db): the moves (made, failed, interrupted,
 * or advised in observe mode), the runs Lair saw start (lane, class, load
 * while running), and the durations learned from finished runs. SQLite, so
 * cool-downs, learned durations and a move interrupted by a restart survive
 * it. Times are the placement Clock's milliseconds.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { PlacementMove, PlacementMoveStatus } from "../../shared/placement-types.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS placement_moves (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    from_lane TEXT NOT NULL,
    to_lane TEXT NOT NULL,
    priority INTEGER NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    gain_seconds INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    argv TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pl_moves_gate ON placement_moves(project, gate_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pl_moves_project ON placement_moves(project, created_at);
  CREATE INDEX IF NOT EXISTS idx_pl_moves_status ON placement_moves(project, status);

  CREATE TABLE IF NOT EXISTS placement_runs (
    project TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    machine TEXT NOT NULL,
    class TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    load_sum REAL NOT NULL DEFAULT 0,
    load_samples INTEGER NOT NULL DEFAULT 0,
    start_known INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, gate_id)
  );

  CREATE TABLE IF NOT EXISTS placement_samples (
    project TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    class TEXT NOT NULL,
    machine TEXT NOT NULL,
    seconds REAL NOT NULL,
    factor REAL,
    finished_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (project, gate_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pl_samples ON placement_samples(project, finished_at);
`;

/** Rows kept: moves for 30 days, samples for 90 */
const MOVE_RETENTION_MS = 30 * 86_400_000;
const SAMPLE_RETENTION_MS = 90 * 86_400_000;

interface MoveRow {
  id: string;
  project: string;
  gate_id: string;
  from_lane: string;
  to_lane: string;
  priority: number;
  mode: string;
  status: string;
  gain_seconds: number;
  explanation: string;
  argv: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface StoredMove {
  id: string;
  gateId: string;
  from: string;
  to: string;
  priority: number;
  mode: "observe" | "act";
  status: PlacementMoveStatus;
  gainSeconds: number;
  explanation: string;
  argv: string[] | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface RunRecord {
  gateId: string;
  lane: string;
  machine: string;
  class: string;
  startedAt: number;
  lastSeenAt: number;
  loadSum: number;
  loadSamples: number;
  /** Lair saw it start (queued one tick, running the next) or read its claim time: its start is exact */
  startKnown: boolean;
}

export interface Sample {
  gateId: string;
  class: string;
  machine: string;
  seconds: number;
  /** The average load factor while it ran, when Lair measured it */
  factor: number | null;
  finishedAt: number;
  source: "observed" | "history";
}

function toMove(row: MoveRow): StoredMove {
  let argv: string[] | null = null;
  try {
    argv = row.argv ? (JSON.parse(row.argv) as string[]) : null;
  } catch {
    argv = null;
  }
  return {
    id: row.id,
    gateId: row.gate_id,
    from: row.from_lane,
    to: row.to_lane,
    priority: row.priority,
    mode: row.mode === "act" ? "act" : "observe",
    status: row.status as PlacementMoveStatus,
    gainSeconds: row.gain_seconds,
    explanation: row.explanation,
    argv,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function moveForApi(move: StoredMove): PlacementMove {
  return {
    id: move.id,
    gateId: move.gateId,
    from: move.from,
    to: move.to,
    mode: move.mode,
    status: move.status,
    gainSeconds: move.gainSeconds,
    explanation: move.explanation,
    argv: move.argv,
    error: move.error,
    at: new Date(move.createdAt).toISOString(),
    completedAt: move.completedAt === null ? null : new Date(move.completedAt).toISOString(),
  };
}

export class PlacementStore {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`${dbPath} has schema version ${version}, newer than this Lair (${SCHEMA_VERSION})`);
    }
    if (version < SCHEMA_VERSION) {
      // Version 1 is the first: every statement is IF NOT EXISTS, so a later version adds to it
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ MOVES ============

  addMove(
    project: string,
    move: Omit<StoredMove, "id" | "completedAt"> & { completedAt?: number | null },
  ): StoredMove {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO placement_moves (id, project, gate_id, from_lane, to_lane, priority, mode, status, gain_seconds,
           explanation, argv, error, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project,
        move.gateId,
        move.from,
        move.to,
        move.priority,
        move.mode,
        move.status,
        Math.round(move.gainSeconds),
        move.explanation,
        move.argv ? JSON.stringify(move.argv) : null,
        move.error,
        move.createdAt,
        move.completedAt ?? null,
      );
    return { ...move, id, completedAt: move.completedAt ?? null };
  }

  finishMove(id: string, status: PlacementMoveStatus, at: number, error: string | null = null): void {
    this.db
      .prepare(`UPDATE placement_moves SET status = ?, completed_at = ?, error = ? WHERE id = ?`)
      .run(status, at, error, id);
  }

  movesWithStatus(project: string, status: PlacementMoveStatus): StoredMove[] {
    const rows = this.db
      .prepare(`SELECT * FROM placement_moves WHERE project = ? AND status = ? ORDER BY created_at`)
      .all(project, status) as MoveRow[];
    return rows.map(toMove);
  }

  /** The latest moves, newest first. */
  recentMoves(project: string, limit = 20): StoredMove[] {
    const rows = this.db
      .prepare(`SELECT * FROM placement_moves WHERE project = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as MoveRow[];
    return rows.map(toMove);
  }

  /**
   * When each gate was last moved or tried (act mode: moved, failed,
   * interrupted, moving) at or after `since`. Advice (would_move) is not a move.
   */
  lastAttempts(project: string, since: number): Map<string, StoredMove> {
    const rows = this.db
      .prepare(
        `SELECT * FROM placement_moves WHERE project = ? AND mode = 'act' AND status != 'would_move'
           AND created_at >= ? ORDER BY created_at`,
      )
      .all(project, since) as MoveRow[];
    const out = new Map<string, StoredMove>();
    for (const row of rows) out.set(row.gate_id, toMove(row));
    return out;
  }

  // ============ RUNS ============

  runs(project: string): RunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM placement_runs WHERE project = ?`).all(project) as {
      gate_id: string;
      lane: string;
      machine: string;
      class: string;
      started_at: number;
      last_seen_at: number;
      load_sum: number;
      load_samples: number;
      start_known: number;
    }[];
    return rows.map((r) => ({
      gateId: r.gate_id,
      lane: r.lane,
      machine: r.machine,
      class: r.class,
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      loadSum: r.load_sum,
      loadSamples: r.load_samples,
      startKnown: r.start_known === 1,
    }));
  }

  putRun(project: string, run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO placement_runs (project, gate_id, lane, machine, class, started_at, last_seen_at, load_sum,
           load_samples, start_known)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, gate_id) DO UPDATE SET lane = excluded.lane, machine = excluded.machine,
           class = excluded.class, started_at = excluded.started_at, last_seen_at = excluded.last_seen_at,
           load_sum = excluded.load_sum, load_samples = excluded.load_samples, start_known = excluded.start_known`,
      )
      .run(
        project,
        run.gateId,
        run.lane,
        run.machine,
        run.class,
        run.startedAt,
        run.lastSeenAt,
        run.loadSum,
        run.loadSamples,
        run.startKnown ? 1 : 0,
      );
  }

  deleteRun(project: string, gateId: string): void {
    this.db.prepare(`DELETE FROM placement_runs WHERE project = ? AND gate_id = ?`).run(project, gateId);
  }

  // ============ SAMPLES ============

  hasSample(project: string, gateId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM placement_samples WHERE project = ? AND gate_id = ?`).get(project, gateId) !==
      undefined
    );
  }

  /** Learn one finished run; a gate id learned before is kept as it was. */
  addSample(project: string, sample: Sample): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO placement_samples (project, gate_id, class, machine, seconds, factor, finished_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project,
        sample.gateId,
        sample.class,
        sample.machine,
        sample.seconds,
        sample.factor,
        sample.finishedAt,
        sample.source,
      );
  }

  /** The newest samples first, at most `limit`. */
  recentSamples(project: string, limit = 5000): Sample[] {
    const rows = this.db
      .prepare(`SELECT * FROM placement_samples WHERE project = ? ORDER BY finished_at DESC LIMIT ?`)
      .all(project, limit) as {
      gate_id: string;
      class: string;
      machine: string;
      seconds: number;
      factor: number | null;
      finished_at: number;
      source: string;
    }[];
    return rows.map((r) => ({
      gateId: r.gate_id,
      class: r.class,
      machine: r.machine,
      seconds: r.seconds,
      factor: r.factor,
      finishedAt: r.finished_at,
      source: r.source === "observed" ? "observed" : "history",
    }));
  }

  /** Drop old moves and samples. */
  prune(project: string, now: number): void {
    this.db.prepare(`DELETE FROM placement_moves WHERE project = ? AND created_at < ?`).run(project, now - MOVE_RETENTION_MS);
    this.db
      .prepare(`DELETE FROM placement_samples WHERE project = ? AND finished_at < ?`)
      .run(project, now - SAMPLE_RETENTION_MS);
  }
}
