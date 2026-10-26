/**
 * Data service - reads files from the configured project paths
 * All operations are READ-ONLY
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
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
import { parseDragonRegistry } from "../parsers/dragon-config.js";

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

export class DataService {
  constructor(private config: ProjectConfig) {}

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

  getDragons(): Dragon[] {
    const dragonsPath = join(this.config.agents_dir, "dragons.txt");
    const content = safeReadFile(dragonsPath);
    if (!content) return [];

    const baseDragons = parseDragonsFile(content);
    const runningDirs = safeListDir(this.config.agents_dir).filter((d) =>
      d.endsWith(".running"),
    );

    const logFiles = safeListDir(this.config.agents_dir).filter((f) =>
      f.endsWith(".log"),
    );

    const dragonIds = baseDragons.map((d) => d.id);
    const logsByDragon = matchLogsToDragons(logFiles, dragonIds);

    const queueLines = this.getQueueLines();
    const gateResults = this.getGateResultsMap();

    // Get dragon registry from config (phase 4)
    const dragonRegistry = parseDragonRegistry(this.config);

    return baseDragons.map((d) => {
      const running = isDragonRunning(runningDirs, d.id);
      const logs = logsByDragon.get(d.id) || [];
      const recentLog = getMostRecentLog(logs);

      let lastLogTime: string | undefined;
      let lastLogLine: string | undefined;

      if (recentLog) {
        const logPath = join(this.config.agents_dir, recentLog);
        const logContent = safeReadFile(logPath);
        if (logContent) {
          const parsed = parseLogLastLine(logContent);
          if (parsed) {
            lastLogTime = parsed.time;
            lastLogLine = parsed.line;
          }
        }
      }

      const queueStats = calculateAgentStats(queueLines, d.id);
      const stats = calculateDragonStats(
        queueStats.gateIds,
        gateResults,
        queueStats,
      );

      // Get config-derived fields (phase 4)
      const dragonConfig = dragonRegistry.get(d.id);

      return {
        ...d,
        running,
        lastLogTime,
        lastLogLine,
        stats,
        // Add config-derived fields
        model: dragonConfig?.model,
        machine: dragonConfig?.machine,
        instructions: dragonConfig?.instructions,
        adapter: dragonConfig?.adapter,
      };
    });
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
        // Try to read current step from log
        const logPath = join(
          this.config.gates_dir,
          "queue",
          `${gate.lane}.${gate.priority}.${gate.id.split("-")[0]}-${gate.track}-${gate.headSha}-${gate.id.split("-").pop()}.log`,
        );
        const content = safeReadFile(logPath);
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

  getRecentGateResults(hours = 24): GateResult[] {
    const resultsDir = join(this.config.gates_dir, "results");
    const files = safeListDir(resultsDir);

    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const results: GateResult[] = [];

    for (const file of files) {
      if (!file.endsWith(".rc")) continue;

      const id = file.replace(".rc", "");
      const rcPath = join(resultsDir, file);
      const logPath = join(resultsDir, `${id}.log`);

      // Check file modification time
      try {
        const stat = statSync(rcPath);
        if (stat.mtimeMs < cutoff) continue;
      } catch {
        continue;
      }

      const rcContent = safeReadFile(rcPath);
      const logContent = safeReadFile(logPath);

      if (!rcContent) continue;

      const rc = parseGateRc(rcContent);
      if (rc === null) continue;

      const { failedSteps } = logContent
        ? parseGateLog(logContent)
        : { failedSteps: [] };

      results.push({
        id,
        rc,
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

    // Silent agents
    for (const dragon of dragons) {
      if (dragon.running && isLogSilent(dragon.lastLogTime, 45)) {
        problems.push({
          type: "silent_agent",
          severity: "warning",
          message: `${dragon.name} (${dragon.id}) silent > 45 min`,
          details: `Last log: ${dragon.lastLogTime || "unknown"}`,
        });
      }
    }

    // No runner for lane with queued gates
    const byLane = groupByLane(gates);
    const machines = this.getMachineStatuses();
    const localMachine = machines.find((m) => m.type === "local");

    for (const lane of ["heavy", "light", "remote"] as const) {
      const queued = byLane[lane].filter((g) => g.status === "queued");
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
