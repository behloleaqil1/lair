/**
 * Triage store (SQLite, data/triage.db): every ingested result with its
 * causes and verdicts, per-test observations (pass or fail at a commit, in a
 * step), actions, re-checks, tasks, flaky tests, incidents with their bisect
 * state, protected merges and raised decisions.
 *
 * Times come from the triage Clock, never SQLite's datetime(), so tests with
 * a fake clock get exact values. Lists bound into SQL are chunked below
 * SQLite's variable limit.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  ActionKind,
  ActionStatus,
  BisectState,
  ClassifiedCause,
  FailureCause,
  FlakyTest,
  Incident,
  IncidentTarget,
  ProtectedMerge,
  Recheck,
  RecheckPurpose,
  RecheckStatus,
  ResultPurpose,
  ResultTrust,
  TriageAction,
  TriageClass,
  TriageRecord,
  TriageTask,
  Verdict,
} from "../../shared/triage-types.js";
import { TRIAGE_CLASSES } from "../../shared/triage-types.js";

const SCHEMA_VERSION = 1;
/** Rows of an IN (...) list per statement, well below SQLite's variable limit */
const CHUNK = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS triage_records (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    trust TEXT NOT NULL,
    sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_sha TEXT,
    agent TEXT,
    pr INTEGER,
    purpose TEXT NOT NULL,
    recheck_id TEXT,
    origin_id TEXT,
    status TEXT NOT NULL,
    default_branch INTEGER NOT NULL,
    verdict TEXT,
    blocking INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    failed_steps TEXT NOT NULL,
    passed_steps TEXT NOT NULL,
    changed_files TEXT NOT NULL,
    received_at TEXT NOT NULL,
    received_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tr_records_project ON triage_records(project, received_ms);
  CREATE INDEX IF NOT EXISTS idx_tr_records_sha ON triage_records(project, sha);
  CREATE INDEX IF NOT EXISTS idx_tr_records_branch ON triage_records(project, branch, pipeline_id, received_ms);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_records_gate ON triage_records(project, gate_id);

  CREATE TABLE IF NOT EXISTS triage_causes (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES triage_records(id),
    position INTEGER NOT NULL,
    signature TEXT NOT NULL,
    class TEXT NOT NULL,
    cause TEXT NOT NULL,
    verdict TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tr_causes_record ON triage_causes(record_id, position);

  CREATE TABLE IF NOT EXISTS triage_tests (
    project TEXT NOT NULL,
    sha TEXT NOT NULL,
    test_key TEXT NOT NULL,
    record_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    class TEXT,
    step TEXT,
    at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tr_tests_sha ON triage_tests(project, sha, test_key);
  CREATE INDEX IF NOT EXISTS idx_tr_tests_key ON triage_tests(project, test_key, at_ms);

  CREATE TABLE IF NOT EXISTS triage_actions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    record_id TEXT,
    incident_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    argv TEXT,
    output TEXT,
    actor TEXT,
    at TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tr_actions_record ON triage_actions(record_id);
  CREATE INDEX IF NOT EXISTS idx_tr_actions_incident ON triage_actions(incident_id);
  CREATE INDEX IF NOT EXISTS idx_tr_actions_project ON triage_actions(project, at_ms);

  CREATE TABLE IF NOT EXISTS triage_rechecks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    purpose TEXT NOT NULL,
    record_id TEXT,
    incident_id TEXT,
    sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    steps TEXT NOT NULL,
    tests TEXT NOT NULL,
    classes TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    requested_at TEXT,
    requested_ms INTEGER,
    completed_at TEXT,
    answer_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tr_rechecks_status ON triage_rechecks(project, status, created_ms);
  CREATE INDEX IF NOT EXISTS idx_tr_rechecks_record ON triage_rechecks(record_id);
  CREATE INDEX IF NOT EXISTS idx_tr_rechecks_incident ON triage_rechecks(incident_id);

  CREATE TABLE IF NOT EXISTS triage_tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    ref TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_tasks_open ON triage_tasks(project, kind, key) WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS triage_flaky (
    project TEXT NOT NULL,
    test_key TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    last_at TEXT NOT NULL,
    quarantined_at TEXT,
    quarantine_until TEXT,
    passes INTEGER NOT NULL DEFAULT 0,
    ticket_id TEXT,
    PRIMARY KEY (project, test_key)
  );

  CREATE TABLE IF NOT EXISTS triage_incidents (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    branch TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    red_sha TEXT NOT NULL,
    last_green_sha TEXT,
    record_id TEXT NOT NULL,
    target TEXT NOT NULL,
    bisect TEXT NOT NULL,
    revert TEXT NOT NULL,
    decision_ref TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_incidents_open
    ON triage_incidents(project, branch, pipeline_id) WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS triage_protected (
    project TEXT NOT NULL,
    sha TEXT NOT NULL,
    note TEXT NOT NULL,
    by_who TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project, sha)
  );

  CREATE TABLE IF NOT EXISTS triage_decisions (
    project TEXT NOT NULL,
    subject TEXT NOT NULL,
    ref TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project, subject)
  );

  -- Calls a decision queued (agent messages, tasks, reverts, decisions, a
  -- culprit's commit), written in the decision's transaction and removed in
  -- the transaction that records the call's result, so a restart runs what a
  -- killed process left
  CREATE TABLE IF NOT EXISTS triage_outbox (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tr_outbox ON triage_outbox(project, created_ms);
`;

interface RecordRow {
  id: string;
  project: string;
  gate_id: string;
  pipeline_id: string;
  trust: string;
  sha: string;
  branch: string;
  base_sha: string | null;
  agent: string | null;
  pr: number | null;
  purpose: string;
  recheck_id: string | null;
  origin_id: string | null;
  status: string;
  default_branch: number;
  verdict: string | null;
  blocking: number;
  resolution: string | null;
  failed_steps: string;
  passed_steps: string;
  changed_files: string;
  received_at: string;
  received_ms: number;
}

interface CauseRow {
  id: string;
  record_id: string;
  position: number;
  signature: string;
  class: string;
  cause: string;
  verdict: string;
}

interface ActionRow {
  id: string;
  project: string;
  record_id: string | null;
  incident_id: string | null;
  kind: string;
  status: string;
  detail: string;
  argv: string | null;
  output: string | null;
  actor: string | null;
  at: string;
}

interface RecheckRow {
  id: string;
  project: string;
  purpose: string;
  record_id: string | null;
  incident_id: string | null;
  sha: string;
  branch: string;
  gate_id: string;
  steps: string;
  tests: string;
  classes: string;
  attempt: number;
  status: string;
  reason: string | null;
  run_id: string | null;
  created_at: string;
  requested_at: string | null;
  completed_at: string | null;
  answer_id: string | null;
}

interface TaskRow {
  id: string;
  project: string;
  kind: string;
  key: string;
  title: string;
  body: string;
  status: string;
  ref: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface FlakyRow {
  project: string;
  test_key: string;
  occurrences: number;
  last_at: string;
  quarantined_at: string | null;
  quarantine_until: string | null;
  passes: number;
  ticket_id: string | null;
}

interface IncidentRow {
  id: string;
  project: string;
  branch: string;
  pipeline_id: string;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  resolution: string | null;
  red_sha: string;
  last_green_sha: string | null;
  record_id: string;
  target: string;
  bisect: string;
  revert: string;
  decision_ref: string | null;
}

export interface NewRecord {
  project: string;
  gateId: string;
  pipelineId: string;
  trust: ResultTrust;
  sha: string;
  branch: string;
  baseSha?: string;
  agent?: string;
  pr?: number;
  purpose: ResultPurpose;
  recheckId?: string;
  originId?: string;
  status: TriageRecord["status"];
  defaultBranch: boolean;
  failedSteps: string[];
  passedSteps: string[];
  changedFiles: string[];
  receivedAt: string;
  receivedMs: number;
}

export interface TestRow {
  key: string;
  outcome: "pass" | "fail";
  cls?: TriageClass;
  step?: string;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class TriageStore {
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
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ============ RECORDS ============

  insertRecord(record: NewRecord): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO triage_records
           (id, project, gate_id, pipeline_id, trust, sha, branch, base_sha, agent, pr, purpose, recheck_id, origin_id,
            status, default_branch, failed_steps, passed_steps, changed_files, received_at, received_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.project,
        record.gateId,
        record.pipelineId,
        record.trust,
        record.sha,
        record.branch,
        record.baseSha ?? null,
        record.agent ?? null,
        record.pr ?? null,
        record.purpose,
        record.recheckId ?? null,
        record.originId ?? null,
        record.status,
        record.defaultBranch ? 1 : 0,
        JSON.stringify(record.failedSteps),
        JSON.stringify(record.passedSteps),
        JSON.stringify(record.changedFiles),
        record.receivedAt,
        record.receivedMs,
      );
    return id;
  }

  /** True when a result with this gate id was already ingested. */
  hasGateResult(project: string, gateId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM triage_records WHERE project = ? AND gate_id = ?`).get(project, gateId) !== undefined
    );
  }

  updateRecord(
    id: string,
    patch: { verdict?: TriageClass | null; blocking?: boolean; resolution?: string | null },
  ): void {
    const row = this.db.prepare(`SELECT verdict, blocking, resolution FROM triage_records WHERE id = ?`).get(id) as
      | Pick<RecordRow, "verdict" | "blocking" | "resolution">
      | undefined;
    if (!row) return;
    this.db
      .prepare(`UPDATE triage_records SET verdict = ?, blocking = ?, resolution = ? WHERE id = ?`)
      .run(
        patch.verdict !== undefined ? patch.verdict : row.verdict,
        patch.blocking !== undefined ? (patch.blocking ? 1 : 0) : row.blocking,
        patch.resolution !== undefined ? patch.resolution : row.resolution,
        id,
      );
  }

  insertCauses(recordId: string, causes: ClassifiedCause[]): void {
    const insert = this.db.prepare(
      `INSERT INTO triage_causes (id, record_id, position, signature, class, cause, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      causes.forEach((c, position) => {
        insert.run(c.id, recordId, position, c.cause.signature, c.verdict.class, JSON.stringify(c.cause), JSON.stringify(c.verdict));
      });
    });
  }

  updateCauseVerdict(causeId: string, verdict: Verdict): void {
    this.db
      .prepare(`UPDATE triage_causes SET class = ?, verdict = ? WHERE id = ?`)
      .run(verdict.class, JSON.stringify(verdict), causeId);
  }

  private causesOf(recordId: string): ClassifiedCause[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_causes WHERE record_id = ? ORDER BY position`)
      .all(recordId) as CauseRow[];
    return rows.map((row) => ({
      id: row.id,
      cause: JSON.parse(row.cause) as FailureCause,
      verdict: JSON.parse(row.verdict) as Verdict,
    }));
  }

  private toRecord(row: RecordRow): TriageRecord {
    const origin = row.origin_id ?? row.id;
    const retries = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM triage_rechecks WHERE record_id = ? AND purpose = 'infra'`).get(origin) as {
        n: number;
      }
    ).n;
    return {
      id: row.id,
      project: row.project,
      gateId: row.gate_id,
      pipelineId: row.pipeline_id,
      trust: row.trust as ResultTrust,
      sha: row.sha,
      branch: row.branch,
      baseSha: row.base_sha ?? undefined,
      agent: row.agent ?? undefined,
      pr: row.pr ?? undefined,
      purpose: row.purpose as ResultPurpose,
      recheckId: row.recheck_id ?? undefined,
      originId: row.origin_id ?? undefined,
      status: row.status as TriageRecord["status"],
      defaultBranch: row.default_branch === 1,
      verdict: (row.verdict as TriageClass | null) ?? undefined,
      blocking: row.blocking === 1,
      resolution: row.resolution ?? undefined,
      retries,
      failedSteps: JSON.parse(row.failed_steps) as string[],
      changedFiles: JSON.parse(row.changed_files) as string[],
      receivedAt: row.received_at,
      causes: this.causesOf(row.id),
    };
  }

  getRecord(id: string): TriageRecord | null {
    const row = this.db.prepare(`SELECT * FROM triage_records WHERE id = ?`).get(id) as RecordRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  receivedMs(id: string): number | null {
    const row = this.db.prepare(`SELECT received_ms FROM triage_records WHERE id = ?`).get(id) as
      | { received_ms: number }
      | undefined;
    return row?.received_ms ?? null;
  }

  /** Newest first. `failedOnly` leaves out passed results. */
  listRecords(
    project: string,
    options: { limit?: number; failedOnly?: boolean; verdict?: TriageClass; blocking?: boolean; sha?: string } = {},
  ): TriageRecord[] {
    const where = ["project = ?"];
    const args: unknown[] = [project];
    if (options.failedOnly) where.push("status != 'passed'");
    if (options.verdict) {
      where.push("verdict = ?");
      args.push(options.verdict);
    }
    if (options.blocking !== undefined) {
      where.push("blocking = ?");
      args.push(options.blocking ? 1 : 0);
    }
    if (options.sha) {
      where.push("sha = ?");
      args.push(options.sha.toLowerCase());
    }
    args.push(options.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM triage_records WHERE ${where.join(" AND ")} ORDER BY received_ms DESC, rowid DESC LIMIT ?`)
      .all(...args) as RecordRow[];
    return rows.map((row) => this.toRecord(row));
  }

  /** The newest gate run (not a re-check or probe) of a pipeline at exactly this commit, received since `sinceMs`. */
  baseResult(project: string, sha: string, pipelineId: string, sinceMs: number, excludeId: string): TriageRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM triage_records WHERE project = ? AND sha = ? AND pipeline_id = ? AND purpose = 'gate'
           AND received_ms >= ? AND id != ?
         ORDER BY received_ms DESC, rowid DESC LIMIT 1`,
      )
      .get(project, sha.toLowerCase(), pipelineId, sinceMs, excludeId) as RecordRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  /**
   * The newest passed gate run of a pipeline on a branch, received at or
   * before `beforeMs`, that ran (and passed) every one of `steps`.
   */
  lastGreen(project: string, branch: string, pipelineId: string, steps: string[], beforeMs: number): TriageRecord | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM triage_records WHERE project = ? AND branch = ? AND default_branch = 1 AND pipeline_id = ? AND purpose = 'gate'
           AND status = 'passed' AND received_ms <= ?
         ORDER BY received_ms DESC, rowid DESC LIMIT 200`,
      )
      .all(project, branch, pipelineId, beforeMs) as RecordRow[];
    const row = rows.find((r) => {
      const passed = new Set(JSON.parse(r.passed_steps) as string[]);
      return steps.every((s) => passed.has(s));
    });
    return row ? this.toRecord(row) : null;
  }

  /** The steps a record ran and passed. */
  passedSteps(id: string): string[] {
    const row = this.db.prepare(`SELECT passed_steps FROM triage_records WHERE id = ?`).get(id) as
      | { passed_steps: string }
      | undefined;
    return row ? (JSON.parse(row.passed_steps) as string[]) : [];
  }

  /** Gate results at any of these commits, newest first. */
  recordsAt(project: string, shas: string[]): TriageRecord[] {
    const out: TriageRecord[] = [];
    for (const part of chunks(shas.map((s) => s.toLowerCase()))) {
      const rows = this.db
        .prepare(
          `SELECT * FROM triage_records WHERE project = ? AND sha IN (${placeholders(part.length)}) AND purpose = 'gate'
           ORDER BY received_ms DESC, rowid DESC`,
        )
        .all(project, ...part) as RecordRow[];
      out.push(...rows.map((row) => this.toRecord(row)));
    }
    return out;
  }

  counts(project: string): { failures: number; blocking: number; byClass: Record<TriageClass, number> } {
    const rows = this.db
      .prepare(
        `SELECT verdict, blocking, COUNT(*) AS n FROM triage_records
         WHERE project = ? AND status != 'passed' AND purpose != 'bisect' GROUP BY verdict, blocking`,
      )
      .all(project) as { verdict: string | null; blocking: number; n: number }[];
    const byClass = Object.fromEntries(TRIAGE_CLASSES.map((c) => [c, 0])) as Record<TriageClass, number>;
    let failures = 0;
    let blocking = 0;
    for (const row of rows) {
      failures += row.n;
      if (row.blocking === 1) blocking += row.n;
      if (row.verdict && row.verdict in byClass) byClass[row.verdict as TriageClass] += row.n;
    }
    return { failures, blocking, byClass };
  }

  // ============ TEST OBSERVATIONS ============

  addTests(project: string, sha: string, recordId: string, rows: TestRow[], atMs: number): void {
    const insert = this.db.prepare(
      `INSERT INTO triage_tests (project, sha, test_key, record_id, outcome, class, step, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const row of rows) {
        insert.run(project, sha, row.key, recordId, row.outcome, row.cls ?? null, row.step ?? null, atMs);
      }
    });
  }

  /** Passes of these tests at a commit within [sinceMs, untilMs], from other results. */
  passesAt(
    project: string,
    sha: string,
    keys: string[],
    sinceMs: number,
    untilMs: number,
    excludeRecord: string,
  ): Map<string, { recordId: string; at: string }> {
    const found = new Map<string, { recordId: string; at: string }>();
    if (keys.length === 0) return found;
    const select = this.db.prepare(
      `SELECT test_key, record_id, at_ms FROM triage_tests
       WHERE project = ? AND sha = ? AND test_key = ? AND outcome = 'pass' AND at_ms >= ? AND at_ms <= ? AND record_id != ?
       ORDER BY at_ms DESC LIMIT 1`,
    );
    for (const key of new Set(keys)) {
      const row = select.get(project, sha, key, sinceMs, untilMs, excludeRecord) as
        | { test_key: string; record_id: string; at_ms: number }
        | undefined;
      if (row) found.set(key, { recordId: row.record_id, at: new Date(row.at_ms).toISOString() });
    }
    return found;
  }

  /** Failures of these tests at a commit since `sinceMs`, from other results. */
  failsAt(
    project: string,
    sha: string,
    keys: string[],
    sinceMs: number,
    excludeRecord: string,
  ): { recordId: string; key: string; cls: TriageClass | null }[] {
    const out: { recordId: string; key: string; cls: TriageClass | null }[] = [];
    for (const part of chunks([...new Set(keys)])) {
      const rows = this.db
        .prepare(
          `SELECT record_id, test_key, class FROM triage_tests
           WHERE project = ? AND sha = ? AND outcome = 'fail' AND at_ms >= ? AND record_id != ?
             AND test_key IN (${placeholders(part.length)})`,
        )
        .all(project, sha, sinceMs, excludeRecord, ...part) as { record_id: string; test_key: string; class: string | null }[];
      out.push(...rows.map((r) => ({ recordId: r.record_id, key: r.test_key, cls: (r.class as TriageClass | null) ?? null })));
    }
    return out;
  }

  /** Tests that failed at a commit, in one of these steps, since `sinceMs`. */
  failedKeysInSteps(project: string, sha: string, steps: string[], sinceMs: number): string[] {
    const keys = new Set<string>();
    for (const part of chunks([...new Set(steps)])) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT test_key FROM triage_tests
           WHERE project = ? AND sha = ? AND outcome = 'fail' AND at_ms >= ? AND step IN (${placeholders(part.length)})`,
        )
        .all(project, sha, sinceMs, ...part) as { test_key: string }[];
      for (const r of rows) keys.add(r.test_key);
    }
    return [...keys];
  }

  setTestClass(recordId: string, keys: string[], cls: TriageClass): void {
    const update = this.db.prepare(`UPDATE triage_tests SET class = ? WHERE record_id = ? AND test_key = ? AND outcome = 'fail'`);
    this.transaction(() => {
      for (const key of keys) update.run(cls, recordId, key);
    });
  }

  /** The verdict classes of a test's latest failures, newest first. */
  recentFailureClasses(project: string, key: string, limit: number): (TriageClass | null)[] {
    const rows = this.db
      .prepare(
        `SELECT class FROM triage_tests WHERE project = ? AND test_key = ? AND outcome = 'fail'
         ORDER BY at_ms DESC, rowid DESC LIMIT ?`,
      )
      .all(project, key, limit) as { class: string | null }[];
    return rows.map((r) => (r.class as TriageClass | null) ?? null);
  }

  // ============ ACTIONS ============

  addAction(action: Omit<TriageAction, "id">, atMs: number): TriageAction {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO triage_actions (id, project, record_id, incident_id, kind, status, detail, argv, output, actor, at, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        action.project,
        action.recordId ?? null,
        action.incidentId ?? null,
        action.kind,
        action.status,
        action.detail,
        action.argv ? JSON.stringify(action.argv) : null,
        action.output ?? null,
        action.actor ?? null,
        action.at,
        atMs,
      );
    return { id, ...action };
  }

  actionsFor(options: { recordId?: string; incidentId?: string }): TriageAction[] {
    const rows = (
      options.recordId
        ? this.db.prepare(`SELECT * FROM triage_actions WHERE record_id = ? ORDER BY at_ms, rowid`).all(options.recordId)
        : this.db.prepare(`SELECT * FROM triage_actions WHERE incident_id = ? ORDER BY at_ms, rowid`).all(options.incidentId ?? "")
    ) as ActionRow[];
    return rows.map(toAction);
  }

  listActions(project: string, limit = 100): TriageAction[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_actions WHERE project = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as ActionRow[];
    return rows.map(toAction);
  }

  // ============ RE-CHECKS ============

  createRecheck(recheck: Omit<Recheck, "id">, createdMs: number): Recheck {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO triage_rechecks
           (id, project, purpose, record_id, incident_id, sha, branch, gate_id, steps, tests, classes, attempt, status,
            reason, created_at, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        recheck.project,
        recheck.purpose,
        recheck.recordId ?? null,
        recheck.incidentId ?? null,
        recheck.sha,
        recheck.branch,
        recheck.gateId,
        JSON.stringify(recheck.steps),
        JSON.stringify(recheck.tests),
        JSON.stringify(recheck.classes),
        recheck.attempt,
        recheck.status,
        recheck.reason ?? null,
        recheck.createdAt,
        createdMs,
      );
    return this.getRecheck(id)!;
  }

  updateRecheck(
    id: string,
    patch: {
      status?: RecheckStatus;
      reason?: string;
      runId?: string;
      requestedAt?: string;
      requestedMs?: number;
      completedAt?: string;
      answerId?: string;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.reason !== undefined) add("reason", patch.reason);
    if (patch.runId !== undefined) add("run_id", patch.runId);
    if (patch.requestedAt !== undefined) add("requested_at", patch.requestedAt);
    if (patch.requestedMs !== undefined) add("requested_ms", patch.requestedMs);
    if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);
    if (patch.answerId !== undefined) add("answer_id", patch.answerId);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE triage_rechecks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  getRecheck(id: string): Recheck | null {
    const row = this.db.prepare(`SELECT * FROM triage_rechecks WHERE id = ?`).get(id) as RecheckRow | undefined;
    return row ? toRecheck(row) : null;
  }

  /** The re-check still waiting for an answer whose id or run id is one of `ids`, at this commit and branch. */
  answerableRecheck(project: string, ids: string[], sha: string, branch: string, statuses: readonly string[]): Recheck | null {
    if (ids.length === 0 || statuses.length === 0) return null;
    const idMarks = ids.map(() => "?").join(", ");
    const statusMarks = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT * FROM triage_rechecks WHERE project = ? AND lower(sha) = ? AND branch = ? AND status IN (${statusMarks})
           AND (id IN (${idMarks}) OR run_id IN (${idMarks})) ORDER BY created_ms DESC LIMIT 1`,
      )
      .get(project, sha.toLowerCase(), branch, ...statuses, ...ids, ...ids) as RecheckRow | undefined;
    return row ? toRecheck(row) : null;
  }

  requestedMs(id: string): number | null {
    const row = this.db.prepare(`SELECT requested_ms FROM triage_rechecks WHERE id = ?`).get(id) as
      | { requested_ms: number | null }
      | undefined;
    return row?.requested_ms ?? null;
  }

  /** Oldest first. */
  rechecksWithStatus(project: string, statuses: RecheckStatus[]): Recheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM triage_rechecks WHERE project = ? AND status IN (${placeholders(statuses.length)})
         ORDER BY created_ms, rowid`,
      )
      .all(project, ...statuses) as RecheckRow[];
    return rows.map(toRecheck);
  }

  /** A failure's or an incident's re-checks, oldest first. */
  rechecksFor(options: { recordId?: string; incidentId?: string; purpose?: RecheckPurpose }): Recheck[] {
    const column = options.recordId ? "record_id" : "incident_id";
    const value = options.recordId ?? options.incidentId ?? "";
    const rows = (
      options.purpose
        ? this.db
            .prepare(`SELECT * FROM triage_rechecks WHERE ${column} = ? AND purpose = ? ORDER BY created_ms, rowid`)
            .all(value, options.purpose)
        : this.db.prepare(`SELECT * FROM triage_rechecks WHERE ${column} = ? ORDER BY created_ms, rowid`).all(value)
    ) as RecheckRow[];
    return rows.map(toRecheck);
  }

  listRechecks(project: string, limit = 100): Recheck[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_rechecks WHERE project = ? ORDER BY created_ms DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as RecheckRow[];
    return rows.map(toRecheck);
  }

  // ============ TASKS ============

  /** Open a task unless one with the same kind and key is open; `created` says which. */
  openTask(task: Omit<TriageTask, "id" | "status" | "resolvedAt" | "ref">): { task: TriageTask; created: boolean } {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO triage_tasks (id, project, kind, key, title, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, task.project, task.kind, task.key, task.title, task.body, task.createdAt);
    const row = this.db
      .prepare(`SELECT * FROM triage_tasks WHERE project = ? AND kind = ? AND key = ? AND status = 'open'`)
      .get(task.project, task.kind, task.key) as TaskRow;
    return { task: toTask(row), created: result.changes > 0 };
  }

  setTaskRef(id: string, ref: string): void {
    this.db.prepare(`UPDATE triage_tasks SET ref = ? WHERE id = ?`).run(ref, id);
  }

  listTasks(project: string, status?: "open" | "resolved"): TriageTask[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM triage_tasks WHERE project = ? AND status = ? ORDER BY created_at DESC, rowid DESC`).all(project, status)
        : this.db.prepare(`SELECT * FROM triage_tasks WHERE project = ? ORDER BY created_at DESC, rowid DESC`).all(project)
    ) as TaskRow[];
    return rows.map(toTask);
  }

  // ============ FLAKY TESTS ============

  /** A flaky occurrence: counted, and a quarantined test's run of passes starts over. */
  bumpFlaky(project: string, key: string, at: string): FlakyTest {
    this.db
      .prepare(
        `INSERT INTO triage_flaky (project, test_key, occurrences, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(project, test_key) DO UPDATE SET occurrences = occurrences + 1, last_at = excluded.last_at, passes = 0`,
      )
      .run(project, key, at);
    return this.getFlaky(project, key)!;
  }

  getFlaky(project: string, key: string): FlakyTest | null {
    const row = this.db.prepare(`SELECT * FROM triage_flaky WHERE project = ? AND test_key = ?`).get(project, key) as
      | FlakyRow
      | undefined;
    return row ? toFlaky(row) : null;
  }

  setTicket(project: string, key: string, ticketId: string): void {
    this.db.prepare(`UPDATE triage_flaky SET ticket_id = ? WHERE project = ? AND test_key = ?`).run(ticketId, project, key);
  }

  quarantine(project: string, key: string, at: string, until: string): void {
    this.db
      .prepare(
        `UPDATE triage_flaky SET quarantined_at = ?, quarantine_until = ?, passes = 0
         WHERE project = ? AND test_key = ? AND quarantined_at IS NULL`,
      )
      .run(at, until, project, key);
  }

  /** End a quarantine; false when the test was not quarantined. */
  liftQuarantine(project: string, key: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE triage_flaky SET quarantined_at = NULL, quarantine_until = NULL, passes = 0
           WHERE project = ? AND test_key = ? AND quarantined_at IS NOT NULL`,
        )
        .run(project, key).changes > 0
    );
  }

  /** A quarantined test passed: its run of passes, or null when it is not quarantined. */
  quarantinedPass(project: string, key: string): number | null {
    const result = this.db
      .prepare(
        `UPDATE triage_flaky SET passes = passes + 1 WHERE project = ? AND test_key = ? AND quarantined_at IS NOT NULL`,
      )
      .run(project, key);
    if (result.changes === 0) return null;
    return this.getFlaky(project, key)?.passes ?? null;
  }

  /** A quarantined test failed: its run of passes starts over. */
  quarantinedFail(project: string, key: string): void {
    this.db
      .prepare(`UPDATE triage_flaky SET passes = 0 WHERE project = ? AND test_key = ? AND quarantined_at IS NOT NULL`)
      .run(project, key);
  }

  /** Quarantined tests whose quarantine ended before `at`. */
  expiredQuarantines(project: string, at: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT test_key FROM triage_flaky WHERE project = ? AND quarantined_at IS NOT NULL
           AND quarantine_until IS NOT NULL AND quarantine_until <= ?`,
      )
      .all(project, at) as { test_key: string }[];
    return rows.map((r) => r.test_key);
  }

  listFlaky(project: string): FlakyTest[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_flaky WHERE project = ? ORDER BY last_at DESC, rowid DESC`)
      .all(project) as FlakyRow[];
    return rows.map(toFlaky);
  }

  quarantinedKeys(project: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT test_key FROM triage_flaky WHERE project = ? AND quarantined_at IS NOT NULL`)
      .all(project) as { test_key: string }[];
    return new Set(rows.map((r) => r.test_key));
  }

  // ============ INCIDENTS ============

  createIncident(incident: Omit<Incident, "id">): Incident {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO triage_incidents
           (id, project, branch, pipeline_id, status, opened_at, red_sha, last_green_sha, record_id, target, bisect, revert)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        incident.project,
        incident.branch,
        incident.pipelineId,
        incident.status,
        incident.openedAt,
        incident.redSha,
        incident.lastGreenSha ?? null,
        incident.recordId,
        JSON.stringify(incident.target),
        JSON.stringify(incident.bisect),
        JSON.stringify(incident.revert),
      );
    return this.getIncident(id)!;
  }

  updateIncident(
    id: string,
    patch: Partial<Pick<Incident, "status" | "resolvedAt" | "resolution" | "target" | "bisect" | "revert" | "decisionRef">>,
  ): void {
    const current = this.getIncident(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE triage_incidents SET status = ?, resolved_at = ?, resolution = ?, target = ?, bisect = ?, revert = ?, decision_ref = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.resolvedAt ?? null,
        next.resolution ?? null,
        JSON.stringify(next.target),
        JSON.stringify(next.bisect),
        JSON.stringify(next.revert),
        next.decisionRef ?? null,
        id,
      );
  }

  getIncident(id: string): Incident | null {
    const row = this.db.prepare(`SELECT * FROM triage_incidents WHERE id = ?`).get(id) as IncidentRow | undefined;
    return row ? toIncident(row) : null;
  }

  /** The open incident of a pipeline on a branch. */
  openIncident(project: string, branch: string, pipelineId: string): Incident | null {
    const row = this.db
      .prepare(`SELECT * FROM triage_incidents WHERE project = ? AND branch = ? AND pipeline_id = ? AND status = 'open'`)
      .get(project, branch, pipelineId) as IncidentRow | undefined;
    return row ? toIncident(row) : null;
  }

  /** Every open incident of a project, newest first. */
  openIncidents(project: string): Incident[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_incidents WHERE project = ? AND status = 'open' ORDER BY opened_at DESC, rowid DESC`)
      .all(project) as IncidentRow[];
    return rows.map(toIncident);
  }

  listIncidents(project: string, options: { status?: "open" | "resolved"; limit?: number } = {}): Incident[] {
    const rows = (
      options.status
        ? this.db
            .prepare(`SELECT * FROM triage_incidents WHERE project = ? AND status = ? ORDER BY opened_at DESC, rowid DESC LIMIT ?`)
            .all(project, options.status, options.limit ?? 50)
        : this.db
            .prepare(`SELECT * FROM triage_incidents WHERE project = ? ORDER BY opened_at DESC, rowid DESC LIMIT ?`)
            .all(project, options.limit ?? 50)
    ) as IncidentRow[];
    return rows.map(toIncident);
  }

  // ============ PROTECTED MERGES ============

  protect(project: string, sha: string, note: string, by: string | undefined, at: string): void {
    this.db
      .prepare(
        `INSERT INTO triage_protected (project, sha, note, by_who, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project, sha) DO UPDATE SET note = excluded.note, by_who = excluded.by_who`,
      )
      .run(project, sha.toLowerCase(), note, by ?? null, at);
  }

  unprotect(project: string, sha: string): boolean {
    return this.db.prepare(`DELETE FROM triage_protected WHERE project = ? AND sha = ?`).run(project, sha.toLowerCase()).changes > 0;
  }

  listProtected(project: string): ProtectedMerge[] {
    const rows = this.db
      .prepare(`SELECT sha, note, by_who, created_at FROM triage_protected WHERE project = ? ORDER BY created_at DESC, rowid DESC`)
      .all(project) as { sha: string; note: string; by_who: string | null; created_at: string }[];
    return rows.map((r) => ({ sha: r.sha, note: r.note, by: r.by_who ?? undefined, createdAt: r.created_at }));
  }

  // ============ DECISIONS ============

  /** Claim the right to raise a decision about `subject`; false when one was already raised. */
  claimDecision(project: string, subject: string, at: string): boolean {
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO triage_decisions (project, subject, created_at) VALUES (?, ?, ?)`)
        .run(project, subject, at).changes > 0
    );
  }

  /** An answered subject may be asked about again. */
  releaseDecision(project: string, subject: string): void {
    this.db.prepare(`DELETE FROM triage_decisions WHERE project = ? AND subject = ?`).run(project, subject);
  }

  setDecisionRef(project: string, subject: string, ref: string): void {
    this.db.prepare(`UPDATE triage_decisions SET ref = ? WHERE project = ? AND subject = ?`).run(ref, project, subject);
  }

  addOutbox(project: string, kind: string, payload: unknown, createdMs: number): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO triage_outbox (id, project, kind, payload, created_ms) VALUES (?, ?, ?, ?, ?)`)
      .run(id, project, kind, JSON.stringify(payload), createdMs);
    return id;
  }

  /** The calls still to run, oldest first. */
  outbox(project: string): { id: string; kind: string; payload: unknown }[] {
    const rows = this.db
      .prepare(`SELECT id, kind, payload FROM triage_outbox WHERE project = ? ORDER BY created_ms, rowid`)
      .all(project) as { id: string; kind: string; payload: string }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  }

  /** Remove a call that ran; false when it was already removed. */
  removeOutbox(id: string): boolean {
    return this.db.prepare(`DELETE FROM triage_outbox WHERE id = ?`).run(id).changes > 0;
  }
}

function toAction(row: ActionRow): TriageAction {
  return {
    id: row.id,
    project: row.project,
    recordId: row.record_id ?? undefined,
    incidentId: row.incident_id ?? undefined,
    kind: row.kind as ActionKind,
    status: row.status as ActionStatus,
    detail: row.detail,
    argv: row.argv ? (JSON.parse(row.argv) as string[]) : undefined,
    output: row.output ?? undefined,
    actor: row.actor ?? undefined,
    at: row.at,
  };
}

function toRecheck(row: RecheckRow): Recheck {
  return {
    id: row.id,
    project: row.project,
    purpose: row.purpose as RecheckPurpose,
    recordId: row.record_id ?? undefined,
    incidentId: row.incident_id ?? undefined,
    sha: row.sha,
    branch: row.branch,
    gateId: row.gate_id,
    steps: JSON.parse(row.steps) as string[],
    tests: JSON.parse(row.tests) as string[],
    classes: JSON.parse(row.classes) as string[],
    attempt: row.attempt,
    status: row.status as RecheckStatus,
    reason: row.reason ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at,
    requestedAt: row.requested_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    answerId: row.answer_id ?? undefined,
  };
}

function toTask(row: TaskRow): TriageTask {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind as TriageTask["kind"],
    key: row.key,
    title: row.title,
    body: row.body,
    status: row.status as TriageTask["status"],
    ref: row.ref ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function toFlaky(row: FlakyRow): FlakyTest {
  return {
    key: row.test_key,
    occurrences: row.occurrences,
    lastAt: row.last_at,
    quarantinedAt: row.quarantined_at ?? undefined,
    quarantineUntil: row.quarantine_until ?? undefined,
    passes: row.passes,
    ticketId: row.ticket_id ?? undefined,
  };
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    project: row.project,
    branch: row.branch,
    pipelineId: row.pipeline_id,
    status: row.status as Incident["status"],
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolution: row.resolution ?? undefined,
    redSha: row.red_sha,
    lastGreenSha: row.last_green_sha ?? undefined,
    recordId: row.record_id,
    target: JSON.parse(row.target) as IncidentTarget,
    bisect: JSON.parse(row.bisect) as BisectState,
    revert: JSON.parse(row.revert) as Incident["revert"],
    decisionRef: row.decision_ref ?? undefined,
  };
}
