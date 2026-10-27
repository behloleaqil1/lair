/**
 * Data service - reads files from the configured project paths
 * All operations are READ-ONLY
 */
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from "fs";
import { join } from "path";
import { execSync, execFileSync } from "child_process";
import type {
  ProjectConfig,
  Dragon,
  Gate,
  QueueLine,
  QueueLineType,
  PullRequest,
  MachineStatus,
  OrchestratorStatus,
  OverviewData,
  Problem,
  GateResult,
  RunnerStatus,
  MergedPR,
  ManagedRunInfo,
} from "../../shared/types.js";
import {
  parseQueueFile,
  filterByType,
  filterByAgent,
  calculateAgentStats,
  getTickLines,
} from "../parsers/queue.js";
import {
  parseDragonsFile,
  isDragonRunning,
  matchLogsToDragons,
  getMostRecentLog,
  parseLogLastLine,
  calculateDragonStats,
  isLogSilent,
} from "../parsers/dragons.js";
import {
  parseGateFiles,
  parseGateRc,
  parseGateLog,
  groupByLane,
  findDuplicates,
  isStaleRun,
} from "../parsers/gates.js";
import { hasOwnModel } from "../parsers/dragon-config.js";
import { mergeDragonRegistry } from "./dragon-registry.js";

/**
 * Safe file read - returns null if file doesn't exist
 */
function safeReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Safe directory list - returns empty array if dir doesn't exist
 */
function safeListDir(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Run a read-only command WITHOUT a shell. Arguments are passed as argv, so
 * values from config, files or requests can never be parsed as shell syntax.
 * Returns stdout, or null if the command fails or is missing.
 */
function safeExecFile(
  file: string,
  args: string[],
  timeoutMs = 5000,
): string | null {
  try {
    return execFileSync(file, args, {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Run a shell command string. Only for the legacy `ssh_cmd` machine key,
 * whose value IS a shell command written by the user in their own project
 * config. Never pass file- or request-derived values here.
 */
function safeExecShell(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Gate ids are file-name stems: no path separators, no leading dot. */
const SAFE_GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** True if `id` is safe to join into a gates_dir path. */
export function isSafeGateId(id: unknown): id is string {
  return typeof id === "string" && SAFE_GATE_ID.test(id);
}

/** A PID read from a runner pid file: digits only, and not 0. */
export function parsePidFile(content: string | null): string | null {
  const pid = content?.trim();
  if (!pid || !/^\d+$/.test(pid) || /^0+$/.test(pid)) {
    return null;
  }
  return pid;
}

/** True if a process with this (validated) PID exists. */
function isPidRunning(pid: string): boolean {
  return safeExecFile("ps", ["-p", pid, "-o", "pid="]) !== null;
}

/** How many of a dragon's newest logs (by name) are checked for the newest by mtime */
const LOG_CANDIDATES = 20;
/** The end of a dragon's log that its last line is read from */
const DRAGON_LOG_TAIL_BYTES = 64 * 1024;
/** The end of a gate result's log that failed steps are read from */
const RESULT_LOG_TAIL_BYTES = 1024 * 1024;
/** At most this many recent gate results (newest first) */
const RECENT_RESULTS_LIMIT = 100;
/** The longest window /api/gates/results looks back */
const MAX_RESULT_HOURS = 24 * 30;
/** A result written a little "in the future" (another machine's clock) still counts */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The last `maxBytes` of a regular file as UTF-8, or null. Opened without
 * blocking, so a FIFO planted where a log should be can't hang the server.
 */
function readTail(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface DataServiceOptions {
  /**
   * The agents module's active runs per dragon id (AgentsManager.managedRuns
   * for this project): such a dragon is running, "managed by Lair"
   */
  managedRuns?: () => Map<string, ManagedRunInfo>;
}

export class DataService {
  constructor(
    private config: ProjectConfig,
    private options: DataServiceOptions = {},
  ) {}

  // ============ QUEUE ============

  getQueueLines(): QueueLine[] {
    const content = safeReadFile(this.config.queue_file);
    if (!content) return [];
    return parseQueueFile(content);
  }

  getQueueLinesByType(types: string[]): QueueLine[] {
    const lines = this.getQueueLines();
    return filterByType(lines, types as QueueLineType[]);
  }

  getQueueLinesByAgent(agentId: string): QueueLine[] {
    const lines = this.getQueueLines();
    return filterByAgent(lines, agentId);
  }

  // ============ DRAGONS ============

  /**
   * The dragons of dragons.txt (and any dragon the agents module has a run
   * for), with:
   * - running: a `<id>.running` directory, or an active run in the agents
   *   module (managedRun: its state, e.g. working or hung);
   * - lastLogTime: when its newest log (`<id>-<UTC>.log` or `<id>.log`) was
   *   last written, that file's mtime; lastLogLine: that file's last line;
   * - model and adapter: its own (YAML dragons:), else dragon_defaults';
   *   modelFromDefault says which.
   */
  getDragons(): Dragon[] {
    const content = safeReadFile(join(this.config.agents_dir, "dragons.txt")) ?? "";
    const listed = parseDragonsFile(content);
    // The YAML dragons: with dragons.txt, dragon_defaults applied (as start/stop and the agents module see them)
    const registry = mergeDragonRegistry(this.config, content);
    const managed = this.managedRuns();

    // A dragon the agents module runs is shown even when dragons.txt doesn't list it
    const listedIds = new Set(listed.map((d) => d.id));
    for (const [id, run] of managed) {
      const known = registry.get(id);
      if (known && !listedIds.has(id)) {
        listed.push({ id, name: known.name, task: run.task });
        listedIds.add(id);
      }
    }
    if (listed.length === 0) return [];

    const entries = safeListDir(this.config.agents_dir);
    const runningDirs = entries.filter((d) => d.endsWith(".running"));
    const logFiles = entries.filter((f) => f.endsWith(".log"));
    const logsByDragon = matchLogsToDragons(
      logFiles,
      listed.map((d) => d.id),
    );

    const queueLines = this.getQueueLines();
    const gateResults = this.getGateResultsMap();

    return listed.map((d) => {
      const run = managed.get(d.id);
      const newest = this.newestLog(logsByDragon.get(d.id) || []);
      const parsed = newest
        ? parseLogLastLine(readTail(newest.path, DRAGON_LOG_TAIL_BYTES) ?? "")
        : null;

      const queueStats = calculateAgentStats(queueLines, d.id);
      const stats = calculateDragonStats(
        queueStats.gateIds,
        gateResults,
        queueStats,
      );

      // Config-derived fields (phase 4)
      const dragonConfig = registry.get(d.id);
      const model = dragonConfig?.model || undefined;

      return {
        ...d,
        running: run !== undefined || isDragonRunning(runningDirs, d.id),
        lastLogTime: newest ? newest.mtime.toISOString() : undefined,
        lastLogLine: parsed?.line,
        stats,
        model,
        modelFromDefault: model !== undefined && !hasOwnModel(this.config, d.id),
        machine: dragonConfig?.machine || undefined,
        instructions: dragonConfig?.instructions || undefined,
        adapter: dragonConfig?.adapter,
        ...(run ? { managedRun: run } : {}),
      };
    });
  }

  /** The agents module's active runs per dragon (none without the module). */
  private managedRuns(): Map<string, ManagedRunInfo> {
    try {
      return this.options.managedRuns?.() ?? new Map();
    } catch {
      return new Map();
    }
  }

  /**
   * The newest of a dragon's logs by mtime. Only the newest few by name are
   * looked at (their names carry a UTC stamp), so a directory of old logs
   * costs no more than a handful of stats.
   */
  private newestLog(files: string[]): { path: string; mtimeMs: number; mtime: Date } | null {
    let newest: { path: string; mtimeMs: number; mtime: Date } | null = null;
    for (const file of [...files].sort().reverse().slice(0, LOG_CANDIDATES)) {
      const path = join(this.config.agents_dir, file);
      try {
        const stat = statSync(path);
        if (stat.isFile() && (newest === null || stat.mtimeMs > newest.mtimeMs)) {
          newest = { path, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
        }
      } catch {
        // Gone since the listing
      }
    }
    return newest;
  }

  getDragonById(id: string): Dragon | null {
    const dragons = this.getDragons();
    return dragons.find((d) => d.id === id) || null;
  }

  getDragonLogTail(id: string, lines = 50): string | null {
    const logFiles = safeListDir(this.config.agents_dir).filter(
      (f) => f.startsWith(id) && f.endsWith(".log"),
    );

    const recentLog = getMostRecentLog(logFiles);
    if (!recentLog) return null;

    const logPath = join(this.config.agents_dir, recentLog);
    const content = safeReadFile(logPath);
    if (!content) return null;

    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  // ============ GATES ============

  getGateQueue(): Gate[] {
    const queueDir = join(this.config.gates_dir, "queue");
    const files = safeListDir(queueDir).filter(
      (f) => f.endsWith(".req") || f.includes(".req."),
    );
    return parseGateFiles(files);
  }

  getGatesByStatus(status: string): Gate[] {
    const gates = this.getGateQueue();
    return gates.filter((g) => g.status === status);
  }

  getRunningGates(): Gate[] {
    const gates = this.getGateQueue();
    return gates
      .filter((g) => g.status === "running")
      .map((gate) => {
        // Try to read current step from log: <lane>.<priority>.<gate-id>.log
        const logPath = join(
          this.config.gates_dir,
          "queue",
          `${gate.lane}.${gate.priority}.${gate.id}.log`,
        );
        const content = readTail(logPath, RESULT_LOG_TAIL_BYTES);
        if (content) {
          const { currentStep } = parseGateLog(content);
          return { ...gate, currentStep };
        }
        return gate;
      });
  }

  getGateResultsMap(): Map<string, number> {
    const resultsDir = join(this.config.gates_dir, "results");
    const files = safeListDir(resultsDir).filter((f) => f.endsWith(".rc"));

    const results = new Map<string, number>();
    for (const file of files) {
      const id = file.replace(".rc", "");
      const content = safeReadFile(join(resultsDir, file));
      if (content) {
        const rc = parseGateRc(content);
        if (rc !== null) {
          results.set(id, rc);
        }
      }
    }
    return results;
  }

  /**
   * The results written in the last `hours` hours, newest first, at most
   * `limit`. A result's time is when it was written (its .rc file's mtime),
   * returned as finishedAt; one more than a few minutes in the future (a
   * clock ahead, a copied file) is not counted as recent.
   */
  getRecentGateResults(
    hours = 24,
    limit = RECENT_RESULTS_LIMIT,
    now = Date.now(),
  ): GateResult[] {
    const resultsDir = join(this.config.gates_dir, "results");
    const span =
      Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_RESULT_HOURS) : 24;
    const cutoff = now - span * 60 * 60 * 1000;
    const latest = now + CLOCK_SKEW_MS;

    const recent: { id: string; rcPath: string; mtimeMs: number; mtime: Date }[] = [];
    for (const file of safeListDir(resultsDir)) {
      if (!file.endsWith(".rc")) continue;
      const id = file.slice(0, -".rc".length);
      if (!isSafeGateId(id)) continue;
      const rcPath = join(resultsDir, file);
      try {
        const stat = statSync(rcPath);
        if (!stat.isFile() || stat.mtimeMs < cutoff || stat.mtimeMs > latest) continue;
        recent.push({ id, rcPath, mtimeMs: stat.mtimeMs, mtime: stat.mtime });
      } catch {
        continue;
      }
    }
    // Newest first; for the same time, the later id first
    recent.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

    const results: GateResult[] = [];
    for (const { id, rcPath, mtime } of recent) {
      if (results.length >= limit) break;
      const rc = parseGateRc(readTail(rcPath, 1024) ?? "");
      if (rc === null) continue;

      const logContent = readTail(join(resultsDir, `${id}.log`), RESULT_LOG_TAIL_BYTES);
      const { failedSteps } = logContent
        ? parseGateLog(logContent)
        : { failedSteps: [] };

      results.push({
        id,
        rc,
        finishedAt: mtime.toISOString(),
        failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
      });
    }

    return results;
  }

  getGateLog(id: string): string | null {
    // The id comes from the URL (Fastify decodes %2F), so it must not be
    // able to name a path outside gates_dir
    if (!isSafeGateId(id)) {
      throw new Error("Invalid gate id");
    }

    // Try results first
    const resultsLog = join(this.config.gates_dir, "results", `${id}.log`);
    const content = safeReadFile(resultsLog);
    if (content) return content;

    // Try finding in queue logs
    const queueDir = join(this.config.gates_dir, "queue");
    const files = safeListDir(queueDir).filter(
      (f) => f.includes(id) && f.endsWith(".log"),
    );
    if (files.length > 0) {
      return safeReadFile(join(queueDir, files[0]));
    }

    return null;
  }

  // ============ PRs ============

  getPullRequests(): PullRequest[] {
    if (!this.config.github) return [];

    const output = safeExecFile(
      "gh",
      [
        "pr",
        "list",
        "-R",
        this.config.github,
        "--json",
        "number,title,headRefName,headRefOid,mergeable,updatedAt",
      ],
      15000,
    );

    if (!output) return [];

    try {
      interface GhPr {
        number: number;
        title: string;
        headRefName: string;
        headRefOid: string;
        mergeable: string;
        updatedAt: string;
      }
      const prs = JSON.parse(output) as GhPr[];
      const gateResults = this.getGateResultsMap();

      return prs.map((pr) => {
        // Find latest gate for this head sha
        let latestGate: Gate | undefined;
        let mergeReady = false;

        for (const [id, rc] of gateResults) {
          if (id.includes(pr.headRefOid.slice(0, 8))) {
            if (!latestGate || id > latestGate.id) {
              latestGate = {
                id,
                lane: "heavy",
                priority: 0,
                status: "completed",
              } as Gate;
            }
            if (rc === 0) {
              mergeReady = true;
            }
          }
        }

        return {
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          headRefOid: pr.headRefOid,
          mergeable: pr.mergeable,
          updatedAt: pr.updatedAt,
          latestGate,
          mergeReady,
        };
      });
    } catch {
      return [];
    }
  }

  // ============ MACHINES ============

  getMachineStatuses(): MachineStatus[] {
    const statuses: MachineStatus[] = [];

    for (const [, machine] of Object.entries(this.config.machines || {})) {
      let up = false;

      if (machine.type === "local") {
        up = true; // Local is always up if we're running
      } else if (machine.type === "ssh" && machine.ssh_cmd) {
        // Legacy key: ssh_cmd is a shell command the user wrote in their config
        const result = safeExecShell(machine.ssh_cmd, 10000);
        up = result?.trim() === "up";
      }

      // Check for runner processes
      const runners: RunnerStatus[] = [];

      if (machine.type === "local") {
        for (const lane of ["heavy", "light", "remote"] as const) {
          // Pid files are written by gate runners (and anything else that can
          // write gates_dir), so treat their content as untrusted
          const content = safeReadFile(
            join(this.config.gates_dir, `runner-${lane}.pid`),
          );
          if (!content) continue;
          const pid = parsePidFile(content);
          runners.push({ lane, running: pid !== null && isPidRunning(pid) });
        }
      }

      statuses.push({
        name: machine.name,
        type: machine.type,
        up,
        lastCheck: new Date().toISOString(),
        runners,
      });
    }

    return statuses;
  }

  // ============ ORCHESTRATOR ============

  getOrchestratorStatus(): OrchestratorStatus {
    const queueLines = this.getQueueLines();
    const tickLines = getTickLines(queueLines, 30);

    const stopPath = join(this.config.agents_dir, "STOP");
    const stopFileExists = existsSync(stopPath);

    let launchdLoaded = false;
    if (this.config.orchestrator?.launchd_label) {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        const result = safeExecFile("launchctl", [
          "print",
          `gui/${uid}/${this.config.orchestrator.launchd_label}`,
        ]);
        launchdLoaded = result !== null && !result.includes("Could not find");
      }
    }

    return {
      tickLines,
      stopFileExists,
      launchdLoaded,
    };
  }

  // ============ OVERVIEW ============

  getOverview(): OverviewData {
    const problems: Problem[] = [];

    // Get main head
    let mainHead = "unknown";
    let mainDate = "unknown";

    const gitLog = safeExecFile("git", [
      "-C",
      this.config.repo,
      "log",
      "-1",
      "--format=%H %ci",
      "origin/main",
    ]);
    if (gitLog) {
      const parts = gitLog.trim().split(" ");
      mainHead = parts[0]?.slice(0, 8) || "unknown";
      mainDate = parts.slice(1).join(" ") || "unknown";
    }

    // Get recent merges
    const mergesOutput = this.config.github
      ? safeExecFile(
          "gh",
          [
            "pr",
            "list",
            "-R",
            this.config.github,
            "--state",
            "merged",
            "--json",
            "number,title,mergedAt",
            "-L",
            "10",
          ],
          15000,
        )
      : null;

    let recentMerges: MergedPR[] = [];
    if (mergesOutput) {
      try {
        interface GhMergedPr {
          number: number;
          title: string;
          mergedAt: string;
        }
        const all = JSON.parse(mergesOutput) as GhMergedPr[];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        recentMerges = all.filter(
          (pr) => new Date(pr.mergedAt).getTime() > cutoff,
        );
      } catch {
        // ignore parse errors
      }
    }

    // Check for problems
    const gates = this.getGateQueue();
    const dragons = this.getDragons();

    // Stale runs (> 2 hours)
    for (const gate of gates) {
      if (isStaleRun(gate, 7200)) {
        problems.push({
          type: "stale_run",
          severity: "warning",
          message: `Gate ${gate.id} running for > 2 hours`,
          details: `Lane: ${gate.lane}, Track: ${gate.track}`,
        });
      }
    }

    // Duplicate gates
    const duplicates = findDuplicates(gates);
    for (const group of duplicates) {
      problems.push({
        type: "duplicate_gate",
        severity: "warning",
        message: `Duplicate queued gates for track ${group[0].track}`,
        details: `IDs: ${group.map((g) => g.id).join(", ")}`,
      });
    }

    // Silent agents: only a known log time can be silent; an unknown one is said so
    for (const dragon of dragons) {
      if (!dragon.running) continue;
      if (!dragon.lastLogTime) {
        problems.push({
          type: "log_time_unknown",
          severity: "warning",
          message: `${dragon.name} (${dragon.id}): log time unknown`,
          details: `No log of it (${dragon.id}-<UTC>.log or ${dragon.id}.log) in agents_dir`,
        });
      } else if (isLogSilent(dragon.lastLogTime, 45)) {
        problems.push({
          type: "silent_agent",
          severity: "warning",
          message: `${dragon.name} (${dragon.id}) silent > 45 min`,
          details: `Last log: ${dragon.lastLogTime}`,
        });
      }
    }

    // No runner for lane with queued gates: the lanes a machine's runners can serve
    const byLane = groupByLane(gates);
    const machines = this.getMachineStatuses();
    const localMachine = machines.find((m) => m.type === "local");

    for (const lane of ["heavy", "light", "remote"] as const) {
      const queued = (byLane[lane] ?? []).filter((g) => g.status === "queued");
      if (queued.length > 0) {
        const runner = localMachine?.runners?.find((r) => r.lane === lane);
        if (!runner || !runner.running) {
          problems.push({
            type: "no_runner",
            severity: "error",
            message: `No runner for ${lane} lane with ${queued.length} queued gates`,
          });
        }
      }
    }

    // Count agents
    const runningCount = dragons.filter((d) => d.running).length;
    const idleCount = dragons.length - runningCount;

    // Count gates
    const queuedCount = gates.filter((g) => g.status === "queued").length;
    const runningGates = gates.filter((g) => g.status === "running").length;

    return {
      project: this.config.name,
      mainHead,
      mainDate,
      recentMerges,
      problems,
      agentCounts: { running: runningCount, idle: idleCount },
      gateCounts: { queued: queuedCount, running: runningGates },
    };
  }
}
