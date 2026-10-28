/**
 * Sessions: where an agent keeps its session, moving a broken one aside (it
 * is never deleted), and the resume summary a fresh session starts from: the
 * task card, the branch state, the agent's latest queue lines (with the
 * failing gate's log), and the previous session's last output.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { isSafeGateId } from "../services/data.js";
import type { ProjectView } from "../watchdog/view.js";
import type { AgentsSettings } from "./config.js";
import type { AgentRun } from "./types.js";

/** UTC time as YYYYMMDDTHHMMSSZ, the stamp agent log names use. */
export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** The agent's session directory (agents.session_dir), or null when not configured. */
export function sessionDirFor(settings: AgentsSettings, config: ProjectConfig, agent: string): string | null {
  if (!settings.sessionDir) return null;
  const vars: Record<string, string> = { agents_dir: config.agents_dir, agent, repo: config.repo };
  const dir = settings.sessionDir.replace(/\{([a-z_]+)\}/g, (match, name: string) => vars[name] ?? match);
  return isAbsolute(dir) ? dir : resolve(config.repo, dir);
}

/** Move a session directory aside: <dir>.aside-<UTC>. Null when there is none. */
export function moveSessionAside(dir: string, now: number): string | null {
  if (!existsSync(dir)) return null;
  const base = `${dir}.aside-${utcStamp(now)}`;
  let aside = base;
  for (let n = 2; existsSync(aside); n++) aside = `${base}-${n}`;
  renameSync(dir, aside);
  return aside;
}

/** The last `maxBytes` of a file, or "" when it can't be read. */
export function readTail(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The last `count` non-empty lines of a text. */
export function lastLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

/** Max bytes of log to read for hung info */
const HUNG_LOG_MAX_BYTES = 16 * 1024;
/** Max lines of log to include in hung info */
const HUNG_MAX_LINES = 20;
/** Max characters of hung info */
const HUNG_MAX_CHARS = 2048;

/**
 * Clean text for hung info: remove control characters and ANSI escapes,
 * bound to at most maxChars.
 */
export function cleanForHungInfo(text: string, maxChars: number = HUNG_MAX_CHARS): string {
  // Remove ANSI escape sequences and control characters
  let cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // Control chars except \t \n \r
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(-maxChars);
  }
  return cleaned;
}

/**
 * Extract bounded, cleaned last lines from a log for hung info.
 * Returns at most HUNG_MAX_LINES lines, at most HUNG_MAX_CHARS total.
 */
export function extractHungLogLines(logPath: string | undefined): string {
  if (!logPath) return "";
  const raw = readTail(logPath, HUNG_LOG_MAX_BYTES);
  if (!raw) return "";
  const cleaned = cleanForHungInfo(raw);
  const lines = lastLines(cleaned, HUNG_MAX_LINES);
  return lines.join("\n");
}

/**
 * Try to extract the last tool call from an adapter log.
 * Returns a one-line description or null.
 */
export function extractLastTool(logPath: string | undefined): string | null {
  if (!logPath) return null;
  const raw = readTail(logPath, 32 * 1024);
  if (!raw) return null;
  // Look for common tool call patterns in agent logs
  const patterns = [
    /\btool[_\s]?call[:\s]+([^\n]{1,200})/i,
    /\b(?:calling|executing|running)[:\s]+([^\n]{1,200})/i,
    /\bfunction[:\s]+([A-Za-z_][A-Za-z0-9_]*)/i,
  ];
  for (const pattern of patterns) {
    const matches = [...raw.matchAll(new RegExp(pattern, "gi"))];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      return last[1]?.trim().slice(0, 200) ?? null;
    }
  }
  return null;
}

export interface SummaryInput {
  run: AgentRun;
  /** The runs of the chain so far, first first */
  chain: AgentRun[];
  config: ProjectConfig;
  view: ProjectView;
  /** Output of agents.branch_state_cmd, if configured */
  branchState?: string;
  why: string;
}

/** The resume summary for the run after `run` (a fresh session, or a fallback agent). */
export function resumeSummary(input: SummaryInput): string {
  const { run, chain, config, view } = input;
  const parts: string[] = [
    "# Resume summary (written by Lair)",
    "",
    `You are continuing task ${run.task} as agent ${run.agent}. A previous session could not finish it: ${input.why}.`,
    "Start from the current state of the branch; do not redo work that is already committed.",
    "",
    "## Previous attempts",
    ...chain.map(
      (r) =>
        `- attempt ${r.attempt} (${r.profile.adapter}${r.profile.model ? ` ${r.profile.model}` : ""}, ${r.sessionMode} session): ${r.state}: ${r.detail}`,
    ),
  ];
  if (input.branchState && input.branchState.trim()) {
    parts.push("", "## Branch state", "```", input.branchState.trim().slice(0, 4000), "```");
  }
  const lines = view.queueLines().filter((line) => line.agent?.toLowerCase() === run.agent.toLowerCase());
  if (lines.length > 0) {
    parts.push("", "## Your latest status lines", ...lines.slice(-5).map((line) => `- ${line.message}`));
    const gateId = [...lines].reverse().find((line) => line.gateId)?.gateId;
    if (gateId && isSafeGateId(gateId) && view.gateResultExists(gateId)) {
      const log = readTail(join(config.gates_dir, "results", `${gateId}.log`), 16 * 1024);
      const tail = lastLines(log, 30);
      if (tail.length > 0) {
        parts.push("", `## Last gate ${gateId}: end of its log`, "```", ...tail, "```");
      }
    }
  }
  const output = run.logPath ? lastLines(readTail(run.logPath, 16 * 1024), 40) : [];
  if (output.length > 0) {
    parts.push("", "## Last output of the previous session", "```", ...output, "```");
  }
  return parts.join("\n") + "\n";
}
