/**
 * Checks store: SQLite-backed storage for check requests and results.
 *
 * One store per project, owned by the Lair server:
 * - better-sqlite3 in WAL mode for concurrent reads
 * - Every write in a transaction
 * - Survives restarts
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

// ============ Constants ============

export const CHECKS_SCHEMA_VERSION = 1;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_FAILING_TESTS = 50;
export const LOG_TAIL_LINES = 40;

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

// ============ Store ============

export class ChecksStore {
  private db: Database.Database;
  readonly project: string;

  constructor(project: string, dbPath: string) {
    this.project = project;

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.migrate();
  }

  private migrate(): void {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checks_schema'")
      .get();
    if (!row) {
      this.db.exec(CHECKS_SCHEMA);
    }
    // Future migrations would go here
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
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO check_requests (id, project, kind, agent, run_id, sha, branch, tests, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, this.project, kind, agent, runId, sha, branch ?? null, JSON.stringify(tests), at);

    this.audit(id, kind, agent, "requested", `tests: ${tests.length}`, at);
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
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO check_requests (id, project, kind, agent, run_id, sha, branch, tests, status, created_at, refusal_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'refused', ?, ?)`,
      )
      .run(id, this.project, kind, agent, runId, sha, branch ?? null, JSON.stringify(tests), at, reason);

    this.audit(id, kind, agent, "refused", reason, at);
    return id;
  }

  /** Mark a check as running. */
  startCheck(id: string, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE check_requests SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(at, id);
    if (result.changes > 0) {
      const check = this.getCheck(id);
      if (check) {
        this.audit(id, check.kind, check.agent, "started", "", at);
      }
    }
    return result.changes > 0;
  }

  /** Complete a check with results. */
  completeCheck(
    id: string,
    status: CheckStatus,
    exitCode: number | undefined,
    failingTests: string[],
    logTail: string,
    at: number,
  ): boolean {
    const check = this.getCheck(id);
    if (!check || check.status !== "running") {
      return false;
    }

    const durationMs = check.startedAt ? at - check.startedAt : 0;
    const truncatedTests = failingTests.slice(0, MAX_FAILING_TESTS);
    const truncatedLog = logTail.slice(-LOG_TAIL_LINES * 200); // ~200 chars per line

    this.db
      .prepare(
        `UPDATE check_requests
         SET status = ?, completed_at = ?, duration_ms = ?, exit_code = ?, failing_tests = ?, log_tail = ?
         WHERE id = ?`,
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
      .prepare(`SELECT * FROM check_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as CheckRow[];

    return rows.map(toCheckRequest);
  }

  /** Count queued checks for a kind. */
  countQueued(kind: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM check_requests WHERE project = ? AND kind = ? AND status = 'queued'`)
      .get(this.project, kind) as { n: number };
    return row.n;
  }

  /** Count running checks for a kind. */
  countRunning(kind: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM check_requests WHERE project = ? AND kind = ? AND status = 'running'`)
      .get(this.project, kind) as { n: number };
    return row.n;
  }

  /** Count checks by an agent in the last hour. */
  countAgentHourly(agent: string, kind: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND agent = ? AND kind = ? AND created_at >= ?`,
      )
      .get(this.project, agent, kind, since) as { n: number };
    return row.n;
  }

  /** Count all checks for a kind today (since midnight UTC). */
  countDailyChecks(kind: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND kind = ? AND created_at >= ?`,
      )
      .get(this.project, kind, since) as { n: number };
    return row.n;
  }

  /** Get the next queued check for a kind. */
  getNextQueued(kind: string): CheckRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM check_requests
         WHERE project = ? AND kind = ? AND status = 'queued'
         ORDER BY created_at ASC
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

  /** Count refused requests by an agent in the last hour (for rate limiting refusals). */
  countAgentRefusals(agent: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM check_requests
         WHERE project = ? AND agent = ? AND status = 'refused' AND created_at >= ?`,
      )
      .get(this.project, agent, since) as { n: number };
    return row.n;
  }

  /**
   * Reconcile running checks from a previous instance: mark them as infrastructure failures.
   * Called at startup. Returns the count of checks reconciled.
   */
  reconcileRunningChecks(reason: string, at: number): number {
    const running = this.db
      .prepare(`SELECT id, kind, agent FROM check_requests WHERE project = ? AND status = 'running'`)
      .all(this.project) as Array<{ id: string; kind: string; agent: string }>;

    for (const row of running) {
      this.db
        .prepare(
          `UPDATE check_requests
           SET status = 'infrastructure', completed_at = ?, log_tail = ?
           WHERE id = ?`,
        )
        .run(at, reason, row.id);
      this.audit(row.id, row.kind, row.agent, "completed", `status=infrastructure (reconciled: ${reason})`, at);
    }

    // Also process any queued checks that are now stale
    return running.length;
  }

  /**
   * Prune old checks to keep the database bounded.
   * Keeps the most recent `keep` checks and deletes older ones.
   */
  pruneOldChecks(keep: number, at: number): number {
    // Get the cutoff id
    const cutoff = this.db
      .prepare(
        `SELECT id FROM check_requests WHERE project = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
      )
      .get(this.project, keep) as { id: string } | undefined;

    if (!cutoff) return 0;

    // Delete checks older than the cutoff
    const checkResult = this.db
      .prepare(`DELETE FROM check_requests WHERE project = ? AND created_at < (SELECT created_at FROM check_requests WHERE id = ?)`)
      .run(this.project, cutoff.id);

    // Delete audit entries for deleted checks
    this.db
      .prepare(`DELETE FROM checks_audit WHERE project = ? AND check_id NOT IN (SELECT id FROM check_requests WHERE project = ?)`)
      .run(this.project, this.project);

    return checkResult.changes;
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
      .prepare(`SELECT * FROM checks_audit WHERE project = ? ORDER BY created_at DESC LIMIT ?`)
      .all(this.project, limit) as AuditRow[];
    return rows.map(toAuditEntry);
  }
}

// ============ Store management ============

const stores = new Map<string, ChecksStore>();

export function getChecksStore(project: string, dataDir: string): ChecksStore {
  const key = `${dataDir}:${project}`;
  let store = stores.get(key);
  if (!store) {
    const dbPath = join(dataDir, "checks", `${project}.db`);
    store = new ChecksStore(project, dbPath);
    stores.set(key, store);
  }
  return store;
}

export function closeChecksStores(): void {
  for (const store of stores.values()) {
    store.close();
  }
  stores.clear();
}
