/**
 * All projects' planner services. The store (data/planner.db) is opened only
 * when at least one project enables the planner.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { PlannerStatusView } from "../../shared/planner-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { PlannerAgents } from "./agents.js";
import { parsePlannerConfig } from "./config.js";
import { DECISION_MODULE, PlannerService } from "./service.js";
import { PlannerStore } from "./store.js";

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

export interface PlannerManagerOptions {
  dbPath: string;
  agents: PlannerAgents;
  events?: EventBus;
  /** Replace the clock (tests) */
  clock?: { now(): number };
}

const systemClock = { now: () => Date.now() };

export class PlannerManager {
  private services = new Map<string, PlannerService>();
  private problems = new Map<string, string[]>();
  private store: PlannerStore | null = null;
  private producer: DecisionProducer | null = null;
  /** Per project: stop following its answers */
  private stopFollowing = new Map<string, () => void>();
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private options: PlannerManagerOptions) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      if (entry.config.planner === undefined) continue;
      const parsed = parsePlannerConfig(entry.config.planner, entry.config);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[planner] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new PlannerStore(this.options.dbPath);
      const service = new PlannerService({
        project: entry.name,
        config: entry.config,
        settings: parsed.settings,
        store: this.store,
        agents: this.options.agents,
        clock: this.options.clock ?? systemClock,
        events: this.options.events,
        decisions: () => this.producer,
      });
      this.services.set(entry.name, service);
      this.follow(entry.name, service);
    }
  }

  /**
   * Raise decisions in the Decision Inbox and follow the answers: each
   * service gets its project's answers, also those given while the server
   * was down.
   */
  useDecisions(decisions: DecisionProducer): void {
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    this.producer = decisions;
    for (const [project, service] of this.services) this.follow(project, service);
  }

  private follow(project: string, service: PlannerService): void {
    if (!this.producer) return;
    this.stopFollowing.set(project, this.producer.onResolved(DECISION_MODULE, (r) => service.followAnswer(r), { project }));
  }

  start(): string[] {
    this.phase = "started";
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  /**
   * Apply a project's new config (the shape of the other modules'
   * reloadProject): its service stops (the cycle in progress finishes), then
   * the new one starts from the same store, so its history, pending
   * approvals and planner run carry on. Other projects are not touched. A
   * service that fails to start is stopped and removed before the error is
   * thrown.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    this.stopFollowing.get(entry.name)?.();
    this.stopFollowing.delete(entry.name);
    const old = this.services.get(entry.name);
    if (old) await old.stop();
    if (this.inPhase("stopped")) return;
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (!next) return;
    try {
      if (this.inPhase("started")) next.start();
    } catch (e) {
      this.stopFollowing.get(entry.name)?.();
      this.stopFollowing.delete(entry.name);
      await next.stop();
      this.services.delete(entry.name);
      throw e;
    }
  }

  /** Stop every service, wait for work in progress, then close the store. */
  async stop(): Promise<void> {
    this.phase = "stopped";
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    await Promise.all([...this.services.values()].map((service) => service.stop()));
    this.services.clear();
    this.store?.close();
    this.store = null;
  }

  get(project: string): PlannerService | undefined {
    return this.services.get(project);
  }

  /** Projects with the planner on. */
  enabled(): string[] {
    return [...this.services.keys()];
  }

  errors(project: string): string[] {
    return this.problems.get(project) ?? [];
  }

  status(project: string): PlannerStatusView {
    const service = this.services.get(project);
    const errors = this.problems.get(project) ?? [];
    if (service) return service.status(errors);
    return {
      project,
      enabled: false,
      mode: null,
      running: false,
      paused: false,
      lastCycle: null,
      lastError: null,
      errors,
      warnings: [],
      counts: { sources: 0, sourcesFailing: 0, openTasks: 0, readyTasks: 0, pending: 0, runs: 0 },
      activeRun: null,
    };
  }
}
