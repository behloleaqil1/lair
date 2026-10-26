/**
 * Gate file parser - pure functions for parsing gate queue and results
 */
import type { Gate, GateLane, GateStatus } from "../../shared/types.js";

/**
 * Parse a gate request filename into structured data
 * Format: <lane>.<priority>.<timestamp>-<track>-<sha>-<random>.req[.run|.superseded]
 * Example: heavy.1.20260101T000000Z-example-track-abcdef12-12345.req
 */
export function parseGateFilename(filename: string): Gate | null {
  // Remove directory path if present
  const basename = filename.split("/").pop() || filename;

  // Match the pattern
  const match = basename.match(
    /^(heavy|light|remote)\.(\d+)\.(\d{8}T\d{6}Z)-([a-zA-Z0-9-]+)-([a-f0-9]+)-(\d+)\.req(\.run|\.superseded)?$/,
  );

  if (!match) {
    return null;
  }

  const [, lane, priority, timestamp, track, sha, random, suffix] = match;

  let status: GateStatus = "queued";
  if (suffix === ".run") {
    status = "running";
  } else if (suffix === ".superseded") {
    status = "superseded";
  }

  const id = `${timestamp}-${track}-${sha}-${random}`;

  return {
    id,
    lane: lane as GateLane,
    priority: parseInt(priority, 10),
    status,
    track,
    headSha: sha,
    startTime: parseGateTimestamp(timestamp),
  };
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
 * Group gates by lane
 */
export function groupByLane(gates: Gate[]): Record<GateLane, Gate[]> {
  const result: Record<GateLane, Gate[]> = {
    heavy: [],
    light: [],
    remote: [],
  };

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
