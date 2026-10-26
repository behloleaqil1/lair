/**
 * Agents module probes: the watchdog's (process table, files, commands,
 * clock) plus the one thing the agents module adds, starting and signalling
 * processes. Tests fake only these (and use real files in a temp dir).
 */
import { spawn } from "child_process";
import { closeSync, mkdirSync, openSync } from "fs";
import { dirname } from "path";
import { systemProbes, type ProcessInfo, type Probes } from "../watchdog/probes.js";

/** A process identity that survives pid reuse: the pid and when that process started. */
export interface ProcessOwner {
  pid: number;
  /** Milliseconds since the epoch */
  startedAt: number;
}

export interface SpawnOptions {
  cwd?: string;
  /** The process's whole environment: nothing is inherited from this server (see agentEnvironment) */
  env: Record<string, string>;
  /** stdout and stderr are appended here */
  logPath: string;
}

/** Variables every agent gets from this server's environment, when they are set. */
export const BASE_ENV: readonly string[] = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TERM", "SHELL"];

/**
 * An agent's whole environment: BASE_ENV and the `passthrough` names
 * (agents.env_passthrough, e.g. a provider API key the CLI needs) copied from
 * `source`, then the run's own variables. Nothing else of this server's
 * environment reaches an agent, and no LAIR_* variable but the run's own.
 */
export function agentEnvironment(
  source: NodeJS.ProcessEnv,
  passthrough: readonly string[],
  run: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...passthrough]) {
    if (name.startsWith("LAIR_")) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...run };
}

export interface ProcessSpawner {
  /**
   * Start argv[0] with the rest as its arguments, never through a shell.
   * Resolves once the process runs; rejects when it can't be started.
   */
  spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner>;
  /**
   * The exit code of a process this spawner started: a number once it exited
   * with one, null when a signal ended it, undefined when unknown (still
   * running, or started before this server did).
   */
  exitCode(pid: number): number | null | undefined;
  /** True when this spawner started the process (in this server's lifetime) and hasn't forgotten it */
  knows(pid: number): boolean;
  /** Signal the process and its process group. False when it can't be signalled. */
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;
  /** Drop what is kept about an ended process */
  forget(pid: number): void;
}

export interface AgentProbes extends Probes {
  spawner: ProcessSpawner;
  /** This server process: the owner of claims and launch locks while a run starts */
  self: ProcessOwner;
}

/**
 * One reading of the process table. A pid is alive for an owner only when a
 * process with that pid runs AND started when the owner says it did: a pid
 * the system handed to a new process is not the old owner.
 */
export class ProcessSnapshot {
  private byPid: Map<number, ProcessInfo>;
  /** Processes started after the reading (pid -> start time) */
  private spawned = new Map<number, number>();
  private toleranceMs: number;

  constructor(
    list: ProcessInfo[],
    readonly now: number,
    readonly self: ProcessOwner,
    toleranceSeconds: number,
  ) {
    this.byPid = new Map(list.map((p) => [p.pid, p] as const));
    // ps reports elapsed time in whole seconds
    this.toleranceMs = toleranceSeconds * 1000 + 1000;
  }

  get(pid: number): ProcessInfo | undefined {
    return this.byPid.get(pid);
  }

  /** A process this server started after the reading: alive for the rest of it. */
  addSpawned(owner: ProcessOwner): void {
    this.spawned.set(owner.pid, owner.startedAt);
  }

  /** The processes added with addSpawned */
  spawnedOwners(): ProcessOwner[] {
    return [...this.spawned.entries()].map(([pid, startedAt]) => ({ pid, startedAt }));
  }

  /** When the process with this pid started, or null when none runs. */
  startedAt(pid: number): number | null {
    const spawned = this.spawned.get(pid);
    if (spawned !== undefined) return spawned;
    if (pid === this.self.pid && !this.byPid.has(pid)) return this.self.startedAt;
    const proc = this.byPid.get(pid);
    return proc ? this.now - proc.elapsedSeconds * 1000 : null;
  }

  /** Alive: a process with this pid runs and, when `startedAt` is given, started then. */
  isAlive(pid: number, startedAt?: number | null): boolean {
    const actual = this.startedAt(pid);
    if (actual === null) return false;
    if (startedAt === undefined || startedAt === null) return true;
    return Math.abs(actual - startedAt) <= this.toleranceMs;
  }

  /** Why an owner is alive or not, for evidence. */
  describe(pid: number, startedAt?: number | null): string {
    const actual = this.startedAt(pid);
    if (actual === null) return `pid ${pid} is not running`;
    if (startedAt === undefined || startedAt === null) return `pid ${pid} is running`;
    if (Math.abs(actual - startedAt) <= this.toleranceMs) {
      return `pid ${pid} is running (started ${new Date(actual).toISOString()})`;
    }
    return `pid ${pid} is a different process now: it started ${new Date(actual).toISOString()}, the owner started ${new Date(startedAt).toISOString()}`;
  }
}

/** The real spawner: child_process.spawn, detached, output appended to the run's log. */
export class ChildProcessSpawner implements ProcessSpawner {
  private exits = new Map<number, number | null>();
  private started = new Set<number>();

  spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const [file, ...args] = argv;
    if (!file) return Promise.reject(new Error("empty command"));
    return new Promise<ProcessOwner>((resolve, reject) => {
      let opened: number;
      try {
        mkdirSync(dirname(options.logPath), { recursive: true });
        opened = openSync(options.logPath, "a");
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const fd = opened;
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      };
      try {
        const child = spawn(file, args, {
          cwd: options.cwd,
          // Exactly the environment given: never this server's own
          env: options.env,
          // Its own process group, so a stop reaches the agent's children too,
          // and the agent keeps running if this server restarts
          detached: true,
          stdio: ["ignore", fd, fd],
          shell: false,
        });
        child.once("spawn", () => {
          close();
          const pid = child.pid;
          if (pid === undefined) {
            reject(new Error("the process started without a pid"));
            return;
          }
          child.unref();
          this.started.add(pid);
          resolve({ pid, startedAt: Date.now() });
        });
        child.once("error", (error) => {
          close();
          reject(error);
        });
        child.once("exit", (code) => {
          if (child.pid !== undefined) this.exits.set(child.pid, code);
        });
      } catch (e) {
        close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }

  knows(pid: number): boolean {
    return this.started.has(pid);
  }

  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  forget(pid: number): void {
    this.exits.delete(pid);
    this.started.delete(pid);
  }
}

/** The real probes. */
export function systemAgentProbes(commandTimeoutMs = 30_000): AgentProbes {
  return {
    ...systemProbes(commandTimeoutMs),
    spawner: new ChildProcessSpawner(),
    self: { pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000) },
  };
}
