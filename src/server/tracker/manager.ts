/**
 * TrackerManager: one TrackerService per project with `tracker.enabled:
 * true`, as src/server/index.ts wires it (load, start, live reload, stop).
 * The store (data/tracker.db) is opened only once a project enables the
 * tracker. Starting never waits on GitHub and never throws: a project whose
 * config or store is refused shows why in its status, and the others run.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { TrackerStatusView } from "../../shared/tracker-types.js";
import type { EventBus } from "../core/event-bus.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { ProjectEntry } from "../reload/modules.js";
import { tokenFrom } from "../review/github.js";
import { parseTrackerConfig, type TrackerSettings } from "./config.js";
import { GitHubTrackerClient, type FetchLike } from "./github-projects.js";
import { DECISION_MODULE, TrackerService } from "./service.js";
import { TrackerStore } from "./store.js";
import { fileTaskSource, type TaskSource } from "./tasks.js";
import { makeRedactor } from "./redact.js";

export interface TrackerManagerOptions {
  /** data/tracker.db (":memory:" in tests) */
  dbPath: string;
  events?: EventBus;
  /** GitHub's HTTP API (tests pass a stand-in); default: fetch */
  fetch?: FetchLike;
  /** Where tokens are read (default: process.env) */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Overrides each project's request_timeout_seconds (tests) */
  timeoutMs?: number;
  /** The tasks a project's tracker follows (default: agents.fill's tasks file) */
  tasks?: (settings: TrackerSettings) => TaskSource;
  log?: Pick<Console, "warn">;
}

export class TrackerManager {
  private services = new Map<string, TrackerService>();
  private problems = new Map<string, string[]>();
  private store: TrackerStore | null = null;
  private decisions: DecisionProducer | null = null;
  private stopFollowing = new Map<string, () => void>();
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private readonly options: TrackerManagerOptions) {}

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parseTrackerConfig(config.tracker, config);
    return parsed.ok ? [] : parsed.errors;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const parsed = parseTrackerConfig(entry.config.tracker, entry.config);
      if (!parsed.ok) {
        // A project that doesn't turn the tracker on never fails on it
        const raw = entry.config.tracker as { enabled?: unknown } | undefined;
        if (raw?.enabled === true) {
          this.problems.set(entry.name, parsed.errors);
          (this.options.log ?? console).warn(`[tracker] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        }
        continue;
      }
      if (!parsed.settings.enabled) continue;
      try {
        this.store ??= new TrackerStore(this.options.dbPath);
      } catch (e) {
        this.problems.set(entry.name, [`the tracker store: ${e instanceof Error ? e.message : String(e)}`]);
        continue;
      }
      this.services.set(entry.name, this.create(entry.name, parsed.settings, this.store));
    }
  }

  private create(project: string, settings: TrackerSettings, store: TrackerStore): TrackerService {
    const abort = new AbortController();
    const client = new GitHubTrackerClient({
      apiUrl: settings.apiUrl,
      token: tokenFrom(settings.token.env, settings.token.cmd, this.options.env ?? process.env),
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs ?? settings.requestTimeoutSeconds * 1000,
      // Observe mode: the client itself refuses every write
      readOnly: settings.mode !== "act",
      stopSignal: abort.signal,
      now: this.options.now,
    });
    const service = new TrackerService({
      project,
      settings,
      store,
      client,
      tasks: this.options.tasks?.(settings) ?? fileTaskSource(settings.tasksFile, settings.doneMarker),
      abort,
      events: this.options.events,
      decisions: this.decisions,
      now: this.options.now,
      // The secret values it redacts come from the same environment its token does
      redact: makeRedactor({ patterns: settings.redactPatterns, env: this.options.env ?? process.env }),
      log: this.options.log,
    });
    this.follow(project, service);
    return service;
  }

  /** The Decision Inbox: the tracker asks for missing token scopes there, and follows the answers. */
  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    for (const [project, service] of this.services) {
      service.useDecisions(decisions);
      this.follow(project, service);
    }
  }

  private follow(project: string, service: TrackerService): void {
    if (!this.decisions) return;
    this.stopFollowing.get(project)?.();
    this.stopFollowing.set(project, this.decisions.onResolved(DECISION_MODULE, (r) => service.followAnswer(r), { project }));
  }

  /** Start every loaded tracker (each syncs in the background); returns their projects. */
  start(): string[] {
    this.phase = "started";
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  /**
   * Apply a project's new config: its tracker stops (requests in flight are
   * cut short), then the new one starts on the same store, so its links,
   * pending creates and audit carry on. Other projects are not touched.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.phase === "stopped") return;
    const old = this.services.get(entry.name);
    this.services.delete(entry.name);
    this.stopFollowing.get(entry.name)?.();
    this.stopFollowing.delete(entry.name);
    if (old) await old.stop();
    if (this.isStopped()) return;
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (next && this.phase === "started") next.start();
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private isStopped(): boolean {
    return this.phase === "stopped";
  }

  /** Stop every tracker (requests in flight are cut short), then close the store. */
  async stop(): Promise<void> {
    this.phase = "stopped";
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    await Promise.all([...this.services.values()].map((s) => s.stop()));
    this.services.clear();
    this.store?.close();
    this.store = null;
  }

  get(project: string): TrackerService | undefined {
    return this.services.get(project);
  }

  /** Projects with a tracker running */
  enabled(): string[] {
    return [...this.services.keys()];
  }

  status(project: string): TrackerStatusView {
    const service = this.services.get(project);
    const base = { project, enabled: service !== undefined, errors: this.problems.get(project) ?? [] };
    if (!service) {
      return {
        ...base,
        running: false,
        mode: null,
        repos: [],
        scopes: { checked: false, granted: null, missing: [] },
        syncState: null,
        links: [],
        pending: [],
        recentWrites: [],
        queue: { waiting: 0, dropped: 0 },
        closedUnmerged: [],
        removedTasks: [],
        warnings: [],
      };
    }
    return { ...base, ...service.status() };
  }
}
