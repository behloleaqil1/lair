/**
 * One delivery environment: a docker compose project.
 *
 * - read(): every service's containers (`docker compose ps`, `docker
 *   inspect`) and health check, and the last error lines of a service that
 *   isn't running healthy. On ticks it also samples restart counts: a count
 *   that rises by crash_loop.max_restarts within crash_loop.window_minutes
 *   marks the service crash-looping (the watchdog's crash_loop detector reads
 *   the mark).
 * - request(): Up, Down, Restart, Deploy and Release, run one at a time in
 *   the background as recorded operations (every argv, exit code and output).
 * - checkMerge(): with deploy.auto, deploys the services a new commit on
 *   deploy.ref changed.
 *
 * What Lair never does on its own: start a held service (Up skips it, a
 * deploy skips it, the watchdog leaves its container alone), restart a
 * crash-looping one (only a per-service action by a human does, and that
 * clears the mark), or start a stopped one in an automatic deploy. Every
 * compose call starts services with --no-deps, so a held dependency is never
 * started as a side effect.
 */
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { CommandOutput } from "../watchdog/probes.js";
import { placeholdersIn } from "../watchdog/config.js";
import { countRestarts } from "../watchdog/detectors.js";
import type { ContainerCrashLoop } from "../watchdog/types.js";
import {
  CONTAINER_NAME,
  PREVIOUS_TAG,
  composeBase,
  errorLines,
  imageRepository,
  isImageId,
  isImageRef,
  parseComposePs,
  parseInspect,
  type InspectEntry,
  type PsEntry,
} from "./compose.js";
import { pathMatches, type DeliverySettings, type EnvironmentSettings, type ServiceSettings } from "./config.js";
import type { DeliveryProbes } from "./probes.js";
import type { DeliveryStore } from "./store.js";
import type {
  ContainerInfo,
  CrashLoop,
  EnvironmentStatus,
  Operation,
  OperationKind,
  OperationStatus,
  OperationStep,
  RequestedBy,
  ServiceStatus,
} from "./types.js";

/** Everything an environment needs for one project. */
export interface DeliveryContext {
  project: string;
  config: ProjectConfig;
  settings: DeliverySettings;
  store: DeliveryStore;
  probes: DeliveryProbes;
  events?: EventBus;
  /** Aborted by Delivery.stop(): waits end early and no further command starts */
  signal: AbortSignal;
}

export interface OperationRequest {
  kind: OperationKind;
  /** One service; undefined for the whole environment */
  service?: string;
  /** An environment deploy: the services to deploy (default: every service with build: true) */
  services?: string[];
  by: RequestedBy;
  reason?: string;
  sha?: string;
}

export type RequestResult =
  | { ok: true; operation: Operation }
  | { ok: false; code: 400 | 403 | 404 | 409; error: string };

type Outcome = { status: OperationStatus; error?: string };

/** How often Up, Restart and Deploy re-read a service while waiting for it to be healthy */
const POLL_MS = 5000;
const OUTPUT_TAIL = 2000;
const MAX_ERROR_LINES = 10;
const MAX_SAMPLE_EVIDENCE = 10;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

class Stopping extends Error {
  constructor() {
    super("stopped: Lair is shutting down");
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

function duration(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 1000)} s`;
}

/** Running, and healthy (or running without a health check to ask). */
export function isHealthy(status: ServiceStatus): boolean {
  return status.state === "running" && (status.health === "healthy" || status.health === "none");
}

function toContainer(ps: PsEntry, inspect: InspectEntry | undefined): ContainerInfo {
  const errors = [inspect?.error, inspect?.health?.lastFailure].filter((e): e is string => !!e);
  return {
    id: ps.id,
    name: inspect?.name || ps.name,
    state: inspect?.restarting ? "restarting" : ps.state || inspect?.status || "",
    status: ps.status,
    exitCode: inspect?.exitCode ?? ps.exitCode,
    restartCount: inspect?.restartCount ?? 0,
    imageId: inspect?.imageId || undefined,
    imageRef: inspect?.imageRef || ps.image || undefined,
    health: inspect?.health?.status ?? ps.health,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

/** Fill prepare_cmd's placeholders; a value that would read as an option is refused. */
function fillPrepare(template: string[], vars: Record<string, string>): { argv: string[] } | { error: string } {
  for (const name of placeholdersIn(template)) {
    if (vars[name] === undefined) return { error: `deploy.prepare_cmd: no value for {${name}}` };
  }
  const argv: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => vars[name] ?? "");
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `deploy.prepare_cmd: ${arg} would start with "-" and read as an option` };
    }
    argv.push(filled);
  }
  return { argv };
}

export class EnvironmentController {
  private snapshot: { at: number; services: ServiceStatus[] } | null = null;
  private readError: string | null = null;
  private current: { operation: Operation; done: Promise<void> } | null = null;
  /** Why deploy.auto is not acting (read_only), or null */
  autoDeployBlocked: string | null = null;

  constructor(
    private ctx: DeliveryContext,
    readonly env: EnvironmentSettings,
  ) {}

  get name(): string {
    return this.env.name;
  }

  private get readOnly(): boolean {
    return this.ctx.config.read_only === true;
  }

  private iso(ms = this.ctx.probes.clock.now()): string {
    return new Date(ms).toISOString();
  }

  private compose(...args: string[]): string[] {
    return [...composeBase(this.ctx.settings.dockerCmd, this.env), ...args];
  }

  private docker(...args: string[]): string[] {
    return [...this.ctx.settings.dockerCmd, ...args];
  }

  private run(argv: string[], timeoutSeconds = this.ctx.settings.commandTimeoutSeconds): Promise<CommandOutput> {
    return this.ctx.probes.runner.run(argv, { timeoutMs: timeoutSeconds * 1000 });
  }

  service(name: string): ServiceSettings | undefined {
    return this.env.services.find((s) => s.name === name);
  }

  // ============ READING ============

  /**
   * Read every service. `sample`: record restart counts and mark or clear
   * crash loops (ticks only). `logs`: read the last error lines of services
   * that aren't running healthy.
   */
  async read(options: { sample?: boolean; logs?: boolean } = {}): Promise<ServiceStatus[]> {
    const now = this.ctx.probes.clock.now();
    try {
      const ps = await this.run(this.compose("ps", "--all", "--format", "json"));
      if (ps.code !== 0) {
        throw new Error(`docker compose ps exited ${ps.code}: ${ps.stderr.trim().slice(0, 300)}`);
      }
      const known = new Set(this.env.services.map((s) => s.name));
      const entries = parseComposePs(ps.stdout).filter((e) => known.has(e.service));
      // inspect prints the containers it found even when one is gone (exit 1)
      const inspected =
        entries.length > 0 ? parseInspect((await this.run(this.docker("inspect", ...entries.map((e) => e.id)))).stdout) : [];
      const previous = this.snapshot;
      const services: ServiceStatus[] = [];
      for (const service of this.env.services) {
        const containers = entries
          .filter((e) => e.service === service.name)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => toContainer(e, inspected.find((i) => i.id.startsWith(e.id))));
        const status = await this.serviceStatus(service, containers);
        if (options.sample) await this.sample(status, now);
        if (options.logs && this.needsLogs(status)) {
          status.lastErrorLines = await this.lastErrorLines(status);
        } else if (!isHealthy(status)) {
          status.lastErrorLines =
            status.crashLoop?.errorLines ??
            previous?.services.find((s) => s.name === service.name)?.lastErrorLines ??
            [];
        }
        services.push(status);
      }
      this.snapshot = { at: now, services };
      this.readError = null;
      return services;
    } catch (e) {
      this.readError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  private async serviceStatus(service: ServiceSettings, containers: ContainerInfo[]): Promise<ServiceStatus> {
    const { store, project } = this.ctx;
    const base = {
      name: service.name,
      restartCount: containers.reduce((n, c) => n + c.restartCount, 0),
      containers,
      held: store.getHold(project, this.env.name, service.name),
      crashLoop: store.getCrashLoop(project, this.env.name, service.name),
      lastErrorLines: [] as string[],
      buildable: service.build,
    };
    const restarting = containers.find((c) => c.state === "restarting");
    if (restarting) {
      return { ...base, state: "restarting", health: "unknown", healthDetail: restarting.status || "restarting" };
    }
    const running = containers.filter((c) => c.state === "running");
    if (running.length === 0) {
      return {
        ...base,
        state: "stopped",
        health: "unknown",
        healthDetail:
          containers.length === 0 ? "no container" : containers.map((c) => c.status || c.state).join("; "),
      };
    }
    const check = service.health;
    if (check.type === "http") {
      const answer = await this.ctx.probes.http.get(check.url, check.timeoutSeconds * 1000);
      if ("error" in answer) {
        return { ...base, state: "unhealthy", health: "unhealthy", healthDetail: `GET ${check.url}: ${answer.error}` };
      }
      const ok =
        check.expectStatus !== undefined
          ? answer.status === check.expectStatus
          : answer.status >= 200 && answer.status < 400;
      return {
        ...base,
        state: ok ? "running" : "unhealthy",
        health: ok ? "healthy" : "unhealthy",
        healthDetail: `GET ${check.url}: ${answer.status}`,
      };
    }
    const unhealthy = running.find((c) => c.health === "unhealthy");
    if (unhealthy) {
      return {
        ...base,
        state: "unhealthy",
        health: "unhealthy",
        healthDetail: `docker health check: unhealthy${unhealthy.error ? ` (${unhealthy.error.slice(0, 200)})` : ""}`,
      };
    }
    if (running.some((c) => c.health === "starting")) {
      return { ...base, state: "running", health: "starting", healthDetail: "docker health check: starting" };
    }
    if (running.every((c) => c.health === "healthy")) {
      return { ...base, state: "running", health: "healthy", healthDetail: "docker health check: healthy" };
    }
    return { ...base, state: "running", health: "none", healthDetail: "running (the image has no HEALTHCHECK)" };
  }

  private needsLogs(status: ServiceStatus): boolean {
    if (status.held || status.containers.length === 0) return false;
    if (status.crashLoop || status.state === "restarting" || status.state === "unhealthy") return true;
    return status.state === "stopped" && status.containers.some((c) => c.state !== "created" && c.exitCode !== 0);
  }

  private async lastErrorLines(status: ServiceStatus): Promise<string[]> {
    const docker = status.containers.map((c) => c.error).filter((e): e is string => !!e);
    const out = await this.run(this.compose("logs", "--no-color", "--no-log-prefix", "--tail", "200", status.name));
    const logged = out.code === 0 ? errorLines(out.stdout, MAX_ERROR_LINES) : [];
    return [...docker, ...logged].slice(-MAX_ERROR_LINES);
  }

  /** Record a restart-count sample, and mark or clear a crash loop. */
  private async sample(status: ServiceStatus, now: number): Promise<void> {
    const { store, project, events } = this.ctx;
    const env = this.env.name;
    if (status.held || status.containers.length === 0) return;
    const { maxRestarts, windowMinutes } = this.env.crashLoop;
    const window = windowMinutes * 60000;
    store.addSample(project, env, status.name, now, status.restartCount);
    const samples = store.samples(project, env, status.name, now - window);
    const restarts = countRestarts(samples);
    const evidence = (lines: string[]) => [
      ...samples.slice(-MAX_SAMPLE_EVIDENCE).map((s) => `${this.iso(s.at)} restart count ${s.restartCount}`),
      ...lines.map((line) => `log: ${line}`),
    ];

    if (restarts >= maxRestarts) {
      const container = [...status.containers].sort((a, b) => b.restartCount - a.restartCount)[0];
      if (!CONTAINER_NAME.test(container.name)) return;
      const lines = await this.lastErrorLines(status);
      const loop: CrashLoop = {
        project,
        environment: env,
        service: status.name,
        container: container.name,
        restarts,
        maxRestarts,
        windowMinutes,
        since: status.crashLoop?.since ?? this.iso(now),
        evidence: evidence(lines),
        errorLines: lines,
      };
      store.setCrashLoop(loop);
      const isNew = status.crashLoop === null;
      status.crashLoop = loop;
      status.lastErrorLines = lines;
      if (isNew) {
        console.warn(`[delivery] ${project}/${env}: ${status.name} is crash-looping (${restarts} restarts in ${windowMinutes} min)`);
        await events?.emit("delivery.crash_loop", {
          project,
          environment: env,
          service: status.name,
          container: container.name,
          restarts,
          errorLines: lines,
        });
      }
      return;
    }
    // A loop that ended by itself: no restart for a whole window, and running healthy
    if (status.crashLoop && restarts === 0 && isHealthy(status) && now - Date.parse(status.crashLoop.since) >= window) {
      store.clearCrashLoop(project, env, status.name);
      status.crashLoop = null;
      await events?.emit("delivery.crash_loop_cleared", { project, environment: env, service: status.name });
    }
  }

  /** Status for the API: the latest read (made now if there is none), with fresh holds and crash loops. */
  async status(): Promise<EnvironmentStatus> {
    const { store, project } = this.ctx;
    if (!this.snapshot) {
      try {
        await this.read({ logs: true });
      } catch {
        // shown as `error`
      }
    }
    const services = this.env.services.map((service) => {
      const read = this.snapshot?.services.find((s) => s.name === service.name);
      return {
        ...(read ?? {
          name: service.name,
          state: "stopped" as const,
          health: "unknown" as const,
          healthDetail: "not read yet",
          restartCount: 0,
          containers: [],
          lastErrorLines: [],
          buildable: service.build,
        }),
        held: store.getHold(project, this.env.name, service.name),
        crashLoop: store.getCrashLoop(project, this.env.name, service.name),
      };
    });
    const running = this.current ? store.getOperation(this.current.operation.id) : null;
    return {
      environment: this.env.name,
      composeProject: this.env.projectName,
      checkedAt: this.snapshot ? this.iso(this.snapshot.at) : null,
      error: this.readError,
      services,
      operation: running,
      autoDeploy: {
        enabled: this.env.deploy.auto,
        ref: this.env.deploy.ref,
        lastSha: store.seenSha(project, this.env.name),
        blocked: this.autoDeployBlocked,
      },
    };
  }

  // ============ FOR THE WATCHDOG ============

  crashLoops(): ContainerCrashLoop[] {
    return this.ctx.store
      .crashLoops(this.ctx.project)
      .filter((loop) => loop.environment === this.env.name)
      .map((loop) => ({
        container: loop.container,
        service: loop.service,
        environment: loop.environment,
        restarts: loop.restarts,
        maxRestarts: loop.maxRestarts,
        windowMinutes: loop.windowMinutes,
        evidence: loop.evidence,
      }));
  }

  /** Why a container must be left alone (it belongs to a held service), or null. */
  heldReason(container: string): string | null {
    for (const hold of this.ctx.store.holds(this.ctx.project, this.env.name)) {
      if (this.belongsTo(container, hold.service)) {
        return `container ${container} is service ${hold.service} of delivery environment ${this.env.name}, held by a human: ${hold.reason}`;
      }
    }
    return null;
  }

  private belongsTo(container: string, service: string): boolean {
    const read = this.snapshot?.services.find((s) => s.name === service);
    if (read?.containers.some((c) => c.name === container)) return true;
    // Not read yet, or removed by a Down: Compose names containers <project>-<service>-<n>
    const prefix = `${this.env.projectName}-${service}-`;
    return container.startsWith(prefix) && /^\d+$/.test(container.slice(prefix.length));
  }

  // ============ OPERATIONS ============

  /** The operation in progress, if any. */
  get busy(): Operation | null {
    return this.current?.operation ?? null;
  }

  /** Resolves once no operation is running. */
  async idle(): Promise<void> {
    while (this.current) await this.current.done;
  }

  /**
   * Start an operation. Checks run now (the answer is immediate); the
   * commands run in the background. A Down holds right away, so nothing can
   * start the service while it is being stopped.
   */
  request(req: OperationRequest): RequestResult {
    const { store, project } = this.ctx;
    const env = this.env.name;
    if (this.readOnly) return { ok: false, code: 403, error: "the project is read_only" };
    if (this.ctx.signal.aborted) return { ok: false, code: 409, error: "delivery is stopping" };
    const target = req.service;
    if (target !== undefined && !this.service(target)) {
      return { ok: false, code: 404, error: `no service ${target} in environment ${env}` };
    }
    const at = this.iso();

    if (req.kind === "release") {
      if (target === undefined) return { ok: false, code: 400, error: "release a held service, not an environment" };
      const hold = store.getHold(project, env, target);
      if (!hold) return { ok: false, code: 409, error: `service ${target} is not held` };
      store.releaseHold(project, env, target);
      void this.ctx.events?.emit("delivery.released", { project, environment: env, service: target, by: req.by });
      return {
        ok: true,
        operation: store.createOperation({
          project,
          environment: env,
          kind: "release",
          services: [target],
          requestedBy: req.by,
          status: "succeeded",
          startedAt: at,
          completedAt: at,
          steps: [{ at, service: target, action: "release", status: "succeeded", detail: `released (held: ${hold.reason})` }],
        }),
      };
    }

    if (this.current) {
      return { ok: false, code: 409, error: `environment ${env} is busy: ${this.current.operation.kind} started ${this.current.operation.startedAt}` };
    }

    let services = target !== undefined ? [target] : [];
    if (req.kind === "deploy") {
      services = target !== undefined ? [target] : (req.services ?? this.env.services.filter((s) => s.build).map((s) => s.name));
      if (services.length === 0) return { ok: false, code: 400, error: `no service in ${env} has build: true` };
      for (const name of services) {
        const service = this.service(name);
        if (!service) return { ok: false, code: 404, error: `no service ${name} in environment ${env}` };
        if (!service.build) return { ok: false, code: 400, error: `service ${name} has no build: true, so it can't be deployed` };
      }
    }
    if (req.by === "human" && req.kind !== "down") {
      // An environment Up or Restart skips held services; asking for one by name is refused
      const named = req.kind === "deploy" || target !== undefined ? services : [];
      for (const name of named) {
        const hold = store.getHold(project, env, name);
        if (hold) return { ok: false, code: 409, error: `service ${name} is held (${hold.reason}): release it first` };
      }
    }
    const reason = req.reason?.trim();
    if (req.kind === "down" && !reason) return { ok: false, code: 400, error: "a reason is required to take services down" };

    const steps: OperationStep[] = [];
    const operation = store.createOperation({
      project,
      environment: env,
      kind: req.kind,
      services,
      requestedBy: req.by,
      reason: reason || undefined,
      sha: req.sha,
      status: "running",
      startedAt: at,
      steps,
    });
    if (req.kind === "down" && reason) {
      const names = target !== undefined ? [target] : this.env.services.map((s) => s.name);
      for (const name of names) {
        const existing = store.getHold(project, env, name);
        // An environment Down keeps a service's own hold (it outlives an environment Up)
        if (target === undefined && existing) continue;
        const source = target !== undefined ? "service" : "environment";
        store.setHold({ project, environment: env, service: name, reason, source, heldAt: at });
        steps.push({ at, service: name, action: "hold", status: "succeeded", detail: `held (${source}): ${reason}` });
        void this.ctx.events?.emit("delivery.held", { project, environment: env, service: name, reason, source });
      }
      store.updateOperation(operation.id, { steps });
    }
    // Start on the next microtask, after `current` is set; never reject (nobody may be waiting)
    const done = Promise.resolve()
      .then(() => this.execute(operation, steps))
      .catch((e) => {
        console.error(`[delivery] ${project}/${env}: ${req.kind} failed to finish:`, e);
        if (this.current?.operation.id === operation.id) this.current = null;
      });
    this.current = { operation, done };
    return { ok: true, operation: store.getOperation(operation.id)! };
  }

  private async execute(op: Operation, steps: OperationStep[]): Promise<void> {
    const { store, project, events } = this.ctx;
    await events?.emit("delivery.started", {
      project,
      environment: op.environment,
      operationId: op.id,
      kind: op.kind,
      services: op.services,
      by: op.requestedBy,
    });
    let outcome: Outcome;
    try {
      outcome = await this.perform(op, steps);
    } catch (e) {
      outcome = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    // Read before reporting the end, so a finished operation never comes with a stale status
    if (!this.ctx.signal.aborted) {
      try {
        await this.read({ logs: true });
      } catch {
        // shown as the environment's read error
      }
    }
    store.updateOperation(op.id, { status: outcome.status, error: outcome.error, completedAt: this.iso(), steps });
    if (this.current?.operation.id === op.id) this.current = null;
    await events?.emit("delivery.finished", {
      project,
      environment: op.environment,
      operationId: op.id,
      kind: op.kind,
      status: outcome.status,
      error: outcome.error ?? null,
    });
  }

  private record(op: Operation, steps: OperationStep[], step: Omit<OperationStep, "at">): void {
    steps.push({ at: this.iso(), ...step });
    this.ctx.store.updateOperation(op.id, { steps });
  }

  /** Run one command as a step; true when it exited 0. Throws when Lair is stopping. */
  private async command(
    op: Operation,
    steps: OperationStep[],
    action: string,
    service: string | undefined,
    argv: string[],
    timeoutSeconds?: number,
  ): Promise<boolean> {
    if (this.ctx.signal.aborted) {
      this.record(op, steps, { action, service, status: "skipped", argv, detail: "Lair is stopping" });
      throw new Stopping();
    }
    const out = await this.run(argv, timeoutSeconds);
    const output = tail([out.stdout.trim(), out.stderr.trim()].filter((s) => s !== "").join("\n"));
    this.record(op, steps, {
      action,
      service,
      status: out.code === 0 ? "succeeded" : "failed",
      argv,
      code: out.code,
      output: output || undefined,
    });
    return out.code === 0;
  }

  private skip(op: Operation, steps: OperationStep[], service: string, detail: string): void {
    this.record(op, steps, { action: "skip", service, status: "skipped", detail });
  }

  private skipRest(op: Operation, steps: OperationStep[], services: ServiceSettings[], detail: string): void {
    for (const service of services) this.skip(op, steps, service.name, detail);
  }

  /** Why Lair must not start or restart this service on its own, or null. */
  private leaveAlone(name: string): string | null {
    const { store, project } = this.ctx;
    const hold = store.getHold(project, this.env.name, name);
    if (hold) return `held: ${hold.reason}`;
    const loop = store.getCrashLoop(project, this.env.name, name);
    if (loop) {
      return `crash-looping since ${loop.since} (${loop.restarts} restarts in ${loop.windowMinutes} min): Lair doesn't restart it; act on the service itself to retry`;
    }
    return null;
  }

  /** A human acting on a crash-looping service by name clears the mark. */
  private clearCrashLoop(op: Operation, steps: OperationStep[], name: string): void {
    const { store, project } = this.ctx;
    if (store.clearCrashLoop(project, this.env.name, name)) {
      this.record(op, steps, { action: "clear-crash-loop", service: name, status: "succeeded", detail: `asked for by ${op.requestedBy}` });
      void this.ctx.events?.emit("delivery.crash_loop_cleared", { project, environment: this.env.name, service: name });
    }
  }

  private async perform(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const one = op.kind !== "deploy" && op.services.length === 1 ? op.services[0] : undefined;
    switch (op.kind) {
      case "up":
        return one !== undefined ? this.upService(op, steps, one) : this.upAll(op, steps);
      case "down":
        return one !== undefined ? this.downService(op, steps, one) : this.downAll(op, steps);
      case "restart":
        return one !== undefined ? this.restartService(op, steps, one) : this.restartAll(op, steps);
      case "deploy":
        return this.deploy(op, steps);
      case "release":
        return { status: "succeeded" };
    }
  }

  /** `up -d --no-deps` or `restart` one service, then wait for it to be healthy. */
  private async start(
    op: Operation,
    steps: OperationStep[],
    name: string,
    how: "up" | "restart",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const argv = how === "up" ? this.compose("up", "-d", "--no-deps", name) : this.compose("restart", name);
    if (!(await this.command(op, steps, how, name, argv))) {
      return { ok: false, error: `${how} ${name} failed` };
    }
    const wait = await this.waitHealthy(name, this.env.startTimeoutSeconds * 1000);
    this.record(op, steps, { action: "wait", service: name, status: wait.ok ? "succeeded" : "failed", detail: wait.detail });
    return wait.ok ? { ok: true } : { ok: false, error: `${name}: ${wait.detail}` };
  }

  /** Start every service in start order, each healthy before the next; held and crash-looping ones are skipped. */
  private async upAll(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const { store, project } = this.ctx;
    for (const hold of store.holds(project, this.env.name)) {
      if (hold.source !== "environment") continue;
      store.releaseHold(project, this.env.name, hold.service);
      this.record(op, steps, {
        action: "release",
        service: hold.service,
        status: "succeeded",
        detail: `the environment Up releases the environment Down's hold (${hold.reason})`,
      });
      void this.ctx.events?.emit("delivery.released", { project, environment: this.env.name, service: hold.service, by: op.requestedBy });
    }
    const services = this.env.services;
    for (let i = 0; i < services.length; i++) {
      const name = services[i].name;
      const why = this.leaveAlone(name);
      if (why) {
        this.skip(op, steps, name, why);
        continue;
      }
      const started = await this.start(op, steps, name, "up");
      if (!started.ok) {
        this.skipRest(op, steps, services.slice(i + 1), `not started: ${name} did not become healthy`);
        return { status: "failed", error: started.error };
      }
    }
    return { status: "succeeded" };
  }

  private async upService(op: Operation, steps: OperationStep[], name: string): Promise<Outcome> {
    const hold = this.ctx.store.getHold(this.ctx.project, this.env.name, name);
    if (hold) {
      this.skip(op, steps, name, `held: ${hold.reason}`);
      return { status: "failed", error: `service ${name} is held (${hold.reason})` };
    }
    this.clearCrashLoop(op, steps, name);
    const started = await this.start(op, steps, name, "up");
    return started.ok ? { status: "succeeded" } : { status: "failed", error: started.error };
  }

  private async downAll(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const ok = await this.command(op, steps, "down", undefined, this.compose("down"));
    return ok ? { status: "succeeded" } : { status: "failed", error: "docker compose down failed" };
  }

  private async downService(op: Operation, steps: OperationStep[], name: string): Promise<Outcome> {
    const ok = await this.command(op, steps, "stop", name, this.compose("stop", name));
    return ok ? { status: "succeeded" } : { status: "failed", error: `stop ${name} failed (it stays held)` };
  }

  /** Restart every service that has a container, in start order; held and crash-looping ones are skipped. */
  private async restartAll(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const current = await this.read();
    const services = this.env.services;
    for (let i = 0; i < services.length; i++) {
      const name = services[i].name;
      const why = this.leaveAlone(name);
      if (why) {
        this.skip(op, steps, name, why);
        continue;
      }
      if ((current.find((s) => s.name === name)?.containers.length ?? 0) === 0) {
        this.skip(op, steps, name, "no container: nothing to restart (use Up)");
        continue;
      }
      const restarted = await this.start(op, steps, name, "restart");
      if (!restarted.ok) {
        this.skipRest(op, steps, services.slice(i + 1), `not restarted: ${name} did not become healthy`);
        return { status: "failed", error: restarted.error };
      }
    }
    return { status: "succeeded" };
  }

  private async restartService(op: Operation, steps: OperationStep[], name: string): Promise<Outcome> {
    const hold = this.ctx.store.getHold(this.ctx.project, this.env.name, name);
    if (hold) {
      this.skip(op, steps, name, `held: ${hold.reason}`);
      return { status: "failed", error: `service ${name} is held (${hold.reason})` };
    }
    const current = (await this.read()).find((s) => s.name === name);
    if (!current || current.containers.length === 0) {
      this.skip(op, steps, name, "no container: nothing to restart (use Up)");
      return { status: "failed", error: `service ${name} has no container to restart` };
    }
    this.clearCrashLoop(op, steps, name);
    const restarted = await this.start(op, steps, name, "restart");
    return restarted.ok ? { status: "succeeded" } : { status: "failed", error: restarted.error };
  }

  /** Re-read the environment until the service is healthy, or `timeoutMs` has passed. */
  private async waitHealthy(name: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
    const clock = this.ctx.probes.clock;
    const start = clock.now();
    const deadline = start + timeoutMs;
    for (;;) {
      let detail: string;
      try {
        const status = (await this.read()).find((s) => s.name === name);
        if (status && isHealthy(status)) {
          return { ok: true, detail: `healthy after ${duration(clock.now() - start)} (${status.healthDetail})` };
        }
        detail = status ? `${status.state}: ${status.healthDetail}` : "not found";
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      if (this.ctx.signal.aborted) return { ok: false, detail: `Lair is stopping (${detail})` };
      const left = deadline - clock.now();
      if (left <= 0) return { ok: false, detail: `not healthy within ${duration(timeoutMs)} (${detail})` };
      await clock.sleep(Math.min(POLL_MS, left), this.ctx.signal);
    }
  }

  // ============ DEPLOY ============

  /**
   * Deploy services in start order: tag the image each one runs, build, roll
   * it, wait for it to be healthy, and roll back to the tagged image when it
   * isn't within deploy.health_timeout_minutes. A service that isn't deployed
   * stops the deploy (the later ones may need it).
   */
  private async deploy(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const { store, project } = this.ctx;
    const auto = op.requestedBy === "auto";
    const prepare = this.env.deploy.prepareCmd;
    if (auto && prepare) {
      const built = fillPrepare(prepare, {
        sha: op.sha ?? "",
        ref: this.env.deploy.ref,
        environment: this.env.name,
        project,
      });
      if ("error" in built) {
        this.record(op, steps, { action: "prepare", status: "failed", detail: built.error });
        return { status: "failed", error: built.error };
      }
      if (!(await this.command(op, steps, "prepare", undefined, built.argv, this.ctx.settings.buildTimeoutSeconds))) {
        return { status: "failed", error: "deploy.prepare_cmd failed" };
      }
    }
    const current = await this.read();
    const targets = this.env.services.filter((s) => op.services.includes(s.name));
    for (let i = 0; i < targets.length; i++) {
      const name = targets[i].name;
      const status = current.find((s) => s.name === name);
      const hold = store.getHold(project, this.env.name, name);
      if (hold) {
        this.skip(op, steps, name, `held: ${hold.reason}`);
        continue;
      }
      if (auto) {
        const why = this.leaveAlone(name);
        if (why) {
          this.skip(op, steps, name, why);
          continue;
        }
        if (!status || status.state === "stopped") {
          this.skip(op, steps, name, "not running: an automatic deploy never starts a stopped service");
          continue;
        }
      } else {
        this.clearCrashLoop(op, steps, name);
      }
      const result = await this.deployService(op, steps, name, status);
      if (result.status !== "succeeded") {
        this.skipRest(op, steps, targets.slice(i + 1), `not deployed: ${name} was not`);
        return result;
      }
    }
    return { status: "succeeded" };
  }

  private async deployService(
    op: Operation,
    steps: OperationStep[],
    name: string,
    status: ServiceStatus | undefined,
  ): Promise<Outcome> {
    const primary = status?.containers[0];
    let previous: { ref: string; tag: string } | null = null;
    if (primary) {
      const ref = primary.imageRef ?? "";
      const id = primary.imageId ?? "";
      const repository = imageRepository(ref);
      if (!repository || !isImageId(id) || !isImageRef(ref)) {
        const detail = `can't tag the image ${name} runs (${ref || "unknown"}), so there would be no way back: not deploying`;
        this.record(op, steps, { action: "tag", service: name, status: "failed", detail });
        return { status: "failed", error: detail };
      }
      const tag = `${repository}:${PREVIOUS_TAG}`;
      if (!(await this.command(op, steps, "tag", name, this.docker("tag", id, tag)))) {
        return { status: "failed", error: `could not tag the previous image of ${name}` };
      }
      previous = { ref, tag };
    } else {
      this.record(op, steps, {
        action: "tag",
        service: name,
        status: "skipped",
        detail: "no container yet: there is no previous image to roll back to",
      });
    }

    if (!(await this.command(op, steps, "build", name, this.compose("build", name), this.ctx.settings.buildTimeoutSeconds))) {
      return { status: "failed", error: `build of ${name} failed; the running container was not touched` };
    }
    const rolled = await this.command(op, steps, "roll", name, this.compose("up", "-d", "--no-deps", "--no-build", name));
    let why: string;
    if (rolled) {
      const timeout = this.env.deploy.healthTimeoutMinutes * 60000;
      const wait = await this.waitHealthy(name, timeout);
      this.record(op, steps, { action: "wait", service: name, status: wait.ok ? "succeeded" : "failed", detail: wait.detail });
      if (wait.ok) return { status: "succeeded" };
      why = wait.detail;
    } else {
      why = "the new container did not start";
    }
    if (!previous) {
      return { status: "failed", error: `${name}: ${why}; no previous image to roll back to` };
    }
    return this.rollback(op, steps, name, previous, why);
  }

  /** Point the image reference back at the tagged previous image and recreate the container. */
  private async rollback(
    op: Operation,
    steps: OperationStep[],
    name: string,
    previous: { ref: string; tag: string },
    why: string,
  ): Promise<Outcome> {
    if (!(await this.command(op, steps, "rollback", name, this.docker("tag", previous.tag, previous.ref)))) {
      return { status: "failed", error: `${name}: ${why}; rollback failed: could not re-tag ${previous.tag}` };
    }
    if (
      !(await this.command(
        op,
        steps,
        "rollback",
        name,
        this.compose("up", "-d", "--no-deps", "--no-build", "--force-recreate", name),
      ))
    ) {
      return { status: "failed", error: `${name}: ${why}; rollback failed: the previous image did not start` };
    }
    const wait = await this.waitHealthy(name, this.env.startTimeoutSeconds * 1000);
    this.record(op, steps, { action: "wait", service: name, status: wait.ok ? "succeeded" : "failed", detail: wait.detail });
    return wait.ok
      ? { status: "rolled_back", error: `${name}: ${why}; rolled back to ${previous.tag}` }
      : { status: "failed", error: `${name}: ${why}; rolled back, but the previous image is not healthy either (${wait.detail})` };
  }

  // ============ AFTER A MERGE ============

  /**
   * With deploy.auto: when deploy.ref points at a new commit, deploy the
   * services whose paths it changed. The first commit seen is taken as what
   * runs now. Each commit is tried once; a deploy that rolls back waits for
   * the next merge.
   */
  async checkMerge(): Promise<void> {
    const deploy = this.env.deploy;
    if (!deploy.auto) {
      this.autoDeployBlocked = null;
      return;
    }
    if (this.readOnly) {
      this.autoDeployBlocked = "the project is read_only";
      return;
    }
    this.autoDeployBlocked = null;
    if (this.current) return; // the next tick looks again
    const { store, project } = this.ctx;
    const repo = deploy.repo ?? this.ctx.config.repo;
    const rev = await this.run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${deploy.ref}^{commit}`]);
    const sha = rev.stdout.trim();
    if (rev.code !== 0 || !COMMIT.test(sha)) {
      throw new Error(`git rev-parse ${deploy.ref} exited ${rev.code}: ${rev.stderr.trim().slice(0, 200)}`);
    }
    const seen = store.seenSha(project, this.env.name);
    if (seen === sha) return;
    store.setSeenSha(project, this.env.name, sha, this.iso());
    if (seen === null) return;
    const diff = await this.run(["git", "-C", repo, "diff", "--name-only", seen, sha]);
    if (diff.code !== 0) {
      throw new Error(`git diff ${seen.slice(0, 12)} ${sha.slice(0, 12)} exited ${diff.code}: ${diff.stderr.trim().slice(0, 200)}`);
    }
    const files = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const changed = this.env.services.filter(
      (s) => s.build && s.paths.some((path) => files.some((file) => pathMatches(path, file))),
    );
    if (changed.length === 0) return;
    const result = this.request({ kind: "deploy", services: changed.map((s) => s.name), by: "auto", sha });
    if (!result.ok) throw new Error(`deploy of ${sha.slice(0, 12)} not started: ${result.error}`);
  }

  /** One tick: read (sampling restart counts), then look for a merge. */
  async tick(): Promise<void> {
    await this.read({ sample: true, logs: true });
    await this.checkMerge();
  }
}
