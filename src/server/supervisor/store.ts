/**
 * The supervisor's store (data/supervisor.db): the audit of every ops API
 * call (who, when, the tool, a redacted summary of its arguments, and how it
 * ended) and of every token minted or revoked. Never a token. SQLite, so it
 * survives a restart; rows older than 30 days, and past the newest 50,000,
 * are pruned as new ones come.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { OpsAuditEntry, OpsCallOutcome } from "../../shared/supervisor-types.js";

// 1: ops_audit
const SCHEMA_VERSION = 1;

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
`;

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
  }
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
