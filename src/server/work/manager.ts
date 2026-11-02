/**
 * WorkStoreManager: the work store per project, as src/server/index.ts wires it (load, live reload, stop).
 *
 * Off by default: a project without `work_store.mode: observe` keeps today's files exactly, has no store file, and
 * every call here answers 404 for it. In observe the store is opened on first use (data/work/<project>.db) and
 * follows the files one way when the owner imports; nothing else reads it yet, and fill is unchanged (work store 3
 * makes fill read it). One import per project at a time; a store that can't be opened is the call's error, and the
 * other projects go on.
 */
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { BusLineSource } from "../bus/consumers.js";
import { isValidTaskId } from "../agents/types.js";
import type { ProjectEntry } from "../reload/modules.js";
import { parseWorkStoreConfig, type WorkMode } from "./config.js";
import { readFiles, type ReportAccepted, type RunsSource } from "./importer.js";
import { SqliteWorkStore, type StoredTaskState, type SyncChange, type TaskState, type WorkActor, type WorkEvent, type WorkImportRecord, type WorkStore, type WorkTask } from "./store.js";

export interface WorkStoreManagerOptions {
  /** Lair's data directory: a project's store is <dataDir>/work/<project>.db */
  dataDir: string;
  /** The agents module's store (claims, runs, fill's kept records), or null while it is off */
  runs: () => RunsSource | null;
  /** The project's bus line source (bus.consume observe or on), or null */
  bus: (project: string) => BusLineSource | null;
  /** Fill's ready guard on a DONE line; absent: every DONE fill's checks find counts */
  accepted?: (project: string) => ReportAccepted | undefined;
  now?: () => number;
  log?: Pick<Console, "warn">;
}

/** A task with the state the claims give it (§1.5): a stored `ready` with a claim is `assigned`, or `running` with its run */
export interface WorkTaskView extends WorkTask {
  derived: TaskState;
  holder: { agent: string; runId: string } | null;
}

export interface WorkStatus {
  project: string;
  mode: WorkMode;
  problems: string[];
  store: { schemaVersion: number; counts: Partial<Record<StoredTaskState, number>>; lastImport: WorkImportRecord | null } | null;
}

export interface ImportReport {
  dryRun: boolean;
  tasksFile: string;
  /** Tasks in the files (open and done lines) */
  read: number;
  changes: SyncChange[];
  unchanged: number;
  warnings: string[];
}

export type WorkResult<T> = { ok: true; data: T } | { ok: false; code: 404 | 409 | 422 | 500 | 503; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class WorkStoreManager {
  private projects = new Map<string, { config: ProjectConfig; mode: WorkMode; problems: string[] }>();
  private stores = new Map<string, Promise<SqliteWorkStore>>();
  private importing = new Set<string>();
  private stopped = false;

  constructor(private readonly options: WorkStoreManagerOptions) {}

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parseWorkStoreConfig(config.work_store);
    return parsed.ok ? [] : parsed.errors;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) this.apply(entry);
  }

  /** Live reload: the new mode at once; switched off, the project's store is closed (its file is kept). */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    this.apply(entry);
    if (this.mode(entry.name) === "off") await this.closeStore(entry.name);
  }

  private apply(entry: ProjectEntry): void {
    if (!entry.config) {
      this.projects.delete(entry.name);
      return;
    }
    const parsed = parseWorkStoreConfig(entry.config.work_store);
    if (!parsed.ok) (this.options.log ?? console).warn(`[work] ${entry.name}: the work store stays off: ${parsed.errors.join("; ")}`);
    this.projects.set(entry.name, { config: entry.config, mode: parsed.ok ? parsed.settings.mode : "off", problems: parsed.ok ? [] : parsed.errors });
  }

  mode(project: string): WorkMode {
    return this.projects.get(project)?.mode ?? "off";
  }

  /** The project's store while it is in observe mode, opened on first use. */
  private async opened(project: string): Promise<WorkResult<WorkStore>> {
    if (this.stopped) return { ok: false, code: 503, error: "the server is stopping" };
    if (this.mode(project) === "off") return { ok: false, code: 404, error: `the work store is off for ${project} (work_store.mode)` };
    let store = this.stores.get(project);
    if (!store) {
      store = SqliteWorkStore.open(project, join(this.options.dataDir, "work", `${project}.db`));
      this.stores.set(project, store);
      store.catch(() => this.stores.delete(project));
    }
    try {
      return { ok: true, data: await store };
    } catch (e) {
      return { ok: false, code: 500, error: `the work store of ${project} can't be opened: ${message(e)}` };
    }
  }

  async status(project: string): Promise<WorkStatus> {
    const problems = [...(this.projects.get(project)?.problems ?? [])];
    const opened = this.mode(project) === "off" ? null : await this.opened(project);
    if (opened && !opened.ok) problems.push(opened.error);
    const store = opened?.ok ? { schemaVersion: opened.data.schemaVersion, counts: await opened.data.counts(), lastImport: await opened.data.lastImport() } : null;
    return { project, mode: this.mode(project), problems, store };
  }

  /** Tasks with their derived state; a derived state (`assigned`, `running`) is filtered after the claims are read. */
  async tasks(project: string, query: { state?: TaskState; agent?: string; limit: number }): Promise<WorkResult<WorkTaskView[]>> {
    const opened = await this.opened(project);
    if (!opened.ok) return opened;
    const derived = query.state === "assigned" || query.state === "running" || query.state === "ready";
    const states: StoredTaskState[] | undefined = query.state === undefined ? undefined : derived ? ["ready"] : [query.state as StoredTaskState];
    const rows = await opened.data.listTasks({ states, agent: query.agent, limit: derived ? 5000 : query.limit });
    const views = rows.map((task) => this.view(project, task));
    return { ok: true, data: (derived ? views.filter((v) => v.derived === query.state) : views).slice(0, query.limit) };
  }

  async task(project: string, id: string, eventLimit = 200): Promise<WorkResult<{ task: WorkTaskView; events: WorkEvent[] }>> {
    if (!isValidTaskId(id)) return { ok: false, code: 422, error: "not a valid task id" };
    const opened = await this.opened(project);
    if (!opened.ok) return opened;
    const task = await opened.data.getTask(id);
    if (!task) return { ok: false, code: 404, error: `no task ${id} in the work store of ${project}` };
    return { ok: true, data: { task: this.view(project, task), events: await opened.data.timeline(id, eventLimit) } };
  }

  private view(project: string, task: WorkTask): WorkTaskView {
    const runs = this.options.runs();
    const claim = task.state === "ready" && runs ? runs.getClaim(project, task.id) : null;
    if (!claim || !runs) return { ...task, derived: task.state, holder: null };
    const latest = runs.latestRunForTask(project, task.id);
    const running = latest?.id === claim.runId && latest.state === "running";
    return { ...task, derived: running ? "running" : "assigned", holder: { agent: claim.agent, runId: claim.runId } };
  }

  /**
   * Import the configured files one way (§6.4): a dry run (the default) reports what would change and writes
   * nothing; otherwise the diff is applied in one transaction, with `actor` (the owner's session) on every event.
   */
  async import(project: string, options: { dryRun: boolean; actor: WorkActor }): Promise<WorkResult<ImportReport>> {
    const entry = this.projects.get(project);
    if (!entry || entry.mode === "off") return { ok: false, code: 404, error: `the work store is off for ${project} (work_store.mode)` };
    if (this.importing.has(project)) return { ok: false, code: 409, error: `an import of ${project} is already running: try again when it ends` };
    this.importing.add(project);
    try {
      const files = await readFiles({ project, config: entry.config, runs: this.options.runs(), bus: this.options.bus(project), accepted: this.options.accepted?.(project) });
      if (!files.ok) return { ok: false, code: 422, error: files.error };
      // Opened after the reads: a reload that switched the project off meanwhile refuses the import
      const opened = await this.opened(project);
      if (!opened.ok) return opened;
      const synced = await opened.data.syncFromFiles(files.snapshot, { dryRun: options.dryRun, actor: options.actor, at: (this.options.now ?? Date.now)() });
      return {
        ok: true,
        data: { dryRun: options.dryRun, tasksFile: files.tasksFile, read: files.snapshot.tasks.length, ...synced, warnings: files.warnings },
      };
    } catch (e) {
      return { ok: false, code: 500, error: `the import of ${project} failed: ${message(e)}` };
    } finally {
      this.importing.delete(project);
    }
  }

  private async closeStore(project: string): Promise<void> {
    const store = this.stores.get(project);
    this.stores.delete(project);
    if (store) (await store.catch(() => null))?.close();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.stores.keys()].map((project) => this.closeStore(project)));
  }
}
