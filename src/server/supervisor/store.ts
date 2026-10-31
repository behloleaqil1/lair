/**
 * The supervisor's store (data/supervisor.db): the audit of every ops API
 * call (who, when, the tool, a redacted summary of its arguments, and how it
 * ended) and of every token minted or revoked, and the supervisor's
 * conversations: the owner's questions, the daily digests, and their
 * answers with the evidence they cite. Never a token. SQLite, so it
 * survives a restart; audit rows older than 30 days, and past the newest
 * 50,000, are pruned as new ones come; conversations older than 90 days go
 * the same way.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  ConversationKind,
  ConversationSummary,
  ConversationTurn,
  EvidenceItem,
  OpsAuditEntry,
  OpsCallOutcome,
  TurnState,
} from "../../shared/supervisor-types.js";

// 1: ops_audit; 2: conversations and turns (S1-2); 3: act_audit (S3); 4: act_cooldowns (M7)
const SCHEMA_VERSION = 4;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops_audit (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    who TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ops_audit_at ON ops_audit(at);
  CREATE TABLE IF NOT EXISTS act_audit (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    project TEXT NOT NULL,
    op TEXT NOT NULL,
    target TEXT NOT NULL,
    evidence TEXT NOT NULL,
    cleared_check_output TEXT,
    mode TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_act_audit_at ON act_audit(at);
  CREATE INDEX IF NOT EXISTS idx_act_audit_project ON act_audit(project, at);
  CREATE TABLE IF NOT EXISTS act_cooldowns (
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (project, key)
  );
  CREATE INDEX IF NOT EXISTS idx_act_cooldowns_expires ON act_cooldowns(expires_at);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    digest_date TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project, kind, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_digest ON conversations(project, digest_date) WHERE digest_date IS NOT NULL;
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    question TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    run_id TEXT,
    agent TEXT,
    task TEXT,
    deadline_at INTEGER NOT NULL,
    answer TEXT,
    evidence TEXT,
    answered_at INTEGER,
    reason TEXT,
    UNIQUE (conversation_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_turns_state ON turns(state);
  CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);
`;

/** Conversations not touched for this long are pruned */
const CONVERSATION_RETENTION_MS = 90 * 86_400_000;

interface ConversationRow {
  id: string;
  project: string;
  kind: string;
  digest_date: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  seq: number;
  question: string;
  asked_at: number;
  state: string;
  run_id: string | null;
  agent: string | null;
  task: string | null;
  deadline_at: number;
  answer: string | null;
  evidence: string | null;
  answered_at: number | null;
  reason: string | null;
}

export interface StoredConversation {
  id: string;
  project: string;
  kind: ConversationKind;
  digestDate: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A turn as the store keeps it (times in ms) */
export interface StoredTurn {
  id: string;
  conversationId: string;
  seq: number;
  question: string;
  askedAt: number;
  state: TurnState;
  runId: string | null;
  agent: string | null;
  task: string | null;
  deadlineAt: number;
  answer: string | null;
  evidence: EvidenceItem[];
  answeredAt: number | null;
  reason: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind === "digest" ? "digest" : "chat",
    digestDate: row.digest_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEvidence(text: string | null): EvidenceItem[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as EvidenceItem[]) : [];
  } catch {
    return [];
  }
}

function toTurn(row: TurnRow): StoredTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    question: row.question,
    askedAt: row.asked_at,
    state: row.state === "answered" || row.state === "no_answer" ? row.state : "pending",
    runId: row.run_id,
    agent: row.agent,
    task: row.task,
    deadlineAt: row.deadline_at,
    answer: row.answer,
    evidence: parseEvidence(row.evidence),
    answeredAt: row.answered_at,
    reason: row.reason,
  };
}

/** A stored turn as the API shows it */
export function turnView(t: StoredTurn): ConversationTurn {
  return {
    id: t.id,
    seq: t.seq,
    question: t.question,
    askedAt: iso(t.askedAt),
    state: t.state,
    runId: t.runId,
    agent: t.agent,
    deadlineAt: iso(t.deadlineAt),
    answer: t.answer,
    evidence: t.evidence,
    answeredAt: t.answeredAt === null ? null : iso(t.answeredAt),
    reason: t.reason,
  };
}

const RETENTION_MS = 30 * 86_400_000;
const MAX_ROWS = 50_000;
const PRUNE_EVERY = 500;

interface AuditRow {
  id: string;
  at: number;
  token_id: string;
  who: string;
  tool: string;
  args: string;
  outcome: string;
  detail: string | null;
  duration_ms: number;
}

export interface AuditInput {
  at: number;
  tokenId: string;
  who: string;
  tool: string;
  args: string;
  outcome: OpsCallOutcome;
  detail?: string | null;
  durationMs: number;
}

export class SupervisorStore {
  private db: Database.Database;
  private inserts = 0;

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
      this.db.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  audit(entry: AuditInput): OpsAuditEntry {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ops_audit (id, at, token_id, who, tool, args, outcome, detail, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.at,
        entry.tokenId.slice(0, 64),
        entry.who.slice(0, 120),
        entry.tool.slice(0, 80),
        entry.args.slice(0, 500),
        entry.outcome,
        entry.detail ? entry.detail.slice(0, 500) : null,
        Math.max(0, Math.round(entry.durationMs)),
      );
    if (++this.inserts % PRUNE_EVERY === 0) this.prune(entry.at);
    return toEntry({
      id,
      at: entry.at,
      token_id: entry.tokenId,
      who: entry.who,
      tool: entry.tool,
      args: entry.args.slice(0, 500),
      outcome: entry.outcome,
      detail: entry.detail ?? null,
      duration_ms: Math.round(entry.durationMs),
    });
  }

  /** The newest entries first. */
  list(limit = 100, tokenId?: string): OpsAuditEntry[] {
    const n = Math.min(Math.max(1, Math.floor(limit)), 1000);
    const rows = (
      tokenId === undefined
        ? this.db.prepare(`SELECT * FROM ops_audit ORDER BY at DESC, rowid DESC LIMIT ?`).all(n)
        : this.db.prepare(`SELECT * FROM ops_audit WHERE token_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`).all(tokenId, n)
    ) as AuditRow[];
    return rows.map(toEntry);
  }

  prune(now: number): void {
    this.db.prepare(`DELETE FROM ops_audit WHERE at < ?`).run(now - RETENTION_MS);
    this.db
      .prepare(`DELETE FROM ops_audit WHERE rowid NOT IN (SELECT rowid FROM ops_audit ORDER BY at DESC, rowid DESC LIMIT ?)`)
      .run(MAX_ROWS);
    this.pruneConversations(now);
  }

  // ============ CONVERSATIONS ============

  /** A conversation and its first turn, or a new turn of an existing one, in one transaction. */
  addTurn(conversation: StoredConversation, turn: StoredTurn, isNew: boolean): void {
    this.db.transaction(() => {
      if (isNew) {
        this.db
          .prepare(`INSERT INTO conversations (id, project, kind, digest_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(conversation.id, conversation.project, conversation.kind, conversation.digestDate, conversation.createdAt, turn.askedAt);
      } else {
        this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(turn.askedAt, conversation.id);
      }
      this.db
        .prepare(
          `INSERT INTO turns (id, conversation_id, seq, question, asked_at, state, run_id, agent, task, deadline_at, answer, evidence, answered_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.id,
          conversation.id,
          turn.seq,
          turn.question,
          turn.askedAt,
          turn.state,
          turn.runId,
          turn.agent,
          turn.task,
          turn.deadlineAt,
          turn.answer,
          turn.evidence.length > 0 ? JSON.stringify(turn.evidence) : null,
          turn.answeredAt,
          turn.reason,
        );
    })();
    if (++this.inserts % PRUNE_EVERY === 0) this.prune(turn.askedAt);
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  turnsOf(conversationId: string): StoredTurn[] {
    const rows = this.db.prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq ASC`).all(conversationId) as TurnRow[];
    return rows.map(toTurn);
  }

  turnByRun(runId: string): (StoredTurn & { project: string }) | null {
    const row = this.db
      .prepare(`SELECT t.*, c.project AS project FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE t.run_id = ?`)
      .get(runId) as (TurnRow & { project: string }) | undefined;
    return row ? { ...toTurn(row), project: row.project } : null;
  }

  /** Every turn still waiting on its run, oldest first. */
  pendingTurns(): (StoredTurn & { project: string })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, c.project AS project FROM turns t JOIN conversations c ON c.id = t.conversation_id
         WHERE t.state = 'pending' ORDER BY t.asked_at ASC LIMIT 1000`,
      )
      .all() as (TurnRow & { project: string })[];
    return rows.map((row) => ({ ...toTurn(row), project: row.project }));
  }

  /** Answered turns whose deadline passed since `since`: their runs should have ended by now. */
  answeredPastDeadline(now: number, since: number): (StoredTurn & { project: string })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, c.project AS project FROM turns t JOIN conversations c ON c.id = t.conversation_id
         WHERE t.state = 'answered' AND t.run_id IS NOT NULL AND t.deadline_at <= ? AND t.deadline_at > ? LIMIT 1000`,
      )
      .all(now, since) as (TurnRow & { project: string })[];
    return rows.map((row) => ({ ...toTurn(row), project: row.project }));
  }

  /** The answer, once: false when the turn is no longer pending. */
  answerTurn(turnId: string, answer: string, evidence: EvidenceItem[], at: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(`UPDATE turns SET state = 'answered', answer = ?, evidence = ?, answered_at = ? WHERE id = ? AND state = 'pending'`)
        .run(answer, evidence.length > 0 ? JSON.stringify(evidence) : null, at, turnId).changes;
      if (changed === 1) {
        this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = (SELECT conversation_id FROM turns WHERE id = ?)`).run(at, turnId);
      }
      return changed === 1;
    })();
  }

  /** No answer, with the reason: false when the turn is no longer pending. */
  closeTurn(turnId: string, reason: string, at: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(`UPDATE turns SET state = 'no_answer', reason = ? WHERE id = ? AND state = 'pending'`)
        .run(reason.slice(0, 1000), turnId).changes;
      if (changed === 1) {
        this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = (SELECT conversation_id FROM turns WHERE id = ?)`).run(at, turnId);
      }
      return changed === 1;
    })();
  }

  /** Update a turn's run_id to track a new run in the same chain (after agents module restarts it). */
  updateTurnRunId(turnId: string, runId: string): boolean {
    return this.db.prepare(`UPDATE turns SET run_id = ? WHERE id = ? AND state = 'pending'`).run(runId, turnId).changes === 1;
  }

  /** Supervisor runs a project started since `since` (questions and digests whose run was requested). */
  runsSince(project: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM turns t JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project = ? AND t.run_id IS NOT NULL AND t.asked_at > ?`,
      )
      .get(project, since) as { n: number };
    return row.n;
  }

  /** When the project's latest supervisor run was requested, or null. */
  lastRunAt(project: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(t.asked_at) AS at FROM turns t JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project = ? AND t.run_id IS NOT NULL`,
      )
      .get(project) as { at: number | null };
    return row.at;
  }

  /** The project's conversations of a kind, the latest first. */
  listConversations(project: string, kind: ConversationKind, limit = 20): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
           (SELECT question FROM turns t WHERE t.conversation_id = c.id ORDER BY seq ASC LIMIT 1) AS first_question,
           (SELECT state FROM turns t WHERE t.conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_state,
           (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count
         FROM conversations c WHERE c.project = ? AND c.kind = ? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`,
      )
      .all(project, kind, Math.min(Math.max(1, Math.floor(limit)), 100)) as (ConversationRow & {
      first_question: string | null;
      last_state: string | null;
      turn_count: number;
    })[];
    return rows.map((row): ConversationSummary => {
      const title = (row.first_question ?? "").replace(/\s+/g, " ").trim();
      return {
        id: row.id,
        kind: row.kind === "digest" ? "digest" : "chat",
        title: title.length > 120 ? `${title.slice(0, 120)}...` : title,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        turns: row.turn_count,
        state: row.last_state === "answered" || row.last_state === "no_answer" ? row.last_state : "pending",
      };
    });
  }

  digestFor(project: string, date: string): StoredConversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE project = ? AND digest_date = ?`).get(project, date) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  latestDigest(project: string): StoredConversation | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE project = ? AND kind = 'digest' ORDER BY digest_date DESC, created_at DESC LIMIT 1`)
      .get(project) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  /** Conversations not touched for 90 days, with their turns. */
  pruneConversations(now: number): void {
    const before = now - CONVERSATION_RETENTION_MS;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)`).run(before);
      this.db.prepare(`DELETE FROM conversations WHERE updated_at < ?`).run(before);
    })();
  }

  // ============ ACT AUDIT (S3) ============

  /** Record a supervisor acting operation */
  recordActAudit(entry: ActAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO act_audit (id, at, project, op, target, evidence, cleared_check_output, mode, result, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        new Date(entry.at).getTime(),
        entry.project.slice(0, 200),
        entry.op,
        entry.target.slice(0, 500),
        JSON.stringify(entry.evidence).slice(0, 5000),
        entry.clearedCheckOutput?.slice(0, 1000) ?? null,
        entry.mode,
        entry.result,
        entry.detail?.slice(0, 1000) ?? null,
      );
    // S3 fix: increment inserts so pruneActAudit runs correctly
    this.inserts++;
    this.pruneActAudit(new Date(entry.at).getTime());
  }

  /** Get recent act audit entries for a project */
  getActAuditHistory(project: string, limit = 20): ActAuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM act_audit WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(project, Math.min(Math.max(1, Math.floor(limit)), 100)) as ActAuditRow[];
    return rows.map(toActEntry);
  }

  /** Get counts of act audit entries for the UI. S3 fix: takes a clock parameter for testability. */
  getActCounts(project: string, now?: number): { wouldAct: number; acted: number; failed: number } {
    const hourAgo = (now ?? Date.now()) - 3600_000;
    const rows = this.db
      .prepare(
        `SELECT mode, result, COUNT(*) as count FROM act_audit
         WHERE project = ? AND at > ? GROUP BY mode, result`,
      )
      .all(project, hourAgo) as { mode: string; result: string; count: number }[];

    let wouldAct = 0;
    let acted = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.mode === "observe" && row.result === "success") wouldAct += row.count;
      else if (row.mode === "act" && row.result === "success") acted += row.count;
      else if (row.result === "failed") failed += row.count;
    }
    return { wouldAct, acted, failed };
  }

  /** Prune old act audit entries */
  private pruneActAudit(now: number): void {
    if (this.inserts % PRUNE_EVERY !== 0) return;
    this.db.prepare(`DELETE FROM act_audit WHERE at < ?`).run(now - RETENTION_MS);
    this.db
      .prepare(`DELETE FROM act_audit WHERE rowid NOT IN (SELECT rowid FROM act_audit ORDER BY at DESC, rowid DESC LIMIT ?)`)
      .run(MAX_ROWS);
    // M7: Also prune expired cooldowns
    this.db.prepare(`DELETE FROM act_cooldowns WHERE expires_at < ?`).run(now);
  }

  // ============ ACT COOLDOWNS (M7) ============

  /** Get all non-expired cooldowns for a project (M7: persist cooldowns across restart) */
  getActCooldowns(project: string): Array<{ key: string; expiresAt: number }> {
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT key, expires_at FROM act_cooldowns WHERE project = ? AND expires_at > ?`)
      .all(project, now) as Array<{ key: string; expires_at: number }>;
    return rows.map((r) => ({ key: r.key, expiresAt: r.expires_at }));
  }

  /** Set a cooldown for a key (M7: persist cooldowns) */
  setActCooldown(project: string, key: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO act_cooldowns (project, key, expires_at) VALUES (?, ?, ?)`,
      )
      .run(project, key.slice(0, 500), expiresAt);
  }

  /** Clear a specific cooldown (for testing) */
  clearActCooldown(project: string, key: string): void {
    this.db.prepare(`DELETE FROM act_cooldowns WHERE project = ? AND key = ?`).run(project, key);
  }
}

/** A supervisor acting audit entry */
export interface ActAuditEntry {
  id: string;
  at: string;
  project: string;
  op: string;
  target: string;
  evidence: string[];
  clearedCheckOutput: string;
  mode: "observe" | "act";
  result: "success" | "failed" | "skipped";
  detail: string;
}

interface ActAuditRow {
  id: string;
  at: number;
  project: string;
  op: string;
  target: string;
  evidence: string;
  cleared_check_output: string | null;
  mode: string;
  result: string;
  detail: string | null;
}

function toActEntry(row: ActAuditRow): ActAuditEntry {
  let evidence: string[] = [];
  try {
    evidence = JSON.parse(row.evidence);
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    project: row.project,
    op: row.op,
    target: row.target,
    evidence,
    clearedCheckOutput: row.cleared_check_output ?? "",
    mode: row.mode === "act" ? "act" : "observe",
    result: row.result === "success" ? "success" : row.result === "skipped" ? "skipped" : "failed",
    detail: row.detail ?? "",
  };
}


function toEntry(row: AuditRow): OpsAuditEntry {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    tokenId: row.token_id,
    who: row.who,
    tool: row.tool,
    args: row.args,
    outcome: row.outcome as OpsCallOutcome,
    detail: row.detail,
    durationMs: row.duration_ms,
  };
}
