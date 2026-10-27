/**
 * Dragons/agents parser - pure functions for parsing dragons.txt and related files
 */
import type { Dragon, DragonStats } from "../../shared/types.js";

/**
 * Parse dragons.txt file
 * Format: one line per dragon, tab-separated: id, name, task
 * Example: kiro-A\tSmaug\tfix-auth-bug
 */
export function parseDragonsFile(
  content: string,
): Omit<Dragon, "running" | "lastLogTime" | "lastLogLine" | "stats">[] {
  const lines = content.trim().split("\n");
  const dragons: Omit<
    Dragon,
    "running" | "lastLogTime" | "lastLogLine" | "stats"
  >[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Try tab-separated first, then space-separated
    let parts = trimmed.split("\t");
    if (parts.length < 2) {
      parts = trimmed.split(/\s+/);
    }

    if (parts.length >= 2) {
      const [id, name, ...taskParts] = parts;
      dragons.push({
        id: id.trim(),
        name: name.trim(),
        task: taskParts.join(" ").trim() || "unassigned",
      });
    }
  }

  return dragons;
}

/**
 * Parse owners.txt file (task ownership)
 * Format: task\tdragon-id
 */
export function parseOwnersFile(content: string): Map<string, string> {
  const lines = content.trim().split("\n");
  const owners = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      const [task, dragonId] = parts;
      owners.set(task.trim(), dragonId.trim());
    }
  }

  return owners;
}

/**
 * Parse a dragon's log file to extract last meaningful line
 * Skips [INFO], [tool], and other noise
 */
export function parseLogLastLine(
  content: string,
): { time?: string; line: string } | null {
  const lines = content.trim().split("\n");

  // Work backwards to find a meaningful line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (!line) continue;

    // Skip noise patterns
    if (
      line.startsWith("[INFO]") ||
      line.startsWith("[tool]") ||
      line.startsWith("[DEBUG]") ||
      line.match(/^\s*$/) ||
      line.match(/^-{3,}$/) ||
      line.match(/^={3,}$/)
    ) {
      continue;
    }

    // Try to extract timestamp from line
    const timeMatch = line.match(
      /^(\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
    );

    return {
      time: timeMatch?.[1],
      line: line.slice(0, 200), // Truncate long lines
    };
  }

  return null;
}

/**
 * Check if a dragon is running (has a .running directory)
 */
export function isDragonRunning(
  runningDirs: string[],
  dragonId: string,
): boolean {
  return runningDirs.some(
    (dir) => dir.includes(dragonId) || dir === `${dragonId}.running`,
  );
}

/**
 * Calculate dragon stats from gate results
 */
export function calculateDragonStats(
  gateIds: string[],
  gateResults: Map<string, number>,
  queueStats: { doneCount: number; waitingCount: number; blockedCount: number },
): DragonStats {
  let gatesPassed = 0;
  let gatesFailed = 0;

  for (const gateId of gateIds) {
    const rc = gateResults.get(gateId);
    if (rc === 0) {
      gatesPassed++;
    } else if (rc !== undefined) {
      gatesFailed++;
    }
  }

  const gatesSubmitted = gateIds.length;
  const firstTimePassRate =
    gatesSubmitted > 0 ? Math.round((gatesPassed / gatesSubmitted) * 100) : 0;

  // Early stops: WAITING lines not followed by a gate
  // This is approximate - a more accurate count would require correlating timelines
  const earlyStops = Math.max(0, queueStats.waitingCount - gatesSubmitted);

  return {
    ...queueStats,
    gatesSubmitted,
    gatesPassed,
    gatesFailed,
    firstTimePassRate,
    earlyStops,
  };
}

/**
 * Match log files to dragons
 * Log format: <id>-<UTC>.log or <id>.log
 */
export function matchLogsToDragons(
  logFiles: string[],
  dragonIds: string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const dragonId of dragonIds) {
    result.set(dragonId, []);
  }

  for (const logFile of logFiles) {
    const basename = logFile.split("/").pop() || logFile;

    // Match pattern: kiro-X-20261024T123456Z.log or kiro-X.log
    for (const dragonId of dragonIds) {
      if (
        basename.startsWith(dragonId + "-") ||
        basename === dragonId + ".log"
      ) {
        const logs = result.get(dragonId) || [];
        logs.push(logFile);
        result.set(dragonId, logs);
        break;
      }
    }
  }

  return result;
}

/**
 * Get the most recent log file for a dragon
 */
export function getMostRecentLog(logFiles: string[]): string | null {
  if (logFiles.length === 0) {
    return null;
  }

  // Sort by filename (which includes timestamp) descending
  const sorted = [...logFiles].sort().reverse();
  return sorted[0];
}

/**
 * Check if a log is silent (no updates in given minutes). Only a known time
 * can be silent: an unknown or unreadable one is not (the overview says "log
 * time unknown" for it instead of raising a false "silent" alarm).
 */
export function isLogSilent(
  lastLogTime: string | undefined,
  silentMinutes: number = 45,
  now: number = Date.now(),
): boolean {
  if (!lastLogTime) {
    return false;
  }

  // Parse the time - could be HH:MM:SS or full ISO
  let logDate: Date;
  if (lastLogTime.includes("T")) {
    logDate = new Date(lastLogTime);
  } else if (lastLogTime.match(/^\d{2}:\d{2}:\d{2}$/)) {
    // Just time, assume today
    const today = new Date();
    const [h, m, s] = lastLogTime.split(":").map(Number);
    logDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      h,
      m,
      s,
    );
  } else {
    return false; // Can't parse: unknown, not silent
  }
  if (Number.isNaN(logDate.getTime())) {
    return false;
  }

  const diffMinutes = (now - logDate.getTime()) / (1000 * 60);

  return diffMinutes > silentMinutes;
}
