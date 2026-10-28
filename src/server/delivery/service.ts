/**
 * The delivery service: one Delivery per project with `delivery.enabled`,
 * holding one EnvironmentController per configured environment.
 *
 * Each tick (every interval_seconds) reads every environment, sampling
 * restart counts for crash loops, and with deploy.auto looks for a merge.
 * Operations (Up, Down, Restart, Deploy, Release) come from the routes, or
 * from a tick for an automatic deploy.
 *
 * DeliveryManager is also the watchdog's view of these containers
 * (ContainerServices): the crash loops delivery marked, and the holds.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { ProjectEntry } from "../watchdog/service.js";
import type { ContainerCrashLoop, ContainerServices } from "../watchdog/types.js";
import { parseDeliveryConfig, type DeliverySettings } from "./config.js";
import { EnvironmentController, type DeliveryContext } from "./environment.js";
import { systemDeliveryProbes, type DeliveryProbes } from "./probes.js";
import { DeliveryStore } from "./store.js";
import type { DeliveryProjectStatus, EnvironmentStatus, Hold } from "./types.js";
import { asContextText, HoldDecisions, type OwnerHold } from "../decisions/holds.js";
import type { DecisionProducer } from "../decisions/types.js";

/** The module delivery's hold decisions are raised as */
export const DELIVERY_DECISION_MODULE = "delivery";

/** One decision per held service and hold (a Down after a release is a new hold) */
export const deliveryHoldKey = (hold: Pick<Hold, "environment" | "service" | "heldAt">) =>
  `hold:${hold.environment}:${hold.service}:${hold.heldAt}`;

export interface DeliveryOptions {
  project: string;
  config: ProjectConfig;
  settings: DeliverySettings;
  store: DeliveryStore;
  probes: DeliveryProbes;
  events?: EventBus;
}

export class Delivery {
  readonly project: string;
  readonly environments: EnvironmentController[];
  private ctx: DeliveryContext;
  private abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = true;
  /** One decision per held service: only the owner releases one */
  private readonly holdDecisions: HoldDecisions;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  lastError?: string;

  constructor(options: DeliveryOptions) {
    this.project = options.project;
    this.holdDecisions = new HoldDecisions(DELIVERY_DECISION_MODULE, options.project);
    this.ctx = {
      project: options.project,
      config: options.config,
      settings: options.settings,
      store: options.store,
      probes: options.probes,
      events: options.events,
      signal: this.abort.signal,
      holdsChanged: () => void this.reconcileHolds(),
    };
    // Operations a previous run left marked running were cut off by its stop
    options.store.failInterrupted(options.project, new Date(options.probes.clock.now()).toISOString());
    this.environments = options.settings.environments.map((env) => new EnvironmentController(this.ctx, env));
  }

  get settings(): DeliverySettings {
    return this.ctx.settings;
  }

  get readOnly(): boolean {
    return this.ctx.config.read_only === true;
  }

  get running(): boolean {
    return !this.stopped;
  }

  environment(name: string): EnvironmentController | undefined {
    return this.environments.find((env) => env.name === name);
  }

  /**
   * Ask through the Decision Inbox: every held service gets its one decision
   * (also one held while Lair was down), and answering "Release it"
   * releases it as the owner, as the Release button does.
   */
  async useDecisions(producer: DecisionProducer): Promise<void> {
    this.holdDecisions.use(producer, async (key) => {
      const hold = this.ctx.store.holds(this.project).find((h) => deliveryHoldKey(h) === key);
      if (!hold) return; // released meanwhile, or held again since (a new hold, with its own decision)
      const result = this.environment(hold.environment)?.request({ kind: "release", service: hold.service, by: "human" });
      if (result && !result.ok) {
        console.warn(`[delivery] ${this.project}: could not release ${hold.environment}/${hold.service} as answered: ${result.error}`);
      }
    });
    await this.reconcileHolds();
  }

  /**
   * Every hold has its decision and every decision a hold: raised when a
   * service is held, withdrawn when it is released (in Delivery, or by an
   * environment Up). One at a time; a change meanwhile reconciles again.
   */
  reconcileHolds(): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        try {
          const holds = this.ctx.store.holds(this.project).map((hold) => this.holdQuestion(hold));
          await this.holdDecisions.reconcile(holds, () => "The service was released.");
        } catch (e) {
          console.warn(`[delivery] ${this.project}: could not match the holds' decisions: ${e instanceof Error ? e.message : String(e)}`);
        }
      } while (this.reconcileAgain);
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** A held service's decision, in plain words (the Down's reason is the owner's own text: in the context). */
  private holdQuestion(hold: Hold): OwnerHold {
    const where = `${hold.service} in ${hold.environment}`;
    return {
      key: deliveryHoldKey(hold),
      ref: `${hold.environment}/${hold.service}`,
      title: `${where} is stopped and held: Up and deploys skip it until you release it`,
      context: [
        `${hold.source === "environment" ? `An environment Down of ${hold.environment}` : `A Down of ${hold.service}`} held it at ${hold.heldAt}, with this reason:`,
        "",
        "```text",
        asContextText(hold.reason),
        "```",
        "",
        "Lair never starts a held service: not an Up, a deploy, a restart or the watchdog.",
      ].join("\n"),
      releaseLabel: "Release it",
      releaseConsequences: `${where} is no longer held: the next Up or deploy starts it again (releasing doesn't start it by itself).`,
      keepLabel: "Keep it held",
      keepConsequences: "It stays stopped until you release it in Delivery. Nothing more is asked about it.",
      blocks: [`delivery:${this.project}:${hold.environment}:${hold.service}`],
    };
  }

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const errors: string[] = [];
    for (const env of this.environments) {
      if (this.ctx.signal.aborted) break;
      try {
        await env.tick();
      } catch (e) {
        errors.push(`${env.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.lastError = errors.length > 0 ? errors.join("; ") : undefined;
    // What a raise that failed (or a crash between a hold and its decision) left behind
    await this.reconcileHolds();
  }

  /** Resolves once no environment has an operation running. */
  async idle(): Promise<void> {
    await Promise.all(this.environments.map((env) => env.idle()));
  }

  /** Tick now, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.abort.signal.aborted) {
      this.abort = new AbortController();
      this.ctx.signal = this.abort.signal;
    }
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[delivery] ${this.project}: tick failed:`, e);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.ctx.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  /**
   * Stop ticking. A wait in progress ends early and no further command
   * starts; resolves once the tick and any operation in progress have ended.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.idle();
    await this.reconciling;
    // Answers given from now on wait in the inbox for the next Delivery (a reload, a restart)
    this.holdDecisions.close();
  }

  /**
   * Stop for a config reload: no new tick or operation starts (requests get
   * 409), while the tick and the operation in progress run to the end; their
   * commands are not killed. Then stop() as usual.
   */
  async drain(): Promise<void> {
    this.ctx.closing = true;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.idle();
    await this.stop();
  }

  async status(errors: string[] = []): Promise<DeliveryProjectStatus> {
    const environments: EnvironmentStatus[] = [];
    for (const env of this.environments) environments.push(await env.status());
    return {
      project: this.project,
      enabled: true,
      running: this.running,
      readOnly: this.readOnly,
      errors,
      lastError: this.lastError ?? null,
      environments,
    };
  }

  crashLoops(): ContainerCrashLoop[] {
    return this.environments.flatMap((env) => env.crashLoops());
  }

  heldReason(container: string): string | null {
    for (const env of this.environments) {
      const reason = env.heldReason(container);
      if (reason) return reason;
    }
    return null;
  }
}

/** Build a Delivery from a project config; throws when `delivery:` is invalid. */
export function createDelivery(options: Omit<DeliveryOptions, "settings">): Delivery {
  const parsed = parseDeliveryConfig(options.config.delivery);
  if (!parsed.ok) {
    throw new Error(`Invalid delivery config for ${options.project}: ${parsed.errors.join("; ")}`);
  }
  return new Delivery({ ...options, settings: parsed.settings });
}

/**
 * All projects' deliveries. The store (data/delivery.db) is opened only when
 * at least one project enables delivery.
 */
export class DeliveryManager implements ContainerServices {
  private deliveries = new Map<string, Delivery>();
  private problems = new Map<string, string[]>();
  private readOnly = new Map<string, boolean>();
  private store: DeliveryStore | null = null;
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";
  /** The Decision Inbox, once useDecisions() connected it */
  private producer: DecisionProducer | null = null;

  constructor(
    private options: {
      dbPath: string;
      probes?: DeliveryProbes;
      events?: EventBus;
    },
  ) {}

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      this.readOnly.set(entry.name, entry.config.read_only === true);
      const parsed = parseDeliveryConfig(entry.config.delivery);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[delivery] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new DeliveryStore(this.options.dbPath);
      this.deliveries.set(
        entry.name,
        new Delivery({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.store,
          probes: this.options.probes ?? systemDeliveryProbes(parsed.settings.commandTimeoutSeconds * 1000),
          events: this.options.events,
        }),
      );
      // A project loaded after the inbox was connected (a reload) follows its holds' decisions too
      const loaded = this.deliveries.get(entry.name);
      if (loaded && this.producer) void this.follow(loaded);
    }
  }

  /**
   * Follow the held services through the Decision Inbox (src/server/index.ts
   * calls this once the inbox is mounted): every hold gets its one decision,
   * and answering one releases its service.
   */
  useDecisions(producer: DecisionProducer): Promise<void> {
    this.producer = producer;
    return Promise.all([...this.deliveries.values()].map((delivery) => this.follow(delivery))).then(() => undefined);
  }

  private async follow(delivery: Delivery): Promise<void> {
    if (!this.producer) return;
    try {
      await delivery.useDecisions(this.producer);
    } catch (e) {
      console.warn(`[delivery] ${delivery.project}: could not follow its holds' decisions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const delivery of this.deliveries.values()) delivery.start();
    return [...this.deliveries.keys()];
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  /** The operations running now, e.g. "deploy of shop/local (since ...)" (a restart waits for them). */
  busy(): string[] {
    return [...this.deliveries.entries()].flatMap(([project, delivery]) =>
      delivery.environments.flatMap((env) => {
        const op = env.busy;
        return op ? [`${op.kind} of ${project}/${env.name} (since ${op.startedAt})`] : [];
      }),
    );
  }

  /**
   * Apply a project's new config (src/server/reload/): its delivery drains
   * (the operation in progress finishes, new ones get 409), then the new one
   * starts. Other projects are not touched. A delivery that fails to start is
   * stopped and removed before the error is thrown, so the project's
   * delivery is either running or off. A shutdown during the drain wins.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    const old = this.deliveries.get(entry.name);
    if (old) await old.drain();
    if (this.inPhase("stopped")) return;
    this.deliveries.delete(entry.name);
    this.problems.delete(entry.name);
    this.readOnly.delete(entry.name);
    this.load([entry]);
    const next = this.deliveries.get(entry.name);
    if (!next || !this.inPhase("started")) return;
    try {
      next.start();
    } catch (e) {
      await next.stop();
      this.deliveries.delete(entry.name);
      throw e;
    }
  }

  /** Stop every delivery, wait for ticks and operations in progress, then close the store. */
  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.deliveries.values()].map((delivery) => delivery.stop()));
    this.deliveries.clear();
    this.store?.close();
    this.store = null;
  }

  get(project: string): Delivery | undefined {
    return this.deliveries.get(project);
  }

  /** The project's config errors and its last error, without asking its environments (the supervisor's module_errors check). */
  report(project: string): { errors: string[]; lastError: string | null } {
    return { errors: this.problems.get(project) ?? [], lastError: this.deliveries.get(project)?.lastError ?? null };
  }

  getStore(): DeliveryStore | null {
    return this.store;
  }

  async status(project: string): Promise<DeliveryProjectStatus> {
    const errors = this.problems.get(project) ?? [];
    const delivery = this.deliveries.get(project);
    if (delivery) return delivery.status(errors);
    return {
      project,
      enabled: false,
      running: false,
      readOnly: this.readOnly.get(project) ?? false,
      errors,
      lastError: null,
      environments: [],
    };
  }

  // ============ ContainerServices (read by the watchdog) ============

  covers(project: string): boolean {
    return this.deliveries.has(project);
  }

  crashLoops(project: string): ContainerCrashLoop[] {
    return this.deliveries.get(project)?.crashLoops() ?? [];
  }

  heldReason(project: string, container: string): string | null {
    return this.deliveries.get(project)?.heldReason(container) ?? null;
  }
}
