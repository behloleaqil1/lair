/**
 * What the tracker remembers: facts (codes and ids) taken from events on the
 * bus, kept in its own SQLite file (data/outcomes.db) so a restart in the
 * middle of a window loses nothing. It only reads events; nothing here
 * calls into the modules that raised them.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Event } from "../../shared/server-types.js";
import type { Fact, FactCode, FactView } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    project TEXT NOT NULL,
    code TEXT NOT NULL,
    task TEXT,
    family TEXT,
    pr INTEGER,
    sha TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facts_project_at ON facts(project, at);
  CREATE INDEX IF NOT EXISTS idx_facts_at ON facts(at);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface FactRow {
  at: string;
  project: string;
  code: string;
  task: string | null;
  family: string | null;
  pr: number | null;
  sha: string | null;
}

export class FactLog implements FactView {
  private db: Database.Database;

  /** `dbPath` may be ":memory:" */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  add(fact: Fact): void {
    this.db
      .prepare(`INSERT INTO facts (at, project, code, task, family, pr, sha) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(fact.at, fact.project, fact.code, fact.task ?? null, fact.family ?? null, fact.pr ?? null, fact.sha ?? null);
  }

  between(project: string, from: string, to: string): Fact[] {
    const rows = this.db
      .prepare(`SELECT at, project, code, task, family, pr, sha FROM facts WHERE project = ? AND at > ? AND at <= ? ORDER BY at, id`)
      .all(project, from, to) as FactRow[];
    return rows.map((r) => ({
      at: r.at,
      project: r.project,
      code: r.code as FactCode,
      ...(r.task !== null ? { task: r.task } : {}),
      ...(r.family !== null ? { family: r.family } : {}),
      ...(r.pr !== null ? { pr: r.pr } : {}),
      ...(r.sha !== null ? { sha: r.sha } : {}),
    }));
  }

  /**
   * When the tracker first ran (ISO-8601), written on the first call and kept after. Answers given before it have no
   * facts and a closed window: they are left alone, never stamped unknown for ever.
   */
  enabledSince(now: string): string {
    this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('enabled_since', ?)`).run(now);
    return (this.db.prepare(`SELECT value FROM meta WHERE key = 'enabled_since'`).get() as { value: string }).value;
  }

  /** Forget facts older than `before` (ISO-8601). */
  prune(before: string): number {
    return this.db.prepare(`DELETE FROM facts WHERE at < ?`).run(before).changes;
  }
}

const TASK_REF = /^[a-z][a-z-]*:[^:]{1,100}:task:(.{1,200})$/;
const FAILED_KINDS = new Set(["crashed", "dead_on_start", "hung", "exit_unknown", "lost_claim", "never_started"]);

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** The task a decision waits on, from the refs it blocks (`<module>:<project>:task:<task>`). */
export function taskOfRefs(blocks: readonly string[]): string | null {
  return tasksOfRefs(blocks)[0] ?? null;
}

/** Every task a decision waits on (a provider outage holds up to 50). */
export function tasksOfRefs(blocks: readonly string[]): string[] {
  const tasks: string[] = [];
  for (const ref of blocks) {
    const m = TASK_REF.exec(ref);
    if (m && !tasks.includes(m[1])) tasks.push(m[1]);
  }
  return tasks;
}

/** The cause of a hold: the module and the ref the decision is about (`signin:<tool>`, `transient:<provider>`, `chain:<id>`). */
export function holdFamily(module: string, ref: string): string {
  return `${module}/${ref}`;
}

/** The facts an event stands for (none for events the rules do not use). Fields of the wrong type are ignored. */
export function factsFromEvent(event: Event): Fact[] {
  const d = event.data;
  const project = text(d.project, 100);
  if (!project) return [];
  const at = event.timestamp;
  const task = text(d.task);
  const base = { at, project, ...(task ? { task } : {}) };
  switch (event.type) {
    case "agent.recovery": {
      const kind = d.kind;
      if (typeof kind === "string" && FAILED_KINDS.has(kind)) return task ? [{ ...base, code: "task_failed" }] : [];
      if (kind === "escalated") return task ? [{ ...base, code: "task_paused" }] : [];
      return [];
    }
    case "agent.run.started":
      return task ? [{ ...base, code: "run_started" }] : [];
    case "agent.run.ended":
      return task ? [{ ...base, code: "run_completed" }] : [];
    case "decision.raised": {
      const module = text(d.module, 60);
      const cause = text(d.ref);
      // With no usable cause, nothing can say it was the same hold again
      if (!module || !cause) return [];
      const blocks = Array.isArray(d.blocks) ? d.blocks.filter((b): b is string => typeof b === "string") : [];
      const of = taskOfRefs(blocks);
      return [{ at, project, code: "hold_raised", family: holdFamily(module, cause), ...(of ? { task: of } : {}) }];
    }
    case "planner.changed": {
      if (d.outcome !== "applied" || !task) return [];
      const codes: Record<string, FactCode> = { add: "task_added", drop: "task_dropped", reword: "task_reworded", mark_done: "task_done" };
      const code = typeof d.op === "string" ? codes[d.op] : undefined;
      return code ? [{ ...base, code }] : [];
    }
    case "review.merged": {
      const pr = typeof d.pr === "number" && Number.isSafeInteger(d.pr) ? d.pr : null;
      const sha = text(d.resultSha, 64);
      return pr !== null && sha ? [{ at, project, code: "merged", pr, sha }] : [];
    }
    // A revert that was only requested may be declined or fail: it is not a fact. Only a proven culprit counts.
    case "triage.culprit_found": {
      const sha = text(d.sha, 64);
      return sha ? [{ at, project, code: "default_red", sha }] : [];
    }
    default:
      return [];
  }
}
