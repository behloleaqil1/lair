/**
 * The owner's Restart (POST /api/owner/restart, routes.ts).
 *
 * Restart answers 202, then shuts the server down gracefully (the shutdown
 * src/server/index.ts runs on SIGTERM) and exits with code 0, so the service
 * manager starts it again: launchd with KeepAlive, or systemd with
 * Restart=always. Without one the process just exits; serviceManagerOf()
 * says what Lair can tell about that.
 *
 * "Update and restart" first runs server.update_cmd from data/server.yaml
 * (server-config.ts), step by step, each an argv run without a shell, from
 * Lair's directory, with a timeout. Its output goes to the log line by line
 * and is kept (the latest lines) for the dashboard. When a step fails
 * nothing restarts, and the error is shown.
 */
import { spawn } from "child_process";
import { relative, sep } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { RestartState, RestartStatusView } from "../../shared/lifecycle-types.js";
import {
  loadServerConfig,
  serviceManagerOf,
  type ServerConfigFileOptions,
  type ServerSettings,
} from "./server-config.js";

const MAX_LINES = 400;
const MAX_LINE = 2000;
const KILL_GRACE_MS = 5000;
/** A graceful shutdown that takes longer than this is given up on, and the process exits anyway */
export const SHUTDOWN_DEADLINE_MS = 60_000;
const BUSY_POLL_MS = 1000;

export interface RestartControllerOptions {
  /** The server's graceful shutdown (stops the modules, closes the stores and Fastify) */
  shutdown: () => Promise<void>;
  /** process.exit in the server; tests pass a stand-in */
  exit: (code: number) => void;
  /** data/server.yaml */
  configPath: string;
  /** Lair's directory: the update runs here, and file names are shown relative to it */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The parent pid, for the service manager hint (default: process.ppid) */
  ppid?: number;
  /** Who must own data/server.yaml (tests) */
  fileOptions?: ServerConfigFileOptions;
  /**
   * Work a restart would cut off (a merge, a delivery operation): while any
   * runs, Restart answers 409; after an update, the restart waits for it
   * (at most busyWaitMs)
   */
  busy?: () => string[];
  /** Environment variables the update must not get besides LAIR_* (the projects' token variables) */
  secretEnv?: () => string[];
  /** Pause between the 202 and the shutdown, so the answer reaches the browser (default 250 ms) */
  delayMs?: number;
  /** How long the restart after an update waits for busy work to end (default 120 s) */
  busyWaitMs?: number;
  /** How long the graceful shutdown may take before the process exits anyway (default 60 s) */
  shutdownTimeoutMs?: number;
  events?: EventBus;
  log?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * `work`, or give up on it after `ms`: resolves true when it finished in
 * time (or failed: `onError` gets the error), false at the deadline.
 */
export async function withDeadline(
  work: Promise<unknown>,
  ms: number,
  onError: (e: unknown) => void = () => undefined,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  const done = work.then(
    () => true as const,
    (e) => {
      onError(e);
      return true as const;
    },
  );
  try {
    return await Promise.race([done, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type RestartRequestResult = { ok: true; status: RestartStatusView } | { ok: false; code: number; error: string };

export interface StepResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The command could not be started */
  error?: string;
}

/**
 * The server's environment for the update, without Lair's own variables
 * (LAIR_*) and without `secrets` (the token variables the projects name).
 */
export function updateEnvironment(source: NodeJS.ProcessEnv, secrets: readonly string[] = []): Record<string, string> {
  const strip = new Set(secrets);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !name.toUpperCase().startsWith("LAIR_") && !strip.has(name)) env[name] = value;
  }
  return env;
}

/** Split a stream into lines (each at most MAX_LINE characters) for `onLine`. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString("utf-8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        onLine(buffer.slice(0, newline).replace(/\r$/, "").slice(0, MAX_LINE));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE) {
        onLine(`${buffer.slice(0, MAX_LINE)}...`);
        buffer = "";
      }
    },
    end() {
      if (buffer) onLine(buffer.slice(0, MAX_LINE));
      buffer = "";
    },
  };
}

/** Run one step: argv without a shell, its own process group, killed (with its children) at the timeout. */
export function runStep(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; onLine: (line: string) => void },
): Promise<StepResult> {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    let settled = false;
    let timedOut = false;
    const finish = (result: StepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      out.end();
      err.end();
      resolve(result);
    };
    const out = lineSplitter(options.onLine);
    const err = lineSplitter(options.onLine);
    let killTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e) => finish({ code: null, signal: null, timedOut, error: e.message }));
    child.on("close", (code, signal) => finish({ code, signal, timedOut }));
  });
}

function describe(result: StepResult, timeoutSeconds: number): string {
  if (result.error) return `could not start: ${result.error}`;
  if (result.timedOut) return `timed out after ${timeoutSeconds} s`;
  if (result.signal) return `was ended by ${result.signal}`;
  return `exited with code ${result.code}`;
}

export class RestartController {
  private state: RestartState = "idle";
  private output: string[] = [];
  private error: string | null = null;
  private requestedAt: string | null = null;
  private work: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  private readonly cwd: string;
  private readonly log: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly options: RestartControllerOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.log = options.log ?? console;
  }

  private get configFile(): string {
    const rel = relative(this.cwd, this.options.configPath);
    return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : this.options.configPath;
  }

  private loadConfig() {
    return loadServerConfig(this.options.configPath, { platform: this.options.platform, ...this.options.fileOptions });
  }

  private busyWork(): string[] {
    try {
      return this.options.busy?.() ?? [];
    } catch (e) {
      return [`can't tell what runs (${e instanceof Error ? e.message : String(e)})`];
    }
  }

  status(): RestartStatusView {
    const loaded = this.loadConfig();
    return {
      state: this.state,
      startedAt: this.startedAt,
      configFile: this.configFile,
      configError: loaded.ok ? null : loaded.errors.join("; "),
      update: {
        configured: loaded.settings.updateSteps.length > 0,
        steps: loaded.settings.updateSteps,
        timeoutSeconds: loaded.settings.updateTimeoutSeconds,
      },
      serviceManager: serviceManagerOf(
        loaded.settings.serviceManager,
        this.options.env,
        this.options.platform,
        this.options.ppid,
      ),
      output: [...this.output],
      error: this.error,
      requestedAt: this.requestedAt,
    };
  }

  /**
   * Restart (after the update when `update`). The answer is immediate; the
   * update and the shutdown run after it. Refused (409) while one is under
   * way or while work a restart would cut off runs (a merge, a delivery
   * operation), and (400) for an update without a valid server.update_cmd.
   */
  request(options: { update: boolean }): RestartRequestResult {
    if (this.state === "updating" || this.state === "restarting") {
      return { ok: false, code: 409, error: `Lair is already ${this.state}` };
    }
    const busy = this.busyWork();
    if (busy.length > 0) {
      return { ok: false, code: 409, error: `Not now: ${busy.join("; ")}. Restart when it has finished` };
    }
    let settings: ServerSettings | null = null;
    if (options.update) {
      const loaded = this.loadConfig();
      if (!loaded.ok) return { ok: false, code: 400, error: `${this.configFile} has an error: ${loaded.errors.join("; ")}` };
      if (loaded.settings.updateSteps.length === 0) {
        return { ok: false, code: 400, error: `There is no server.update_cmd in ${this.configFile}: set one, or use Restart` };
      }
      settings = loaded.settings;
    }
    this.output = [];
    this.error = null;
    this.requestedAt = new Date().toISOString();
    this.state = settings ? "updating" : "restarting";
    this.work = this.run(settings).catch((e) => {
      this.log.error("[restart] failed:", e);
    });
    return { ok: true, status: this.status() };
  }

  /** Resolves once the update and the shutdown asked for have run (for tests). */
  settled(): Promise<void> {
    return this.work;
  }

  private line(text: string): void {
    this.output.push(text);
    if (this.output.length > MAX_LINES) this.output.splice(0, this.output.length - MAX_LINES);
    this.log.log(`[update] ${text}`);
  }

  private async run(settings: ServerSettings | null): Promise<void> {
    if (settings) {
      let secrets: string[] = [];
      try {
        secrets = this.options.secretEnv?.() ?? [];
      } catch (e) {
        this.log.warn("[restart] could not list the projects' token variables:", e);
      }
      const env = updateEnvironment(this.options.env ?? process.env, secrets);
      const steps = settings.updateSteps;
      for (const [i, argv] of steps.entries()) {
        this.line(`$ ${argv.join(" ")}`);
        const result = await runStep(argv, {
          cwd: this.cwd,
          env,
          timeoutMs: settings.updateTimeoutSeconds * 1000,
          onLine: (line) => this.line(line),
        });
        if (result.error || result.timedOut || result.code !== 0) {
          this.error = `Update step ${i + 1} of ${steps.length} (${argv[0]}) ${describe(result, settings.updateTimeoutSeconds)}: Lair was not restarted`;
          this.state = "failed";
          this.log.warn(`[restart] ${this.error}`);
          void this.options.events?.emit("server.update_failed", { error: this.error });
          return;
        }
      }
      this.line("Update finished: restarting");
      // A merge or a delivery operation may have started while it ran: let it end (bounded)
      const until = Date.now() + (this.options.busyWaitMs ?? 120_000);
      let busy = this.busyWork();
      if (busy.length > 0) this.line(`Waiting for: ${busy.join("; ")}`);
      while (busy.length > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
        busy = this.busyWork();
      }
      if (busy.length > 0) this.line(`Still running, restarting anyway: ${busy.join("; ")}`);
    }
    this.state = "restarting";
    this.log.log("[restart] The owner asked for a restart: shutting down, then exiting with code 0");
    void this.options.events?.emit("server.restarting", { update: settings !== null });
    await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 250));
    const deadline = this.options.shutdownTimeoutMs ?? SHUTDOWN_DEADLINE_MS;
    const finished = await withDeadline(this.options.shutdown(), deadline, (e) => {
      this.log.error("[restart] the shutdown failed; exiting anyway:", e);
    });
    if (!finished) this.log.error(`[restart] the shutdown took more than ${deadline / 1000} s; exiting anyway`);
    this.options.exit(0);
  }
}
