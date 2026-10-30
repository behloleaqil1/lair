/**
 * Cloud machines (docs/configuration.md#cloud-machines,
 * docs/design/cloud-runners.md step 1). One CloudMachines per project with
 * `cloud.enabled: true` (off by default). Every `check_seconds` it
 *
 * 1. describes each machine's tagged instance (power state, last launch and
 *    stop) and records the run for the meter;
 * 2. reads the account's cost from the provider when the last reading is
 *    older than `budget.spend_check_hours` (each read may cost money);
 * 3. runs the money guard on both, and records a trip at the limit.
 *
 * startMachine() is the only way to a provider's start, and it runs the same
 * check first, on fresh readings: a refusal, a spend that can't be told or
 * an error means no start. Checks and starts run one at a time. Starting on
 * demand and stopping when idle (step 2) call it; until then the module only
 * observes, and its route is read-only.
 */
import type { EventBus } from "../core/event-bus.js";
import { systemClock, type Clock } from "../watchdog/probes.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  CloudBudgetStatus,
  CloudGuardStatus,
  CloudMachineStatus,
  CloudMeterSpend,
  CloudPowerState,
  CloudProviderSpend,
  CloudStatus,
} from "../../shared/cloud-types.js";
import { parseCloudConfig, type CloudBudgetSettings, type CloudMachineSettings, type CloudSettings } from "./config.js";
import { evaluateGuard, type GuardVerdict } from "./guard.js";
import { meterSpend } from "./meter.js";
import { AwsEc2Provider, providerText, sdkClients, type AwsClients, type CloudProvider, type PowerState } from "./provider.js";
import { CloudStore, type StoredSpend } from "./store.js";

const HOUR_MS = 3_600_000;

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

/** The SDK clients for one profile: the boundary tests fake */
export type ClientsFactory = (profile: string, timeoutMs: number) => AwsClients;

export interface StartResult {
  /** The guard allowed it, and the machine is starting or running */
  allowed: boolean;
  state: CloudPowerState;
  reason: string;
}

interface MachineRuntime {
  state: CloudPowerState;
  launchedAt: number | null;
  stoppedAt: number | null;
  lastCheckAt: number | null;
  lastError: string | null;
}

interface Check {
  at: number;
  meter: CloudMeterSpend | null;
  meterError: string | null;
  provider: CloudProviderSpend[];
  verdict: GuardVerdict;
}

/** An error as Lair keeps, logs and shows it: no ARN, account id or key id (providerText) */
function message(e: unknown): string {
  return providerText(e instanceof Error ? e.message : String(e));
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** `work`, or an error after `ms`: no provider call can hold a check or a start */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function publicSpend(reading: StoredSpend): CloudProviderSpend {
  return { profile: reading.profile, state: reading.state, amount: reading.amount, detail: reading.detail, readAt: reading.readAt };
}

export class CloudMachines {
  readonly project: string;
  readonly settings: CloudSettings;
  lastError: string | null = null;
  private budget: CloudBudgetSettings;
  private store: CloudStore;
  private clients: ClientsFactory;
  private clock: Pick<Clock, "now">;
  private events?: EventBus;
  private providers = new Map<string, CloudProvider>();
  private runtime = new Map<string, MachineRuntime>();
  private last: Check | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = true;

  constructor(options: {
    project: string;
    settings: CloudSettings;
    store: CloudStore;
    clients: ClientsFactory;
    clock: Pick<Clock, "now">;
    events?: EventBus;
  }) {
    if (!options.settings.budget) throw new Error("cloud.budget is needed");
    this.project = options.project;
    this.settings = options.settings;
    this.budget = options.settings.budget;
    this.store = options.store;
    this.clients = options.clients;
    this.clock = options.clock;
    this.events = options.events;
    for (const m of this.settings.machines) {
      this.runtime.set(m.id, { state: "unknown", launchedAt: null, stoppedAt: null, lastCheckAt: null, lastError: null });
    }
  }

  get running(): boolean {
    return !this.stopped;
  }

  private get timeoutMs(): number {
    return this.settings.requestTimeoutSeconds * 1000;
  }

  /** One provider per profile (one account) */
  private provider(machine: CloudMachineSettings): CloudProvider {
    let provider = this.providers.get(machine.profile);
    if (!provider) {
      provider = new AwsEc2Provider(this.clients(machine.profile, this.timeoutMs));
      this.providers.set(machine.profile, provider);
    }
    return provider;
  }

  private machine(id: string): CloudMachineSettings {
    const machine = this.settings.machines.find((m) => m.id === id);
    if (!machine) throw new Error(`no cloud machine ${id} in ${this.project}`);
    return machine;
  }

  /** Checks, starts and stops run one at a time, in the order asked */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Describe every machine, read the cost when due, and run the guard. */
  check(): Promise<GuardVerdict> {
    return this.serial(() => this.refresh());
  }

  /**
   * Start a machine. The guard runs first, on fresh readings: every machine
   * is described again, and the cost is read if its reading is due. A
   * refusal or a spend that can't be told means no start; an error before
   * the provider's start does too.
   */
  startMachine(id: string): Promise<StartResult> {
    return this.serial(async () => {
      const machine = this.machine(id);
      const verdict = await this.refresh();
      const rt = this.runtime.get(id) as MachineRuntime;
      if (!verdict.allowed) {
        console.warn(`[cloud] ${this.project}: ${id} not started: ${verdict.reason}`);
        return { allowed: false, state: rt.state, reason: verdict.reason };
      }
      const state = await withTimeout(this.provider(machine).start(machine), this.timeoutMs, `start ${id}`);
      rt.state = state;
      return { allowed: true, state, reason: verdict.reason };
    });
  }

  /** Stop a machine. Never guarded: stopping only saves money. */
  stopMachine(id: string): Promise<PowerState> {
    return this.serial(async () => {
      const machine = this.machine(id);
      const state = await withTimeout(this.provider(machine).stop(machine), this.timeoutMs, `stop ${id}`);
      (this.runtime.get(id) as MachineRuntime).state = state;
      return state;
    });
  }

  private async refresh(): Promise<GuardVerdict> {
    const now = this.clock.now();
    const budget = this.budget;
    const failures: string[] = [];
    await Promise.all(
      this.settings.machines.map(async (m) => {
        const rt = this.runtime.get(m.id) as MachineRuntime;
        rt.lastCheckAt = now;
        try {
          const desc = await withTimeout(this.provider(m).describe(m), this.timeoutMs, `describe ${m.id}`);
          rt.state = desc.state;
          rt.launchedAt = desc.launchedAt;
          rt.stoppedAt = desc.stoppedAt;
          rt.lastError = null;
          this.store.recordDescription(this.project, m, desc, now);
        } catch (e) {
          // A machine Lair can't see may be running: the meter can't be told
          rt.state = "unknown";
          rt.lastError = message(e);
          failures.push(`${m.id}: ${rt.lastError}`);
        }
      }),
    );
    const provider = await this.readSpend(now);
    const meter =
      failures.length > 0
        ? null
        : meterSpend({ runs: this.store.runs(this.project, budget.startMs, budget.endMs), machines: this.settings.machines, budget, now });
    const meterError = failures.length > 0 ? `describe failed for ${failures.join("; ")}` : null;
    const input = { budget, now, meter: meter?.total ?? null, meterError, provider };
    let verdict = evaluateGuard({ ...input, trip: this.store.trip(this.project, budget) });
    if (verdict.trips && verdict.spend !== null) {
      if (this.store.addTrip(this.project, budget, verdict.spend, verdict.reason, now)) {
        console.warn(`[cloud] ${this.project}: money guard tripped: ${verdict.reason}`);
        await this.events?.emit("cloud.guard_tripped", {
          project: this.project,
          limit: budget.limit,
          spend: verdict.spend,
          reason: verdict.reason,
        });
      }
      // From here on the recorded trip decides, whatever the next readings say
      verdict = evaluateGuard({ ...input, trip: this.store.trip(this.project, budget) });
    }
    this.last = { at: now, meter, meterError, provider, verdict };
    return verdict;
  }

  /** Each account's cost reading: the stored one while fresh, else a new read */
  private async readSpend(now: number): Promise<CloudProviderSpend[]> {
    const budget = this.budget;
    const profiles = [...new Set(this.settings.machines.map((m) => m.profile))];
    return Promise.all(
      profiles.map(async (profile): Promise<CloudProviderSpend> => {
        if (now < budget.startMs || now >= budget.endMs) {
          // The guard refuses outside the period anyway: no paid read
          return { profile, state: "not_read", amount: null, detail: "outside the budget period", readAt: null };
        }
        const stored = this.store.spend(this.project, profile, budget);
        if (
          stored &&
          stored.state !== "error" &&
          stored.readAtMs !== null &&
          stored.readAtMs <= now &&
          now - stored.readAtMs < budget.spendCheckHours * HOUR_MS
        ) {
          return publicSpend(stored);
        }
        const machine = this.settings.machines.find((m) => m.profile === profile) as CloudMachineSettings;
        const at = { readAt: iso(now), readAtMs: now };
        let reading: StoredSpend;
        try {
          const read = await withTimeout(
            this.provider(machine).spend({ start: budget.periodStart, end: budget.periodEnd }, now),
            this.timeoutMs,
            `cost reading for ${profile}`,
          );
          reading =
            read.kind === "amount"
              ? { profile, state: "amount", amount: read.amount, detail: null, ...at }
              : { profile, state: "unknown", amount: null, detail: read.reason, ...at };
        } catch (e) {
          reading = { profile, state: "error", amount: null, detail: message(e), ...at };
        }
        this.store.saveSpend(this.project, budget, reading);
        return publicSpend(reading);
      }),
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.pruneRuns(this.clock.now());
    const loop = async () => {
      if (this.stopped) return;
      this.ticking = this.check().then(
        () => {
          this.lastError = null;
        },
        (e) => {
          // The text only: the error object would print the provider's own message, account and all
          this.lastError = message(e);
          console.error(`[cloud] ${this.project}: check failed: ${this.lastError}`);
        },
      );
      await this.ticking;
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.checkSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref();
  }

  /** Stop checking; a check, start or stop in progress finishes first. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.queue.catch(() => undefined);
  }

  get lastCheck(): number | null {
    return this.last?.at ?? null;
  }

  machineStatuses(): CloudMachineStatus[] {
    return this.settings.machines.map((m) => {
      const rt = this.runtime.get(m.id) as MachineRuntime;
      return {
        id: m.id,
        provider: m.provider,
        region: m.region,
        instanceId: m.instanceId,
        tag: `${m.tagKey}=${m.tagValue}`,
        state: rt.state,
        launchedAt: iso(rt.launchedAt),
        stoppedAt: iso(rt.stoppedAt),
        lastCheckAt: iso(rt.lastCheckAt),
        lastError: rt.lastError,
        pricePerHour: m.pricePerHour,
        storagePerMonth: m.storagePerMonth,
      };
    });
  }

  budgetStatus(): CloudBudgetStatus {
    const b = this.budget;
    const last = this.last;
    const trip = this.store.trip(this.project, b);
    const guard: CloudGuardStatus = last
      ? { state: last.verdict.state, allowed: last.verdict.allowed, reason: last.verdict.reason, trip: null, checkedAt: iso(last.at) }
      : { state: trip ? "tripped" : "refused", allowed: false, reason: "not checked yet", trip: null, checkedAt: null };
    guard.trip = trip ? { limit: trip.limit, spend: trip.spend, at: new Date(trip.at).toISOString(), reason: trip.reason } : null;
    const spend = last?.verdict.spend ?? null;
    return {
      limit: b.limit,
      currency: "USD",
      period: { start: b.periodStart, end: b.periodEnd },
      warnPercent: b.warnPercent,
      spend,
      percent: spend === null ? null : Math.round((spend / b.limit) * 1000) / 10,
      meter: last?.meter ?? null,
      meterError: last?.meterError ?? null,
      provider: last?.provider ?? [],
      guard,
    };
  }
}

/** Every project's cloud machines, as src/server/index.ts wires them. */
export class CloudManager {
  private instances = new Map<string, CloudMachines>();
  private problems = new Map<string, string[]>();
  private store: CloudStore | null = null;
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(
    private options: { dbPath: string; clients?: ClientsFactory; clock?: Pick<Clock, "now">; events?: EventBus },
  ) {}

  /** What load() would refuse in a project's config ([] when valid). */
  validate(config: ProjectConfig): string[] {
    const parsed = parseCloudConfig(config.cloud);
    return parsed.ok ? [] : parsed.errors;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) continue;
      const parsed = parseCloudConfig(entry.config.cloud);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[cloud] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      // Off: no client is made and no provider is called
      if (!parsed.settings.enabled) continue;
      this.store ??= new CloudStore(this.options.dbPath);
      this.instances.set(
        entry.name,
        new CloudMachines({
          project: entry.name,
          settings: parsed.settings,
          store: this.store,
          clients: this.options.clients ?? sdkClients,
          clock: this.options.clock ?? systemClock,
          events: this.options.events,
        }),
      );
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const instance of this.instances.values()) instance.start();
    return [...this.instances.keys()];
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  /** Apply a project's new config: its instance stops, then the new one starts. */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    const old = this.instances.get(entry.name);
    if (old) await old.stop();
    if (this.inPhase("stopped")) return;
    this.instances.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    const next = this.instances.get(entry.name);
    if (next && this.inPhase("started")) next.start();
  }

  async stop(): Promise<void> {
    this.phase = "stopped";
    await Promise.all([...this.instances.values()].map((i) => i.stop()));
    this.store?.close();
    this.store = null;
    this.instances.clear();
  }

  get(project: string): CloudMachines | undefined {
    return this.instances.get(project);
  }

  status(project: string): CloudStatus {
    const instance = this.instances.get(project);
    return {
      project,
      enabled: instance !== undefined,
      errors: this.problems.get(project) ?? [],
      checkSeconds: instance?.settings.checkSeconds ?? null,
      lastCheck: iso(instance?.lastCheck ?? null),
      lastError: instance?.lastError ?? null,
      machines: instance?.machineStatuses() ?? [],
      budget: instance?.budgetStatus() ?? null,
    };
  }
}
