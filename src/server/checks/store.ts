/**
 * Checks store: SQLite-backed storage for check requests and results.
 *
 * One store per project, owned by the Lair server:
 * - better-sqlite3 in WAL mode for concurrent reads
 * - Multi-row writes in a transaction
 * - Survives restarts; pruned by age and count (pruneOldChecks)
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

// ============ Constants ============

export const CHECKS_SCHEMA_VERSION = 1;
export const MAX_FAILING_TESTS = 50;
export const LOG_TAIL_LINES = 40;
/** The longest log tail line kept (characters) */
export const LOG_TAIL_LINE_CHARS = 400;
/** A check id: 16 hex characters (also the name of its output directory) */
export const CHECK_ID_PATTERN = /^[0-9a-f]{16}$/;

// ============ Types ============

export type CheckStatus =
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "infrastructure"
  | "timeout"
  | "guard"
  | "refused";

export const CHECK_STATUSES: readonly CheckStatus[] = [
  "queued",
  "running",
  "pass",
  "fail",
  "infrastructure",
  "timeout",
  "guard",
  "refused",
];

export interface CheckRequest {
  id: string;
  project: string;
  kind: string;
  agent: string;
  runId: string;
  sha: string;
  branch?: string;
  tests: string[];
  status: CheckStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number;
  failingTests: string[];
  logTail: string;
  refusalReason?: string;
}

export interface CheckAuditEntry {
  id: number;
  checkId: string;
  project: string;
  kind: string;
  agent: string;
  action: "requested" | "started" | "completed" | "refused";
  detail: string;
  createdAt: number;
}

export interface PruneOptions {
  /** Finished rows created before this are deleted */
  olderThan: number;
  /** Keep at most this many rows ... */
  maxRows: number;
  /** ... but never delete a row created at or after this (the rate-limit windows read them) */
  keepSince: number;
}

// ============ Schema ============

const CHECKS_SCHEMA = `
  -- Schema version
  CREATE TABLE IF NOT EXISTS checks_schema (
    version INTEGER PRIMARY KEY
  );
  INSERT OR IGNORE INTO checks_schema (version) VALUES (${CHECKS_SCHEMA_VERSION});

  -- Check requests
  CREATE TABLE IF NOT EXISTS check_requests (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT NOT NULL,
    run_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    branch TEXT,
    tests TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    exit_code INTEGER,
    failing_tests TEXT,
    log_tail TEXT,
    refusal_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_checks_project_status ON check_requests(project, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_checks_project_kind ON check_requests(project, kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_checks_project_agent ON check_requests(project, agent, created_at);
  CREATE INDEX IF NOT EXISTS idx_checks_sha ON check_requests(project, sha);
  CREATE INDEX IF NOT EXISTS idx_checks_created ON check_requests(project, created_at);

  -- The branch each run tests: fixed by the run's first accepted check
  CREATE TABLE IF NOT EXISTS check_run_branches (
    run_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    branch TEXT NOT NULL,
    bound_at INTEGER NOT NULL
  );

  -- Audit log
  CREATE TABLE IF NOT EXISTS checks_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id TEXT NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checks_audit_project ON checks_audit(project, created_at);
  CREATE INDEX IF NOT EXISTS idx_checks_audit_check ON checks_audit(check_id);
`;

// ============ Row types ============

interface CheckRow {
  id: string;
  project: string;
  kind: string;
  agent: string;
  run_id: string;
  sha: string;
  branch: string | null;
  tests: string;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  failing_tests: string | null;
  log_tail: string | null;
  refusal_reason: string | null;
}

interface AuditRow {
  id: number;
  check_id: string;
  project: string;
  kind: string;
  agent: string;
  action: string;
  detail: string;
  created_at: number;
}

function toCheckRequest(row: CheckRow): CheckRequest {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    agent: row.agent,
    runId: row.run_id,
    sha: row.sha,
    branch: row.branch ?? undefined,
    tests: JSON.parse(row.tests) as string[],
    status: row.status as CheckStatus,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    exitCode: row.exit_code ?? undefined,
    failingTests: row.failing_tests ? (JSON.parse(row.failing_tests) as string[]) : [],
    logTail: row.log_tail ?? "",
    refusalReason: row.refusal_reason ?? undefined,
  };
}

function toAuditEntry(row: AuditRow): CheckAuditEntry {
  return {
    id: row.id,
    checkId: row.check_id,
    project: row.project,
    kind: row.kind,
    agent: row.agent,
    action: row.action as CheckAuditEntry["action"],
    detail: row.detail,
    createdAt: row.created_at,
  };
}

/** The last LOG_TAIL_LINES lines, each at most LOG_TAIL_LINE_CHARS characters. */
export function logTailOf(text: string): string {
  return text
    .split(/\r?\n/)
    .slice(-LOG_TAIL_LINES)
    .map((line) => (line.length > LOG_TAIL_LINE_CHARS ? line.slice(0, LOG_TAIL_LINE_CHARS) : line))
    .join("\n");
}

function newCheckId(): string {
  return randomBytes(8).toString("hex");
}

// ============ Store ============

export class ChecksStore {
  private db: Database.Database;
  readonly project: string;

  constructor(project: string, dbPath: string) {
    this.project = project;

    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    // Every statement is IF NOT EXISTS / OR IGNORE: safe on every open
    this.db.exec(CHECKS_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ============ Check requests ============

  /** Create a new check request. Returns the check id. */
  createCheck(
    kind: string,
    agent: string,
    runId: string,
    sha: string,
    branch: string | undefined,
    tests: string[],
    at: number,
  ): string {
    const id = newCheckId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO check_requests (id, project, kind, agent, run_id, sha, branch, tests, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, this.project, kind, agent, runId, sha, branch ?? null, JSON.stringify(tests), at);
      this.audit(id, kind, agent, "requested", `tests: ${tests.length}`, at);
    })();
    return id;
  }

  /** Create a refused check (for auditing). Returns the check id. */
  createRefusedCheck(
    kind: string,
    agent: string,
    runId: string,
    sha: string,
    branch: string | undefined,
    tests: string[],
    reason: string,
    at: number,
  ): string {
    const id = newCheckId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO check_requests (id, project, kind, agent, run_id, sha, branch, tests, status, created_at, completed_at, refusal_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'refused', ?, ?, ?)`,
        )
        .run(id, this.project, kind, agent, runId, sha, branch ?? null, JSON.stringify(tests), at, at, reason);
      this.audit(id, kind, agent, "refused", reason, at);
    })();
    return id;
  }

  /** Mark a check as running. */
  startCheck(id: string, at: number): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(`UPDATE check_requests SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
        .run(at, id);
      if (result.changes === 0) return false;
      const check = this.getCheck(id);
      if (check) this.audit(id, check.kind, check.agent, "started", "", at);
      return true;
    })();
  }

  /** Complete a running check with its results. False when it is not running (already completed or reconciled). */
  completeCheck(
    id: string,
    status: CheckStatus,
    exitCode: number | undefined,
    failingTests: string[],
    logTail: string,
    at: number,
  ): boolean {
    return this.db.transaction(() => {
      const check = this.getCheck(id);
      if (!check || check.status !== "running") return false;

      const durationMs = check.startedAt ? at - check.startedAt : 0;
      const truncatedTests = failingTests.slice(0, MAX_FAILING_TESTS);
      const truncatedLog = logTailOf(logTail);

      this.db
        .prepare(
          `UPDATE check_requests
           SET status = ?, completed_at = ?, duration_ms = ?, exit_code = ?, failing_tests = ?, log_tail = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, at, durationMs, exitCode ?? null, JSON.stringify(truncatedTests), truncatedLog, id);

      this.audit(
        id,
        check.kind,
        check.agent,
        "completed",
        `status=${status}, exit=${exitCode ?? "none"}, duration=${durationMs}ms`,
        at,
      );
      return true;
    })();
  }

  /** Get a check by id. */
  getCheck(id: string): CheckRequest | null {
    const row = this.db.prepare(`SELECT * FROM check_requests WHERE id = ?`).get(id) as CheckRow | undefined;
    return row ? toCheckRequest(row) : null;
  }

  /** List checks by project, optionally filtered. */
  listChecks(options: {
    kind?: string;
    agent?: string;
    sha?: string;
    status?: CheckStatus;
    limit?: number;
  }): CheckRequest[] {
    const where = ["project = ?"];
    const params: (string | number)[] = [this.project];

    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.agent) {
      where.push("agent = ?");
      params.push(options.agent);
    }
    if (options.sha) {
      where.push("sha = ?");
      params.push(options.sha);
    }
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }

    params.push(options.limit ?? 100);

    const rows = this.db
      .prepare(`SELECT * FROM check_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as CheckRow[];

    return rows.map(toCheckRequest);
  }

  /** Counts by status and by kind, over every stored row. */
  counts(): { total: number; byStatus: Record<CheckStatus, number>; byKind: Record<string, number> } {
    const byStatus = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
    const byKind: Record<string, number> = {};
    let total = 0;
    const rows = this.db
      .prepare(`SELECT kind, status, COUNT(*) as n FROM check_requests WHERE project = ? GROUP BY kind, status`)
      .all(this.project) as { kind: string; status: string; n: number }[];
    for (const row of rows) {
      total += row.n;
      if (row.status in byStatus) byStatus[row.status as CheckStatus] += row.n;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + row.n;
    }
    return { total, byStatus, byKind };
  }

  /** Count running checks for a kind. */
  countRunning(kind: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM check_requests WHERE project = ? AND kind = ? AND status = 'running'`)
      .get(this.project, kind) as { n: number };
    return row.n;
  }

  /** Accepted checks of a kind by an agent since `since` (refusals are limited separately). */
  countAgentHourly(agent: string, kind: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND agent = ? AND kind = ? AND created_at >= ? AND status != 'refused'`,
      )
      .get(this.project, agent, kind, since) as { n: number };
    return row.n;
  }

  /** Accepted checks of a kind since `since` (midnight UTC): refusals never use the daily budget. */
  countDailyChecks(kind: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND kind = ? AND created_at >= ? AND status != 'refused'`,
      )
      .get(this.project, kind, since) as { n: number };
    return row.n;
  }

  /** Get the next queued check for a kind (oldest first). */
  getNextQueued(kind: string): CheckRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM check_requests
         WHERE project = ? AND kind = ? AND status = 'queued'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get(this.project, kind) as CheckRow | undefined;
    return row ? toCheckRequest(row) : null;
  }

  /** Check if a sha has a passing check of a given kind. */
  hasPassingCheck(kind: string, sha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM check_requests
         WHERE project = ? AND kind = ? AND sha = ? AND status = 'pass'
         LIMIT 1`,
      )
      .get(this.project, kind, sha);
    return !!row;
  }

  /** Count refused requests by an agent since `since` (for rate limiting refusals). */
  countAgentRefusals(agent: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND agent = ? AND status = 'refused' AND created_at >= ?`,
      )
      .get(this.project, agent, since) as { n: number };
    return row.n;
  }

  // ============ Run branches ============

  /** The branch a run is bound to, or null before its first accepted check. */
  getRunBranch(runId: string): string | null {
    const row = this.db
      .prepare(`SELECT branch FROM check_run_branches WHERE project = ? AND run_id = ?`)
      .get(this.project, runId) as { branch: string } | undefined;
    return row?.branch ?? null;
  }

  /** Bind a run to a branch unless it is bound already. Returns the run's branch (an existing binding wins). */
  bindRunBranch(runId: string, agent: string, branch: string, at: number): string {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO check_run_branches (run_id, project, agent, branch, bound_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, this.project, agent, branch, at);
      return this.getRunBranch(runId) ?? branch;
    })();
  }

  // ============ Restart and retention ============

  /**
   * Reconcile running checks from a previous instance: mark them as infrastructure failures.
   * Called at startup. Returns the count of checks reconciled.
   */
  reconcileRunningChecks(reason: string, at: number): number {
    return this.db.transaction(() => {
      const running = this.db
        .prepare(`SELECT id, kind, agent, started_at FROM check_requests WHERE project = ? AND status = 'running'`)
        .all(this.project) as Array<{ id: string; kind: string; agent: string; started_at: number | null }>;

      for (const row of running) {
        this.db
          .prepare(
            `UPDATE check_requests
             SET status = 'infrastructure', completed_at = ?, duration_ms = ?, log_tail = ?
             WHERE id = ?`,
          )
          .run(at, row.started_at ? at - row.started_at : 0, reason, row.id);
        this.audit(row.id, row.kind, row.agent, "completed", `status=infrastructure (reconciled: ${reason})`, at);
      }
      return running.length;
    })();
  }

  /**
   * Prune finished checks: those created before `olderThan`, and the oldest
   * beyond the newest `maxRows` (never one created at or after `keepSince`).
   * Queued and running checks are never pruned. Their audit entries go with
   * them, and run branch bindings older than `olderThan`. Returns the ids
   * deleted (their output directories are the caller's to remove).
   */
  pruneOldChecks(options: PruneOptions): string[] {
    return this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT id FROM check_requests
           WHERE project = ? AND status NOT IN ('queued', 'running') AND created_at < ?`,
        )
        .all(this.project, options.olderThan) as { id: string }[];
      const overflow = this.db
        .prepare(
          `SELECT id FROM (
             SELECT id, status, created_at FROM check_requests WHERE project = ?
             ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
           ) WHERE status NOT IN ('queued', 'running') AND created_at < ?`,
        )
        .all(this.project, Math.max(0, options.maxRows), options.keepSince) as { id: string }[];

      const ids = [...new Set([...expired, ...overflow].map((row) => row.id))];
      const deleteCheck = this.db.prepare(`DELETE FROM check_requests WHERE id = ?`);
      const deleteAudit = this.db.prepare(`DELETE FROM checks_audit WHERE check_id = ?`);
      for (const id of ids) {
        deleteCheck.run(id);
        deleteAudit.run(id);
      }
      this.db
        .prepare(`DELETE FROM check_run_branches WHERE project = ? AND bound_at < ?`)
        .run(this.project, options.olderThan);
      return ids;
    })();
  }

  // ============ Audit ============

  private audit(checkId: string, kind: string, agent: string, action: string, detail: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO checks_audit (check_id, project, kind, agent, action, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkId, this.project, kind, agent, action, detail, at);
  }

  /** List audit entries. */
  listAudit(limit: number): CheckAuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM checks_audit WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(this.project, limit) as AuditRow[];
    return rows.map(toAuditEntry);
  }
}
