/**
 * The local executor: runs a job's steps on this machine, last in the
 * executor order. It waits for a free slot and enough capacity (memory
 * pressure, free RAM, load per core) before it starts, runs each step's argv
 * without a shell in a clean `git worktree` at the commit, and produces its
 * result through the existing gate executor (runGate).
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { cpus, freemem, loadavg, platform, totalmem } from "os";
import { join } from "path";
import { runGate, type ExecuteResult } from "../gate-executor.js";
import { terminateWithEscalation } from "../../services/remote-gate.js";
import { ExecFileRunner, type Clock, type CommandRunner } from "../../watchdog/probes.js";
import type {
  AttemptOutcome,
  AttemptReporter,
  CapacityProbe,
  CapacitySample,
  Executor,
  JobControl,
  JobSpec,
  MemoryPressure,
  Spawner,
} from "./types.js";
import type { LocalSettings } from "../project-pipelines.js";

const MB = 1024 * 1024;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const LOG_TAIL_CHARS = 64 * 1024;

// ============ SPAWNER ============

function keepTail(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? text.slice(-max) : text;
}

/** child_process.spawn with an argv array, shell: false, a timeout and abort. */
export class ProcessSpawner implements Spawner {
  constructor(private killGraceMs = 5000) {}

  run(
    argv: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ExecuteResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const [file, ...args] = argv;
      if (!file) {
        resolve({ exitCode: -1, stdout: "", stderr: "empty command", timedOut: false, durationMs: 0 });
        return;
      }
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        stderr = e instanceof Error ? e.message : String(e);
        resolve({ exitCode: -1, stdout, stderr, timedOut: false, durationMs: Date.now() - started });
        return;
      }
      const onAbort = () => terminateWithEscalation(child, this.killGraceMs);
      const timer = setTimeout(() => {
        timedOut = true;
        terminateWithEscalation(child, this.killGraceMs);
      }, Math.max(0, options.timeoutMs));
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = keepTail(stdout + chunk.toString("utf-8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = keepTail(stderr + chunk.toString("utf-8"));
      });
      child.on("error", (error) => {
        stderr += (stderr ? "\n" : "") + error.message;
        // A spawn failure (e.g. ENOENT) may not be followed by "close"
        if (child.pid === undefined) finish(-1);
      });
      child.on("close", (code) => finish(code ?? -1));
    });
  }
}

// ============ CAPACITY ============

/** MemAvailable from /proc/meminfo, in MB */
export function parseMeminfoAvailableMb(text: string): number | null {
  const match = text.match(/^MemAvailable:\s+(\d+)\s*kB/m);
  return match ? Number(match[1]) / 1024 : null;
}

/** `some avg10=` from /proc/pressure/memory (Linux PSI): >= 50 critical, >= 20 warn */
export function parsePsiPressure(text: string): MemoryPressure {
  const match = text.match(/^some\s+avg10=([\d.]+)/m);
  if (!match) return "unknown";
  const avg10 = Number(match[1]);
  if (avg10 >= 50) return "critical";
  if (avg10 >= 20) return "warn";
  return "normal";
}

/** Available RAM from macOS `vm_stat`: free, inactive, speculative and purgeable pages, in MB */
export function parseVmStatAvailableMb(text: string): number | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? NaN);
  if (!Number.isFinite(pageSize)) return null;
  let pages = 0;
  let found = false;
  for (const label of ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"]) {
    const match = text.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"));
    if (match) {
      pages += Number(match[1]);
      found = true;
    }
  }
  return found ? (pages * pageSize) / MB : null;
}

/** macOS `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical */
export function parseDarwinPressureLevel(text: string): MemoryPressure {
  switch (text.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return "unknown";
  }
}

/** Measures this machine. Unknown values fall back to what Node reports. */
export class SystemCapacityProbe implements CapacityProbe {
  constructor(
    private runner: CommandRunner = new ExecFileRunner(5000),
    private readText: (path: string) => string | null = (path) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
  ) {}

  async sample(): Promise<CapacitySample> {
    const sample: CapacitySample = {
      cores: Math.max(1, cpus().length),
      load1: loadavg()[0] ?? 0,
      totalRamMb: totalmem() / MB,
      freeRamMb: freemem() / MB,
      memoryPressure: "unknown",
    };
    const os = platform();
    if (os === "linux") {
      const meminfo = this.readText("/proc/meminfo");
      const available = meminfo ? parseMeminfoAvailableMb(meminfo) : null;
      if (available !== null) sample.freeRamMb = available;
      const psi = this.readText("/proc/pressure/memory");
      if (psi) sample.memoryPressure = parsePsiPressure(psi);
    } else if (os === "darwin") {
      const vmStat = await this.runner.run(["vm_stat"], { timeoutMs: 5000 });
      const available = vmStat.code === 0 ? parseVmStatAvailableMb(vmStat.stdout) : null;
      if (available !== null) sample.freeRamMb = available;
      const level = await this.runner.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], {
        timeoutMs: 5000,
      });
      if (level.code === 0) sample.memoryPressure = parseDarwinPressureLevel(level.stdout);
    }
    return sample;
  }
}

/** Why the machine can't take a job now, or null when it can. */
export function capacityProblem(sample: CapacitySample, settings: LocalSettings): string | null {
  if (sample.memoryPressure === "warn" || sample.memoryPressure === "critical") {
    return `memory pressure is ${sample.memoryPressure}`;
  }
  if (sample.freeRamMb < settings.minFreeRamMb) {
    return `free RAM ${Math.round(sample.freeRamMb)} MB is below min_free_ram_mb (${settings.minFreeRamMb})`;
  }
  const perCore = sample.load1 / Math.max(1, sample.cores);
  if (perCore > settings.maxLoadPerCore) {
    return `load ${sample.load1.toFixed(2)} on ${sample.cores} cores is above max_load_per_core (${settings.maxLoadPerCore})`;
  }
  return null;
}

// ============ EXECUTOR ============

/** Environment variables never passed to local steps */
const ALWAYS_STRIPPED = ["LAIR_NODE_TOKEN", "LAIR_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];

export interface LocalExecutorOptions {
  spawner: Spawner;
  capacity: CapacityProbe;
  clock: Clock;
  /** The Lair directory (default worktree location: <dir>/data/pipelines/worktrees) */
  lairDir: string;
  /** The environment local steps inherit (minus tokens) */
  env: NodeJS.ProcessEnv;
}

export class LocalExecutor implements Executor {
  readonly id = "local" as const;
  /** Running local jobs per project */
  private running = new Map<string, number>();

  constructor(private options: LocalExecutorOptions) {}

  /** Running local jobs for a project */
  runningJobs(project: string): number {
    return this.running.get(project) ?? 0;
  }

  private stepEnv(job: JobSpec, extra?: Record<string, string>): Record<string, string> {
    const strip = new Set([...ALWAYS_STRIPPED, job.settings.executors.github.tokenEnv]);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env)) {
      if (value !== undefined && !strip.has(key)) env[key] = value;
    }
    return { ...env, ...(extra ?? {}) };
  }

  private git(job: JobSpec, args: string[], timeoutMs = 120_000): Promise<ExecuteResult> {
    return this.options.spawner.run(["git", "-C", job.repoDir, ...args], {
      cwd: job.repoDir,
      env: this.stepEnv(job),
      timeoutMs,
    });
  }

  async run(job: JobSpec, reporter: AttemptReporter, control: JobControl): Promise<AttemptOutcome> {
    const settings = job.settings.executors.local;
    const { clock, capacity } = this.options;

    // Wait for a slot and for capacity; the reason is shown while waiting
    for (;;) {
      if (control.signal.aborted) {
        return control.isCancelled() ? { kind: "cancelled", reason: "cancelled" } : { kind: "interrupted" };
      }
      const busy = this.runningJobs(job.project);
      let problem: string | null =
        busy >= settings.maxParallel
          ? `${busy} local job(s) running (executors.local.max_parallel is ${settings.maxParallel})`
          : null;
      if (!problem) problem = capacityProblem(await capacity.sample(), settings);
      if (!problem) break;
      reporter.wait(`waiting for local capacity: ${problem}`);
      reporter.update({ status: "queued", reason: `waiting for local capacity: ${problem}` });
      await clock.sleep(settings.capacityRetrySeconds * 1000, control.signal);
    }
    reporter.wait(undefined);
    this.running.set(job.project, this.runningJobs(job.project) + 1);
    reporter.update({ status: "running", reason: undefined, where: "local machine" });

    let worktree: string | null = null;
    try {
      let workDir = job.repoDir;
      if (settings.workdir === "worktree") {
        const base = settings.worktreeDir ?? join(this.options.lairDir, "data", "pipelines", "worktrees");
        mkdirSync(base, { recursive: true });
        worktree = join(base, job.jobId);
        if (existsSync(worktree)) {
          await this.git(job, ["worktree", "remove", "--force", worktree]);
          rmSync(worktree, { recursive: true, force: true });
        }
        const added = await this.git(job, ["worktree", "add", "--detach", worktree, job.commitSha]);
        if (added.exitCode !== 0) {
          worktree = null;
          return {
            kind: "error",
            reason: `git worktree add failed for ${job.commitSha}: ${(added.stderr || added.stdout).trim()}`,
          };
        }
        workDir = join(base, job.jobId);
      } else {
        const head = await this.git(job, ["rev-parse", "HEAD"], 30_000);
        const at = head.stdout.trim();
        if (head.exitCode !== 0 || at !== job.commitSha) {
          return {
            kind: "error",
            reason:
              head.exitCode !== 0
                ? `git rev-parse HEAD failed in ${job.repoDir}: ${head.stderr.trim()}`
                : `executors.local.workdir is repo, and the repository is at ${at}, not ${job.commitSha}`,
          };
        }
      }

      const result = await runGate({
        pipeline: job.lane.gate,
        commitSha: job.commitSha,
        branch: job.branch ?? "",
        projectId: job.project,
        nodeId: "local",
        changedFiles: [],
        workDir,
        signal: control.signal,
        executeCommand: (_command, options) => {
          if (!options.argv) {
            // Pipelines from the project config always have an argv; never run a shell string
            return Promise.resolve({
              exitCode: -1,
              stdout: "",
              stderr: "refused: the step has no argv",
              timedOut: false,
              durationMs: 0,
            });
          }
          return this.options.spawner.run(options.argv, {
            cwd: options.cwd,
            env: this.stepEnv(job, options.env),
            timeoutMs: options.timeoutMs,
            signal: options.signal,
          });
        },
      });
      if (control.signal.aborted) {
        return control.isCancelled() ? { kind: "cancelled", reason: "cancelled" } : { kind: "interrupted" };
      }
      const log = result.steps
        .map((s) => `== ${s.name}: ${s.status}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ""} ==\n${s.output ?? s.error ?? ""}`)
        .join("\n");
      return {
        kind: "completed",
        result,
        where: "local machine",
        log: log.length > LOG_TAIL_CHARS ? log.slice(-LOG_TAIL_CHARS) : log,
        artifacts: [],
        minutes: 0,
        billedMinutes: 0,
      };
    } finally {
      this.running.set(job.project, Math.max(0, this.runningJobs(job.project) - 1));
      if (worktree) {
        await this.git(job, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      }
    }
  }
}
