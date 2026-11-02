/**
 * WorkStoreManager: the work store per project, as src/server/index.ts wires it (load, live reload, start, stop).
 *
 * Off by default: a project without `work_store.mode: observe` keeps today's files exactly and has no store file;
 * its status says `off`, and every other read and the import answer 404. In observe the store is opened on first use
 * (data/work/<project>.db; a status read opens it too) and nothing but the owner reads it: fill, the planner and the
 * tracker still read the files (work store 3 makes fill read the store). The owner's first applied import adopts the
 * store; from then on it follows by itself (`files: follow`, follow.ts): the consumer applies bus reports and run and
 * claim facts by cursor, and the follower imports again when a configured file changed. The status compares the
 * store with fill's view at its last check. One import per project at a time; a store that can't be opened is the
 * call's error, and the other projects go on.
 */
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { FillLineView, FillStatusView } from "../../shared/agents-types.js";
import type { Event } from "../../shared/server-types.js";
import type { EventBus } from "../core/event-bus.js";
import type { BusLineSource } from "../bus/consumers.js";
import { isActive, isValidTaskId } from "../agents/types.js";
import type { ProjectEntry } from "../reload/modules.js";
import { parseWorkStoreConfig, type WorkFiles, type WorkMode } from "./config.js";
import { drainFacts, factMarks, fileSignature, type ClaimFactReader, type FactSources, type ReportReader } from "./follow.js";
import { configuredFiles, readFiles, type ReportAccepted, type RunsSource } from "./importer.js";
import {
  SqliteWorkStore,
  type Cursors,
  type StoredTaskState,
  type SyncChange,
  type TaskState,
  type WorkActor,
  type WorkEvent,
  type WorkImportRecord,
  type WorkStore,
  type WorkTask,
} from "./store.js";

export interface WorkStoreManagerOptions {
  /** Lair's data directory: a project's store is <dataDir>/work/<project>.db */
  dataDir: string;
  /** The agents module's store (claims, runs, fill's kept records, run and claim facts), or null while it is off */
  runs: () => (RunsSource & ClaimFactReader) | null;
  /** The project's bus line source (bus.consume observe or on), or null */
  bus: (project: string) => BusLineSource | null;
  /** The project's bus store when its file exists (never created): the consumer reads its reports */
  reports?: (project: string) => Promise<ReportReader | null>;
  /** Fill's ready guard on a DONE line; absent: every DONE fill's checks find counts */
  accepted?: (project: string) => ReportAccepted | undefined;
  /** Fill's view at its last check: the status compares the store with it */
  fill?: (project: string) => FillStatusView | null;
  /** The server's events: a bus report or a run or claim fact makes the consumer read at once */
  events?: Pick<EventBus, "on">;
  /** How often the follower drains and looks at the configured files (ms, default 15 s) */
  followIntervalMs?: number;
  /** A follow step that takes longer fails (ms, default 60 s); the step in flight still ends before another starts */
  followTimeoutMs?: number;
  now?: () => number;
  log?: Pick<Console, "warn">;
}

/** A task with the state the claims give it (§1.5): a stored `ready` with a claim is `assigned`, or `running` with its run */
export interface WorkTaskView extends WorkTask {
  derived: TaskState;
  holder: { agent: string; runId: string } | null;
}

/** The follower and the consumer of one project (null in the status while the mode is off) */
export interface FollowView {
  /** Not adopted yet: nothing follows until the owner applies a first import */
  waiting: boolean;
  /** File checks, and the reads the changed ones cost */
  checks: number;
  reads: number;
  lastReadAt: string | null;
  /** Facts applied to a task, and facts for tasks the store doesn't have */
  applied: number;
  skipped: number;
  failures: number;
  lastError: string | null;
  /** After a failure: the next step waits until then */
  nextAt: string | null;
}

/** The store next to fill's view at its last check (§6.4: fill's holds are not a stored state and are not compared) */
export interface WorkComparison {
  fillCheckedAt: string;
  agree: number;
  /** Lines in a hold the store doesn't keep (paused, owner, backoff, capacity...), unassigned lines not ready, others */
  ignored: number;
  /** The first 50 tasks they disagree on */
  disagree: { task: string; fill: string; store: string }[];
  disagreeCount: number;
}

export interface WorkStatus {
  project: string;
  mode: WorkMode;
  files: WorkFiles;
  problems: string[];
  store: { schemaVersion: number; counts: Partial<Record<StoredTaskState, number>>; lastImport: WorkImportRecord | null; adopted: boolean; cursors: Cursors } | null;
  follow: FollowView | null;
  comparison: WorkComparison | null;
}

export interface ImportReport {
  dryRun: boolean;
  tasksFile: string;
  /** Tasks in the files (open and done lines) */
  read: number;
  changes: SyncChange[];
  unchanged: number;
  /** Tasks the planner or the owner made, in the file: not changed */
  skipped: string[];
  warnings: string[];
}

export type WorkResult<T> = { ok: true; data: T } | { ok: false; code: 404 | 409 | 422 | 500 | 503; error: string };

interface FollowState {
  running: Promise<void> | null;
  /** An event came while a step ran: one more step after it (with the files, when the timer asked) */
  again: { files: boolean } | null;
  signature: string | null;
  checks: number;
  reads: number;
  lastReadAt: number | null;
  applied: number;
  skipped: number;
  failures: number;
  nextAt: number;
  lastError: string | null;
}

const FOLLOWER: WorkActor = { kind: "module", id: "follower" };
const FACT_EVENTS = ["bus.report", "agent.run.started", "agent.run.ended", "agent.claim.released"] as const;
const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_DISAGREE = 50;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number | null) => (ms === null || ms === 0 ? null : new Date(ms).toISOString());

/** What fill's line says the store should hold: a state, a run holding it, or null (fill's own hold: not compared) */
function fillExpects(line: FillLineView): string | null {
  if (line.state === "done") return "done";
  if (line.state === "started" || line.state === "claimed") return "held by a run";
  if (line.state === "unassigned") return line.ready ? "ready" : null;
  if (line.state !== "held") return null;
  if (line.hold === "waiting" || line.hold === "waited_too_long") return "waiting";
  return line.hold === "blocked" ? "blocked" : null;
}

export class WorkStoreManager {
  private projects = new Map<string, { config: ProjectConfig; mode: WorkMode; files: WorkFiles; problems: string[] }>();
  private stores = new Map<string, Promise<SqliteWorkStore>>();
  private importing = new Set<string>();
  private follows = new Map<string, FollowState>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribes: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly options: WorkStoreManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parseWorkStoreConfig(config.work_store);
    return parsed.ok ? [] : parsed.errors;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) this.apply(entry);
  }

  /**
   * Live reload: the new mode at once; switched off, the project's store is closed (its file is kept) and its
   * follower forgotten. Any other change (the agents or planner blocks an import reads) only replaces the config the
   * next step reads: a follow step or import in flight ends with the config it started with, and is not restarted.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    this.apply(entry);
    if (this.mode(entry.name) === "off") {
      this.follows.delete(entry.name);
      await this.closeStore(entry.name);
    }
  }

  private apply(entry: ProjectEntry): void {
    if (!entry.config) {
      this.projects.delete(entry.name);
      return;
    }
    const parsed = parseWorkStoreConfig(entry.config.work_store);
    if (!parsed.ok) (this.options.log ?? console).warn(`[work] ${entry.name}: the work store stays off: ${parsed.errors.join("; ")}`);
    const settings = parsed.ok ? parsed.settings : { mode: "off" as const, files: "follow" as const };
    this.projects.set(entry.name, { config: entry.config, ...settings, problems: parsed.ok ? [] : parsed.errors });
  }

  mode(project: string): WorkMode {
    return this.projects.get(project)?.mode ?? "off";
  }

  /** The follower and the consumer: on the server's fact events, every interval, and once now (the replay at start). */
  start(): void {
    if (this.timer || this.stopped) return;
    const wake = (event: Event) => {
      const project = typeof event.data?.project === "string" ? event.data.project : null;
      if (project !== null && this.mode(project) === "observe") this.followSoon(project, false);
    };
    for (const type of FACT_EVENTS) if (this.options.events) this.unsubscribes.push(this.options.events.on(type, wake));
    this.timer = setInterval(() => this.followAll(), this.options.followIntervalMs ?? 15_000);
    this.timer.unref?.();
    this.followAll();
  }

  /** The timer's step for every following project, now, and the steps it starts. */
  async followNow(): Promise<void> {
    this.followAll();
    await this.settled();
  }

  private followAll(): void {
    for (const [project, entry] of this.projects) if (entry.mode === "observe" && entry.files === "follow") this.followSoon(project, true);
  }

  /** One follow step at a time per project: a request during one runs once after it; none during a backoff. */
  private followSoon(project: string, files: boolean): void {
    if (this.stopped) return;
    const state = this.followState(project);
    if (state.running) {
      state.again = { files: files || (state.again?.files ?? false) };
      return;
    }
    if (this.now() < state.nextAt) return;
    state.running = this.followStep(project, state, files).finally(() => {
      state.running = null;
      const again = state.again;
      state.again = null;
      if (again && this.follows.get(project) === state) this.followSoon(project, again.files);
    });
  }

  /** Waits for the follow steps in flight, and the ones they asked for. */
  async settled(): Promise<void> {
    while ([...this.follows.values()].some((s) => s.running)) await Promise.all([...this.follows.values()].map((s) => s.running));
  }

  private followState(project: string): FollowState {
    let state = this.follows.get(project);
    if (!state) {
      state = { running: null, again: null, signature: null, checks: 0, reads: 0, lastReadAt: null, applied: 0, skipped: 0, failures: 0, nextAt: 0, lastError: null };
      this.follows.set(project, state);
    }
    return state;
  }

  /** A step with a time limit: a timeout is a failure (backed off), and the step in flight still ends before the next. */
  private async followStep(project: string, state: FollowState, files: boolean): Promise<void> {
    const limit = this.options.followTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const work = this.followOnce(project, state, files);
    try {
      await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the follow step timed out after ${limit / 1000} s`)), limit)))]);
      state.failures = 0;
      state.nextAt = 0;
      state.lastError = null;
    } catch (e) {
      state.failures++;
      state.lastError = message(e);
      state.nextAt = this.now() + Math.min((this.options.followIntervalMs ?? 15_000) * 2 ** (state.failures - 1), MAX_BACKOFF_MS);
      (this.options.log ?? console).warn(`[work] ${project}: ${state.lastError} (failure ${state.failures}, next try ${iso(state.nextAt)})`);
      await work.catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  private async followOnce(project: string, state: FollowState, files: boolean): Promise<void> {
    const opened = await this.opened(project);
    if (!opened.ok) throw new Error(opened.error);
    // Not adopted: the owner's first applied import (after a dry run) starts the following
    if (!(await opened.data.adopted())) return;
    const facts = await drainFacts(project, opened.data, await this.factSources(project), () => this.now());
    state.applied += facts.applied;
    state.skipped += facts.skipped;
    const entry = this.projects.get(project);
    if (!files || !entry) return;
    const paths = configuredFiles(entry.config);
    if (!paths.ok) throw new Error(paths.error);
    // Taken before the read: a change during the read is read again next time
    const signature = await fileSignature([paths.tasksFile, paths.queueFile]);
    state.checks++;
    if (signature === state.signature) return;
    state.reads++;
    const imported = await this.import(project, { dryRun: false, actor: FOLLOWER });
    if (!imported.ok) {
      // The owner's import runs: the next step reads the files
      if (imported.code === 409) return;
      throw new Error(imported.error);
    }
    state.signature = signature;
    state.lastReadAt = this.now();
  }

  private async factSources(project: string): Promise<FactSources> {
    return { reports: (await this.options.reports?.(project)) ?? null, runs: this.options.runs(), accepted: this.options.accepted?.(project) };
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
    const entry = this.projects.get(project);
    const problems = [...(entry?.problems ?? [])];
    const opened = this.mode(project) === "off" ? null : await this.opened(project);
    if (opened && !opened.ok) problems.push(opened.error);
    const data = opened?.ok ? opened.data : null;
    const adopted = data ? await data.adopted() : false;
    const store = data ? { schemaVersion: data.schemaVersion, counts: await data.counts(), lastImport: await data.lastImport(), adopted, cursors: await data.cursors() } : null;
    const s = this.mode(project) === "off" ? null : this.followState(project);
    const follow: FollowView | null = s && {
      waiting: !adopted,
      checks: s.checks,
      reads: s.reads,
      lastReadAt: iso(s.lastReadAt),
      applied: s.applied,
      skipped: s.skipped,
      failures: s.failures,
      lastError: s.lastError,
      nextAt: iso(s.nextAt),
    };
    const comparison = data && adopted ? await this.compare(project, data) : null;
    return { project, mode: this.mode(project), files: entry?.files ?? "follow", problems, store, follow, comparison };
  }

  /** The store next to fill's view at its last check; null while fill has no complete check to compare with. */
  private async compare(project: string, store: WorkStore): Promise<WorkComparison | null> {
    const fill = this.options.fill?.(project) ?? null;
    if (!fill || fill.lastCheck === null || fill.lastError !== null) return null;
    const runs = this.options.runs();
    const tasks = new Map((await store.listTasks({ limit: 5000 })).map((t) => [t.id, t]));
    const held = (task: string) => {
      const latest = runs?.latestRunForTask(project, task) ?? null;
      return (latest !== null && isActive(latest.state)) || (runs?.getClaim(project, task) ?? null) !== null;
    };
    const result: WorkComparison = { fillCheckedAt: fill.lastCheck, agree: 0, ignored: 0, disagree: [], disagreeCount: 0 };
    const differ = (task: string, fillSays: string, storeSays: string) => {
      result.disagreeCount++;
      if (result.disagree.length < MAX_DISAGREE) result.disagree.push({ task, fill: fillSays, store: storeSays });
    };
    const lined = new Set<string>();
    for (const line of fill.lines) {
      if (line.task === null) continue;
      lined.add(line.task);
      const expected = fillExpects(line);
      if (expected === null) {
        result.ignored++;
        continue;
      }
      const task = tasks.get(line.task);
      const actual = !task ? "not in the store" : expected === "held by a run" && held(task.id) ? "held by a run" : task.state;
      if (actual === expected) result.agree++;
      else differ(line.task, line.hold ? `${line.state} (${line.hold})` : line.state, actual);
    }
    for (const task of tasks.values()) {
      if (!lined.has(task.id) && task.state !== "done" && task.state !== "dropped") differ(task.id, "no line", task.state);
    }
    return result;
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
   * nothing; otherwise the diff is applied in one transaction, with `actor` (the owner's session, or the follower) on
   * every event. The first applied import adopts the store: the consumer starts where the files were read.
   */
  async import(project: string, options: { dryRun: boolean; actor: WorkActor }): Promise<WorkResult<ImportReport>> {
    const entry = this.projects.get(project);
    if (!entry || entry.mode === "off") return { ok: false, code: 404, error: `the work store is off for ${project} (work_store.mode)` };
    if (this.importing.has(project)) return { ok: false, code: 409, error: `an import of ${project} is already running: try again when it ends` };
    this.importing.add(project);
    try {
      // The consumer's starting points, read before the files: a fact after them is the consumer's, one before the files'
      const cursors = options.dryRun ? undefined : factMarks(await this.factSources(project));
      const files = await readFiles({ project, config: entry.config, runs: this.options.runs(), bus: this.options.bus(project), accepted: this.options.accepted?.(project) });
      if (!files.ok) return { ok: false, code: 422, error: files.error };
      // Opened after the reads: a reload that switched the project off meanwhile refuses the import
      const opened = await this.opened(project);
      if (!opened.ok) return opened;
      const synced = await opened.data.syncFromFiles(files.snapshot, { dryRun: options.dryRun, actor: options.actor, at: this.now(), cursors });
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    // A follow step in flight ends before its store is closed (each of its writes is one transaction), for at most 5 s
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([this.settled(), new Promise<void>((resolve) => (wait = setTimeout(resolve, 5_000)))]);
    clearTimeout(wait);
    await Promise.all([...this.stores.keys()].map((project) => this.closeStore(project)));
  }
}
