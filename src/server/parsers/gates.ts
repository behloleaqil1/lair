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

// ============ STEPS, FOR THE GATE DETAIL ============

/** A step's result as a gate log states it */
export type GateLogStepState = "passed" | "failed" | "skipped" | "running" | "timed_out";

export interface GateLogStep {
  name: string;
  state: GateLogStepState;
  /** null when the log gives no duration */
  durationSeconds: number | null;
  /** From "== FAILED STEPS: name(rc=N)" */
  exitCode?: number;
}

/** What a gate log says about its run: its steps and the commit it tested. */
export interface GateLogSummary {
  steps: GateLogStep[];
  /** The step still running (its "STEP name: running" line has no result after it) */
  currentStep: string | null;
  failedSteps: string[];
  sha: string | null;
  base: string | null;
  startedAt: string | null;
  lane: string | null;
  track: string | null;
  branch: string | null;
}

/** Lines are cut to this many characters before any regular expression sees them */
const MAX_STEP_LINE = 500;
/** At most this many lines of a log are read (the last ones) */
const MAX_STEP_LINES = 20_000;
/** At most this many steps are listed */
const MAX_STEPS = 200;

const STEP_NAME = "([A-Za-z0-9][\\w.-]{0,99})";
const RESULT = "(PASS(?:ED)?|FAIL(?:ED)?|SKIP(?:PED)?|TIMEOUT|TIMED[ _]OUT|running)";
const DURATION = "(\\d{1,9}(?:\\.\\d{1,3})?)\\s?(ms|s|sec|m|min)";
/** "STEP commitlint: PASS (2s)", "STEP verify-backend: running" */
const STEP_LINE = new RegExp(`^\\s*STEP\\s+${STEP_NAME}\\s*:\\s*${RESULT}\\b(?:\\s*\\(${DURATION}\\))?`, "i");
/** "PASS security-guard (24s)" */
const RESULT_FIRST = new RegExp(`^\\s*${RESULT}\\s+${STEP_NAME}(?:\\s*\\(${DURATION}\\))?\\s*$`, "i");
/** "  commitlint      0s  PASS" */
const TABLE_ROW = new RegExp(`^\\s*${STEP_NAME}\\s{2,}${DURATION}\\s+${RESULT}\\s*$`, "i");
/** "== gate backend at abc1234d 2026-10-24T14:35:00Z; base def5678e" */
const GATE_HEADER =
  /^==\s*gate\s+\S+\s+at\s+([0-9a-f]{7,64})(?:\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z))?(?:;\s*base\s+([0-9a-f]{7,64}))?/i;
/** "[gate-run] heavy lane, track: api-tests" */
const RUN_HEADER = /^\[gate-run\]\s*(?:([A-Za-z][\w-]{0,31})\s+lane)?(?:,?\s*track:\s*([A-Za-z0-9][\w.-]{0,99}))?/;
const BRANCH = /^(?:==|\[gate-run\]).*?\bbranch[:=]?\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,199})/i;
const FAILED_LIST = /^==\s*FAILED STEPS:\s*(.+)$/;
const FAILED_ENTRY = /([A-Za-z0-9][\w.-]{0,99})\(rc=(\d{1,5})\)/g;

function stepState(word: string): GateLogStepState {
  const w = word.toUpperCase();
  if (w.startsWith("PASS")) return "passed";
  if (w.startsWith("FAIL")) return "failed";
  if (w.startsWith("SKIP")) return "skipped";
  if (w === "RUNNING") return "running";
  return "timed_out";
}

function seconds(value: string | undefined, unit: string | undefined): number | null {
  if (value === undefined || unit === undefined) return null;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const u = unit.toLowerCase();
  if (u === "ms") return n / 1000;
  if (u === "m" || u === "min") return n * 60;
  return n;
}

/**
 * Read a gate log's steps with their results and durations, and the commit,
 * lane and track its header lines name. Bounded: the last MAX_STEP_LINES
 * lines, each cut to MAX_STEP_LINE characters, at most MAX_STEPS steps. A
 * step named twice (a preflight and the gate run) keeps its place and takes
 * the later result.
 */
export function parseGateSteps(content: string): GateLogSummary {
  const summary: GateLogSummary = {
    steps: [],
    currentStep: null,
    failedSteps: [],
    sha: null,
    base: null,
    startedAt: null,
    lane: null,
    track: null,
    branch: null,
  };
  const byName = new Map<string, GateLogStep>();
  const record = (name: string, state: GateLogStepState, duration: number | null) => {
    const known = byName.get(name);
    if (known) {
      known.state = state;
      if (duration !== null || state !== "running") known.durationSeconds = duration;
      return;
    }
    if (byName.size >= MAX_STEPS) return;
    const step: GateLogStep = { name, state, durationSeconds: duration };
    byName.set(name, step);
    summary.steps.push(step);
  };

  const all = content.split("\n");
  const lines = all.length > MAX_STEP_LINES ? all.slice(-MAX_STEP_LINES) : all;
  for (const raw of lines) {
    const line = raw.length > MAX_STEP_LINE ? raw.slice(0, MAX_STEP_LINE) : raw.replace(/\r$/, "");
    let m = STEP_LINE.exec(line);
    if (m) {
      record(m[1], stepState(m[2]), seconds(m[3], m[4]));
      continue;
    }
    m = RESULT_FIRST.exec(line);
    if (m) {
      record(m[2], stepState(m[1]), seconds(m[3], m[4]));
      continue;
    }
    m = TABLE_ROW.exec(line);
    if (m) {
      record(m[1], stepState(m[4]), seconds(m[2], m[3]));
      continue;
    }
    m = FAILED_LIST.exec(line);
    if (m) {
      for (const entry of m[1].matchAll(FAILED_ENTRY)) {
        record(entry[1], "failed", byName.get(entry[1])?.durationSeconds ?? null);
        const step = byName.get(entry[1]);
        if (step) step.exitCode = Number(entry[2]);
      }
      continue;
    }
    m = GATE_HEADER.exec(line);
    if (m) {
      summary.sha = m[1].toLowerCase();
      summary.startedAt = m[2] ?? summary.startedAt;
      summary.base = m[3] ? m[3].toLowerCase() : summary.base;
    }
    m = RUN_HEADER.exec(line);
    if (m) {
      summary.lane = m[1] ?? summary.lane;
      summary.track = m[2] ?? summary.track;
    }
    m = BRANCH.exec(line);
    if (m) summary.branch = m[1];
  }

  summary.failedSteps = summary.steps.filter((s) => s.state === "failed" || s.state === "timed_out").map((s) => s.name);
  const running = summary.steps.filter((s) => s.state === "running");
  summary.currentStep = running.length > 0 ? running[running.length - 1].name : null;
  return summary;
}
