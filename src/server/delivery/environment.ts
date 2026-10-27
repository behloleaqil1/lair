/**
 * One delivery environment: a docker compose project.
 *
 * - read(): every service's containers (`docker compose ps`, `docker
 *   inspect`) and health check, and the last error lines of a service that
 *   isn't running healthy. On ticks it also samples restart counts: a count
 *   that rises by crash_loop.max_restarts within crash_loop.window_minutes
 *   marks the service crash-looping (the watchdog's crash_loop detector reads
 *   the mark). When the environment can't be read, every service is
 *   `unknown`, and Up, Restart and Deploy wait until it can be.
 * - request(): Up, Down, Restart, Deploy and Release, run one at a time in
 *   the background as recorded operations (every argv, exit code and output,
 *   redacted). A Down may also run while another operation is in progress:
 *   that operation re-checks holds before each command, so it never starts
 *   or recreates what the human just stopped.
 * - checkMerge(): with deploy.auto, deploys the services whose paths changed
 *   since the commit each one was last deployed at, so a service a rollback
 *   left behind comes again with the next merge.
 * - recoverInterrupted(): after a restart, rolls back what a deploy cut off
 *   by the stop had built or rolled but never seen healthy.
 *
 * What Lair never does on its own: start a held service (Up skips it, a
 * deploy skips it, the watchdog leaves its container alone), restart a
 * crash-looping one (only a per-service action by a human does, and that
 * clears the mark), or start a stopped one in an automatic deploy. Every
 * compose call names the configured services and starts them with
 * --no-deps, so neither a held dependency nor a service Lair doesn't manage
 * is started or removed as a side effect.
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
import { redact } from "./redact.js";
import type { DeliveryStore } from "./store.js";
import type {
  ContainerInfo,
  CrashLoop,
  EnvironmentStatus,
  Hold,
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
  /** Aborted by Delivery.stop(): running commands are killed, waits end, no further command starts */
  signal: AbortSignal;
  /** Set by Delivery.drain() (a config reload): no new operation starts, the one running finishes */
  closing?: boolean;
  /** A hold was set or released: its one Decision Inbox item is raised or withdrawn (Delivery) */
  holdsChanged?: () => void;
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
type Started = { ok: true } | { ok: false; held: boolean; error: string };
type Waited = { ok: boolean; held?: boolean; detail: string };
type Previous = { ref: string; tag: string };

/** How often Up, Restart and Deploy re-read a service while waiting for it to be healthy */
const POLL_MS = 5000;
const OUTPUT_TAIL = 2000;
const MAX_ERROR_LINES = 10;
const MAX_SAMPLE_EVIDENCE = 10;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

class Stopping extends Error {
  constructor() {
    super("interrupted: Lair is shutting down");
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
    error: errors.length > 0 ? redact(errors.join("; ")) : undefined,
  };
}

/** Fill a command's {placeholders}; a value that would read as an option is refused. */
function fill(key: string, template: string[], vars: Record<string, string>): { argv: string[] } | { error: string } {
  for (const name of placeholdersIn(template)) {
    if (vars[name] === undefined) return { error: `${key}: no value for {${name}}` };
  }
  const argv: string[] = [];
  for (const arg of template) {
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => vars[name] ?? "");
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `${key}: ${arg} would start with "-" and read as an option` };
    }
    argv.push(filled);
  }
  return { argv };
}

export class EnvironmentController {
  private snapshot: { at: number; services: ServiceStatus[] } | null = null;
  private readError: string | null = null;
  /** Reads are numbered; an older read never overwrites a newer one's result */
  /** A commit to try once more although it was seen: its deploy was interrupted and recovered */
  private retrySha: string | null = null;
  private readSeq = 0;
  private appliedSeq = 0;
  private current: { operation: Operation; done: Promise<void> } | null = null;
  /** Downs that run while another operation is in progress */
  private sides = new Set<Promise<void>>();
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

  /** Every command gets the stop signal: a stop kills it instead of waiting out a build. */
  private run(argv: string[], timeoutSeconds = this.ctx.settings.commandTimeoutSeconds): Promise<CommandOutput> {
    return this.ctx.probes.runner.run(argv, { timeoutMs: timeoutSeconds * 1000, signal: this.ctx.signal });
  }

  service(name: string): ServiceSettings | undefined {
    return this.env.services.find((s) => s.name === name);
  }

  private holdOf(name: string): Hold | null {
    return this.ctx.store.getHold(this.ctx.project, this.env.name, name);
  }

  // ============ READING ============

  /**
   * Read every service. `sample`: record restart counts and mark or clear
   * crash loops (ticks only). `logs`: read the last error lines of services
   * that aren't running healthy.
   */
  async read(options: { sample?: boolean; logs?: boolean } = {}): Promise<ServiceStatus[]> {
    const seq = ++this.readSeq;
    const now = this.ctx.probes.clock.now();
    try {
      const ps = await this.run(this.compose("ps", "--all", "--format", "json"));
      if (ps.code !== 0) {
        throw new Error(`docker compose ps exited ${ps.code}: ${redact(ps.stderr.trim().slice(0, 300))}`);
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
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.snapshot = { at: now, services };
        this.readError = null;
        for (const s of services) {
          if (s.containers.length > 0) {
            this.ctx.store.setContainerNames(this.ctx.project, this.env.name, s.name, s.containers.map((c) => c.name));
          }
        }
      }
      return services;
    } catch (e) {
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.readError = redact(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  }

  private shaFields(name: string): { deployedSha: string | null; behind: boolean } {
    const { deployedSha, targetSha } = this.ctx.store.serviceShas(this.ctx.project, this.env.name, name);
    return { deployedSha, behind: targetSha !== null && targetSha !== deployedSha };
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
      ...this.shaFields(service.name),
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
        return {
          ...base,
          state: "unhealthy",
          health: "unhealthy",
          healthDetail: redact(`GET ${check.url}: ${answer.error}`),
        };
      }
      const ok =
        check.expectStatus !== undefined
          ? answer.status === check.expectStatus
          : answer.status >= 200 && answer.status < 400;
      return {
        ...base,
        state: ok ? "running" : "unhealthy",
        health: ok ? "healthy" : "unhealthy",
        healthDetail: redact(`GET ${check.url}: ${answer.status}`),
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
    return [...docker, ...logged].slice(-MAX_ERROR_LINES).map(redact);
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

  /**
   * Status for the API. It never runs a command (the tick reads every
   * interval_seconds), so a request never waits on docker. When the last
   * read failed, or there was none yet, every service is `unknown`: a stale
   * "running" or a guessed "stopped" would both mislead.
   */
  async status(): Promise<EnvironmentStatus> {
    const { store, project } = this.ctx;
    const services = this.env.services.map((service): ServiceStatus => {
      const read = this.readError === null ? this.snapshot?.services.find((s) => s.name === service.name) : undefined;
      return {
        ...(read ?? {
          name: service.name,
          state: "unknown" as const,
          health: "unknown" as const,
          healthDetail: this.readError !== null ? `can't read the environment: ${this.readError}` : "not read yet",
          restartCount: 0,
          containers: [],
          lastErrorLines: [],
          buildable: service.build,
        }),
        held: store.getHold(project, this.env.name, service.name),
        crashLoop: store.getCrashLoop(project, this.env.name, service.name),
        ...this.shaFields(service.name),
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

  /**
   * Whether a container is one of a service's: from the latest read, else
   * the names last read (kept in the store, so this holds right after a
   * restart and for a custom container_name), else Compose's default name
   * <project>-<service>-<n> for a service never read.
   */
  private belongsTo(container: string, service: string): boolean {
    const read = this.snapshot?.services.find((s) => s.name === service);
    if (read?.containers.some((c) => c.name === container)) return true;
    const known = this.ctx.store.containerNames(this.ctx.project, this.env.name, service);
    if (known.includes(container)) return true;
    const prefix = `${this.env.projectName}-${service}-`;
    return container.startsWith(prefix) && /^\d+$/.test(container.slice(prefix.length));
  }

  // ============ OPERATIONS ============

  /** The operation in progress, if any (a Down running beside it is not counted). */
  get busy(): Operation | null {
    return this.current?.operation ?? null;
  }

  /** Resolves once no operation is running. */
  async idle(): Promise<void> {
    while (this.current || this.sides.size > 0) {
      await Promise.all([this.current?.done, ...this.sides]);
    }
  }

  /**
   * Start an operation. Checks run now (the answer is immediate); the
   * commands run in the background. A Down holds right away, so nothing can
   * start the service while it is being stopped, and it runs even while
   * another operation is in progress.
   */
  request(req: OperationRequest): RequestResult {
    const { store, project } = this.ctx;
    const env = this.env.name;
    if (this.readOnly) return { ok: false, code: 403, error: "the project is read_only" };
    if (this.ctx.signal.aborted) return { ok: false, code: 409, error: "delivery is stopping" };
    if (this.ctx.closing) return { ok: false, code: 409, error: "delivery is reloading its config: try again in a moment" };
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
      this.ctx.holdsChanged?.();
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
          steps: [{ at, service: target, action: "release", status: "succeeded", detail: redact(`released (held: ${hold.reason})`) }],
        }),
      };
    }
    if (req.kind === "recover") return { ok: false, code: 400, error: "recover runs on its own after a restart" };

    const beside = req.kind === "down" && this.current !== null;
    if (this.current && !beside) {
      return { ok: false, code: 409, error: `environment ${env} is busy: ${this.current.operation.kind} started ${this.current.operation.startedAt}` };
    }
    if (this.readError !== null && (req.kind === "up" || req.kind === "restart" || req.kind === "deploy")) {
      return {
        ok: false,
        code: 409,
        error: `environment ${env} can't be read (${this.readError}): Up, Restart and Deploy wait until it can`,
      };
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
    // A service asked for by name must not be held; an environment-wide Up,
    // Restart or Deploy skips held services instead
    if (req.by === "human" && req.kind !== "down" && target !== undefined) {
      const hold = store.getHold(project, env, target);
      if (hold) return { ok: false, code: 409, error: redact(`service ${target} is held (${hold.reason}): release it first`) };
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
      reason: reason ? redact(reason) : undefined,
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
        this.record(operation, steps, { action: "hold", service: name, status: "succeeded", detail: `held (${source}): ${reason}` });
        void this.ctx.events?.emit("delivery.held", { project, environment: env, service: name, reason, source });
      }
      this.ctx.holdsChanged?.();
    }
    return this.launch(operation, steps, { beside });
  }

  /** Run an operation in the background; it never rejects (nobody may be waiting). */
  private launch(
    operation: Operation,
    steps: OperationStep[],
    options: { beside?: boolean; perform?: () => Promise<Outcome> } = {},
  ): RequestResult {
    const { project } = this.ctx;
    const done: Promise<void> = Promise.resolve()
      .then(() => this.execute(operation, steps, options.perform))
      .catch((e) => {
        console.error(`[delivery] ${project}/${this.env.name}: ${operation.kind} failed to finish:`, e);
        if (this.current?.operation.id === operation.id) this.current = null;
      })
      .finally(() => {
        this.sides.delete(done);
      });
    if (options.beside) this.sides.add(done);
    else this.current = { operation, done };
    return { ok: true, operation: this.ctx.store.getOperation(operation.id)! };
  }

  private async execute(op: Operation, steps: OperationStep[], perform?: () => Promise<Outcome>): Promise<void> {
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
      outcome = await (perform ? perform() : this.perform(op, steps));
    } catch (e) {
      outcome =
        e instanceof Stopping
          ? { status: "interrupted", error: e.message }
          : { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    // Cut short by a stop: interrupted, so a deploy is recovered on the next start
    if (this.ctx.signal.aborted && outcome.status !== "succeeded") {
      outcome = { status: "interrupted", error: outcome.error ?? "interrupted: Lair is shutting down" };
    }
    // Read before reporting the end, so a finished operation never comes with a stale status
    if (!this.ctx.signal.aborted) {
      try {
        await this.read({ logs: true });
      } catch {
        // shown as the environment's read error
      }
    }
    const error = outcome.error === undefined ? undefined : redact(outcome.error);
    store.updateOperation(op.id, { status: outcome.status, error, completedAt: this.iso(), steps });
    if (this.current?.operation.id === op.id) this.current = null;
    await events?.emit("delivery.finished", {
      project,
      environment: op.environment,
      operationId: op.id,
      kind: op.kind,
      status: outcome.status,
      error: error ?? null,
    });
  }

  /** Append a step (redacted) and save the operation's steps. */
  private record(op: Operation, steps: OperationStep[], step: Omit<OperationStep, "at">): void {
    steps.push({
      at: this.iso(),
      ...step,
      argv: step.argv?.map(redact),
      output: step.output === undefined ? undefined : redact(step.output),
      detail: step.detail === undefined ? undefined : redact(step.detail),
    });
    this.ctx.store.updateOperation(op.id, { steps });
  }

  /** Run one command as a step; true when it exited 0. Throws when Lair is stopping. */
  private async command(
    op: Operation,
    steps: OperationStep[],
    action: string,
    service: string | undefined,
    argv: string[],
    options: { timeoutSeconds?: number; ref?: string } = {},
  ): Promise<boolean> {
    if (this.ctx.signal.aborted) {
      this.record(op, steps, { action, service, status: "skipped", argv, detail: "Lair is stopping" });
      throw new Stopping();
    }
    const out = await this.run(argv, options.timeoutSeconds);
    const output = tail([out.stdout.trim(), out.stderr.trim()].filter((s) => s !== "").join("\n"));
    if (this.ctx.signal.aborted) {
      this.record(op, steps, { action, service, status: "failed", argv, code: out.code, output: output || undefined, detail: "killed: Lair is stopping", ref: options.ref });
      throw new Stopping();
    }
    this.record(op, steps, {
      action,
      service,
      status: out.code === 0 ? "succeeded" : "failed",
      argv,
      code: out.code,
      output: output || undefined,
      ref: options.ref,
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

  /** A human acting on a crash-looping service by name clears the mark; true when there was one. */
  private clearCrashLoop(op: Operation, steps: OperationStep[], name: string): boolean {
    const { store, project } = this.ctx;
    if (!store.clearCrashLoop(project, this.env.name, name)) return false;
    this.record(op, steps, { action: "clear-crash-loop", service: name, status: "succeeded", detail: `asked for by ${op.requestedBy}` });
    void this.ctx.events?.emit("delivery.crash_loop_cleared", { project, environment: this.env.name, service: name });
    return true;
  }

  private async perform(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const one = op.kind !== "deploy" && op.services.length === 1 ? op.services[0] : undefined;
    switch (op.kind) {
      case "up":
        return one !== undefined ? this.upService(op, steps, one) : this.upAll(op, steps);
      case "down":
        return this.down(op, steps, one);
      case "restart":
        return one !== undefined ? this.restartService(op, steps, one) : this.restartAll(op, steps);
      case "deploy":
        return this.deploy(op, steps);
      case "release":
      case "recover":
        return { status: "succeeded" };
    }
  }

  /**
   * Start one service and wait for it to be healthy. "recreate" is an Up
   * with --force-recreate: the container comes back with the compose file's
   * settings (a crash-loop playbook may have set its restart policy to no).
   * A service held meanwhile is not started.
   */
  private async start(op: Operation, steps: OperationStep[], name: string, how: "up" | "restart" | "recreate"): Promise<Started> {
    const hold = this.holdOf(name);
    if (hold) {
      this.skip(op, steps, name, `held: ${hold.reason}`);
      return { ok: false, held: true, error: `service ${name} is held (${hold.reason})` };
    }
    const argv =
      how === "restart"
        ? this.compose("restart", name)
        : this.compose("up", "-d", "--no-deps", ...(how === "recreate" ? ["--force-recreate"] : []), name);
    if (!(await this.command(op, steps, how === "restart" ? "restart" : "up", name, argv))) {
      return { ok: false, held: false, error: `${how} ${name} failed` };
    }
    const wait = await this.waitHealthy(name, this.env.startTimeoutSeconds * 1000);
    this.record(op, steps, {
      action: "wait",
      service: name,
      status: wait.ok ? "succeeded" : wait.held ? "skipped" : "failed",
      detail: wait.detail,
    });
    if (wait.held) await this.stopHeld(op, steps, name);
    return wait.ok ? { ok: true } : { ok: false, held: wait.held === true, error: `${name}: ${wait.detail}` };
  }

  /**
   * A Down that lands while Lair is starting the service races that start:
   * its stop can run before the container is up. So when a wait ends because
   * the service got held, stop it again: a held service never stays running.
   */
  private async stopHeld(op: Operation, steps: OperationStep[], name: string): Promise<void> {
    await this.command(op, steps, "stop", name, this.compose("stop", name));
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
      this.ctx.holdsChanged?.();
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
      if (!started.ok && !started.held) {
        this.skipRest(op, steps, services.slice(i + 1), `not started: ${name} did not become healthy`);
        return { status: "failed", error: started.error };
      }
    }
    return { status: "succeeded" };
  }

  private async upService(op: Operation, steps: OperationStep[], name: string): Promise<Outcome> {
    const cleared = this.clearCrashLoop(op, steps, name);
    const started = await this.start(op, steps, name, cleared ? "recreate" : "up");
    return started.ok ? { status: "succeeded" } : { status: "failed", error: started.error };
  }

  /**
   * Stop the configured services (one, or all of them in reverse start
   * order). Never `docker compose down`: that would remove services of the
   * compose project Lair doesn't manage, which no Up brings back.
   */
  private async down(op: Operation, steps: OperationStep[], one: string | undefined): Promise<Outcome> {
    const names = one !== undefined ? [one] : [...this.env.services].reverse().map((s) => s.name);
    const ok = await this.command(op, steps, "stop", one, this.compose("stop", ...names));
    return ok ? { status: "succeeded" } : { status: "failed", error: `stop ${names.join(", ")} failed (held anyway)` };
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
      if (!restarted.ok && !restarted.held) {
        this.skipRest(op, steps, services.slice(i + 1), `not restarted: ${name} did not become healthy`);
        return { status: "failed", error: restarted.error };
      }
    }
    return { status: "succeeded" };
  }

  private async restartService(op: Operation, steps: OperationStep[], name: string): Promise<Outcome> {
    const current = (await this.read()).find((s) => s.name === name);
    if (!current || current.containers.length === 0) {
      this.skip(op, steps, name, "no container: nothing to restart (use Up)");
      return { status: "failed", error: `service ${name} has no container to restart` };
    }
    const cleared = this.clearCrashLoop(op, steps, name);
    const restarted = await this.start(op, steps, name, cleared ? "recreate" : "restart");
    return restarted.ok ? { status: "succeeded" } : { status: "failed", error: restarted.error };
  }

  /**
   * Re-read the environment until the service is healthy, or `timeoutMs` has
   * passed. Ends early when the service gets held (a human stopped it) or
   * Lair is stopping.
   */
  private async waitHealthy(name: string, timeoutMs: number): Promise<Waited> {
    const clock = this.ctx.probes.clock;
    const start = clock.now();
    const deadline = start + timeoutMs;
    for (;;) {
      const hold = this.holdOf(name);
      if (hold) return { ok: false, held: true, detail: `held by a human while waiting (${hold.reason})` };
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
   * stops the deploy (the later ones may need it). Held services are skipped.
   */
  private async deploy(op: Operation, steps: OperationStep[]): Promise<Outcome> {
    const { project } = this.ctx;
    const auto = op.requestedBy === "auto";
    const prepare = this.env.deploy.prepareCmd;
    if (auto && prepare) {
      const built = fill("deploy.prepare_cmd", prepare, {
        sha: op.sha ?? "",
        ref: this.env.deploy.ref,
        environment: this.env.name,
        project,
      });
      if ("error" in built) {
        this.record(op, steps, { action: "prepare", status: "failed", detail: built.error });
        return { status: "failed", error: built.error };
      }
      if (!(await this.command(op, steps, "prepare", undefined, built.argv, { timeoutSeconds: this.ctx.settings.buildTimeoutSeconds }))) {
        return { status: "failed", error: "deploy.prepare_cmd failed" };
      }
    }
    const current = await this.read();
    const targets = this.env.services.filter((s) => op.services.includes(s.name));
    for (let i = 0; i < targets.length; i++) {
      const name = targets[i].name;
      const status = current.find((s) => s.name === name);
      const hold = this.holdOf(name);
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
      const result = await this.deployService(op, steps, name, status, current);
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
    current: ServiceStatus[],
  ): Promise<Outcome> {
    const primary = status?.containers[0];
    let previous: Previous | null = null;
    if (primary) {
      const ref = primary.imageRef ?? "";
      const id = primary.imageId ?? "";
      const repository = imageRepository(ref);
      if (!repository || !isImageId(id) || !isImageRef(ref)) {
        const detail = `can't tag the image ${name} runs (${ref || "unknown"}), so there would be no way back: not deploying`;
        this.record(op, steps, { action: "tag", service: name, status: "failed", detail });
        return { status: "failed", error: detail };
      }
      // A rollback re-tags the image reference: with two services on one
      // image it would move the other service's image too
      const sharing = current
        .filter((s) => s.name !== name)
        .find((s) => s.containers.some((c) => c.imageRef !== undefined && imageRepository(c.imageRef) === repository));
      if (sharing) {
        const detail = `services ${name} and ${sharing.name} share the image ${repository}: a rollback of one would move the other's image too, so Lair doesn't deploy it`;
        this.record(op, steps, { action: "tag", service: name, status: "failed", detail });
        return { status: "failed", error: detail };
      }
      const tag = `${repository}:${PREVIOUS_TAG}`;
      if (!(await this.command(op, steps, "tag", name, this.docker("tag", id, tag), { ref }))) {
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

    if (
      !(await this.command(op, steps, "build", name, this.compose("build", name), {
        timeoutSeconds: this.ctx.settings.buildTimeoutSeconds,
      }))
    ) {
      return { status: "failed", error: `build of ${name} failed; the running container was not touched` };
    }
    // Held during the build: don't start it; point its image back so a later Up starts the known one
    const heldNow = this.holdOf(name);
    if (heldNow) {
      return previous
        ? this.rollback(op, steps, name, previous, `held by a human during the deploy (${heldNow.reason})`)
        : { status: "failed", error: `${name} was held during the deploy and has no previous image to point back at` };
    }
    const rolled = await this.command(op, steps, "roll", name, this.compose("up", "-d", "--no-deps", "--no-build", name));
    let why: string;
    if (rolled) {
      const wait = await this.waitHealthy(name, this.env.deploy.healthTimeoutMinutes * 60000);
      this.record(op, steps, {
        action: "wait",
        service: name,
        status: wait.ok ? "succeeded" : wait.held ? "skipped" : "failed",
        detail: wait.detail,
      });
      if (wait.ok) {
        // A deploy by hand counts as deployed at the latest commit Lair has seen
        const { store, project } = this.ctx;
        const sha = op.sha ?? store.seenSha(project, this.env.name);
        if (sha) store.setDeployedSha(project, this.env.name, name, sha);
        return { status: "succeeded" };
      }
      if (wait.held) await this.stopHeld(op, steps, name);
      why = wait.detail;
    } else {
      why = "the new container did not start";
    }
    if (!previous) {
      return { status: "failed", error: `${name}: ${why}; no previous image to roll back to` };
    }
    return this.rollback(op, steps, name, previous, why);
  }

  /**
   * Point the image reference back at the tagged previous image and recreate
   * the container. A held service is only re-tagged, never started: it gets
   * the previous image when the human starts it again.
   */
  private async rollback(op: Operation, steps: OperationStep[], name: string, previous: Previous, why: string): Promise<Outcome> {
    if (!(await this.command(op, steps, "rollback", name, this.docker("tag", previous.tag, previous.ref), { ref: previous.ref }))) {
      return { status: "failed", error: `${name}: ${why}; rollback failed: could not re-tag ${previous.tag}` };
    }
    const hold = this.holdOf(name);
    if (hold) {
      this.skip(op, steps, name, `held (${hold.reason}): not recreated; it starts on ${previous.tag}'s image when it is started again`);
      return { status: "rolled_back", error: `${name}: ${why}; its image points back at ${previous.tag}, not started (held)` };
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
    this.record(op, steps, {
      action: "wait",
      service: name,
      status: wait.ok ? "succeeded" : wait.held ? "skipped" : "failed",
      detail: wait.detail,
    });
    if (wait.held) await this.stopHeld(op, steps, name);
    return wait.ok || wait.held
      ? { status: "rolled_back", error: `${name}: ${why}; rolled back to ${previous.tag}` }
      : { status: "failed", error: `${name}: ${why}; rolled back, but the previous image is not healthy either (${wait.detail})` };
  }

  // ============ AFTER A RESTART ============

  /**
   * A deploy cut off by a stop may have left a service built (its image
   * reference moved) or rolled, but never seen healthy. On the next start,
   * each such service is rolled back to the image tagged before the build,
   * as a recorded `recover` operation. The commit is then tried once more on
   * the next tick (the rolled-back services are behind); after that, the next
   * merge brings them. One interrupted deploy per tick.
   */
  async recoverInterrupted(): Promise<void> {
    if (this.readOnly || this.current || this.ctx.closing) return;
    const { store, project } = this.ctx;
    for (const op of store.interruptedDeploys(project, this.env.name)) {
      const unverified = this.unverified(op);
      if (unverified.length === 0) {
        store.markRecovered(op.id, "nothing to recover");
        continue;
      }
      const steps: OperationStep[] = [];
      const recovery = store.createOperation({
        project,
        environment: this.env.name,
        kind: "recover",
        services: unverified.map((u) => u.service),
        requestedBy: "auto",
        reason: `deploy ${op.id} was interrupted`,
        sha: op.sha,
        status: "running",
        startedAt: this.iso(),
        steps,
      });
      this.launch(recovery, steps, {
        perform: async () => {
          const outcome = await this.recover(recovery, steps, unverified);
          store.markRecovered(op.id, recovery.id);
          if (op.sha) this.retrySha = op.sha;
          return outcome;
        },
      });
      return;
    }
  }

  /**
   * The services an interrupted deploy left unverified: their build finished
   * (the image reference moved) or their roll started, and no healthy wait
   * followed. A build that was killed or failed, with no roll, left the
   * service on its old image: nothing to recover.
   */
  private unverified(op: Operation): { service: string; previous: Previous | null }[] {
    const out: { service: string; previous: Previous | null }[] = [];
    for (const service of this.env.services) {
      const mine = op.steps.filter((s) => s.service === service.name);
      const built = mine.some((s) => s.action === "build" && s.status === "succeeded");
      const rolled = mine.some((s) => s.action === "roll" && s.status !== "skipped");
      const verified = mine.some((s, i) => s.action === "wait" && s.status === "succeeded" && i === mine.length - 1);
      if ((!built && !rolled) || verified) continue;
      const tag = mine.find((s) => s.action === "tag" && s.status === "succeeded" && s.argv && s.ref);
      out.push({
        service: service.name,
        previous: tag?.argv && tag.ref ? { ref: tag.ref, tag: tag.argv[tag.argv.length - 1] } : null,
      });
    }
    return out;
  }

  private async recover(op: Operation, steps: OperationStep[], services: { service: string; previous: Previous | null }[]): Promise<Outcome> {
    let rolledBack = false;
    for (const { service, previous } of services) {
      if (!previous) {
        this.skip(op, steps, service, "the interrupted deploy tagged no previous image: nothing to roll back to");
        continue;
      }
      const result = await this.rollback(op, steps, service, previous, "the deploy was interrupted before it was verified");
      if (result.status === "failed") return result;
      rolledBack = true;
    }
    return rolledBack
      ? { status: "rolled_back", error: `rolled back what the interrupted deploy left unverified: ${services.map((s) => s.service).join(", ")}` }
      : { status: "succeeded" };
  }

  // ============ AFTER A MERGE ============

  /**
   * With deploy.auto: when deploy.ref points at a new commit, deploy every
   * service with paths that changed since the commit it was last deployed
   * at (a service a rollback left behind comes again). The first commit seen
   * is taken as what runs now. The commit is marked seen only once its
   * deploy has started, or nothing needed deploying: a failed git diff, or a
   * human operation in the way, leaves it for the next tick. A commit whose
   * deploy was interrupted and recovered is tried once more.
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
    const env = this.env.name;
    if (deploy.fetchCmd) {
      // command_timeout_seconds: ticks are serial, so a hung fetch must not hold up every environment for long
      const fetched = await this.run(deploy.fetchCmd);
      if (fetched.code !== 0) {
        throw new Error(`deploy.fetch_cmd exited ${fetched.code}: ${redact(fetched.stderr.trim().slice(0, 200))}`);
      }
    }
    const repo = deploy.repo ?? this.ctx.config.repo;
    const rev = await this.run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${deploy.ref}^{commit}`]);
    const sha = rev.stdout.trim();
    if (rev.code !== 0 || !COMMIT.test(sha)) {
      throw new Error(`git rev-parse ${deploy.ref} exited ${rev.code}: ${redact(rev.stderr.trim().slice(0, 200))}`);
    }
    const deployable = this.env.services.filter((s) => s.build && s.paths.length > 0);
    const seen = store.seenSha(project, env);
    if (seen === null) {
      store.setSeenSha(project, env, sha, this.iso());
      for (const s of deployable) {
        if (store.serviceShas(project, env, s.name).deployedSha === null) store.setDeployedSha(project, env, s.name, sha);
      }
      return;
    }
    if (seen === sha && this.retrySha !== sha) return;
    const baseOf = (s: ServiceSettings) => store.serviceShas(project, env, s.name).deployedSha ?? seen;
    const filesSince = new Map<string, string[]>();
    for (const s of deployable) {
      const base = baseOf(s);
      if (filesSince.has(base) || !COMMIT.test(base)) continue;
      const diff = await this.run(["git", "-C", repo, "diff", "--name-only", base, sha]);
      if (diff.code !== 0) {
        throw new Error(`git diff ${base.slice(0, 12)} ${sha.slice(0, 12)} exited ${diff.code}: ${redact(diff.stderr.trim().slice(0, 200))}`);
      }
      filesSince.set(
        base,
        diff.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      );
    }
    const changed = deployable.filter((s) =>
      s.paths.some((path) => (filesSince.get(baseOf(s)) ?? []).some((file) => pathMatches(path, file))),
    );
    if (changed.length === 0) {
      this.retrySha = null;
      store.setSeenSha(project, env, sha, this.iso());
      return;
    }
    if (this.current) return; // a human operation started while git ran: the next tick tries again
    const result = this.request({ kind: "deploy", services: changed.map((s) => s.name), by: "auto", sha });
    if (!result.ok) throw new Error(`deploy of ${sha.slice(0, 12)} not started (tried again next tick): ${result.error}`);
    this.retrySha = null;
    store.setSeenSha(project, env, sha, this.iso());
    for (const s of changed) store.setTargetSha(project, env, s.name, sha);
  }

  /** One tick: read (sampling restart counts), recover an interrupted deploy, then look for a merge. */
  async tick(): Promise<void> {
    await this.read({ sample: true, logs: true });
    await this.recoverInterrupted();
    await this.checkMerge();
  }
}
