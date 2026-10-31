/**
 * Checks manager: the multi-project container for the checks module.
 *
 * One ChecksService per project with `checks:` configured (off by default).
 * Started and stopped by src/server/index.ts. Provides the production
 * boundaries: the process spawner (no shell, own process group, timeout,
 * bounded output), the guard runner, the async filesystem and git.
 */
import { open, readdir, mkdir, rm } from "fs/promises";
import { join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentRun } from "../agents/types.js";
import { ProcessSpawner } from "../gates/executors/local.js";
import { parseChecksConfig, type ParsedChecksConfig } from "./config.js";
import { ChecksService, type CheckSpawner, type SpawnResult, type GuardRunner, type ChecksFs, type RetentionSettings } from "./service.js";
import { ChecksStore } from "./store.js";
import { shaOnPushedBranch, type GitResult, type GitRunner } from "./git.js";

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface ChecksManagerOptions {
  /** Directory for checks databases (one per project) */
  dbPath: string;
  /** Directory for check outputs (one subdirectory per project) */
  outputDir: string;
  events?: EventBus;
  /** Whether a run of `agent` in `project` is active in the agents module (required: no permissive default) */
  isRunActive: (project: string, runId: string, agent: string) => boolean;
  retention?: Partial<RetentionSettings>;
}

/**
 * The agents module's answer for a check request: the run exists, belongs
 * to this project and agent, and is running. Anything else (no agents store,
 * an unknown run, another agent's run, a run that ended without its token
 * being revoked) is not active.
 */
export function agentRunIsActive(
  store: { getRun(id: string): AgentRun | null } | null | undefined,
  project: string,
  runId: string,
  agent: string,
): boolean {
  const run = store?.getRun(runId);
  return !!run && run.project === project && run.agent === agent && run.state === "running";
}

/** Real clock for production */
const realClock = { now: () => Date.now() };

/**
 * Lair's own tokens never reach a check command, its guard or git (the
 * same list the local gate executor strips, plus the per-run tokens).
 */
const STRIPPED_ENV = [
  "LAIR_NODE_TOKEN",
  "LAIR_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "LAIR_BUS_TOKEN",
  "LAIR_OPS_TOKEN",
  "LAIR_REVIEW_TOKEN",
];

export function checkEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The real filesystem: fs/promises only (nothing synchronous on the event
 * loop), and a file read stops at `maxBytes`.
 */
export class NodeChecksFs implements ChecksFs {
  async readFile(path: string, maxBytes: number): Promise<string | null> {
    if (maxBytes <= 0) return null;
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(maxBytes);
      let total = 0;
      while (total < maxBytes) {
        const { bytesRead } = await handle.read(buffer, total, maxBytes - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buffer.subarray(0, total).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async readDir(path: string): Promise<string[] | null> {
    try {
      return await readdir(path);
    } catch {
      return null;
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * The real spawner: the gate executors' ProcessSpawner (argv, shell: false,
 * its own process group, a timeout that stops the whole group, stdout and
 * stderr each kept as a rolling tail of at most 1 MB, completion on "close")
 * plus a kill switch per check id for stop().
 */
export class ChecksProcessSpawner implements CheckSpawner {
  private running = new Map<string, AbortController>();

  constructor(
    private processes = new ProcessSpawner(),
    private baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async spawn(
    argv: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<SpawnResult> {
    const checkId = options.env.CHECK_ID;
    const abort = new AbortController();
    if (checkId) this.running.set(checkId, abort);
    try {
      const result = await this.processes.run(argv, {
        cwd: options.cwd,
        env: checkEnvironment(this.baseEnv, options.env),
        timeoutMs: options.timeoutMs,
        signal: abort.signal,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        killed: abort.signal.aborted,
      };
    } finally {
      if (checkId && this.running.get(checkId) === abort) this.running.delete(checkId);
    }
  }

  kill(checkId: string): void {
    this.running.get(checkId)?.abort();
  }
}

/** The real guard runner: the same spawner, so a timeout stops the guard's whole process group. */
export class ChecksGuardRunner implements GuardRunner {
  constructor(
    private processes = new ProcessSpawner(),
    private baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
    const result = await this.processes.run(argv, { cwd, env: checkEnvironment(this.baseEnv), timeoutMs });
    return {
      exitCode: result.exitCode,
      output: (result.stderr || result.stdout).slice(-2000),
      timedOut: result.timedOut,
    };
  }
}

/** git in the project's repository, through the same spawner (no prompts: a credential prompt would only hang). */
export class RepoGit implements GitRunner {
  constructor(
    private repoDir: string,
    private processes = new ProcessSpawner(),
    private baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(args: string[], timeoutMs: number): Promise<GitResult> {
    const result = await this.processes.run(["git", ...args], {
      cwd: this.repoDir,
      env: checkEnvironment(this.baseEnv, { GIT_TERMINAL_PROMPT: "0" }),
      timeoutMs,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
  }
}

export class ChecksManager {
  private services = new Map<string, { service: ChecksService; store: ChecksStore; config: ParsedChecksConfig }>();
  private dbPath: string;
  private outputDir: string;
  private events?: EventBus;
  private isRunActive: (project: string, runId: string, agent: string) => boolean;
  private retention?: Partial<RetentionSettings>;
  private processes = new ProcessSpawner();
  private spawner = new ChecksProcessSpawner(this.processes);
  private guardRunner = new ChecksGuardRunner(this.processes);
  private fs = new NodeChecksFs();
  /** Projects whose `checks:` block is invalid, with the reason (they stay off) */
  private problems = new Map<string, string>();

  constructor(options: ChecksManagerOptions) {
    this.dbPath = options.dbPath;
    this.outputDir = options.outputDir;
    this.events = options.events;
    this.isRunActive = options.isRunActive;
    this.retention = options.retention;
  }

  /** Load project configs and create services for those with checks enabled. */
  load(entries: ProjectEntry[]): void {
    for (const entry of entries) {
      if (entry.error || !entry.config) continue;
      const config = entry.config;

      // No `checks:` block: the module stays off for this project
      if (!config.checks) continue;
      const parsed = parseChecksConfig(config.checks);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.error);
        console.warn(`[checks] ${entry.name}: not started: ${parsed.error}`);
        continue;
      }
      if (parsed.config.kinds.size === 0) continue;

      const store = new ChecksStore(entry.name, join(this.dbPath, `${entry.name}-checks.db`));
      const git = new RepoGit(config.repo, this.processes);
      const service = new ChecksService({
        store,
        config: parsed.config,
        events: this.events,
        spawner: this.spawner,
        guardRunner: this.guardRunner,
        clock: realClock,
        fs: this.fs,
        outputDir: join(this.outputDir, entry.name),
        repoDir: config.repo,
        validateSha: (sha, branch, remote) => shaOnPushedBranch(git, sha, branch, remote),
        isRunActive: (runId, agent) => this.isRunActive(entry.name, runId, agent),
        retention: this.retention,
      });

      this.services.set(entry.name, { service, store, config: parsed.config });
    }
  }

  /** Start all services. */
  start(): string[] {
    const started: string[] = [];
    for (const [project, { service }] of this.services) {
      service.start();
      started.push(project);
    }
    return started;
  }

  /**
   * Stop all services: no route reaches them from now on, each one records
   * and kills its running checks and waits for its work in flight, then its
   * store closes.
   */
  async stop(): Promise<void> {
    const entries = [...this.services.values()];
    this.services.clear();
    for (const { service, store } of entries) {
      await service.stop();
      store.close();
    }
  }

  /** Get the service for a project. */
  get(project: string): ChecksService | undefined {
    return this.services.get(project)?.service;
  }

  /** Get status for all projects (an invalid `checks:` block is listed with its problem). */
  status(): Array<{ project: string; kinds: string[]; enabled: boolean; problem?: string }> {
    const result: Array<{ project: string; kinds: string[]; enabled: boolean; problem?: string }> = [];
    for (const [project, { config }] of this.services) {
      result.push({ project, kinds: [...config.kinds.keys()], enabled: true });
    }
    for (const [project, problem] of this.problems) {
      result.push({ project, kinds: [], enabled: false, problem });
    }
    return result;
  }

  /** List enabled projects. */
  enabled(): string[] {
    return [...this.services.keys()];
  }
}
