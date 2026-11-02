/**
 * Data service - reads files from the configured project paths
 * All operations are READ-ONLY
 *
 * Every read is asynchronous and bounded (issue #245): the routes that call
 * these run on the event loop, and a synchronous listing of a folder of
 * thousands of logs or results, or a status command waited for in-line,
 * stalled every request and timer for seconds on a busy machine.
 */
import { exec, execFile } from "child_process";
import { join } from "path";
import { noteCommandTimeout } from "../core/command-timeouts.js";
import { listDir, lstatOrNull, mapLimit, readSmallFile, readTail as readTailFile, SingleFlight, statOrNull } from "./async-fs.js";
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
import { DEFAULT_TAIL_LINES, readLogTail } from "./log-tail.js";
import type { LogTailView } from "../../shared/dashboard-types.js";

/** The most a small file (dragons.txt, a pid file) may hold to be read */
const SMALL_FILE_BYTES = 1024 * 1024;
/** The end of the queue file read when no queue cache is given (tests and one-off tools) */
const QUEUE_TAIL_BYTES = 4 * 1024 * 1024;
/** Result codes read at once */
const READ_CONCURRENCY = 16;

/** A small file's text, or null when it is missing, unreadable or larger than SMALL_FILE_BYTES. */
function safeReadFile(path: string): Promise<string | null> {
  return readSmallFile(path, SMALL_FILE_BYTES);
}

/**
 * Run a read-only command WITHOUT a shell, asynchronously. Arguments are
 * passed as argv, so values from config, files or requests can never be
 * parsed as shell syntax. Returns stdout, or null if the command fails, is
 * missing, or runs past `timeoutMs` (it is then killed).
 */
function safeExecFile(file: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf-8" }, (error, stdout) => {
      if (!error) return resolve(stdout);
      // The supervisor's command_timeouts check counts the status commands that time out
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") noteCommandTimeout("status", file);
      resolve(null);
    });
    // Nothing is written to it (stdin was "ignore")
    child.stdin?.end();
  });
}

/**
 * Run a shell command string. Only for the legacy `ssh_cmd` machine key,
 * whose value IS a shell command written by the user in their own project
 * config. Never pass file- or request-derived values here.
 */
function safeExecShell(cmd: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf-8" }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
    child.stdin?.end();
  });
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
async function isPidRunning(pid: string): Promise<boolean> {
  return (await safeExecFile("ps", ["-p", pid, "-o", "pid="])) !== null;
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
async function readTail(path: string, maxBytes: number): Promise<string | null> {
  return (await readTailFile(path, maxBytes))?.text ?? null;
}

/** True for a regular file at `path` itself (a symlink is not one). */
async function isRegularFile(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isFile() === true;
}

/** A dragon's log: `<id>.log`, or `<id>-<UTC stamp>...log` (as the agents module and launchers name them). */
function isLogOf(file: string, id: string): boolean {
  if (!file.endsWith(".log")) return false;
  if (file === `${id}.log`) return true;
  return file.startsWith(`${id}-`) && /^\d{8}T\d{6}Z/.test(file.slice(id.length + 1));
}

export interface DataServiceOptions {
  /**
   * The agents module's active runs per dragon id (AgentsManager.managedRuns
   * for this project): such a dragon is running, "managed by Lair"
   */
  managedRuns?: () => Map<string, ManagedRunInfo>;
  /**
   * The project's parsed queue file, kept in memory (QueueCache). Without it
   * the file is read and parsed on each call, which only tests and one-off
   * tools do: the server always passes it.
   */
  queue?: () => QueueLine[];
}

export class DataService {
  /** Concurrent requests share one listing of a folder (and one read of the result codes) */
  private readonly flight = new SingleFlight<unknown>();

  constructor(
    private config: ProjectConfig,
    private options: DataServiceOptions = {},
  ) {}

  /** A folder's names ([] when it is missing), one listing at a time per folder. */
  private listDir(path: string): Promise<string[]> {
    return this.flight.run(`list:${path}`, () => listDir(path)) as Promise<string[]>;
  }

  // ============ QUEUE ============

  async getQueueLines(): Promise<QueueLine[]> {
    if (this.options.queue) return this.options.queue();
    const read = await readTailFile(this.config.queue_file, QUEUE_TAIL_BYTES);
    if (!read?.text) return [];
    // A window that starts inside the file starts inside a line: that one is dropped
    return parseQueueFile(read.partial ? read.text.slice(read.text.indexOf("\n") + 1) : read.text);
  }

  async getQueueLinesByType(types: string[]): Promise<QueueLine[]> {
    const lines = await this.getQueueLines();
    return filterByType(lines, types as QueueLineType[]);
  }

  async getQueueLinesByAgent(agentId: string): Promise<QueueLine[]> {
    const lines = await this.getQueueLines();
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
  async getDragons(): Promise<Dragon[]> {
    const content = (await safeReadFile(join(this.config.agents_dir, "dragons.txt"))) ?? "";
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

    const entries = await this.listDir(this.config.agents_dir);
    const runningDirs = entries.filter((d) => d.endsWith(".running"));
    const logFiles = entries.filter((f) => f.endsWith(".log"));
    const logsByDragon = matchLogsToDragons(
      logFiles,
      listed.map((d) => d.id),
    );

    const queueLines = await this.getQueueLines();
    const gateResults = await this.getGateResultsMap();

    return mapLimit(listed, 4, async (d) => {
      const run = managed.get(d.id);
      const newest = await this.newestLog(logsByDragon.get(d.id) || []);
      const parsed = newest
        ? parseLogLastLine((await readTail(newest.path, DRAGON_LOG_TAIL_BYTES)) ?? "")
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
  private async newestLog(files: string[]): Promise<{ path: string; mtimeMs: number; mtime: Date } | null> {
    const paths = [...files].sort().reverse().slice(0, LOG_CANDIDATES).map((file) => join(this.config.agents_dir, file));
    // Gone since the listing: null
    const stats = await mapLimit(paths, 4, statOrNull);
    let newest: { path: string; mtimeMs: number; mtime: Date } | null = null;
    for (let i = 0; i < paths.length; i++) {
      const stat = stats[i];
      if (stat?.isFile() && (newest === null || stat.mtimeMs > newest.mtimeMs)) {
        newest = { path: paths[i], mtimeMs: stat.mtimeMs, mtime: stat.mtime };
      }
    }
    return newest;
  }

  async getDragonById(id: string): Promise<Dragon | null> {
    const dragons = await this.getDragons();
    return dragons.find((d) => d.id === id) || null;
  }

  /**
   * The path of a dragon's newest log by mtime (`<id>.log` or
   * `<id>-<UTC>.log` in agents_dir), or null without one.
   */
  async getDragonLogPath(id: string): Promise<string | null> {
    const logs = (await this.listDir(this.config.agents_dir)).filter((f) => isLogOf(f, id));
    return (await this.newestLog(logs))?.path ?? null;
  }

  /** The bounded tail of a dragon's newest log (services/log-tail.ts), or null without one. */
  async getDragonLogTail(id: string, lines = DEFAULT_TAIL_LINES): Promise<LogTailView | null> {
    const path = await this.getDragonLogPath(id);
    return path ? readLogTail(path, lines) : null;
  }

  // ============ GATES ============

  async getGateQueue(): Promise<Gate[]> {
    const queueDir = join(this.config.gates_dir, "queue");
    const files = (await this.listDir(queueDir)).filter(
      (f) => f.endsWith(".req") || f.includes(".req."),
    );
    return parseGateFiles(files);
  }

  async getGatesByStatus(status: string): Promise<Gate[]> {
    const gates = await this.getGateQueue();
    return gates.filter((g) => g.status === status);
  }

  async getRunningGates(): Promise<Gate[]> {
    const gates = await this.getGateQueue();
    return mapLimit(gates.filter((g) => g.status === "running"), 4, async (gate) => {
      // Try to read current step from log: <lane>.<priority>.<gate-id>.log
      const logPath = join(this.config.gates_dir, "queue", `${gate.lane}.${gate.priority}.${gate.id}.log`);
      const content = await readTail(logPath, RESULT_LOG_TAIL_BYTES);
      if (content) {
        const { currentStep } = parseGateLog(content);
        return { ...gate, currentStep };
      }
      return gate;
    });
  }

  /** Every result code in gates_dir/results by gate id; concurrent callers share one read. */
  getGateResultsMap(): Promise<Map<string, number>> {
    return this.flight.run("results-map", () => this.readGateResultsMap()) as Promise<Map<string, number>>;
  }

  private async readGateResultsMap(): Promise<Map<string, number>> {
    const resultsDir = join(this.config.gates_dir, "results");
    const files = (await this.listDir(resultsDir)).filter((f) => f.endsWith(".rc"));
    const contents = await mapLimit(files, READ_CONCURRENCY, (file) => safeReadFile(join(resultsDir, file)));

    const results = new Map<string, number>();
    files.forEach((file, i) => {
      const id = file.replace(".rc", "");
      const content = contents[i];
      if (content) {
        const rc = parseGateRc(content);
        if (rc !== null) {
          results.set(id, rc);
        }
      }
    });
    return results;
  }

  /**
   * The results written in the last `hours` hours, newest first, at most
   * `limit`. A result's time is when it was written (its .rc file's mtime),
   * returned as finishedAt; one more than a few minutes in the future (a
   * clock ahead, a copied file) is not counted as recent.
   */
  async getRecentGateResults(
    hours = 24,
    limit = RECENT_RESULTS_LIMIT,
    now = Date.now(),
  ): Promise<GateResult[]> {
    const resultsDir = join(this.config.gates_dir, "results");
    const span =
      Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_RESULT_HOURS) : 24;
    const cutoff = now - span * 60 * 60 * 1000;
    const latest = now + CLOCK_SKEW_MS;

    const candidates = (await this.listDir(resultsDir)).flatMap((file) => {
      if (!file.endsWith(".rc")) return [];
      const id = file.slice(0, -".rc".length);
      return isSafeGateId(id) ? [{ id, rcPath: join(resultsDir, file) }] : [];
    });
    const stats = await mapLimit(candidates, READ_CONCURRENCY, ({ rcPath }) => statOrNull(rcPath));
    const recent: { id: string; rcPath: string; mtimeMs: number; mtime: Date }[] = [];
    candidates.forEach(({ id, rcPath }, i) => {
      const stat = stats[i];
      if (!stat || !stat.isFile() || stat.mtimeMs < cutoff || stat.mtimeMs > latest) return;
      recent.push({ id, rcPath, mtimeMs: stat.mtimeMs, mtime: stat.mtime });
    });
    // Newest first; for the same time, the later id first
    recent.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

    const results: GateResult[] = [];
    for (const { id, rcPath, mtime } of recent) {
      if (results.length >= limit) break;
      const rc = parseGateRc((await readTail(rcPath, 1024)) ?? "");
      if (rc === null) continue;

      const logContent = await readTail(join(resultsDir, `${id}.log`), RESULT_LOG_TAIL_BYTES);
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

  /**
   * One gate of the queue or the results, by id: its request (null once it
   * left the queue), its result (rc and when it was written; null before),
   * and the path of its log (the result's log, else the request's; null
   * without one). The id comes from a URL (Fastify decodes %2F), so it must
   * be a safe file-name stem that can't name a path outside gates_dir.
   */
  async getGateRecord(id: string): Promise<{
    gate: Gate | null;
    result: { rc: number; finishedAt: string } | null;
    logPath: string | null;
  }> {
    if (!isSafeGateId(id)) {
      throw new Error("Invalid gate id");
    }
    const gate = (await this.getGateQueue()).find((g) => g.id === id) ?? null;
    const resultsDir = join(this.config.gates_dir, "results");
    let result: { rc: number; finishedAt: string } | null = null;
    const rcPath = join(resultsDir, `${id}.rc`);
    const rcStat = await lstatOrNull(rcPath);
    if (rcStat?.isFile()) {
      const rc = parseGateRc((await readTail(rcPath, 1024)) ?? "");
      if (rc !== null) result = { rc, finishedAt: rcStat.mtime.toISOString() };
    }

    const queueDir = join(this.config.gates_dir, "queue");
    const candidates = [join(resultsDir, `${id}.log`)];
    if (gate) candidates.push(join(queueDir, `${gate.lane}.${gate.priority}.${id}.log`));
    for (const file of await this.listDir(queueDir)) {
      if (file.endsWith(`.${id}.log`)) candidates.push(join(queueDir, file));
    }
    let logPath: string | null = null;
    for (const path of candidates) {
      if (await isRegularFile(path)) {
        logPath = path;
        break;
      }
    }
    return { gate, result, logPath };
  }

  /** The bounded tail of a gate's log (services/log-tail.ts), or null without one. */
  async getGateLogTail(id: string, lines = DEFAULT_TAIL_LINES): Promise<LogTailView | null> {
    const { logPath } = await this.getGateRecord(id);
    return logPath ? readLogTail(logPath, lines) : null;
  }

  /** The end of a gate's log as text (at most RESULT_LOG_TAIL_BYTES), to read its steps; null without one. */
  async getGateLogText(id: string): Promise<string | null> {
    const { logPath } = await this.getGateRecord(id);
    return logPath ? readTail(logPath, RESULT_LOG_TAIL_BYTES) : null;
  }

  // ============ PRs ============

  async getPullRequests(): Promise<PullRequest[]> {
    if (!this.config.github) return [];

    const output = await safeExecFile(
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
      const gateResults = await this.getGateResultsMap();

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

  async getMachineStatuses(): Promise<MachineStatus[]> {
    const statuses: MachineStatus[] = [];

    for (const [, machine] of Object.entries(this.config.machines || {})) {
      let up = false;

      if (machine.type === "local") {
        up = true; // Local is always up if we're running
      } else if (machine.type === "ssh" && machine.ssh_cmd) {
        // Legacy key: ssh_cmd is a shell command the user wrote in their config
        const result = await safeExecShell(machine.ssh_cmd, 10000);
        up = result?.trim() === "up";
      }

      // Check for runner processes
      const runners: RunnerStatus[] = [];

      if (machine.type === "local") {
        for (const lane of ["heavy", "light", "remote"] as const) {
          // Pid files are written by gate runners (and anything else that can
          // write gates_dir), so treat their content as untrusted
          const content = await safeReadFile(
            join(this.config.gates_dir, `runner-${lane}.pid`),
          );
          if (!content) continue;
          const pid = parsePidFile(content);
          runners.push({ lane, running: pid !== null && (await isPidRunning(pid)) });
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

  async getOrchestratorStatus(): Promise<OrchestratorStatus> {
    const queueLines = await this.getQueueLines();
    const tickLines = getTickLines(queueLines, 30);

    const stopPath = join(this.config.agents_dir, "STOP");
    const stopFileExists = (await statOrNull(stopPath)) !== null;

    let launchdLoaded = false;
    if (this.config.orchestrator?.launchd_label) {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        const result = await safeExecFile("launchctl", [
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

  async getOverview(): Promise<OverviewData> {
    const problems: Problem[] = [];

    // Get main head
    let mainHead = "unknown";
    let mainDate = "unknown";

    const gitLogRead = safeExecFile("git", [
      "-C",
      this.config.repo,
      "log",
      "-1",
      "--format=%H %ci",
      "origin/main",
    ]);

    // Get recent merges (both commands run at once)
    const mergesRead = this.config.github
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
    const [gitLog, mergesOutput] = await Promise.all([gitLogRead, mergesRead]);
    if (gitLog) {
      const parts = gitLog.trim().split(" ");
      mainHead = parts[0]?.slice(0, 8) || "unknown";
      mainDate = parts.slice(1).join(" ") || "unknown";
    }

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
    const gates = await this.getGateQueue();
    const dragons = await this.getDragons();

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
    const machines = await this.getMachineStatuses();
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
