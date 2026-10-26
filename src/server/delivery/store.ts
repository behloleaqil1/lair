/**
 * Delivery store: holds, crash loops, restart samples, operations, the last
 * commit seen per environment, the commit each service was deployed at, and
 * the last container names read for each service. SQLite (data/delivery.db),
 * so a hold, a crash loop and the operation history survive a restart.
 *
 * Times are written from the delivery Clock, never SQLite's datetime(), so
 * tests with a fake clock get exact values.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  CrashLoop,
  Hold,
  HoldSource,
  Operation,
  OperationKind,
  OperationStatus,
  OperationStep,
  RequestedBy,
} from "./types.js";

/**
 * 1: holds, crash loops, samples, operations, refs.
 * 2: operations.recovered_by, delivery_service_shas, delivery_containers.
 */
export const SCHEMA_VERSION = 2;

/**
 * Changes to tables that already exist, by the version they upgrade from.
 * New tables need no entry: SCHEMA creates whatever is missing.
 */
const MIGRATIONS: Record<number, string[]> = {
  1: [`ALTER TABLE delivery_operations ADD COLUMN recovered_by TEXT`],
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_holds (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    held_at TEXT NOT NULL,
    PRIMARY KEY (project, environment, service)
  );

  CREATE TABLE IF NOT EXISTS delivery_crash_loops (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    container TEXT NOT NULL,
    restarts INTEGER NOT NULL,
    max_restarts INTEGER NOT NULL,
    window_minutes REAL NOT NULL,
    since TEXT NOT NULL,
    evidence TEXT NOT NULL,
    error_lines TEXT NOT NULL,
    PRIMARY KEY (project, environment, service)
  );

  CREATE TABLE IF NOT EXISTS delivery_restart_samples (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    at INTEGER NOT NULL,
    restart_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_samples
    ON delivery_restart_samples(project, environment, service, at);

  CREATE TABLE IF NOT EXISTS delivery_operations (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    kind TEXT NOT NULL,
    services TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    reason TEXT,
    sha TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    steps TEXT NOT NULL,
    error TEXT,
    recovered_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_operations
    ON delivery_operations(project, environment, started_at);

  CREATE TABLE IF NOT EXISTS delivery_refs (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    sha TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (project, environment)
  );

  CREATE TABLE IF NOT EXISTS delivery_service_shas (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    deployed_sha TEXT,
    target_sha TEXT,
    PRIMARY KEY (project, environment, service)
  );

  CREATE TABLE IF NOT EXISTS delivery_containers (
    project TEXT NOT NULL,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    names TEXT NOT NULL,
    PRIMARY KEY (project, environment, service)
  );
`;

interface HoldRow {
  project: string;
  environment: string;
  service: string;
  reason: string;
  source: string;
  held_at: string;
}

interface CrashLoopRow {
  project: string;
  environment: string;
  service: string;
  container: string;
  restarts: number;
  max_restarts: number;
  window_minutes: number;
  since: string;
  evidence: string;
  error_lines: string;
}

interface OperationRow {
  id: string;
  project: string;
  environment: string;
  kind: string;
  services: string;
  requested_by: string;
  reason: string | null;
  sha: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  steps: string;
  error: string | null;
  recovered_by: string | null;
}

export class DeliveryStore {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      this.db.transaction(() => {
        // Creates what is missing: every table on a new database, the tables added since on an old one
        this.db.exec(SCHEMA);
        // A new database (version 0) already has the current tables
        for (let from = version; version > 0 && from < SCHEMA_VERSION; from++) {
          for (const statement of MIGRATIONS[from] ?? []) this.db.exec(statement);
        }
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ HOLDS ============

  /** Hold a service (or update the reason and source of an existing hold). */
  setHold(hold: Hold): void {
    this.db
      .prepare(
        `INSERT INTO delivery_holds (project, environment, service, reason, source, held_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, environment, service) DO UPDATE SET
           reason = excluded.reason, source = excluded.source, held_at = excluded.held_at`,
      )
      .run(hold.project, hold.environment, hold.service, hold.reason, hold.source, hold.heldAt);
  }

  getHold(project: string, environment: string, service: string): Hold | null {
    const row = this.db
      .prepare(`SELECT * FROM delivery_holds WHERE project = ? AND environment = ? AND service = ?`)
      .get(project, environment, service) as HoldRow | undefined;
    return row ? toHold(row) : null;
  }

  holds(project: string, environment?: string): Hold[] {
    const rows = (
      environment === undefined
        ? this.db.prepare(`SELECT * FROM delivery_holds WHERE project = ? ORDER BY rowid`).all(project)
        : this.db
            .prepare(`SELECT * FROM delivery_holds WHERE project = ? AND environment = ? ORDER BY rowid`)
            .all(project, environment)
    ) as HoldRow[];
    return rows.map(toHold);
  }

  /** Release one service's hold; false when it wasn't held. */
  releaseHold(project: string, environment: string, service: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM delivery_holds WHERE project = ? AND environment = ? AND service = ?`)
        .run(project, environment, service).changes > 0
    );
  }

  // ============ CRASH LOOPS ============

  setCrashLoop(loop: CrashLoop): void {
    this.db
      .prepare(
        `INSERT INTO delivery_crash_loops
           (project, environment, service, container, restarts, max_restarts, window_minutes, since, evidence, error_lines)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, environment, service) DO UPDATE SET
           container = excluded.container, restarts = excluded.restarts, evidence = excluded.evidence,
           error_lines = excluded.error_lines`,
      )
      .run(
        loop.project,
        loop.environment,
        loop.service,
        loop.container,
        loop.restarts,
        loop.maxRestarts,
        loop.windowMinutes,
        loop.since,
        JSON.stringify(loop.evidence),
        JSON.stringify(loop.errorLines),
      );
  }

  getCrashLoop(project: string, environment: string, service: string): CrashLoop | null {
    const row = this.db
      .prepare(`SELECT * FROM delivery_crash_loops WHERE project = ? AND environment = ? AND service = ?`)
      .get(project, environment, service) as CrashLoopRow | undefined;
    return row ? toCrashLoop(row) : null;
  }

  crashLoops(project: string): CrashLoop[] {
    const rows = this.db
      .prepare(`SELECT * FROM delivery_crash_loops WHERE project = ? ORDER BY rowid`)
      .all(project) as CrashLoopRow[];
    return rows.map(toCrashLoop);
  }

  /** Clear a crash loop and the samples that led to it; false when there was none. */
  clearCrashLoop(project: string, environment: string, service: string): boolean {
    this.clearSamples(project, environment, service);
    return (
      this.db
        .prepare(`DELETE FROM delivery_crash_loops WHERE project = ? AND environment = ? AND service = ?`)
        .run(project, environment, service).changes > 0
    );
  }

  // ============ RESTART SAMPLES ============

  addSample(project: string, environment: string, service: string, at: number, restartCount: number): void {
    this.db
      .prepare(
        `INSERT INTO delivery_restart_samples (project, environment, service, at, restart_count) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project, environment, service, at, restartCount);
  }

  /** Samples taken at or after `sinceMs`, oldest first; older ones are deleted. */
  samples(
    project: string,
    environment: string,
    service: string,
    sinceMs: number,
  ): { at: number; restartCount: number }[] {
    this.db
      .prepare(
        `DELETE FROM delivery_restart_samples WHERE project = ? AND environment = ? AND service = ? AND at < ?`,
      )
      .run(project, environment, service, sinceMs);
    const rows = this.db
      .prepare(
        `SELECT at, restart_count FROM delivery_restart_samples
         WHERE project = ? AND environment = ? AND service = ? ORDER BY at, rowid`,
      )
      .all(project, environment, service) as { at: number; restart_count: number }[];
    return rows.map((r) => ({ at: r.at, restartCount: r.restart_count }));
  }

  clearSamples(project: string, environment: string, service: string): void {
    this.db
      .prepare(`DELETE FROM delivery_restart_samples WHERE project = ? AND environment = ? AND service = ?`)
      .run(project, environment, service);
  }

  // ============ OPERATIONS ============

  createOperation(op: Omit<Operation, "id">): Operation {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO delivery_operations
           (id, project, environment, kind, services, requested_by, reason, sha, status, started_at, completed_at, steps, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        op.project,
        op.environment,
        op.kind,
        JSON.stringify(op.services),
        op.requestedBy,
        op.reason ?? null,
        op.sha ?? null,
        op.status,
        op.startedAt,
        op.completedAt ?? null,
        JSON.stringify(op.steps),
        op.error ?? null,
      );
    return this.getOperation(id)!;
  }

  updateOperation(
    id: string,
    patch: Partial<Pick<Operation, "status" | "completedAt" | "steps" | "error">>,
  ): void {
    const op = this.getOperation(id);
    if (!op) return;
    const next = { ...op, ...patch };
    this.db
      .prepare(`UPDATE delivery_operations SET status = ?, completed_at = ?, steps = ?, error = ? WHERE id = ?`)
      .run(next.status, next.completedAt ?? null, JSON.stringify(next.steps), next.error ?? null, id);
  }

  getOperation(id: string): Operation | null {
    const row = this.db.prepare(`SELECT * FROM delivery_operations WHERE id = ?`).get(id) as
      | OperationRow
      | undefined;
    return row ? toOperation(row) : null;
  }

  /** A project's operations, newest first. */
  listOperations(project: string, options: { environment?: string; limit?: number } = {}): Operation[] {
    const limit = options.limit ?? 100;
    const rows = (
      options.environment === undefined
        ? this.db
            .prepare(
              `SELECT * FROM delivery_operations WHERE project = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(project, limit)
        : this.db
            .prepare(
              `SELECT * FROM delivery_operations WHERE project = ? AND environment = ?
               ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(project, options.environment, limit)
    ) as OperationRow[];
    return rows.map(toOperation);
  }

  /**
   * Operations still marked running when the server starts were cut off by a
   * stop or a crash: mark them interrupted (a deploy is then recovered).
   */
  failInterrupted(project: string, at: string): number {
    return this.db
      .prepare(
        `UPDATE delivery_operations SET status = 'interrupted', completed_at = ?,
           error = 'interrupted: the server stopped before it finished'
         WHERE project = ? AND status = 'running'`,
      )
      .run(at, project).changes;
  }

  /** Interrupted deploys of an environment that no recover operation has checked yet, oldest first. */
  interruptedDeploys(project: string, environment: string): Operation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_operations
         WHERE project = ? AND environment = ? AND kind = 'deploy' AND status = 'interrupted' AND recovered_by IS NULL
         ORDER BY started_at, rowid`,
      )
      .all(project, environment) as OperationRow[];
    return rows.map(toOperation);
  }

  markRecovered(id: string, by: string): void {
    this.db.prepare(`UPDATE delivery_operations SET recovered_by = ? WHERE id = ?`).run(by, id);
  }

  // ============ COMMITS PER SERVICE ============

  /** The commit a service was last deployed at, and the last merge that changed it. */
  serviceShas(project: string, environment: string, service: string): { deployedSha: string | null; targetSha: string | null } {
    const row = this.db
      .prepare(
        `SELECT deployed_sha, target_sha FROM delivery_service_shas WHERE project = ? AND environment = ? AND service = ?`,
      )
      .get(project, environment, service) as { deployed_sha: string | null; target_sha: string | null } | undefined;
    return { deployedSha: row?.deployed_sha ?? null, targetSha: row?.target_sha ?? null };
  }

  setDeployedSha(project: string, environment: string, service: string, sha: string): void {
    this.db
      .prepare(
        `INSERT INTO delivery_service_shas (project, environment, service, deployed_sha) VALUES (?, ?, ?, ?)
         ON CONFLICT(project, environment, service) DO UPDATE SET deployed_sha = excluded.deployed_sha`,
      )
      .run(project, environment, service, sha);
  }

  setTargetSha(project: string, environment: string, service: string, sha: string): void {
    this.db
      .prepare(
        `INSERT INTO delivery_service_shas (project, environment, service, target_sha) VALUES (?, ?, ?, ?)
         ON CONFLICT(project, environment, service) DO UPDATE SET target_sha = excluded.target_sha`,
      )
      .run(project, environment, service, sha);
  }

  // ============ CONTAINER NAMES ============

  /** The container names last read for a service, so a hold is matched to them after a restart. */
  setContainerNames(project: string, environment: string, service: string, names: string[]): void {
    this.db
      .prepare(
        `INSERT INTO delivery_containers (project, environment, service, names) VALUES (?, ?, ?, ?)
         ON CONFLICT(project, environment, service) DO UPDATE SET names = excluded.names`,
      )
      .run(project, environment, service, JSON.stringify(names));
  }

  containerNames(project: string, environment: string, service: string): string[] {
    const row = this.db
      .prepare(`SELECT names FROM delivery_containers WHERE project = ? AND environment = ? AND service = ?`)
      .get(project, environment, service) as { names: string } | undefined;
    return row ? (JSON.parse(row.names) as string[]) : [];
  }

  // ============ REFS ============

  /** The last commit of deploy.ref an environment has seen (and deployed, or tried to). */
  seenSha(project: string, environment: string): string | null {
    const row = this.db
      .prepare(`SELECT sha FROM delivery_refs WHERE project = ? AND environment = ?`)
      .get(project, environment) as { sha: string } | undefined;
    return row?.sha ?? null;
  }

  setSeenSha(project: string, environment: string, sha: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO delivery_refs (project, environment, sha, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project, environment) DO UPDATE SET sha = excluded.sha, seen_at = excluded.seen_at`,
      )
      .run(project, environment, sha, at);
  }
}

function toHold(row: HoldRow): Hold {
  return {
    project: row.project,
    environment: row.environment,
    service: row.service,
    reason: row.reason,
    source: row.source as HoldSource,
    heldAt: row.held_at,
  };
}

function toCrashLoop(row: CrashLoopRow): CrashLoop {
  return {
    project: row.project,
    environment: row.environment,
    service: row.service,
    container: row.container,
    restarts: row.restarts,
    maxRestarts: row.max_restarts,
    windowMinutes: row.window_minutes,
    since: row.since,
    evidence: JSON.parse(row.evidence) as string[],
    errorLines: JSON.parse(row.error_lines) as string[],
  };
}

function toOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    project: row.project,
    environment: row.environment,
    kind: row.kind as OperationKind,
    services: JSON.parse(row.services) as string[],
    requestedBy: row.requested_by as RequestedBy,
    reason: row.reason ?? undefined,
    sha: row.sha ?? undefined,
    status: row.status as OperationStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    steps: JSON.parse(row.steps) as OperationStep[],
    error: row.error ?? undefined,
    recoveredBy: row.recovered_by ?? undefined,
  };
}
