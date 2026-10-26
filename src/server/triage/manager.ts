/**
 * All projects' triage services. The store (data/triage.db) is opened only
 * when at least one project enables triage.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { TriageClass, TriageProjectStatus } from "../../shared/triage-types.js";
import { TRIAGE_CLASSES } from "../../shared/triage-types.js";
import { ExecFileRunner, NodeFileSystem, systemClock } from "../watchdog/probes.js";
import { parseTriageConfig } from "./config.js";
import { commandAdapters, type TriageAdapters } from "./adapters.js";
import { GitCli } from "./git.js";
import { BUILTIN_PARSERS, type EvidenceParser } from "./parsers/index.js";
import { TriageStore } from "./store.js";
import { TriageConflictError, TriageService, type IngestInput, type IngestOutcome, type TriageProbes } from "./service.js";

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

export interface TriageManagerOptions {
  dbPath: string;
  /** Replace the system boundary (tests): the command runner, the clock, files and git */
  probes?: Partial<TriageProbes>;
  events?: EventBus;
  /** In-process adapters from other modules, per project; they replace the command adapters */
  adapters?: (project: string) => Partial<TriageAdapters>;
  /** Evidence parsers (default: the built-in ones) */
  parsers?: EvidenceParser[];
}

export class TriageManager {
  private services = new Map<string, TriageService>();
  private problems = new Map<string, string[]>();
  private store: TriageStore | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(private options: TriageManagerOptions) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parseTriageConfig(entry.config.triage);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[triage] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new TriageStore(this.options.dbPath);
      const settings = parsed.settings;
      const given = this.options.probes ?? {};
      const probes: TriageProbes = {
        runner: given.runner ?? new ExecFileRunner(settings.commandTimeoutSeconds * 1000),
        clock: given.clock ?? systemClock,
        fs: given.fs ?? new NodeFileSystem(),
        git: given.git ?? ((repo, runner) => new GitCli(repo, runner)),
      };
      const fromCommands = commandAdapters(settings, probes.runner);
      const injected = this.options.adapters?.(entry.name) ?? {};
      this.services.set(
        entry.name,
        new TriageService({
          project: entry.name,
          config: entry.config,
          settings,
          store: this.store,
          probes,
          adapters: { ...fromCommands, ...injected },
          decisionsViaCommand: injected.decisions === undefined && fromCommands.decisions !== undefined,
          parsers: this.options.parsers ?? BUILTIN_PARSERS,
          events: this.options.events,
        }),
      );
    }
  }

  /** Tick every service every interval_seconds; returns the projects started. */
  start(): string[] {
    this.running = true;
    for (const [name, service] of this.services) {
      const loop = async () => {
        if (!this.running) return;
        try {
          await service.tick();
        } catch (e) {
          console.error(`[triage] ${name}: tick failed:`, e);
        }
        if (!this.running) return;
        const timer = setTimeout(loop, service.settings.intervalSeconds * 1000);
        timer.unref();
        this.timers.set(name, timer);
      };
      const timer = setTimeout(loop, 1000);
      timer.unref();
      this.timers.set(name, timer);
    }
    return [...this.services.keys()];
  }

  /** Stop ticking, wait for calls in progress, then close the store. */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.services.values()].map((s) => s.idle()));
    this.store?.close();
    this.store = null;
    this.services.clear();
  }

  get(project: string): TriageService | undefined {
    return this.services.get(project);
  }

  getStore(): TriageStore | null {
    return this.store;
  }

  /** The project's service, or a 409 error saying why there is none. */
  require(project: string): TriageService {
    const service = this.services.get(project);
    if (service) return service;
    const problems = this.problems.get(project);
    throw new TriageConflictError(
      problems
        ? `Triage is not running for ${project}: ${problems.join("; ")}`
        : `Triage is off for ${project} (set triage.enabled: true in its YAML)`,
    );
  }

  ingest(project: string, input: IngestInput): Promise<IngestOutcome> {
    return this.require(project).ingest(input);
  }

  status(project: string): TriageProjectStatus {
    const service = this.services.get(project);
    const store = this.store;
    const empty = Object.fromEntries(TRIAGE_CLASSES.map((c) => [c, 0])) as Record<TriageClass, number>;
    if (!service || !store) {
      return {
        project,
        enabled: false,
        mode: null,
        actBlocked: null,
        errors: this.problems.get(project) ?? [],
        defaultBranch: null,
        counts: { failures: 0, blocking: 0, byClass: empty },
        pendingRechecks: 0,
        openTasks: 0,
        quarantined: 0,
        quarantineCap: null,
        incident: null,
        commands: {},
      };
    }
    const settings = service.settings;
    const open = store.openIncident(project, settings.defaultBranch);
    return {
      project,
      enabled: true,
      mode: settings.mode,
      actBlocked: service.actBlocked,
      errors: [],
      defaultBranch: settings.defaultBranch,
      counts: store.counts(project),
      pendingRechecks: store.rechecksWithStatus(project, ["waiting_capacity", "requested", "unavailable"]).length,
      openTasks: store.listTasks(project, "open").length,
      quarantined: store.quarantinedKeys(project).size,
      quarantineCap: settings.flaky.quarantineCap,
      incident: open ?? store.listIncidents(project, { limit: 1 })[0] ?? null,
      commands: service.commands,
    };
  }
}
