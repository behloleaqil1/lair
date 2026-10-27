/**
 * The triage store's table for re-checks in a project's own gate system
 * (gate-recheck.ts). Part of data/triage.db: TriageStore creates it (schema
 * version 2) and hands this its connection, so its writes join the decision
 * section's transaction.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { GateRecheck, GateRecheckCause, GateRecheckKind, GateRecheckStatus } from "../../shared/triage-types.js";

export const GATE_RECHECK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS triage_gate_rechecks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    record_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    causes TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    tests TEXT NOT NULL,
    test_keys TEXT NOT NULL,
    signatures TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    argv TEXT,
    output TEXT,
    run_id TEXT,
    answer_id TEXT,
    passed_tests TEXT NOT NULL DEFAULT '[]',
    hold_route INTEGER NOT NULL DEFAULT 0,
    not_before_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    started_ms INTEGER,
    queued_at TEXT,
    queued_ms INTEGER,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tr_gr_status ON triage_gate_rechecks(project, status, created_ms);
  CREATE INDEX IF NOT EXISTS idx_tr_gr_record ON triage_gate_rechecks(record_id);
  CREATE INDEX IF NOT EXISTS idx_tr_gr_answer ON triage_gate_rechecks(answer_id);
  CREATE INDEX IF NOT EXISTS idx_tr_gr_root ON triage_gate_rechecks(root_id);
  CREATE INDEX IF NOT EXISTS idx_tr_gr_target ON triage_gate_rechecks(project, sha, pipeline_id);
`;

/** Pending: waiting for its cool-down, its command running, or queued in the gate system */
export const PENDING: GateRecheckStatus[] = ["waiting", "running", "queued"];
/** A result may answer it (an expired one too: a late answer still tells the truth) */
export const ANSWERABLE: GateRecheckStatus[] = ["running", "queued", "expired"];

interface Row {
  id: string;
  project: string;
  record_id: string;
  root_id: string;
  gate_id: string;
  sha: string;
  pipeline_id: string;
  branch: string;
  causes: string;
  kind: string;
  reason: string;
  tests: string;
  test_keys: string;
  signatures: string;
  attempt: number;
  status: string;
  detail: string;
  argv: string | null;
  output: string | null;
  run_id: string | null;
  answer_id: string | null;
  passed_tests: string;
  hold_route: number;
  not_before_ms: number;
  created_at: string;
  created_ms: number;
  started_ms: number | null;
  queued_at: string | null;
  queued_ms: number | null;
  completed_at: string | null;
}

export interface NewGateRecheck {
  project: string;
  recordId: string;
  rootId: string;
  gateId: string;
  sha: string;
  pipelineId: string;
  branch: string;
  causes: GateRecheckCause[];
  kind: GateRecheckKind;
  reason: string;
  tests: string[];
  keys: string[];
  signatures: string[];
  attempt: number;
  status: GateRecheckStatus;
  detail: string;
  argv?: string[];
  holdRoute: boolean;
}

export interface GateRecheckPatch {
  status?: GateRecheckStatus;
  detail?: string;
  output?: string;
  runId?: string;
  answerId?: string;
  passedTests?: string[];
  startedMs?: number;
  queuedAt?: string;
  queuedMs?: number;
  completedAt?: string;
}

const COLUMNS: [keyof GateRecheckPatch, string][] = [
  ["status", "status"],
  ["detail", "detail"],
  ["output", "output"],
  ["runId", "run_id"],
  ["answerId", "answer_id"],
  ["passedTests", "passed_tests"],
  ["startedMs", "started_ms"],
  ["queuedAt", "queued_at"],
  ["queuedMs", "queued_ms"],
  ["completedAt", "completed_at"],
];

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

function toRecheck(row: Row): GateRecheck {
  return {
    id: row.id,
    project: row.project,
    recordId: row.record_id,
    rootId: row.root_id,
    gateId: row.gate_id,
    sha: row.sha,
    pipelineId: row.pipeline_id,
    branch: row.branch,
    causes: JSON.parse(row.causes) as GateRecheckCause[],
    kind: row.kind as GateRecheckKind,
    reason: row.reason,
    tests: JSON.parse(row.tests) as string[],
    keys: JSON.parse(row.test_keys) as string[],
    signatures: JSON.parse(row.signatures) as string[],
    attempt: row.attempt,
    status: row.status as GateRecheckStatus,
    detail: row.detail,
    argv: row.argv ? (JSON.parse(row.argv) as string[]) : undefined,
    output: row.output ?? undefined,
    runId: row.run_id ?? undefined,
    answerId: row.answer_id ?? undefined,
    passedTests: JSON.parse(row.passed_tests) as string[],
    holdRoute: row.hold_route === 1,
    notBefore: new Date(row.not_before_ms).toISOString(),
    createdAt: row.created_at,
    queuedAt: row.queued_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export class GateRecheckStore {
  constructor(private db: Database.Database) {}

  create(input: NewGateRecheck, createdMs: number, notBeforeMs: number): GateRecheck {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO triage_gate_rechecks
           (id, project, record_id, root_id, gate_id, sha, pipeline_id, branch, causes, kind, reason, tests, test_keys,
            signatures, attempt, status, detail, argv, hold_route, not_before_ms, created_at, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.recordId,
        input.rootId,
        input.gateId,
        input.sha,
        input.pipelineId,
        input.branch,
        JSON.stringify(input.causes),
        input.kind,
        input.reason,
        JSON.stringify(input.tests),
        JSON.stringify(input.keys),
        JSON.stringify(input.signatures),
        input.attempt,
        input.status,
        input.detail,
        input.argv ? JSON.stringify(input.argv) : null,
        input.holdRoute ? 1 : 0,
        notBeforeMs,
        new Date(createdMs).toISOString(),
        createdMs,
      );
    return this.get(id)!;
  }

  get(id: string): GateRecheck | null {
    const row = this.db.prepare(`SELECT * FROM triage_gate_rechecks WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecheck(row) : null;
  }

  update(id: string, patch: GateRecheckPatch): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [key, column] of COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(Array.isArray(value) ? JSON.stringify(value) : value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE triage_gate_rechecks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** The times kept as ms: not before, started (its command), queued. */
  times(id: string): { notBeforeMs: number; startedMs: number | null; queuedMs: number | null } | null {
    const row = this.db
      .prepare(`SELECT not_before_ms, started_ms, queued_ms FROM triage_gate_rechecks WHERE id = ?`)
      .get(id) as Pick<Row, "not_before_ms" | "started_ms" | "queued_ms"> | undefined;
    return row ? { notBeforeMs: row.not_before_ms, startedMs: row.started_ms, queuedMs: row.queued_ms } : null;
  }

  withStatus(project: string, statuses: GateRecheckStatus[]): GateRecheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM triage_gate_rechecks WHERE project = ? AND status IN (${placeholders(statuses.length)})
         ORDER BY created_ms, rowid`,
      )
      .all(project, ...statuses) as Row[];
    return rows.map(toRecheck);
  }

  /** Every re-check of a chain (the root failure and the re-checks' own failures), oldest first. */
  forRoot(rootId: string): GateRecheck[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_gate_rechecks WHERE root_id = ? ORDER BY created_ms, rowid`)
      .all(rootId) as Row[];
    return rows.map(toRecheck);
  }

  /** The re-checks of a failure and the one its result answers, oldest first. */
  related(recordId: string): GateRecheck[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_gate_rechecks WHERE record_id = ? OR answer_id = ? ORDER BY created_ms, rowid`)
      .all(recordId, recordId) as Row[];
    return rows.map(toRecheck);
  }

  /** The newest re-check of a failure in one of `statuses` (any status when none are given). */
  latestFor(recordId: string, statuses?: GateRecheckStatus[]): GateRecheck | null {
    const filter = statuses ? ` AND status IN (${placeholders(statuses.length)})` : "";
    const row = this.db
      .prepare(`SELECT * FROM triage_gate_rechecks WHERE record_id = ?${filter} ORDER BY created_ms DESC, rowid DESC LIMIT 1`)
      .get(recordId, ...(statuses ?? [])) as Row | undefined;
    return row ? toRecheck(row) : null;
  }

  /** Pending re-checks of failures at this commit and pipeline. */
  pendingAt(project: string, sha: string, pipelineId: string): GateRecheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM triage_gate_rechecks WHERE project = ? AND sha = ? AND pipeline_id = ?
           AND status IN (${placeholders(PENDING.length)}) ORDER BY created_ms, rowid`,
      )
      .all(project, sha, pipelineId, ...PENDING) as Row[];
    return rows.map(toRecheck);
  }

  /** Newest first. */
  list(project: string, limit = 100): GateRecheck[] {
    const rows = this.db
      .prepare(`SELECT * FROM triage_gate_rechecks WHERE project = ? ORDER BY created_ms DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as Row[];
    return rows.map(toRecheck);
  }

  countPending(project: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM triage_gate_rechecks WHERE project = ? AND status IN (${placeholders(PENDING.length)})`)
      .get(project, ...PENDING) as { n: number };
    return row.n;
  }

  /** The triage record of the result with this id, if one was received. */
  recordIdByGate(project: string, gateId: string): string | null {
    const row = this.db.prepare(`SELECT id FROM triage_records WHERE project = ? AND gate_id = ?`).get(project, gateId) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }
}
