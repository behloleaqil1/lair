/**
 * The lessons store (data/lessons.db): lessons Lair has learned from
 * incidents, escalations, and operational experience. Each lesson has
 * a signal (how to detect), a cause, a response, and prevention.
 *
 * Built-in lessons (L1-L25) ship with Lair and are loaded on start.
 * Project lessons are proposed by incidents and approved by the owner.
 *
 * SQLite, so it survives a restart; lessons are never deleted, only
 * retired.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type {
  Lesson,
  LessonScope,
  LessonSignal,
  LessonSource,
  LessonStatus,
  LessonSummary,
} from "../../shared/lessons-types.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    signal TEXT NOT NULL,
    cause TEXT NOT NULL,
    response TEXT NOT NULL,
    prevention TEXT NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    scope TEXT NOT NULL DEFAULT 'project',
    match_count INTEGER NOT NULL DEFAULT 0,
    last_match_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    feature TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
  CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope);
  CREATE INDEX IF NOT EXISTS idx_lessons_signal ON lessons(json_extract(signal, '$.kind'), json_extract(signal, '$.value'));
`;

interface LessonRow {
  id: string;
  title: string;
  signal: string;
  cause: string;
  response: string;
  prevention: string;
  sources: string;
  status: string;
  scope: string;
  match_count: number;
  last_match_at: number | null;
  created_at: number;
  updated_at: number;
  feature: string | null;
  version: number;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function parseSignal(text: string): LessonSignal {
  try {
    return JSON.parse(text) as LessonSignal;
  } catch {
    return { kind: "check", value: "unknown" };
  }
}

function parseSources(text: string): LessonSource[] {
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? (arr as LessonSource[]) : [];
  } catch {
    return [];
  }
}

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    title: row.title,
    signal: parseSignal(row.signal),
    cause: row.cause,
    response: row.response,
    prevention: row.prevention,
    sources: parseSources(row.sources),
    status: row.status as LessonStatus,
    scope: row.scope as LessonScope,
    matchCount: row.match_count,
    lastMatchAt: iso(row.last_match_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    feature: row.feature,
    version: row.version,
  };
}

function toSummary(row: LessonRow): LessonSummary {
  return {
    id: row.id,
    title: row.title,
    signal: parseSignal(row.signal),
    status: row.status as LessonStatus,
    scope: row.scope as LessonScope,
    matchCount: row.match_count,
    lastMatchAt: iso(row.last_match_at),
    createdAt: iso(row.created_at)!,
  };
}

export interface LessonInput {
  id?: string;
  title: string;
  signal: LessonSignal;
  cause: string;
  response: string;
  prevention: string;
  sources?: LessonSource[];
  status?: LessonStatus;
  scope?: LessonScope;
  feature?: string | null;
  version?: number;
}

export class LessonsStore {
  private db: Database.Database;

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

  /** Add a lesson (built-in or project). Skips if the id already exists. Returns the id if added, null otherwise. */
  add(input: LessonInput, now: number): string | null {
    const id = input.id ?? randomUUID();
    const existing = this.get(id);
    if (existing) return null;

    this.db
      .prepare(
        `INSERT INTO lessons (id, title, signal, cause, response, prevention, sources, status, scope, created_at, updated_at, feature, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title.slice(0, 500),
        JSON.stringify(input.signal),
        input.cause.slice(0, 2000),
        input.response.slice(0, 2000),
        input.prevention.slice(0, 2000),
        JSON.stringify(input.sources ?? []),
        input.status ?? "proposed",
        input.scope ?? "project",
        now,
        now,
        input.feature ?? null,
        input.version ?? 1,
      );
    return id;
  }

  /** Get a lesson by id */
  get(id: string): Lesson | null {
    const row = this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id) as LessonRow | undefined;
    return row ? toLesson(row) : null;
  }

  /** List lessons, optionally filtered by status or scope */
  list(options?: { status?: LessonStatus; scope?: LessonScope; limit?: number }): LessonSummary[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options?.scope) {
      conditions.push("scope = ?");
      params.push(options.scope);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(1, Math.floor(options?.limit ?? 500)), 1000);
    params.push(limit);
    const rows = this.db.prepare(`SELECT * FROM lessons ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as LessonRow[];
    return rows.map(toSummary);
  }

  /** Count lessons by status */
  counts(): { total: number; active: number; proposed: number; retired: number; builtIn: number; project: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed,
           SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) AS retired,
           SUM(CASE WHEN scope = 'built-in' THEN 1 ELSE 0 END) AS built_in,
           SUM(CASE WHEN scope = 'project' THEN 1 ELSE 0 END) AS project
         FROM lessons`,
      )
      .get() as { total: number; active: number; proposed: number; retired: number; built_in: number; project: number };
    return {
      total: row.total,
      active: row.active,
      proposed: row.proposed,
      retired: row.retired,
      builtIn: row.built_in,
      project: row.project,
    };
  }

  /** Update a lesson's fields (owner only) */
  update(
    id: string,
    fields: {
      title?: string;
      signal?: LessonSignal;
      cause?: string;
      response?: string;
      prevention?: string;
      status?: LessonStatus;
      feature?: string | null;
      version?: number;
    },
    now: number,
  ): boolean {
    const updates: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];
    if (fields.title !== undefined) {
      updates.push("title = ?");
      params.push(fields.title.slice(0, 500));
    }
    if (fields.signal !== undefined) {
      updates.push("signal = ?");
      params.push(JSON.stringify(fields.signal));
    }
    if (fields.cause !== undefined) {
      updates.push("cause = ?");
      params.push(fields.cause.slice(0, 2000));
    }
    if (fields.response !== undefined) {
      updates.push("response = ?");
      params.push(fields.response.slice(0, 2000));
    }
    if (fields.prevention !== undefined) {
      updates.push("prevention = ?");
      params.push(fields.prevention.slice(0, 2000));
    }
    if (fields.status !== undefined) {
      updates.push("status = ?");
      params.push(fields.status);
    }
    if (fields.feature !== undefined) {
      updates.push("feature = ?");
      params.push(fields.feature);
    }
    if (fields.version !== undefined) {
      updates.push("version = ?");
      params.push(fields.version);
    }
    params.push(id);
    return this.db.prepare(`UPDATE lessons SET ${updates.join(", ")} WHERE id = ?`).run(...params).changes === 1;
  }

  /** Record a signal match */
  recordMatch(id: string, now: number): boolean {
    return (
      this.db.prepare(`UPDATE lessons SET match_count = match_count + 1, last_match_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id).changes ===
      1
    );
  }

  /** Add a source to a lesson's sources array */
  addSource(id: string, source: LessonSource, now: number): boolean {
    const lesson = this.get(id);
    if (!lesson) return false;
    const sources = [...lesson.sources, source];
    return (
      this.db.prepare(`UPDATE lessons SET sources = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(sources), now, id).changes === 1
    );
  }

  /** Find lessons matching a signal (by kind and value) */
  findBySignal(kind: LessonSignal["kind"], value: string): Lesson[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lessons
         WHERE json_extract(signal, '$.kind') = ?
         AND json_extract(signal, '$.value') = ?
         ORDER BY match_count DESC, created_at DESC
         LIMIT 10`,
      )
      .all(kind, value) as LessonRow[];
    return rows.map(toLesson);
  }

  /** Find active lessons whose signals match a given check id or event type */
  activeBySignalValue(value: string): Lesson[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lessons
         WHERE status = 'active'
         AND json_extract(signal, '$.value') = ?
         ORDER BY match_count DESC
         LIMIT 20`,
      )
      .all(value) as LessonRow[];
    return rows.map(toLesson);
  }

  /** Check if any built-in lessons exist */
  hasBuiltIn(): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE scope = 'built-in' LIMIT 1`).get() as { n: number };
    return row.n > 0;
  }
}
