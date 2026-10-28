/**
 * Bus store: the server-owned SQLite store for the fleet bus.
 *
 * One store per project, owned by the Lair server only:
 * - better-sqlite3 in WAL mode for concurrent reads
 * - Every write in a transaction
 * - Schema versioned with migrations
 * - Survives restarts
 *
 * This replaces the sql.js storage (src/bus/storage.ts) which had no locking
 * and each agent process held its own in-memory copy.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type { ReportKind } from "../../bus/types.js";
import type { BusTokenBinding } from "./tokens.js";

// ============ Schema ============

export const BUS_SCHEMA_VERSION = 1;

const BUS_SCHEMA = `
  -- Schema version
  CREATE TABLE IF NOT EXISTS bus_schema (
    version INTEGER PRIMARY KEY
  );
  INSERT OR IGNORE INTO bus_schema (version) VALUES (${BUS_SCHEMA_VERSION});

  -- Bus tokens: one per active run, stored as hash only
  CREATE TABLE IF NOT EXISTS bus_tokens (
    token_hash TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    run_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bus_tokens_run ON bus_tokens(project, run_id);
  CREATE INDEX IF NOT EXISTS idx_bus_tokens_agent ON bus_tokens(project, agent);

  -- Reports: task status updates from agents
  CREATE TABLE IF NOT EXISTS bus_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    agent TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    task TEXT NOT NULL,
    summary TEXT NOT NULL,
    gate_id TEXT,
    pr INTEGER,
    sha TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bus_reports_task ON bus_reports(project, task, created_at);
  CREATE INDEX IF NOT EXISTS idx_bus_reports_agent ON bus_reports(project, agent, created_at);

  -- Messages: sent between agents, orchestrator, and owner
  CREATE TABLE IF NOT EXISTS bus_messages (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    ack_at INTEGER,
    ack_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bus_messages_to ON bus_messages(project, to_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bus_messages_from ON bus_messages(project, from_id, created_at);
`;

// ============ Types ============

export interface BusReport {
  id: number;
  project: string;
  agent: string;
  runId: string;
  kind: ReportKind;
  task: string;
  summary: string;
  gateId: string | null;
  pr: number | null;
  sha: string | null;
  createdAt: number;
}

export interface BusMessage {
  id: string;
  project: string;
  fromId: string;
  toId: string;
  text: string;
  priority: number;
  createdAt: number;
  readAt: number | null;
  ackAt: number | null;
  ackNote: string | null;
}

export type MessageState = "sent" | "read" | "acknowledged";

export function messageState(msg: BusMessage): MessageState {
  if (msg.ackAt !== null) return "acknowledged";
  if (msg.readAt !== null) return "read";
  return "sent";
}

// ============ Row types ============

interface ReportRow {
  id: number;
  project: string;
  agent: string;
  run_id: string;
  kind: string;
  task: string;
  summary: string;
  gate_id: string | null;
  pr: number | null;
  sha: string | null;
  created_at: number;
}

interface MessageRow {
  id: string;
  project: string;
  from_id: string;
  to_id: string;
  text: string;
  priority: number;
  created_at: number;
  read_at: number | null;
  ack_at: number | null;
  ack_note: string | null;
}

interface TokenRow {
  token_hash: string;
  project: string;
  agent: string;
  run_id: string;
  issued_at: number;
  revoked_at: number | null;
}

function toReport(row: ReportRow): BusReport {
  return {
    id: row.id,
    project: row.project,
    agent: row.agent,
    runId: row.run_id,
    kind: row.kind as ReportKind,
    task: row.task,
    summary: row.summary,
    gateId: row.gate_id,
    pr: row.pr,
    sha: row.sha,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): BusMessage {
  return {
    id: row.id,
    project: row.project,
    fromId: row.from_id,
    toId: row.to_id,
    text: row.text,
    priority: row.priority,
    createdAt: row.created_at,
    readAt: row.read_at,
    ackAt: row.ack_at,
    ackNote: row.ack_note,
  };
}

function toTokenBinding(row: TokenRow): BusTokenBinding {
  return {
    project: row.project,
    agent: row.agent,
    runId: row.run_id,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
  };
}

// ============ Store ============

export class BusStore {
  private db: Database.Database;
  readonly project: string;

  constructor(project: string, dbPath: string) {
    this.project = project;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    // Run migrations
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bus_schema'").get();
    if (!row) {
      this.db.exec(BUS_SCHEMA);
      return;
    }
    // Future migrations would go here based on version
  }

  close(): void {
    this.db.close();
  }

  // ============ Tokens ============

  /** Issue a bus token for a run. Returns the binding (the token itself is given to the caller). */
  issueToken(agent: string, runId: string, tokenHash: string, at: number): BusTokenBinding {
    this.db
      .prepare(
        `INSERT INTO bus_tokens (token_hash, project, agent, run_id, issued_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, this.project, agent, runId, at);
    return { project: this.project, agent, runId, tokenHash, issuedAt: at };
  }

  /** Revoke a token (when a run ends). */
  revokeToken(tokenHash: string, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE bus_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .run(at, tokenHash);
    return result.changes > 0;
  }

  /** Revoke all tokens for a run. */
  revokeTokensForRun(runId: string, at: number): number {
    const result = this.db
      .prepare(`UPDATE bus_tokens SET revoked_at = ? WHERE project = ? AND run_id = ? AND revoked_at IS NULL`)
      .run(at, this.project, runId);
    return result.changes;
  }

  /** Validate a token: returns the binding if valid, null if invalid or revoked. */
  validateToken(tokenHash: string): BusTokenBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM bus_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(tokenHash) as TokenRow | undefined;
    return row ? toTokenBinding(row) : null;
  }

  /** Get the token binding for a run (if any active token exists). */
  getTokenForRun(runId: string): BusTokenBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM bus_tokens WHERE project = ? AND run_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`)
      .get(this.project, runId) as TokenRow | undefined;
    return row ? toTokenBinding(row) : null;
  }

  // ============ Reports ============

  /** Create a report. Returns the report id. */
  createReport(
    agent: string,
    runId: string,
    kind: ReportKind,
    task: string,
    summary: string,
    at: number,
    gateId?: string,
    pr?: number,
    sha?: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO bus_reports (project, agent, run_id, kind, task, summary, gate_id, pr, sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.project, agent, runId, kind, task, summary, gateId ?? null, pr ?? null, sha ?? null, at);
    return Number(result.lastInsertRowid);
  }

  /** Get a report by id. */
  getReport(id: number): BusReport | null {
    const row = this.db.prepare(`SELECT * FROM bus_reports WHERE id = ?`).get(id) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  /** Get the latest report for a task. */
  getLatestReportForTask(task: string): BusReport | null {
    const row = this.db
      .prepare(`SELECT * FROM bus_reports WHERE project = ? AND task = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(this.project, task) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  /** Get latest reports for all tasks (one per task). */
  getLatestReportsByTask(): Map<string, BusReport> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM bus_reports r
         INNER JOIN (
           SELECT task, MAX(id) as max_id FROM bus_reports WHERE project = ? GROUP BY task
         ) latest ON r.id = latest.max_id`,
      )
      .all(this.project) as ReportRow[];
    const map = new Map<string, BusReport>();
    for (const row of rows) {
      map.set(row.task, toReport(row));
    }
    return map;
  }

  /** List recent reports. */
  listReports(options: { task?: string; agent?: string; limit?: number } = {}): BusReport[] {
    const where = ["project = ?"];
    const params: (string | number)[] = [this.project];
    if (options.task) {
      where.push("task = ?");
      params.push(options.task);
    }
    if (options.agent) {
      where.push("agent = ?");
      params.push(options.agent);
    }
    params.push(options.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM bus_reports WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params) as ReportRow[];
    return rows.map(toReport);
  }

  // ============ Messages ============

  /** Send a message. Returns the message id. */
  sendMessage(fromId: string, toId: string, text: string, priority: number, at: number): string {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO bus_messages (id, project, from_id, to_id, text, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.project, fromId, toId, text, priority, at);
    return id;
  }

  /** Get a message by id. */
  getMessage(id: string): BusMessage | null {
    const row = this.db.prepare(`SELECT * FROM bus_messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** Get unread messages for an agent (and mark them as read). */
  getUnreadMessages(agentId: string, at: number): BusMessage[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM bus_messages
           WHERE project = ? AND to_id = ? AND read_at IS NULL
           ORDER BY priority DESC, created_at ASC`,
        )
        .all(this.project, agentId) as MessageRow[];

      if (rows.length > 0) {
        this.db
          .prepare(`UPDATE bus_messages SET read_at = ? WHERE project = ? AND to_id = ? AND read_at IS NULL`)
          .run(at, this.project, agentId);
      }

      return rows.map(toMessage);
    });
    return tx();
  }

  /** Acknowledge a message. Returns true if the message was for this agent and not already acked. */
  ackMessage(messageId: string, agentId: string, note: string | undefined, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE bus_messages SET ack_at = ?, ack_note = ? WHERE id = ? AND to_id = ? AND ack_at IS NULL`)
      .run(at, note ?? null, messageId, agentId);
    return result.changes > 0;
  }

  /** List messages for an agent (sent or received). */
  listMessages(agentId: string, options: { direction?: "sent" | "received"; limit?: number } = {}): BusMessage[] {
    const where = ["project = ?"];
    const params: (string | number)[] = [this.project];
    if (options.direction === "sent") {
      where.push("from_id = ?");
      params.push(agentId);
    } else if (options.direction === "received") {
      where.push("to_id = ?");
      params.push(agentId);
    } else {
      where.push("(from_id = ? OR to_id = ?)");
      params.push(agentId, agentId);
    }
    params.push(options.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM bus_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Count unread messages for an agent. */
  countUnread(agentId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM bus_messages WHERE project = ? AND to_id = ? AND read_at IS NULL`)
      .get(this.project, agentId) as { n: number };
    return row.n;
  }
}

// ============ Store management ============

const stores = new Map<string, BusStore>();

/** Get or create a bus store for a project. */
export function getBusStore(project: string, dataDir: string): BusStore {
  const key = `${dataDir}:${project}`;
  let store = stores.get(key);
  if (!store) {
    const dbPath = join(dataDir, "bus", `${project}.db`);
    store = new BusStore(project, dbPath);
    stores.set(key, store);
  }
  return store;
}

/** Close all bus stores. */
export function closeBusStores(): void {
  for (const store of stores.values()) {
    store.close();
  }
  stores.clear();
}
