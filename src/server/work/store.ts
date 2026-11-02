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
import type { ReportKind } from "../../bus/types.js";

export const WORK_SCHEMA_VERSION = 2;

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
  // v2 (work store 2): the consumer's position in each source of facts, moved in the transaction that applies them
  `CREATE TABLE work_cursors (
     project TEXT NOT NULL, source TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (project, source));`,
];

export const STORED_STATES = ["open", "ready", "waiting", "blocked", "in_review", "done", "dropped"] as const;
export type StoredTaskState = (typeof STORED_STATES)[number];
/** `assigned` and `running` are derived from the claim (§1.5), never stored */
export type TaskState = StoredTaskState | "assigned" | "running";
export const TASK_STATES: readonly TaskState[] = [...STORED_STATES, "assigned", "running"];
export type WorkEventKind = "created" | "edited" | "state_changed" | "reopened" | "dropped" | "report" | "started" | "ended" | "claim_released";
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

/**
 * One task as the configured files describe it (importer.ts); `reason` is the line that set the state (data).
 * `claimed`: a run or a claim holds the task, so the files say nothing new about its state: the stored state is kept
 * (a new task is stored ready, a dropped one back in the file is reopened ready), and the read model shows the holder.
 */
export interface FileTask {
  id: string;
  agent: string | null;
  agentName: string | null;
  description: string;
  state: "ready" | "waiting" | "blocked" | "done" | "claimed";
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

export interface SyncResult {
  changes: SyncChange[];
  unchanged: number;
  /** Tasks in the file that the planner or the owner made: the files never change them */
  skipped: string[];
}

/** Where the consumer reads facts: the project's bus reports (by report id) and the agents store's events (by row) */
export type FactSource = "bus.report" | "agents.event";
export type Cursors = Partial<Record<FactSource, number>>;

/** A bus report (bus/store.ts) to apply to its task */
export interface ReportFact {
  source: "bus.report";
  id: number;
  at: number;
  task: string;
  agent: string;
  runId: string;
  kind: ReportKind;
  summary: string;
  gateId: string | null;
  pr: number | null;
  sha: string | null;
  /** DONE only: fill's ready guard accepts it (a refused DONE is recorded and changes no state) */
  accepted: boolean;
}

/** A claim fact from the agents store's events: a run started, a run ended, a claim was released */
export interface ClaimFact {
  source: "agents.event";
  /** The event's row in the agents store: the cursor's position */
  id: number;
  /** The event's own id: a fact already on the task's timeline is not applied again, whatever its row */
  eventId: string;
  at: number;
  task: string;
  agent: string | null;
  runId: string | null;
  kind: "started" | "completed" | "claim_released";
  /** started only: the run is still the task's live run (a replayed start of a run that has ended moves nothing) */
  live: boolean;
}

export type WorkFact = ReportFact | ClaimFact;

/** A cursor moved with the facts it covers: nothing is applied when another drain moved it first */
export interface CursorMove {
  source: FactSource;
  from: number;
  to: number;
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
  /**
   * The files' view applied one way (§6.4): the diff, and unless dryRun its writes, in one transaction. Only tasks an
   * import made follow the files. `cursors` (an applied import) start the consumer's missing cursors in it.
   */
  syncFromFiles(files: FileSnapshot, options: { dryRun: boolean; actor: WorkActor; at: number; cursors?: Cursors }): Promise<SyncResult>;
  /** The owner adopted the store: an import was applied, or the consumer has a cursor */
  adopted(): Promise<boolean>;
  cursors(): Promise<Cursors>;
  /** Start missing cursors at these positions (one that exists is kept) */
  initCursors(cursors: Cursors, at: number): Promise<void>;
  /** Facts applied in order with their cursor moves, in one transaction; nothing when a cursor moved meanwhile */
  applyFacts(facts: readonly WorkFact[], moves: readonly CursorMove[], at: number): Promise<{ moved: boolean; applied: number; skipped: number }>;
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

const CLAIM_EVENTS = { started: "started", completed: "ended", claim_released: "claim_released" } as const;

/** A blocked task's reason (1-500 characters, §2.1): a BLOCKED report's summary, or the BLOCKED line that set it */
export const reportReason = (text: string): string => (text.trim() || "reported BLOCKED").slice(0, 500);

/** The state a fact moves a task to, or null: terminal tasks and PROGRESS, TICK, a refused DONE and claim ends move nothing */
function factState(task: WorkTask, fact: WorkFact): { state: StoredTaskState; reason: string | null } | null {
  if (TERMINAL.includes(task.state)) return null;
  if (fact.source === "agents.event") {
    // A live run started on a waiting or blocked task: it works on it again (the read model shows it running)
    return fact.kind === "started" && fact.live && (task.state === "waiting" || task.state === "blocked") ? { state: "ready", reason: null } : null;
  }
  if (fact.kind === "WAITING") return { state: "waiting", reason: null };
  if (fact.kind === "BLOCKED") return { state: "blocked", reason: reportReason(fact.summary) };
  return fact.kind === "DONE" && fact.accepted ? { state: "done", reason: null } : null;
}

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
    if (tables.length > 0 && !row) {
      throw new WorkStoreError("the work store's schema table is empty (its first write was cut off?): move the file aside and import again");
    }
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

  async adopted(): Promise<boolean> {
    const has = (table: string) => this.db.prepare(`SELECT 1 FROM ${table} WHERE project = ? LIMIT 1`).get(this.project) !== undefined;
    return has("work_cursors") || has("work_imports");
  }

  async cursors(): Promise<Cursors> {
    const rows = this.db.prepare(`SELECT source, position FROM work_cursors WHERE project = ?`).all(this.project) as { source: FactSource; position: number }[];
    return Object.fromEntries(rows.map((r) => [r.source, r.position]));
  }

  async initCursors(cursors: Cursors, at: number): Promise<void> {
    this.db.transaction(() => this.insertCursors(cursors, at))();
  }

  private insertCursors(cursors: Cursors, at: number): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO work_cursors (project, source, position, updated_at) VALUES (?, ?, ?, ?)`);
    for (const [source, position] of Object.entries(cursors)) insert.run(this.project, source, position, at);
  }

  private eventWriter(at: number) {
    const insert = this.db.prepare(`INSERT INTO work_events (project, task_id, kind, actor_kind, actor_id, actor_run_id, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    return (task: string, kind: WorkEventKind, payload: Record<string, unknown>, actor: WorkActor, when = at) =>
      insert.run(this.project, task, kind, actor.kind, actor.id, actor.runId ?? null, JSON.stringify(payload), when);
  }

  async applyFacts(facts: readonly WorkFact[], moves: readonly CursorMove[], at: number): Promise<{ moved: boolean; applied: number; skipped: number }> {
    const event = this.eventWriter(at);
    const getRow = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM work_tasks WHERE project = ? AND id = ?`);
    const setState = this.db.prepare(`UPDATE work_tasks SET state = ?, blocked_reason = ?, updated_at = ?, version = version + 1 WHERE project = ? AND id = ?`);
    const position = this.db.prepare(`SELECT position FROM work_cursors WHERE project = ? AND source = ?`);
    const move = this.db.prepare(`UPDATE work_cursors SET position = ?, updated_at = ? WHERE project = ? AND source = ?`);
    // A run or claim fact already on the task's timeline (its row was renumbered under the cursor): not applied again
    const seenFact = this.db.prepare(`SELECT 1 FROM work_events WHERE project = ? AND task_id = ? AND kind = ? AND json_extract(payload, '$.eventId') = ? LIMIT 1`);
    return this.db.transaction(() => {
      // Every cursor where this drain read it, or nothing: a fact is applied once, with the cursor that covers it
      if (moves.some((m) => (position.get(this.project, m.source) as { position: number } | undefined)?.position !== m.from)) return { moved: false, applied: 0, skipped: 0 };
      for (const m of moves) move.run(m.to, at, this.project, m.source);
      let applied = 0;
      let skipped = 0;
      for (const fact of facts) {
        const row = getRow.get(this.project, fact.task) as TaskRow | undefined;
        // Not a task of the store (yet): the follower imports it from the files
        const again = row !== undefined && fact.source === "agents.event" && seenFact.get(this.project, fact.task, CLAIM_EVENTS[fact.kind], fact.eventId) !== undefined;
        if (!row || again) {
          skipped++;
          continue;
        }
        const task = taskOf(row);
        applied++;
        // The agent that reported, or the agents module for its runs and claims (never a field of the fact's text)
        const actor: WorkActor =
          fact.source === "bus.report" ? { kind: "agent", id: fact.agent, runId: fact.runId } : { kind: "module", id: "agents", ...(fact.runId ? { runId: fact.runId } : {}) };
        const cause = fact.source === "bus.report" ? { busId: fact.id } : { eventSeq: fact.id, eventId: fact.eventId };
        if (fact.source === "bus.report") {
          const refused = fact.kind === "DONE" && !fact.accepted ? { refused: "fill's ready guard does not accept it now" } : {};
          event(task.id, "report", { ...cause, kind: fact.kind, summary: fact.summary.slice(0, 300), gateId: fact.gateId, pr: fact.pr, sha: fact.sha, ...refused }, actor, fact.at);
        } else {
          event(task.id, CLAIM_EVENTS[fact.kind], { ...cause, agent: fact.agent }, actor, fact.at);
        }
        const next = factState(task, fact);
        if (!next || (next.state === task.state && next.reason === task.blockedReason)) continue;
        setState.run(next.state, next.reason, at, this.project, task.id);
        if (next.state === task.state) event(task.id, "edited", { ...cause, fields: { blockedReason: { before: task.blockedReason, after: next.reason } } }, actor, fact.at);
        else event(task.id, "state_changed", { ...cause, from: task.state, to: next.state, reason: next.reason }, actor, fact.at);
      }
      return { moved: true, applied, skipped };
    })();
  }

  async syncFromFiles(files: FileSnapshot, options: { dryRun: boolean; actor: WorkActor; at: number; cursors?: Cursors }): Promise<SyncResult> {
    const { actor, at } = options;
    const write = this.eventWriter(at);
    const event = (task: string, kind: WorkEventKind, payload: Record<string, unknown>) => write(task, kind, payload, actor);
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
      const skipped = new Map<string, string>();
      files.tasks.forEach((t, i) => {
        seen.add(t.id);
        // `files: follow` follows what an import made: a task the planner or the owner made is theirs (§6.4)
        const source = current.get(t.id)?.source.kind ?? "import";
        if (source !== "import") {
          skipped.set(t.id, `${t.id}: made by the ${source}, so the files do not change it`);
          return;
        }
        const priority = Math.min(i + 1, 999);
        const ref = `tasks_file:${t.line}`;
        const old = current.get(t.id);
        // A claimed task keeps its stored state (the run reports it); dropped and back in the file, it is ready again
        const state: StoredTaskState = t.state !== "claimed" ? t.state : old && old.state !== "dropped" ? old.state : "ready";
        const blocked = state !== "blocked" ? null : t.state === "claimed" ? (old?.blockedReason ?? null) : t.reason;
        if (!old) {
          changes.push({ task: t.id, kind: "created", to: state });
          writes.push(() => {
            insertTask.run(this.project, t.id, titleOf(t.description, t.id), t.description, state, t.agent, t.agentName, priority, ref, blocked, at, at);
            event(t.id, "created", { state, agent: t.agent, line: t.line, reason: t.reason });
          });
          return;
        }
        const moved = old.state !== state;
        const fields: NonNullable<SyncChange["fields"]> = {};
        const compared: [string, string | null, string | null][] = [["agent", old.agent, t.agent], ["agentName", old.agentName, t.agentName], ["description", old.description, t.description]];
        // Still blocked, for another reason: an edit (a new state carries its reason on the state_changed event)
        if (!moved) compared.push(["blockedReason", old.blockedReason, blocked]);
        for (const [name, before, after] of compared) {
          if (before !== after) fields[name] = { before, after };
        }
        const edited = Object.keys(fields).length > 0;
        const kind: WorkEventKind = TERMINAL.includes(old.state) && !TERMINAL.includes(state) ? "reopened" : "state_changed";
        if (edited) changes.push({ task: t.id, kind: "edited", fields });
        if (moved) changes.push({ task: t.id, kind, from: old.state, to: state });
        if (!edited && !moved && old.priority === priority && old.source.ref === ref) return;
        writes.push(() => {
          // A position change alone updates priority and the line quietly: no event, no new version
          const bump = edited || moved ? 1 : 0;
          updateTask.run(titleOf(t.description, t.id), t.description, t.agent, t.agentName, state, blocked, priority, ref, bump ? at : old.updatedAt, bump, this.project, t.id);
          if (edited) event(t.id, "edited", { fields });
          if (moved) event(t.id, kind, { from: old.state, to: state, line: t.line, reason: t.reason });
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
        for (const w of writes) w();
        // An applied import adopts the store: the consumer starts where the files were read (missing cursors only)
        if (options.cursors) this.insertCursors(options.cursors, at);
        // One audit row per import that changed something (a re-run that changes nothing leaves no row)
        if (changes.length > 0) {
          this.db
            .prepare(`INSERT INTO work_imports (project, at, actor_kind, actor_id, tasks_file_hash, created, updated, dropped, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.project, at, actor.kind, actor.id, files.tasksFileHash, touched(["created"]).size, touched(["edited", "state_changed", "reopened"]).size, touched(["dropped"]).size, files.warnings);
        }
      }
      const changed = touched(["created", "edited", "state_changed", "reopened", "dropped"]);
      return { changes, unchanged: files.tasks.filter((t) => !changed.has(t.id) && !skipped.has(t.id)).length, skipped: [...skipped.values()] };
    })();
  }
}
