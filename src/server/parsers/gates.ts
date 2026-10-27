/**
 * Gate file parser - pure functions for parsing gate queue and results
 */
import type { Gate, GateStatus } from "../../shared/types.js";
import { laneNames } from "../../shared/gate-lanes.js";

/**
 * A request file: <lane>.<priority>.<gate-id>.req, then an optional status
 * suffix (.req.run, .req.superseded, .req.stuck, .req.deferred-stacked, ...).
 * The lane comes from the file name, so every lane a runner uses shows
 * (heavy, light, remote, quick, actions, ...): a letter, then letters,
 * digits, "_" or "-", at most 32 characters (as the watchdog's isSafeLane).
 * The gate id is a safe file-name stem (as isSafeGateId in services/data.ts).
 */
const REQUEST_FILE =
  /^([A-Za-z][A-Za-z0-9_-]{0,31})\.(\d{1,9})\.([A-Za-z0-9][A-Za-z0-9._-]{0,199}?)\.req(?:\.([a-z][a-z0-9-]{0,31}))?$/;

/** The usual gate id: <UTC stamp>-<track>-<sha>-<random> */
const STRUCTURED_ID = /^(\d{8}T\d{6}Z)-([a-zA-Z0-9-]+)-([a-f0-9]+)-(\d+)$/;

/** Suffixes of files kept next to the requests that are not a request status */
const NOT_A_STATUS = new Set(["log", "lock", "pid", "tmp", "json", "rc", "txt", "out", "err"]);

/** Longest file name looked at (the parts' limits add up to less) */
const MAX_NAME_LENGTH = 300;

/**
 * Parse a gate request filename into structured data
 * Format: <lane>.<priority>.<gate-id>.req[.<status>]
 * Example: heavy.1.20260101T000000Z-example-track-abcdef12-12345.req
 *
 * The lane is any safe lane name (REQUEST_FILE), not a fixed list. The status is
 * queued for .req and running for .req.run; any other suffix is the status
 * it names (.req.superseded: superseded, .req.stuck: stuck). Track, sha and
 * start time are filled in when the id has the usual form (STRUCTURED_ID).
 */
export function parseGateFilename(filename: string): Gate | null {
  // Remove directory path if present
  const basename = filename.split("/").pop() || filename;
  if (basename.length > MAX_NAME_LENGTH) {
    return null;
  }

  const match = REQUEST_FILE.exec(basename);
  if (!match) {
    return null;
  }

  const [, lane, priority, id, suffix] = match;
  if (suffix !== undefined && NOT_A_STATUS.has(suffix)) {
    return null;
  }
  const status: GateStatus =
    suffix === undefined ? "queued" : suffix === "run" ? "running" : suffix;

  const gate: Gate = {
    id,
    lane,
    priority: parseInt(priority, 10),
    status,
  };
  const structured = STRUCTURED_ID.exec(id);
  if (structured) {
    const [, timestamp, track, sha] = structured;
    gate.track = track;
    gate.headSha = sha;
    gate.startTime = parseGateTimestamp(timestamp);
  }
  return gate;
}

/**
 * Parse gate timestamp from format 20261024T211503Z to ISO string
 */
export function parseGateTimestamp(ts: string): string {
  // Format: YYYYMMDDTHHMMSSZ
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) {
    return ts; // Return as-is if doesn't match
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * Calculate gate age in seconds from start time
 */
export function calculateGateAge(startTime: string): number {
  const start = new Date(startTime);
  const now = new Date();
  return Math.floor((now.getTime() - start.getTime()) / 1000);
}

/**
 * Parse a gate result file (.rc)
 */
export function parseGateRc(content: string): number | null {
  const trimmed = content.trim();
  const rc = parseInt(trimmed, 10);
  return isNaN(rc) ? null : rc;
}

/**
 * Parse gate log to extract current step and failed steps
 */
export function parseGateLog(content: string): {
  currentStep?: string;
  failedSteps: string[];
  steps: { name: string; status: "PASS" | "FAIL" | "SKIPPED" | "running" }[];
} {
  const lines = content.split("\n");
  const failedSteps: string[] = [];
  const steps: {
    name: string;
    status: "PASS" | "FAIL" | "SKIPPED" | "running";
  }[] = [];
  let currentStep: string | undefined;

  for (const line of lines) {
    // Match step status lines like "STEP commitlint: PASS (0s)"
    // or "  commitlint                        0s  PASS"
    const stepMatch = line.match(
      /(?:STEP\s+)?(\w[\w-]*)\s*(?::|\.{2,}|\s{2,})\s*(?:(\d+)s\s+)?(PASS|FAIL|SKIPPED)/i,
    );

    if (stepMatch) {
      const [, name, , status] = stepMatch;
      steps.push({
        name,
        status: status.toUpperCase() as "PASS" | "FAIL" | "SKIPPED",
      });
      if (status.toUpperCase() === "FAIL") {
        failedSteps.push(name);
      }
    }

    // Match "STEP <name>:" at start (indicates current running step)
    const currentMatch = line.match(/^STEP\s+(\w[\w-]*):/);
    if (currentMatch) {
      currentStep = currentMatch[1];
    }

    // Also check for "== FAILED STEPS: step1(rc=1) step2(rc=1)"
    const failedMatch = line.match(/== FAILED STEPS:\s*(.+)/);
    if (failedMatch) {
      const failedList = failedMatch[1].match(/(\w[\w-]*)\(rc=\d+\)/g);
      if (failedList) {
        for (const f of failedList) {
          const name = f.replace(/\(rc=\d+\)/, "");
          if (!failedSteps.includes(name)) {
            failedSteps.push(name);
          }
        }
      }
    }
  }

  return { currentStep, failedSteps, steps };
}

/**
 * Parse multiple gate files from a directory listing
 */
export function parseGateFiles(filenames: string[]): Gate[] {
  const gates: Gate[] = [];

  for (const filename of filenames) {
    const gate = parseGateFilename(filename);
    if (gate) {
      gates.push(gate);
    }
  }

  // Sort by priority (lower first), then by timestamp
  return gates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}

/**
 * Group gates by lane: one entry per lane the gates name (laneNames order),
 * not a fixed list.
 */
export function groupByLane(gates: Gate[]): Record<string, Gate[]> {
  const result: Record<string, Gate[]> = {};
  for (const lane of laneNames(gates)) {
    result[lane] = [];
  }

  for (const gate of gates) {
    result[gate.lane].push(gate);
  }

  return result;
}

/**
 * Find duplicate gates (same track, different IDs)
 */
export function findDuplicates(gates: Gate[]): Gate[][] {
  const byTrack = new Map<string, Gate[]>();

  for (const gate of gates) {
    if (gate.track && gate.status === "queued") {
      const existing = byTrack.get(gate.track) || [];
      existing.push(gate);
      byTrack.set(gate.track, existing);
    }
  }

  return Array.from(byTrack.values()).filter((group) => group.length > 1);
}

/**
 * Check if a gate is stale (running for too long)
 */
export function isStaleRun(gate: Gate, maxAgeSeconds: number = 7200): boolean {
  if (gate.status !== "running" || !gate.startTime) {
    return false;
  }

  const age = calculateGateAge(gate.startTime);
  return age > maxAgeSeconds;
}
