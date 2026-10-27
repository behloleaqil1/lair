/**
 * All projects' triage services. The store (data/triage.db) is opened only
 * when at least one project enables triage.
 */
import { readFileSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { TriageClass, TriageProjectStatus } from "../../shared/triage-types.js";
import { TRIAGE_CLASSES } from "../../shared/triage-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import { ExecFileRunner, NodeFileSystem, systemClock } from "../watchdog/probes.js";
import { parseTriageConfig } from "./config.js";
import { commandAdapters, type TriageAdapters } from "./adapters.js";
import { GitCli } from "./git.js";
import { BUILTIN_PARSERS, type EvidenceParser } from "./parsers/index.js";
import { TriageStore } from "./store.js";
import {
  TriageConflictError,
  TriageService,
  type IngestInput,
  type IngestOutcome,
  type SignedInput,
  type TriageProbes,
} from "./service.js";

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

/** Whether `file` (a real path) is inside `dir`, symlinks resolved. */
function isInside(file: string, dir: string): boolean {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    root = resolve(dir);
  }
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class TriageManager {
  private services = new Map<string, TriageService>();
  private problems = new Map<string, string[]>();
  private store: TriageStore | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** Per project: the tick in progress */
  private ticks = new Map<string, Promise<void>>();
  /** Services a reload is replacing: they tick no more */
  private retired = new WeakSet<TriageService>();
  private running = false;
  private closed = false;
  private decisions?: DecisionProducer;
  /** gate.completed ingests in progress (they don't hold up the module that emitted them) */
  private pending = new Set<Promise<unknown>>();

  constructor(private options: TriageManagerOptions) {}

  /**
   * What load() would refuse in a project's config: the `triage:` block
   * (parseTriageConfig) and, when it is enabled, the trusted nodes' keys.
   */
  validate(config: ProjectConfig): string[] {
    const parsed = parseTriageConfig(config.triage);
    if (!parsed.ok) return parsed.errors;
    if (!parsed.settings.enabled) return [];
    return this.nodeKeys(parsed.settings.trustedNodes, config.repo).errors;
  }

  /**
   * The trusted nodes' keys, or the errors reading them. A relative path is
   * read from Lair's working directory. A key inside the project's
   * repository is refused: an agent working there could replace it.
   */
  private nodeKeys(nodes: { id: string; publicKeyFile: string }[], repo: string): { keys: Map<string, string>; errors: string[] } {
    const keys = new Map<string, string>();
    const errors: string[] = [];
    for (const node of nodes) {
      try {
        const file = realpathSync(resolve(node.publicKeyFile));
        if (isInside(file, repo)) {
          throw new Error("it is inside the project's repository, where an agent could replace it: keep it under Lair's data/");
        }
        const pem = readFileSync(file, "utf-8");
        if (!pem.includes("PUBLIC KEY")) throw new Error("not a PEM public key");
        keys.set(node.id, pem);
      } catch (e) {
        errors.push(`triage.trusted_nodes: ${node.id}: cannot read ${node.publicKeyFile} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { keys, errors };
  }

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
      const settings = parsed.settings;
      const nodes = this.nodeKeys(settings.trustedNodes, entry.config.repo);
      if (nodes.errors.length > 0) {
        this.problems.set(entry.name, nodes.errors);
        console.warn(`[triage] ${entry.name}: not started: ${nodes.errors.join("; ")}`);
        continue;
      }
      this.store ??= new TriageStore(this.options.dbPath);
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
          nodeKeys: nodes.keys,
          parsers: this.options.parsers ?? BUILTIN_PARSERS,
          events: this.options.events,
        }),
      );
    }
  }

  /** Tick every service every interval_seconds; returns the projects started. */
  start(): string[] {
    this.running = true;
    for (const [name, service] of this.services) this.schedule(name, service);
    return [...this.services.keys()];
  }

  /** Tick `service` soon, then every interval_seconds, while it is the project's running service. */
  private schedule(name: string, service: TriageService): void {
    const current = () => this.running && this.services.get(name) === service && !this.retired.has(service);
    const loop = async () => {
      if (!current()) return;
      const tick = service.tick().catch((e) => {
        console.error(`[triage] ${name}: tick failed:`, e);
      });
      this.ticks.set(name, tick);
      await tick;
      if (this.ticks.get(name) === tick) this.ticks.delete(name);
      if (!current()) return;
      const timer = setTimeout(loop, service.settings.intervalSeconds * 1000);
      timer.unref();
      this.timers.set(name, timer);
    };
    const timer = setTimeout(loop, 1000);
    timer.unref();
    this.timers.set(name, timer);
  }

  /**
   * Apply a project's new config (src/server/reload/): its service stops
   * ticking, the tick, ingests and outbox in progress finish, then the new
   * service takes over (connected to the Decision Inbox, ticking when the
   * manager runs). Other projects are not touched.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.closed) return;
    const old = this.services.get(entry.name);
    if (old) this.retired.add(old);
    clearTimeout(this.timers.get(entry.name));
    this.timers.delete(entry.name);
    if (old) {
      await this.ticks.get(entry.name);
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      await old.idle();
      if (this.closed) return;
      old.close();
    }
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (!next) return;
    if (this.decisions) next.useDecisions(this.decisions);
    if (this.running) this.schedule(entry.name, next);
  }

  /** Stop ticking, wait for calls in progress, then close the store. */
  async stop(): Promise<void> {
    this.closed = true;
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.ticks.values());
    await this.idle();
    for (const service of this.services.values()) service.close();
    this.store?.close();
    this.store = null;
    this.services.clear();
  }

  /** Resolves when every service is idle and no gate.completed ingest is in progress. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    await Promise.all([...this.services.values()].map((s) => s.idle()));
  }

  /** Track a background ingest (from an event), so idle() and stop() wait for it. */
  track(work: Promise<unknown>): void {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Raise decisions in the Decision Inbox and follow their answers (the server's mountDecisions calls this). */
  useDecisions(inbox: DecisionProducer): void {
    this.decisions = inbox;
    for (const service of this.services.values()) service.useDecisions(inbox);
  }

  /** Throws (403) unless a node the project trusts signed this result. */
  verify(project: string, signed: SignedInput): void {
    this.require(project).verifySigned(signed);
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

  ingest(project: string, input: IngestInput, options: { background?: boolean } = {}): Promise<IngestOutcome> {
    return this.require(project).ingest(input, options);
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
        openIncidents: 0,
        commands: {},
        trustedNodes: [],
      };
    }
    const settings = service.settings;
    const open = store.openIncidents(project).filter((i) => i.branch === settings.defaultBranch);
    return {
      project,
      enabled: true,
      mode: settings.mode,
      actBlocked: service.actBlocked,
      errors: [],
      defaultBranch: settings.defaultBranch,
      counts: store.counts(project),
      pendingRechecks: store.rechecksWithStatus(project, ["waiting_capacity", "dispatching", "requested", "unavailable"]).length,
      openTasks: store.listTasks(project, "open").length,
      quarantined: store.quarantinedKeys(project).size,
      quarantineCap: settings.flaky.quarantineCap,
      incident: open[0] ?? store.listIncidents(project, { limit: 1 })[0] ?? null,
      openIncidents: open.length,
      commands: service.commands,
      trustedNodes: service.trustedNodes,
    };
  }
}
