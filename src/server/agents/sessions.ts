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
