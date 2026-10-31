/**
 * Checks manager: the multi-project container for the checks module.
 *
 * One ChecksService per project with `checks:` configured. Started and stopped
 * by src/server/index.ts. Provides the shared spawner and git validation.
 */
import { execFile } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { BusStore } from "../bus/store.js";
import { parseChecksConfig, type ParsedChecksConfig } from "./config.js";
import { ChecksService, type CheckSpawner, type SpawnResult, type GuardRunner, type ChecksFs } from "./service.js";
import { ChecksStore } from "./store.js";
import { signalTree, terminateTree } from "../gates/executors/local.js";

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface ChecksManagerOptions {
  /** Directory for checks databases (one per project) */
  dbPath: string;
  /** Directory for check outputs */
  outputDir: string;
  events?: EventBus;
  /** Get the bus store for a project */
  getBusStore: (project: string) => BusStore;
  /** Check if a run is active (from agents module) */
  isRunActive?: (project: string, runId: string) => boolean;
  /** Get run info (from agents module) */
  getRunInfo?: (project: string, runId: string) => { task: string; branch?: string } | null;
}

/** Real clock for production */
const realClock = { now: () => Date.now() };

/**
 * Real filesystem for production.
 */
class RealFs implements ChecksFs {
  readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  readDir(path: string): string[] | null {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  mkdir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * Real spawner: runs commands without a shell, with timeout and process group kill.
 * Reuses the logic from gates/executors/local.ts.
 */
class RealSpawner implements CheckSpawner {
  private killGraceMs = 5000;
  /** Running check processes by check id */
  private running = new Map<string, number>();

  async spawn(
    argv: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<SpawnResult> {
    const { spawn } = await import("child_process");

    return new Promise((resolve) => {
      const [file, ...args] = argv;
      if (!file) {
        resolve({ exitCode: -1, stdout: "", stderr: "empty command", timedOut: false, killed: false });
        return;
      }

      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let exitCode: number | null = null;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Remove from running map
        for (const [id, pid] of this.running) {
          if (pid === child?.pid) {
            this.running.delete(id);
            break;
          }
        }
        resolve({ exitCode: code, stdout, stderr, timedOut, killed: false });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (e) {
        stderr = e instanceof Error ? e.message : String(e);
        resolve({ exitCode: -1, stdout, stderr, timedOut: false, killed: false });
        return;
      }

      const pid = child.pid;

      // Store the check id -> pid mapping if we can find it in env
      const checkId = options.env.CHECK_ID;
      if (checkId && pid !== undefined) {
        this.running.set(checkId, pid);
      }

      const terminate = () => {
        if (pid !== undefined) terminateTree(pid, this.killGraceMs);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, Math.max(0, options.timeoutMs));

      child.stdout?.on("data", (data) => {
        stdout += data.toString().slice(-100000);
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString().slice(-100000);
      });

      child.on("exit", (code) => {
        exitCode = code ?? -1;
        // Kill any remaining children
        if (pid !== undefined) signalTree(pid, "SIGKILL");
        finish(exitCode);
      });

      child.on("error", (err) => {
        stderr += err.message;
        finish(-1);
      });
    });
  }

  kill(checkId: string): void {
    const pid = this.running.get(checkId);
    if (pid !== undefined) {
      terminateTree(pid, this.killGraceMs);
      this.running.delete(checkId);
    }
  }
}

/**
 * Real guard runner: runs guard commands with a timeout.
 */
class RealGuardRunner implements GuardRunner {
  async run(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const [file, ...args] = argv;
      if (!file) {
        resolve({ exitCode: -1, output: "empty command" });
        return;
      }

      const _child = execFile(file, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        shell: false,
      }, (error, stdout, stderr) => {
        if (error) {
          // execFile error.code is a string (like 'ETIMEDOUT'), but exit code is a number
          const exitCode = typeof error.code === "number" ? error.code : (error.killed ? -1 : 1);
          resolve({
            exitCode,
            output: (stderr || stdout || error.message).slice(0, 2000),
          });
        } else {
          resolve({ exitCode: 0, output: (stdout || stderr).slice(0, 2000) });
        }
      });
    });
  }
}

/**
 * Git-based sha validator: checks if a sha is reachable from a branch.
 */
function createShaValidator(repoDir: string): (sha: string, branch: string) => Promise<boolean> {
  return (sha: string, branch: string): Promise<boolean> => {
    return new Promise((resolve) => {
      // Use git branch -r --contains to check if sha is on any remote branch,
      // or git merge-base --is-ancestor to check if sha is an ancestor of the branch
      const _child = execFile("git", ["merge-base", "--is-ancestor", sha, branch], {
        cwd: repoDir,
        timeout: 30000,
      }, (error) => {
        // Exit 0 = sha is ancestor of branch (valid)
        // Exit 1 = sha is not ancestor
        // Exit 128 = bad revision
        resolve(!error);
      });
    });
  };
}

export class ChecksManager {
  private services = new Map<string, { service: ChecksService; store: ChecksStore; config: ParsedChecksConfig }>();
  private dbPath: string;
  private outputDir: string;
  private events?: EventBus;
  private getBusStore: (project: string) => BusStore;
  private isRunActive: (project: string, runId: string) => boolean;
  private getRunInfo: (project: string, runId: string) => { task: string; branch?: string } | null;
  private spawner = new RealSpawner();
  private guardRunner = new RealGuardRunner();
  private fs = new RealFs();

  constructor(options: ChecksManagerOptions) {
    this.dbPath = options.dbPath;
    this.outputDir = options.outputDir;
    this.events = options.events;
    this.getBusStore = options.getBusStore;
    this.isRunActive = options.isRunActive ?? (() => true);
    this.getRunInfo = options.getRunInfo ?? (() => null);
  }

  /** Load project configs and create services for those with checks enabled. */
  load(entries: ProjectEntry[]): void {
    for (const entry of entries) {
      if (entry.error || !entry.config) continue;
      const config = entry.config;

      // Parse checks config
      if (!config.checks) continue;
      const parsed = parseChecksConfig(config.checks);
      if (!parsed.ok) {
        console.warn(`[checks] ${entry.name}: ${parsed.error}`);
        continue;
      }
      if (parsed.config.kinds.size === 0) continue;

      // Create store and service
      const store = new ChecksStore(entry.name, join(this.dbPath, `${entry.name}-checks.db`));
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
        validateSha: createShaValidator(config.repo),
        isRunActive: (runId) => this.isRunActive(entry.name, runId),
        getRunInfo: (runId) => this.getRunInfo(entry.name, runId),
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

  /** Stop all services. */
  async stop(): Promise<void> {
    for (const { service, store } of this.services.values()) {
      service.stop();
      store.close();
    }
    this.services.clear();
  }

  /** Get the service for a project. */
  get(project: string): ChecksService | undefined {
    return this.services.get(project)?.service;
  }

  /** Get status for all projects. */
  status(): Array<{ project: string; kinds: string[]; enabled: boolean }> {
    const result: Array<{ project: string; kinds: string[]; enabled: boolean }> = [];
    for (const [project, { config }] of this.services) {
      result.push({
        project,
        kinds: [...config.kinds.keys()],
        enabled: true,
      });
    }
    return result;
  }

  /** List enabled projects. */
  enabled(): string[] {
    return [...this.services.keys()];
  }
}
