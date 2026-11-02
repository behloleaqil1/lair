/**
 * The work store (docs/design/work-store.md §1-3): a project's tasks and the append-only timeline of what happened to
 * them, in its own SQLite file (data/work/<project>.db), owned by the Lair server only. WAL, a busy timeout, every
 * write in one transaction. The schema version lives in its own table (work_schema), never in PRAGMA user_version:
 * a file whose user_version is set, or that holds another store's tables, is refused, and so is one written by a
 * newer Lair; migration n brings a file from version n-1 to n, in one transaction with the version. `assigned` and
 * `running` are never stored: they follow the agents module's claims (§1.5, derived by the manager at read time).
 */
import Database from "better-sqlite3";
import { mkdir } from "fs/promises";
import { dirname } from "path";

export const WORK_SCHEMA_VERSION = 1;

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE work_schema (version INTEGER NOT NULL);
   CREATE TABLE work_tasks (
     project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL, agent TEXT, agent_name TEXT, priority INTEGER NOT NULL DEFAULT 500,
     source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, blocked_reason TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (project, id));
   CREATE INDEX work_tasks_state ON work_tasks(project, state, priority);
   CREATE INDEX work_tasks_agent ON work_tasks(project, agent) WHERE agent IS NOT NULL;
   CREATE TABLE work_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
     actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, actor_run_id TEXT, payload TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX work_events_task ON work_events(project, task_id, id);
   CREATE TABLE work_imports (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at INTEGER NOT NULL, actor_kind TEXT NOT NULL,
     actor_id TEXT NOT NULL, tasks_file_hash TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
     dropped INTEGER NOT NULL, warnings INTEGER NOT NULL);`,
];

export const STORED_STATES = ["open", "ready", "waiting", "blocked", "in_review", "done", "dropped"] as const;
export type StoredTaskState = (typeof STORED_STATES)[number];
/** `assigned` and `running` are derived from the claim (§1.5), never stored */
export type TaskState = StoredTaskState | "assigned" | "running";
export const TASK_STATES: readonly TaskState[] = [...STORED_STATES, "assigned", "running"];
export type WorkEventKind = "created" | "edited" | "state_changed" | "reopened" | "dropped";
const TERMINAL: readonly StoredTaskState[] = ["done", "dropped"];

/** Who did it: built by a route from the owner's session, or by a module in this process; never read from a body */
export interface WorkActor {
  kind: "owner" | "agent" | "module" | "system";
  id: string;
  runId?: string;
}

export interface WorkTask {
  id: string;
  project: string;
  title: string;
  description: string;
  state: StoredTaskState;
  /** The intended assignee (the tasks file's agent column), null for an unassigned line; never the holder */
  agent: string | null;
  agentName: string | null;
  priority: number;
  source: { kind: "import" | "planner" | "owner" | "intake"; ref: string };
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface WorkEvent {
  id: number;
  taskId: string;
  kind: WorkEventKind;
  actor: WorkActor;
  payload: Record<string, unknown>;
  at: number;
}

export interface WorkImportRecord {
  id: number;
  at: number;
  actor: WorkActor;
  tasksFileHash: string;
  created: number;
  updated: number;
  dropped: number;
  warnings: number;
}

/** One task as the configured files describe it (importer.ts); `reason` is the line that set the state (data) */
export interface FileTask {
  id: string;
  agent: string | null;
  agentName: string | null;
  description: string;
  state: "ready" | "waiting" | "blocked" | "done";
  line: number;
  reason: string | null;
}

/** The files' view: tasks in file order, and the ids on lines fill refuses (still in the file: never dropped) */
export interface FileSnapshot {
  tasks: FileTask[];
  kept: ReadonlySet<string>;
  tasksFileHash: string;
  warnings: number;
}

export interface SyncChange {
  task: string;
  kind: WorkEventKind;
  from?: StoredTaskState;
  to?: StoredTaskState;
  fields?: Record<string, { before: string | null; after: string | null }>;
}

/**
 * The repository interface (§3.2): domain operations, async so a Postgres implementation can follow without
 * touching callers. A change that spans several rows is one method, never a caller holding a transaction.
 */
export interface WorkStore {
  readonly schemaVersion: number;
  getTask(id: string): Promise<WorkTask | null>;
  listTasks(query: { states?: readonly StoredTaskState[]; agent?: string; limit: number }): Promise<WorkTask[]>;
  /** A task's events, newest first */
  timeline(taskId: string, limit: number): Promise<WorkEvent[]>;
  counts(): Promise<Partial<Record<StoredTaskState, number>>>;
  lastImport(): Promise<WorkImportRecord | null>;
  /** The files' view applied one way (§6.4): the diff, and unless dryRun its writes, in one transaction */
  syncFromFiles(files: FileSnapshot, options: { dryRun: boolean; actor: WorkActor; at: number }): Promise<{ changes: SyncChange[]; unchanged: number }>;
  close(): void;
}

export class WorkStoreError extends Error {}

/** A task's title from its description: the first line's first 200 characters, else the id */
export const titleOf = (description: string, id: string): string => description.split("\n")[0].trim().slice(0, 200) || id;

const TASK_COLUMNS = `id, project, title, description, state, agent, agent_name AS agentName, priority, source_kind AS sourceKind,
  source_ref AS sourceRef, blocked_reason AS blockedReason, created_at AS createdAt, updated_at AS updatedAt, version`;
type TaskRow = Omit<WorkTask, "source"> & { sourceKind: WorkTask["source"]["kind"]; sourceRef: string };
const taskOf = ({ sourceKind, sourceRef, ...rest }: TaskRow): WorkTask => ({ ...rest, source: { kind: sourceKind, ref: sourceRef } });

const actorOf = (kind: string, id: string, runId: string | null): WorkActor => ({ kind: kind as WorkActor["kind"], id, ...(runId ? { runId } : {}) });

export class SqliteWorkStore implements WorkStore {
  readonly schemaVersion = WORK_SCHEMA_VERSION;
  private readonly db: Database.Database;

  /** Opens (or creates) a project's store; its directory is made without blocking the event loop. */
  static async open(project: string, path: string): Promise<SqliteWorkStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
    return new SqliteWorkStore(project, path);
  }

  private constructor(
    readonly project: string,
    path: string,
  ) {
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  private migrate(): void {
    const userVersion = this.db.pragma("user_version", { simple: true }) as number;
    const tables = (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
    if (userVersion !== 0 || (tables.length > 0 && !tables.includes("work_schema"))) {
      throw new WorkStoreError(`this database belongs to another store (user_version ${userVersion}): the work store keeps its own file`);
    }
    const row = tables.length > 0 ? (this.db.prepare(`SELECT version FROM work_schema`).get() as { version: number } | undefined) : undefined;
    const current = row?.version ?? 0;
    if (current > WORK_SCHEMA_VERSION) {
      throw new WorkStoreError(`the work store was written by a newer Lair (schema ${current}, this one knows ${WORK_SCHEMA_VERSION}): update Lair, or move the file aside`);
    }
    for (let version = current + 1; version <= WORK_SCHEMA_VERSION; version++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version - 1]);
        this.db.prepare(`DELETE FROM work_schema`).run();
        this.db.prepare(`INSERT INTO work_schema (version) VALUES (?)`).run(version);
      })();
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  async getTask(id: string): Promise<WorkTask | null> {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM work_tasks WHERE project = ? AND id = ?`).get(this.project, id) as TaskRow | undefined;
    return row ? taskOf(row) : null;
  }

  async listTasks(query: { states?: readonly StoredTaskState[]; agent?: string; limit: number }): Promise<WorkTask[]> {
    const where = ["project = ?"];
    const params: (string | number)[] = [this.project];
    if (query.states && query.states.length > 0) {
      where.push(`state IN (${query.states.map(() => "?").join(", ")})`);
      params.push(...query.states);
    }
    if (query.agent) {
      where.push("agent = ?");
      params.push(query.agent);
    }
    const sql = `SELECT ${TASK_COLUMNS} FROM work_tasks WHERE ${where.join(" AND ")} ORDER BY priority, id LIMIT ?`;
    return (this.db.prepare(sql).all(...params, query.limit) as TaskRow[]).map(taskOf);
  }

  async timeline(taskId: string, limit: number): Promise<WorkEvent[]> {
    const rows = this.db
      .prepare(`SELECT id, task_id, kind, actor_kind, actor_id, actor_run_id, payload, at FROM work_events WHERE project = ? AND task_id = ? ORDER BY id DESC LIMIT ?`)
      .all(this.project, taskId, limit) as { id: number; task_id: string; kind: WorkEventKind; actor_kind: string; actor_id: string; actor_run_id: string | null; payload: string; at: number }[];
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, kind: r.kind, actor: actorOf(r.actor_kind, r.actor_id, r.actor_run_id), payload: JSON.parse(r.payload) as Record<string, unknown>, at: r.at }));
  }

  async counts(): Promise<Partial<Record<StoredTaskState, number>>> {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS n FROM work_tasks WHERE project = ? GROUP BY state`).all(this.project) as { state: StoredTaskState; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  async lastImport(): Promise<WorkImportRecord | null> {
    const row = this.db
      .prepare(`SELECT id, at, actor_kind AS kind, actor_id AS actorId, tasks_file_hash AS tasksFileHash, created, updated, dropped, warnings FROM work_imports WHERE project = ? ORDER BY id DESC LIMIT 1`)
      .get(this.project) as (Omit<WorkImportRecord, "actor"> & { kind: string; actorId: string }) | undefined;
    if (!row) return null;
    const { kind, actorId, ...rest } = row;
    return { ...rest, actor: actorOf(kind, actorId, null) };
  }

  async syncFromFiles(files: FileSnapshot, options: { dryRun: boolean; actor: WorkActor; at: number }): Promise<{ changes: SyncChange[]; unchanged: number }> {
    const { actor, at } = options;
    const insertEvent = this.db.prepare(`INSERT INTO work_events (project, task_id, kind, actor_kind, actor_id, actor_run_id, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const event = (task: string, kind: WorkEventKind, payload: Record<string, unknown>) =>
      insertEvent.run(this.project, task, kind, actor.kind, actor.id, actor.runId ?? null, JSON.stringify(payload), at);
    const insertTask = this.db.prepare(
      `INSERT INTO work_tasks (project, id, title, description, state, agent, agent_name, priority, source_kind, source_ref, blocked_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
    );
    const updateTask = this.db.prepare(
      `UPDATE work_tasks SET title = ?, description = ?, agent = ?, agent_name = ?, state = ?, blocked_reason = ?, priority = ?,
         source_ref = ?, updated_at = ?, version = version + ? WHERE project = ? AND id = ?`,
    );

    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM work_tasks WHERE project = ?`).all(this.project) as TaskRow[];
      const current = new Map(rows.map((r) => [r.id, taskOf(r)]));
      const changes: SyncChange[] = [];
      const writes: (() => void)[] = [];
      const seen = new Set<string>();
      files.tasks.forEach((t, i) => {
        seen.add(t.id);
        const priority = Math.min(i + 1, 999);
        const ref = `tasks_file:${t.line}`;
        const blocked = t.state === "blocked" ? t.reason : null;
        const old = current.get(t.id);
        if (!old) {
          changes.push({ task: t.id, kind: "created", to: t.state });
          writes.push(() => {
            insertTask.run(this.project, t.id, titleOf(t.description, t.id), t.description, t.state, t.agent, t.agentName, priority, ref, blocked, at, at);
            event(t.id, "created", { state: t.state, agent: t.agent, line: t.line, reason: t.reason });
          });
          return;
        }
        const fields: NonNullable<SyncChange["fields"]> = {};
        for (const [name, before, after] of [["agent", old.agent, t.agent], ["agentName", old.agentName, t.agentName], ["description", old.description, t.description]] as const) {
          if (before !== after) fields[name] = { before, after };
        }
        const edited = Object.keys(fields).length > 0;
        const moved = old.state !== t.state;
        const kind: WorkEventKind = TERMINAL.includes(old.state) && !TERMINAL.includes(t.state) ? "reopened" : "state_changed";
        if (edited) changes.push({ task: t.id, kind: "edited", fields });
        if (moved) changes.push({ task: t.id, kind, from: old.state, to: t.state });
        if (!edited && !moved && old.priority === priority && old.source.ref === ref) return;
        writes.push(() => {
          // A position change alone updates priority and the line quietly: no event, no new version
          const bump = edited || moved ? 1 : 0;
          updateTask.run(titleOf(t.description, t.id), t.description, t.agent, t.agentName, t.state, blocked, priority, ref, bump ? at : old.updatedAt, bump, this.project, t.id);
          if (edited) event(t.id, "edited", { fields });
          if (moved) event(t.id, kind, { from: old.state, to: t.state, line: t.line, reason: t.reason });
        });
      });
      for (const old of current.values()) {
        // Only what an import made, still open, gone from a file that was read, and not on a line fill refuses
        if (seen.has(old.id) || old.source.kind !== "import" || TERMINAL.includes(old.state) || files.kept.has(old.id)) continue;
        changes.push({ task: old.id, kind: "dropped", from: old.state, to: "dropped" });
        writes.push(() => {
          updateTask.run(old.title, old.description, old.agent, old.agentName, "dropped", null, old.priority, old.source.ref, at, 1, this.project, old.id);
          event(old.id, "dropped", { from: old.state, reason: "no longer in the tasks file" });
        });
      }
      const touched = (kinds: WorkEventKind[]) => new Set(changes.filter((c) => kinds.includes(c.kind)).map((c) => c.task));
      if (!options.dryRun) {
        for (const write of writes) write();
        // One audit row per import that changed something (a re-run that changes nothing leaves no row)
        if (changes.length > 0) {
          this.db
            .prepare(`INSERT INTO work_imports (project, at, actor_kind, actor_id, tasks_file_hash, created, updated, dropped, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.project, at, actor.kind, actor.id, files.tasksFileHash, touched(["created"]).size, touched(["edited", "state_changed", "reopened"]).size, touched(["dropped"]).size, files.warnings);
        }
      }
      const changed = touched(["created", "edited", "state_changed", "reopened", "dropped"]);
      return { changes, unchanged: files.tasks.filter((t) => !changed.has(t.id)).length };
    })();
  }
}
