/**
 * SQLite storage layer for lair-bus
 *
 * Uses sql.js (WebAssembly-based SQLite) for cross-platform compatibility.
 * Each project gets its own database file in data/<project>.db
 */
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type {
  AgentRecord,
  ClaimRecord,
  ReportRecord,
  MessageRecord,
  ReportKind,
} from "./types.js";

type SqlValue = string | number | null;
type SqlRow = SqlValue[];

let SQL: SqlJsStatic | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

/**
 * Storage class wrapping a SQLite database for one project
 */
export class BusStorage {
  private db: Database | null = null;
  private dbPath: string;
  private dirty = false;

  constructor(private project: string, dataDir: string) {
    // The project name becomes a file name: refuse anything that could leave dataDir
    if (
      typeof project !== "string" ||
      project.length === 0 ||
      project.startsWith(".") ||
      /[/\\\0]/.test(project)
    ) {
      throw new Error("Invalid bus project name");
    }
    this.dbPath = join(dataDir, `${project}.db`);
  }

  /**
   * Initialize the database (async because sql.js needs to load WASM)
   */
  async init(): Promise<void> {
    const sql = await getSql();

    // Load existing or create new
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new sql.Database(buffer);
    } else {
      // Ensure data directory exists
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new sql.Database();
    }

    // Create tables if they don't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        last_seen TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        released_at TEXT,
        UNIQUE(task, released_at)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_claims_active
      ON claims(task) WHERE released_at IS NULL
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        task TEXT NOT NULL,
        summary TEXT NOT NULL,
        gate_id TEXT,
        pr INTEGER,
        sha TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        created_at TEXT NOT NULL,
        read_at TEXT,
        ack_at TEXT,
        ack_note TEXT
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id)
    `);

    this.persist();
  }

  /**
   * Persist the database to disk
   */
  persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.dbPath, buffer);
    this.dirty = false;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.dirty) {
      this.persist();
    }
    this.db?.close();
    this.db = null;
  }

  // ============ Agent operations ============

  /**
   * Register or update an agent
   */
  upsertAgent(id: string, displayName?: string): void {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();
    this.db.run(
      `
      INSERT INTO agents (id, display_name, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        last_seen = excluded.last_seen
    `,
      [id, displayName ?? null, now],
    );
    this.dirty = true;
  }

  /**
   * Get an agent by ID
   */
  getAgent(id: string): AgentRecord | null {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec("SELECT * FROM agents WHERE id = ?", [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: row[0] as string,
      display_name: row[1] as string | null,
      last_seen: row[2] as string,
    };
  }

  /**
   * Get all agents
   */
  getAllAgents(): AgentRecord[] {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec("SELECT * FROM agents ORDER BY last_seen DESC");
    if (result.length === 0) return [];

    return result[0].values.map((row: SqlRow) => ({
      id: row[0] as string,
      display_name: row[1] as string | null,
      last_seen: row[2] as string,
    }));
  }

  // ============ Claim operations ============

  /**
   * Try to claim a task atomically
   * Returns the owner if claim succeeds, or the existing owner if someone else has it
   */
  tryClaim(task: string, agentId: string): { success: boolean; owner: string } {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();

    // Check for existing active claim
    const existing = this.db.exec(
      "SELECT owner_id FROM claims WHERE task = ? AND released_at IS NULL",
      [task],
    );

    if (existing.length > 0 && existing[0].values.length > 0) {
      const owner = existing[0].values[0][0] as string;
      if (owner === agentId) {
        return { success: true, owner: agentId };
      }
      return { success: false, owner };
    }

    // No existing claim, create one
    this.db.run(
      "INSERT INTO claims (task, owner_id, claimed_at) VALUES (?, ?, ?)",
      [task, agentId, now],
    );
    this.dirty = true;
    this.persist();

    return { success: true, owner: agentId };
  }

  /**
   * Release a task claim
   * Returns true if the agent owned the claim
   */
  releaseClaim(task: string, agentId: string): boolean {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();

    // Check ownership
    const existing = this.db.exec(
      "SELECT id FROM claims WHERE task = ? AND owner_id = ? AND released_at IS NULL",
      [task, agentId],
    );

    if (existing.length === 0 || existing[0].values.length === 0) {
      return false;
    }

    this.db.run(
      "UPDATE claims SET released_at = ? WHERE task = ? AND owner_id = ? AND released_at IS NULL",
      [now, task, agentId],
    );
    this.dirty = true;
    this.persist();

    return true;
  }

  /**
   * Get active claims for an agent
   */
  getAgentClaims(agentId: string): string[] {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec(
      "SELECT task FROM claims WHERE owner_id = ? AND released_at IS NULL",
      [agentId],
    );

    if (result.length === 0) return [];
    return result[0].values.map((row: SqlRow) => row[0] as string);
  }

  /**
   * Get all active claims
   */
  getAllActiveClaims(): ClaimRecord[] {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec(
      "SELECT id, task, owner_id, claimed_at, released_at FROM claims WHERE released_at IS NULL",
    );

    if (result.length === 0) return [];
    return result[0].values.map((row: SqlRow) => ({
      id: row[0] as number,
      task: row[1] as string,
      owner_id: row[2] as string,
      claimed_at: row[3] as string,
      released_at: row[4] as string | null,
    }));
  }

  // ============ Report operations ============

  /**
   * Create a new report
   */
  createReport(
    agentId: string,
    kind: ReportKind,
    task: string,
    summary: string,
    gateId?: string,
    pr?: number,
    sha?: string,
  ): number {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();

    // Get the next ID first by checking max
    const maxResult = this.db.exec("SELECT COALESCE(MAX(id), 0) FROM reports");
    const nextId = (maxResult[0].values[0][0] as number) + 1;

    this.db.run(
      `
      INSERT INTO reports (id, agent_id, kind, task, summary, gate_id, pr, sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [nextId, agentId, kind, task, summary, gateId ?? null, pr ?? null, sha ?? null, now],
    );
    this.dirty = true;
    this.persist();

    return nextId;
  }

  /**
   * Get latest report for each task
   */
  getLatestReportsByTask(): Map<string, ReportRecord> {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec(`
      SELECT r.* FROM reports r
      INNER JOIN (
        SELECT task, MAX(id) as max_id FROM reports GROUP BY task
      ) latest ON r.id = latest.max_id
    `);

    if (result.length === 0) return new Map();

    const map = new Map<string, ReportRecord>();
    for (const row of result[0].values) {
      const record: ReportRecord = {
        id: row[0] as number,
        agent_id: row[1] as string,
        kind: row[2] as ReportKind,
        task: row[3] as string,
        summary: row[4] as string,
        gate_id: row[5] as string | null,
        pr: row[6] as number | null,
        sha: row[7] as string | null,
        created_at: row[8] as string,
      };
      map.set(record.task, record);
    }
    return map;
  }

  // ============ Message operations ============

  /**
   * Send a message
   */
  sendMessage(
    fromId: string,
    toId: string,
    text: string,
    priority = 5,
  ): string {
    if (!this.db) throw new Error("Database not initialized");

    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    this.db.run(
      `
      INSERT INTO messages (id, from_id, to_id, text, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [id, fromId, toId, text, priority, now],
    );
    this.dirty = true;
    this.persist();

    return id;
  }

  /**
   * Get unread messages for an agent
   */
  getUnreadMessages(agentId: string): MessageRecord[] {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec(
      `
      SELECT id, from_id, to_id, text, priority, created_at, read_at, ack_at, ack_note
      FROM messages
      WHERE to_id = ? AND read_at IS NULL
      ORDER BY priority DESC, created_at ASC
    `,
      [agentId],
    );

    if (result.length === 0) return [];

    const now = new Date().toISOString();

    // Mark as read
    this.db.run("UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL", [
      now,
      agentId,
    ]);
    this.dirty = true;
    this.persist();

    return result[0].values.map((row: SqlRow) => ({
      id: row[0] as string,
      from_id: row[1] as string,
      to_id: row[2] as string,
      text: row[3] as string,
      priority: row[4] as number,
      created_at: row[5] as string,
      read_at: row[6] as string | null,
      ack_at: row[7] as string | null,
      ack_note: row[8] as string | null,
    }));
  }

  /**
   * Acknowledge a message
   */
  ackMessage(messageId: string, agentId: string, note?: string): boolean {
    if (!this.db) throw new Error("Database not initialized");

    // Verify the message is for this agent
    const existing = this.db.exec("SELECT to_id FROM messages WHERE id = ?", [
      messageId,
    ]);

    if (
      existing.length === 0 ||
      existing[0].values.length === 0 ||
      existing[0].values[0][0] !== agentId
    ) {
      return false;
    }

    const now = new Date().toISOString();
    this.db.run("UPDATE messages SET ack_at = ?, ack_note = ? WHERE id = ?", [
      now,
      note ?? null,
      messageId,
    ]);
    this.dirty = true;
    this.persist();

    return true;
  }

  /**
   * Get a message by ID
   */
  getMessage(messageId: string): MessageRecord | null {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.exec(
      `
      SELECT id, from_id, to_id, text, priority, created_at, read_at, ack_at, ack_note
      FROM messages WHERE id = ?
    `,
      [messageId],
    );

    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: row[0] as string,
      from_id: row[1] as string,
      to_id: row[2] as string,
      text: row[3] as string,
      priority: row[4] as number,
      created_at: row[5] as string,
      read_at: row[6] as string | null,
      ack_at: row[7] as string | null,
      ack_note: row[8] as string | null,
    };
  }
}
