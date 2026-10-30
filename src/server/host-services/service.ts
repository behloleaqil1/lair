/**
 * The host-services service: one HostServices instance per project.
 *
 * Each tick:
 * 1. Probe every service on every configured machine
 * 2. For services that are down and in act mode: run start command (with backoff)
 * 3. For services that keep failing: raise a decision (once per outage)
 * 4. Hold lanes that need down services
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { DecisionProducer, DecisionResolution, RaiseDecisionInput } from "../decisions/types.js";
import { actBlockedReason, parseHostServicesConfig } from "./config.js";
import type {
  HostServicesSettings,
  LaneHold,
  ProbeResult,
  ServiceConfig,
  ServiceStatus,
  TickSummary,
} from "./types.js";
import { DECISION_MODULE } from "./types.js";
import { HostServicesStore } from "./store.js";
import { systemHostServicesProbes, type HostServicesProbes } from "./probes.js";

export interface HostServicesOptions {
  project: string;
  config: ProjectConfig;
  settings: HostServicesSettings;
  store: HostServicesStore;
  probes: HostServicesProbes;
  events?: EventBus;
}

export class HostServices {
  readonly project: string;
  private config: ProjectConfig;
  private settings: HostServicesSettings;
  private store: HostServicesStore;
  private probes: HostServicesProbes;
  private events?: EventBus;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<TickSummary[]> | null = null;
  private stopped = true;
  private abort = new AbortController();
  lastTicks?: TickSummary[];
  lastError?: string;
  private decisions?: DecisionProducer;
  private unsubscribe?: () => void;

  constructor(options: HostServicesOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.probes = options.probes;
    this.events = options.events;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Why act mode is off for this project, or null when it is on. */
  get actBlocked(): string | null {
    return actBlockedReason(this.config, this.settings);
  }

  private iso(ms = this.probes.clock.now()): string {
    return new Date(ms).toISOString();
  }

  /**
   * Connect the Decision Inbox: raise decisions when services keep failing,
   * and withdraw them when services recover.
   */
  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    this.listen();
  }

  private listen(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.decisions?.onResolved(DECISION_MODULE, (r) => this.followAnswer(r), {
      project: this.project,
    });
  }

  /**
   * An answer to one of this module's decisions. For host-services, answers
   * are mostly informational (the human acknowledged or fixed the problem).
   */
  async followAnswer(resolution: DecisionResolution): Promise<void> {
    // The service recovers on its own via probes; answers just acknowledge
    // For now, we don't need to do anything special with the answer
  }

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<TickSummary[]> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<TickSummary[]> {
    const summaries: TickSummary[] = [];
    const at = this.iso();
    const blocked = this.actBlocked;

    for (const [machine, configs] of this.settings.machines) {
      if (this.abort.signal.aborted) break;

      const summary: TickSummary = {
        machine,
        at,
        services: configs.length,
        up: 0,
        down: 0,
        started: 0,
        decisions: 0,
      };

      for (const config of configs) {
        if (this.abort.signal.aborted) break;

        const state = this.store.getOrInit(machine, config.name);
        const wasStarting = state.state === "starting";

        // Probe the service
        const probeResult = await this.probe(config.probe);
        this.store.recordProbe(machine, config.name, probeResult);

        if (probeResult.up) {
          summary.up++;
          // Service recovered: withdraw any open decision
          if (state.decisionId) {
            await this.withdrawDecision(machine, config.name, state.decisionId);
          }
          await this.events?.emit("host-service.up", {
            project: this.project,
            machine,
            service: config.name,
          });
        } else {
          summary.down++;

          // Log the outage event (once when first detected)
          if (state.state === "down" && !wasStarting) {
            await this.events?.emit("host-service.down", {
              project: this.project,
              machine,
              service: config.name,
              output: probeResult.output,
            });
          }

          // Try to start in act mode
          if (!blocked && state.startAttempts < this.settings.maxStartAttempts) {
            await this.startService(machine, config);
            summary.started++;
          } else if (state.startAttempts >= this.settings.maxStartAttempts && !state.decisionId) {
            // Max attempts reached: raise a decision
            this.store.markFailing(machine, config.name);
            if (await this.raiseDecision(machine, config)) {
              summary.decisions++;
            }
          }
        }
      }

      summaries.push(summary);
    }

    this.lastTicks = summaries;
    this.lastError = undefined;
    return summaries;
  }

  private async probe(argv: string[]): Promise<ProbeResult> {
    const at = this.iso();
    try {
      const result = await this.probes.runner.run(argv, {
        timeoutMs: this.settings.probeTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });
      return {
        up: result.code === 0,
        code: result.code,
        output: (result.stdout + result.stderr).slice(0, 500),
        checkedAt: at,
      };
    } catch (e) {
      return {
        up: false,
        code: -1,
        output: e instanceof Error ? e.message : String(e),
        checkedAt: at,
      };
    }
  }

  private async startService(machine: string, config: ServiceConfig): Promise<void> {
    const at = this.iso();
    this.store.recordStart(machine, config.name, at);

    await this.events?.emit("host-service.starting", {
      project: this.project,
      machine,
      service: config.name,
    });

    try {
      await this.probes.runner.run(config.start, {
        timeoutMs: this.settings.startTimeoutSeconds * 1000,
        signal: this.abort.signal,
      });
    } catch (e) {
      console.warn(
        `[host-services] ${this.project}: failed to start ${config.name} on ${machine}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Wait before next probe to give service time to start
    await this.probes.clock.sleep(this.settings.startDelaySeconds * 1000, this.abort.signal);
  }

  private async raiseDecision(machine: string, config: ServiceConfig): Promise<boolean> {
    if (!this.decisions) return false;

    const key = `${machine}:${config.name}`;
    const input: RaiseDecisionInput = {
      project: this.project,
      kind: "other",
      attention: "action",
      title: `${config.name} on ${machine} is down and won't start`,
      context: `The service **${config.name}** on machine **${machine}** has been probed and found down.\n\n` +
        `Start command was run ${this.settings.maxStartAttempts} times but the service remains unavailable.\n\n` +
        `**Lanes held:** ${config.neededBy.length > 0 ? config.neededBy.join(", ") : "(none)"}\n\n` +
        `The probe command: \`${config.probe.join(" ")}\`\n\n` +
        `The start command: \`${config.start.join(" ")}\``,
      options: [
        {
          id: "fixed",
          label: "I fixed it",
          consequences: "Lair will probe again and resume normal operation if the service is up.",
        },
        {
          id: "acknowledged",
          label: "Acknowledged",
          consequences: "Lair will keep the lanes held until the service recovers on its own.",
        },
      ],
      recommended: { optionId: "fixed", reasoning: "The human should fix the underlying issue." },
      source: { module: DECISION_MODULE, ref: key },
      key,
      blocks: config.neededBy.map((lane) => `lane:${lane}`),
      links: [],
    };

    try {
      const result = await this.decisions.raise(input);
      if (result.created) {
        this.store.recordDecision(machine, config.name, result.decision.id);
        await this.events?.emit("host-service.decision", {
          project: this.project,
          machine,
          service: config.name,
          decisionId: result.decision.id,
        });
      }
      return result.created;
    } catch (e) {
      console.error(
        `[host-services] ${this.project}: failed to raise decision for ${config.name} on ${machine}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  private async withdrawDecision(machine: string, serviceName: string, decisionId: string): Promise<void> {
    if (!this.decisions) return;

    try {
      await this.decisions.withdraw(decisionId, {
        module: DECISION_MODULE,
        reason: `${serviceName} on ${machine} is now up.`,
      });
    } catch (e) {
      // Decision may have been answered already
      console.warn(
        `[host-services] ${this.project}: could not withdraw decision ${decisionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.store.clearDecision(machine, serviceName);
  }

  /** Get all lanes currently held by down services. */
  getHeldLanes(): LaneHold[] {
    const holds: LaneHold[] = [];
    const at = this.iso();
    for (const [machine, configs] of this.settings.machines) {
      const machineHolds = this.store.heldLanes(machine, configs);
      for (const [lane, info] of machineHolds) {
        holds.push({
          lane,
          reason: info.reason,
          heldAt: at,
          service: info.service,
          machine,
        });
      }
    }
    return holds;
  }

  /** Check if a specific lane is held by any down service. */
  isLaneHeld(lane: string): { held: boolean; reason: string | null } {
    for (const [machine, configs] of this.settings.machines) {
      const machineHolds = this.store.heldLanes(machine, configs);
      const hold = machineHolds.get(lane);
      if (hold) {
        return { held: true, reason: hold.reason };
      }
    }
    return { held: false, reason: null };
  }

  /** Get status of all services for a machine. */
  getServiceStatuses(machine: string): ServiceStatus[] {
    const configs = this.settings.machines.get(machine) ?? [];
    return configs.map((config) => this.store.status(machine, config.name, config));
  }

  /** Get status of all services for all machines. */
  getAllServiceStatuses(): Map<string, ServiceStatus[]> {
    const result = new Map<string, ServiceStatus[]>();
    for (const [machine, configs] of this.settings.machines) {
      result.set(machine, configs.map((config) => this.store.status(machine, config.name, config)));
    }
    return result;
  }

  /** Tick now, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.decisions && !this.unsubscribe) this.listen();
    if (this.abort.signal.aborted) {
      this.abort = new AbortController();
    }
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[host-services] ${this.project}: tick failed:`, e);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  /** Stop ticking. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
  }
}

/** Build a HostServices from a project config; throws when config is invalid. */
export function createHostServices(
  options: Omit<HostServicesOptions, "settings" | "store" | "probes"> & {
    store?: HostServicesStore;
    probes?: HostServicesProbes;
  },
): HostServices {
  const parsed = parseHostServicesConfig(options.config.host_services);
  if (!parsed.ok) {
    throw new Error(`Invalid host_services config for ${options.project}: ${parsed.errors.join("; ")}`);
  }
  return new HostServices({
    ...options,
    settings: parsed.settings,
    store: options.store ?? new HostServicesStore(),
    probes: options.probes ?? systemHostServicesProbes(parsed.settings.probeTimeoutSeconds * 1000),
  });
}

export interface HostServicesProjectStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  actBlocked: string | null;
  errors: string[];
  intervalSeconds: number | null;
  lastTicks: TickSummary[] | null;
  lastError: string | null;
  services: Map<string, ServiceStatus[]>;
  heldLanes: LaneHold[];
}

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

/** All projects' host-services. */
export class HostServicesManager {
  private services = new Map<string, HostServices>();
  private stores = new Map<string, HostServicesStore>();
  private problems = new Map<string, string[]>();
  private decisions?: DecisionProducer;
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(
    private options: {
      probes?: HostServicesProbes;
      events?: EventBus;
    } = {},
  ) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      const parsed = parseHostServicesConfig(entry.config.host_services);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[host-services] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;

      const store = new HostServicesStore();
      this.stores.set(entry.name, store);
      this.services.set(
        entry.name,
        new HostServices({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store,
          probes: this.options.probes ?? systemHostServicesProbes(parsed.settings.probeTimeoutSeconds * 1000),
          events: this.options.events,
        }),
      );
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    const old = this.services.get(entry.name);
    if (old) await old.stop();
    if (this.inPhase("stopped")) return;
    this.services.delete(entry.name);
    this.stores.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (!next) return;
    try {
      if (this.decisions) next.useDecisions(this.decisions);
      if (this.inPhase("started")) next.start();
    } catch (e) {
      await next.stop();
      this.services.delete(entry.name);
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.services.values()].map((s) => s.stop()));
    this.services.clear();
    this.stores.clear();
  }

  get(project: string): HostServices | undefined {
    return this.services.get(project);
  }

  useDecisions(decisions: DecisionProducer): void {
    this.decisions = decisions;
    for (const service of this.services.values()) service.useDecisions(decisions);
  }

  /** Check if a lane is held by any project's down services. */
  isLaneHeld(project: string, lane: string): { held: boolean; reason: string | null } {
    const service = this.services.get(project);
    if (!service) return { held: false, reason: null };
    return service.isLaneHeld(lane);
  }

  /** Get all held lanes across all projects. */
  getAllHeldLanes(): Map<string, LaneHold[]> {
    const result = new Map<string, LaneHold[]>();
    for (const [project, service] of this.services) {
      result.set(project, service.getHeldLanes());
    }
    return result;
  }

  status(project: string): HostServicesProjectStatus {
    const service = this.services.get(project);
    const settings = service ? (service as unknown as { settings: HostServicesSettings }).settings : undefined;
    return {
      project,
      enabled: service !== undefined,
      running: service?.running ?? false,
      mode: settings?.mode ?? null,
      actBlocked: service ? service.actBlocked : null,
      errors: this.problems.get(project) ?? [],
      intervalSeconds: settings?.intervalSeconds ?? null,
      lastTicks: service?.lastTicks ?? null,
      lastError: service?.lastError ?? null,
      services: service?.getAllServiceStatuses() ?? new Map(),
      heldLanes: service?.getHeldLanes() ?? [],
    };
  }
}
