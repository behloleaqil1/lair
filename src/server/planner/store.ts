/**
 * Planner store (data/planner.db): per project its state (the tasks-file
 * content Lair last wrote or accepted, the queue cursor, seen messages,
 * source hashes, pending triggers, failures, the pause), planner runs,
 * proposals, attempts per task and the history of changes. SQLite, so all of
 * it survives a restart.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  ChangeOutcome,
  ChangeSource,
  ChangeView,
  PlannerRunState,
  PlannerRunView,
  ProposalStatus,
  ProposalView,
  TriggerView,
  VerifierState,
  VerifierVerdict,
} from "../../shared/planner-types.js";

/** 2: added verifier columns to runs and proposals. */
export const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS planner_state (
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (project, key)
  );

  CREATE TABLE IF NOT EXISTS planner_runs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    state TEXT NOT NULL,
    agent TEXT NOT NULL,
    task TEXT NOT NULL,
    agent_run_id TEXT,
    chain_id TEXT,
    dir TEXT NOT NULL,
    triggers TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    ended_at INTEGER,
    detail TEXT NOT NULL,
    tampered INTEGER NOT NULL DEFAULT 0,
    decision_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_planner_runs ON planner_runs(project, requested_at);

  CREATE TABLE IF NOT EXISTS planner_proposals (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    op TEXT NOT NULL,
    task TEXT NOT NULL,
    agent TEXT,
    text TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    refusal TEXT,
    decided_by TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_planner_proposals ON planner_proposals(project, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_planner_proposals_run ON planner_proposals(run_id, idx);

  CREATE TABLE IF NOT EXISTS planner_changes (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    outcome TEXT NOT NULL,
    op TEXT NOT NULL,
    task TEXT,
    agent TEXT,
    reason TEXT NOT NULL,
    diff TEXT NOT NULL,
    run_id TEXT,
    proposal_id TEXT,
    dedupe_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_planner_changes ON planner_changes(project, at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_changes_dedupe
    ON planner_changes(project, dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS planner_attempts (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project, task)
  );
`;

const MIGRATE_V1_TO_V2 = `
  ALTER TABLE planner_runs ADD COLUMN verifier_state TEXT;
  ALTER TABLE planner_runs ADD COLUMN verifier_run_id TEXT;
  ALTER TABLE planner_runs ADD COLUMN verifier_chain_id TEXT;
  ALTER TABLE planner_runs ADD COLUMN verifier_task TEXT;
  ALTER TABLE planner_proposals ADD COLUMN verifier_verdict TEXT;
  ALTER TABLE planner_proposals ADD COLUMN verifier_reason TEXT;
  ALTER TABLE planner_proposals ADD COLUMN verifier_evidence TEXT;
`;

export interface StoredRun {
  id: string;
  project: string;
  state: PlannerRunState;
  agent: string;
  task: string;
  agentRunId: string | null;
  chainId: string | null;
  dir: string;
  triggers: TriggerView[];
  requestedAt: number;
  endedAt: number | null;
  detail: string;
  tampered: boolean;
  decisionId: string | null;
  /** Verification state: "pending", "running", "done", "failed", "skipped", or null if not configured */
  verifierState: VerifierState | null;
  /** The verifier agent's run id (the chain's first run) */
  verifierRunId: string | null;
  /** The verifier's chain id */
  verifierChainId: string | null;
  /** The verifier's task id */
  verifierTask: string | null;
}

export interface StoredProposal {
  id: string;
  project: string;
  runId: string;
  index: number;
  op: string;
  task: string;
  agent: string | null;
  text: string | null;
  reason: string;
  status: ProposalStatus;
  refusal: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
  /** The verifier's verdict: "approve", "reject", "unsure", "unverified", or null */
  verifierVerdict: VerifierVerdict | null;
  /** The verifier's reason for its verdict */
  verifierReason: string | null;
  /** Evidence the verifier cited */
  verifierEvidence: string[] | null;
}

export interface ChangeInput {
  project: string;
  at: number;
  source: ChangeSource;
  outcome: ChangeOutcome;
  op: string;
  task?: string | null;
  agent?: string | null;
  reason: string;
  diff: string[];
  runId?: string | null;
  proposalId?: string | null;
  /** One change per key: a planned change is recorded once while it stands */
  dedupeKey?: string;
}

interface RunRow {
  id: string;
  project: string;
  state: string;
  agent: string;
  task: string;
  agent_run_id: string | null;
  chain_id: string | null;
  dir: string;
  triggers: string;
  requested_at: number;
  ended_at: number | null;
  detail: string;
  tampered: number;
  decision_id: string | null;
  verifier_state: string | null;
  verifier_run_id: string | null;
  verifier_chain_id: string | null;
  verifier_task: string | null;
}

interface ProposalRow {
  id: string;
  project: string;
  run_id: string;
  idx: number;
  op: string;
  task: string;
  agent: string | null;
  text: string | null;
  reason: string;
  status: string;
  refusal: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  verifier_verdict: string | null;
  verifier_reason: string | null;
  verifier_evidence: string | null;
}

interface ChangeRow {
  id: string;
  at: number;
  source: string;
  outcome: string;
  op: string;
  task: string | null;
  agent: string | null;
  reason: string;
  diff: string;
  run_id: string | null;
  proposal_id: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    project: row.project,
    state: row.state as PlannerRunState,
    agent: row.agent,
    task: row.task,
    agentRunId: row.agent_run_id,
    chainId: row.chain_id,
    dir: row.dir,
    triggers: JSON.parse(row.triggers) as TriggerView[],
    requestedAt: row.requested_at,
    endedAt: row.ended_at,
    detail: row.detail,
    tampered: row.tampered === 1,
    decisionId: row.decision_id,
    verifierState: row.verifier_state as VerifierState | null,
    verifierRunId: row.verifier_run_id,
    verifierChainId: row.verifier_chain_id,
    verifierTask: row.verifier_task,
  };
}

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    project: row.project,
    runId: row.run_id,
    index: row.idx,
    op: row.op,
    task: row.task,
    agent: row.agent,
    text: row.text,
    reason: row.reason,
    status: row.status as ProposalStatus,
    refusal: row.refusal,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    verifierVerdict: row.verifier_verdict as VerifierVerdict | null,
    verifierReason: row.verifier_reason,
    verifierEvidence: row.verifier_evidence ? JSON.parse(row.verifier_evidence) : null,
  };
}

export function proposalView(p: StoredProposal): ProposalView {
  return {
    id: p.id,
    runId: p.runId,
    index: p.index,
    op: p.op,
    task: p.task,
    agent: p.agent,
    text: p.text,
    reason: p.reason,
    status: p.status,
    refusal: p.refusal,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt === null ? null : iso(p.decidedAt),
    createdAt: iso(p.createdAt),
    verifierVerdict: p.verifierVerdict,
    verifierReason: p.verifierReason,
    verifierEvidence: p.verifierEvidence,
  };
}

export class PlannerStore {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
    }
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
      this.db.exec(SCHEMA_V1);
      this.db.pragma("user_version = 1");
    }
    if (version < 2) {
      this.db.exec(MIGRATE_V1_TO_V2);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ============ STATE ============

  get<T>(project: string, key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM planner_state WHERE project = ? AND key = ?`).get(project, key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(project: string, key: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.prepare(`DELETE FROM planner_state WHERE project = ? AND key = ?`).run(project, key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO planner_state (project, key, value) VALUES (?, ?, ?)
         ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`,
      )
      .run(project, key, JSON.stringify(value));
  }

  // ============ RUNS ============

  insertRun(run: StoredRun): void {
    this.db
      .prepare(
        `INSERT INTO planner_runs (id, project, state, agent, task, agent_run_id, chain_id, dir, triggers, requested_at,
           ended_at, detail, tampered, decision_id, verifier_state, verifier_run_id, verifier_chain_id, verifier_task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.project,
        run.state,
        run.agent,
        run.task,
        run.agentRunId,
        run.chainId,
        run.dir,
        JSON.stringify(run.triggers),
        run.requestedAt,
        run.endedAt,
        run.detail,
        run.tampered ? 1 : 0,
        run.decisionId,
        run.verifierState,
        run.verifierRunId,
        run.verifierChainId,
        run.verifierTask,
      );
  }

  saveRun(run: StoredRun): void {
    this.db
      .prepare(
        `UPDATE planner_runs SET state = ?, agent_run_id = ?, chain_id = ?, ended_at = ?, detail = ?, tampered = ?,
           decision_id = ?, verifier_state = ?, verifier_run_id = ?, verifier_chain_id = ?, verifier_task = ? WHERE id = ?`,
      )
      .run(
        run.state,
        run.agentRunId,
        run.chainId,
        run.endedAt,
        run.detail,
        run.tampered ? 1 : 0,
        run.decisionId,
        run.verifierState,
        run.verifierRunId,
        run.verifierChainId,
        run.verifierTask,
        run.id,
      );
  }

  getRun(id: string): StoredRun | null {
    const row = this.db.prepare(`SELECT * FROM planner_runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The project's run in progress (at most one). */
  activeRun(project: string): StoredRun | null {
    const row = this.db
      .prepare(`SELECT * FROM planner_runs WHERE project = ? AND state = 'running' ORDER BY requested_at DESC LIMIT 1`)
      .get(project) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(project: string, limit = 50): StoredRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM planner_runs WHERE project = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as RunRow[];
    return rows.map(toRun);
  }

  countRuns(project: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM planner_runs WHERE project = ?`).get(project) as { n: number }).n;
  }

  /** When the project's runs requested after `since` started, oldest first (max_runs_per_day). */
  runStartsSince(project: string, since: number): number[] {
    const rows = this.db
      .prepare(`SELECT requested_at FROM planner_runs WHERE project = ? AND requested_at > ? ORDER BY requested_at`)
      .all(project, since) as { requested_at: number }[];
    return rows.map((row) => row.requested_at);
  }

  /** Count verifier runs started after `since` (for max_runs_per_day enforcement). */
  verifierRunsSince(project: string, since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM planner_runs WHERE project = ? AND requested_at > ? AND verifier_run_id IS NOT NULL`)
      .get(project, since) as { n: number };
    return row.n;
  }

  runView(run: StoredRun): PlannerRunView {
    const counts = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM planner_proposals WHERE run_id = ? GROUP BY status`)
      .all(run.id) as { status: string; n: number }[];
    const n = (status: string) => counts.find((c) => c.status === status)?.n ?? 0;
    return {
      id: run.id,
      state: run.state,
      agent: run.agent,
      agentRunId: run.agentRunId,
      task: run.task,
      triggers: run.triggers,
      requestedAt: iso(run.requestedAt),
      endedAt: run.endedAt === null ? null : iso(run.endedAt),
      detail: run.detail,
      proposals: counts.reduce((sum, c) => sum + c.n, 0),
      applied: n("applied"),
      pending: n("pending"),
      rejected: n("rejected") + n("declined"),
      verifierState: run.verifierState,
      verifierRunId: run.verifierRunId,
    };
  }

  // ============ PROPOSALS ============

  insertProposal(p: Omit<StoredProposal, "id">): StoredProposal {
    const stored: StoredProposal = { ...p, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO planner_proposals (id, project, run_id, idx, op, task, agent, text, reason, status, refusal,
           decided_by, decided_at, created_at, verifier_verdict, verifier_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.project,
        stored.runId,
        stored.index,
        stored.op,
        stored.task,
        stored.agent,
        stored.text,
        stored.reason,
        stored.status,
        stored.refusal,
        stored.decidedBy,
        stored.decidedAt,
        stored.createdAt,
        stored.verifierVerdict,
        stored.verifierReason,
      );
    return stored;
  }

  decide(id: string, status: ProposalStatus, by: string | null, at: number, refusal: string | null = null): void {
    this.db
      .prepare(`UPDATE planner_proposals SET status = ?, decided_by = ?, decided_at = ?, refusal = COALESCE(?, refusal) WHERE id = ?`)
      .run(status, by, at, refusal, id);
  }

  setVerifierVerdict(id: string, verdict: VerifierVerdict, reason: string | null, evidence: string[] | null): void {
    this.db
      .prepare(`UPDATE planner_proposals SET verifier_verdict = ?, verifier_reason = ?, verifier_evidence = ? WHERE id = ?`)
      .run(verdict, reason, evidence ? JSON.stringify(evidence) : null, id);
  }

  getProposal(id: string): StoredProposal | null {
    const row = this.db.prepare(`SELECT * FROM planner_proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  runProposals(runId: string): StoredProposal[] {
    const rows = this.db.prepare(`SELECT * FROM planner_proposals WHERE run_id = ? ORDER BY idx`).all(runId) as ProposalRow[];
    return rows.map(toProposal);
  }

  listProposals(project: string, options: { status?: ProposalStatus; limit?: number } = {}): StoredProposal[] {
    const rows = (
      options.status
        ? this.db
            .prepare(`SELECT * FROM planner_proposals WHERE project = ? AND status = ? ORDER BY created_at DESC, idx LIMIT ?`)
            .all(project, options.status, options.limit ?? 100)
        : this.db
            .prepare(`SELECT * FROM planner_proposals WHERE project = ? ORDER BY created_at DESC, idx LIMIT ?`)
            .all(project, options.limit ?? 100)
    ) as ProposalRow[];
    return rows.map(toProposal);
  }

  countPending(project: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM planner_proposals WHERE project = ? AND status = 'pending'`).get(project) as {
        n: number;
      }
    ).n;
  }

  // ============ CHANGES (history) ============

  /** Record a change: its id, or null when one with the same dedupe key exists. */
  addChange(input: ChangeInput): string | null {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO planner_changes (id, project, at, source, outcome, op, task, agent, reason, diff, run_id,
           proposal_id, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.at,
        input.source,
        input.outcome,
        input.op,
        input.task ?? null,
        input.agent ?? null,
        input.reason,
        JSON.stringify(input.diff),
        input.runId ?? null,
        input.proposalId ?? null,
        input.dedupeKey ?? null,
      );
    return result.changes > 0 ? id : null;
  }

  setChangeOutcome(ids: string[], outcome: ChangeOutcome): void {
    const update = this.db.prepare(`UPDATE planner_changes SET outcome = ? WHERE id = ?`);
    for (const id of ids) update.run(outcome, id);
  }

  listChanges(project: string, limit = 100): ChangeView[] {
    const rows = this.db
      .prepare(`SELECT * FROM planner_changes WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(project, limit) as ChangeRow[];
    return rows.map((row) => ({
      id: row.id,
      at: iso(row.at),
      source: row.source as ChangeSource,
      outcome: row.outcome as ChangeOutcome,
      op: row.op,
      task: row.task,
      agent: row.agent,
      reason: row.reason,
      diff: JSON.parse(row.diff) as string[],
      runId: row.run_id,
      proposalId: row.proposal_id,
    }));
  }

  // ============ ATTEMPTS ============

  attempts(project: string, task: string): number {
    const row = this.db.prepare(`SELECT attempts FROM planner_attempts WHERE project = ? AND task = ?`).get(project, task) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }

  addAttempt(project: string, task: string, at: number): number {
    this.db
      .prepare(
        `INSERT INTO planner_attempts (project, task, attempts, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(project, task) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at`,
      )
      .run(project, task, at);
    return this.attempts(project, task);
  }

  resetAttempts(project: string, task: string): void {
    this.db.prepare(`DELETE FROM planner_attempts WHERE project = ? AND task = ?`).run(project, task);
  }
}
