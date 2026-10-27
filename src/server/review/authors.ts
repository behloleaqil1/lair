/**
 * Who wrote a PR, from its branch name, when Lair's own modules didn't
 * register the author (docs/configuration.md#reviews-by-agents):
 *
 * - review.authors.branch_pattern: a template that carries the agent id (agent/{agent}/**);
 * - review.authors.branches: branch glob -> agent id, for branches that don't (team/topic);
 * - review.authors.from_tasks_file: the agents fill tasks file
 *   (`<agent>|<name>|<task>|<description>` lines), whose description names the
 *   line's branch as `(branch: <name>)` or as a `(<prefix>/<topic>)` token.
 *
 * Every source that matches is asked, and when they name different agents
 * the author stays unknown: an unknown author only holds the PR back, a wrong
 * one lets the author review its own work.
 *
 * Globs are matched without regular expressions (a table over the glob and
 * the name, so no pattern can backtrack), and the tasks file is read bounded
 * and parsed as agents fill parses it (agents/fill.ts: at most 256 KB, 200
 * tasks and 2000 characters a line).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { MAX_TASKS_FILE_BYTES, parseTasksFile } from "../agents/fill.js";

/** Branch names longer than this match nothing. */
export const MAX_BRANCH_CHARS = 255;

const GLOB_CHARS = /^[A-Za-z0-9._/*?-]+$/;
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;

type GlobToken = { kind: "char"; ch: string } | { kind: "any" } | { kind: "star" } | { kind: "globstar" };

/** One review.authors.branches entry. */
export interface BranchGlob {
  glob: string;
  agent: string;
  tokens: GlobToken[];
}

/** A plain branch name: no leading "-" or "/", no ".." or empty segment. */
export function isSafeBranchName(name: string): boolean {
  return (
    BRANCH_NAME.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock")
  );
}

/**
 * Compile a branch glob: `*` matches within one path segment, `**` across
 * segments, `?` one character other than "/"; everything else is literal.
 */
export function compileBranchGlob(glob: string, agent: string): BranchGlob | string {
  if (!GLOB_CHARS.test(glob)) return "use letters, digits, '.', '_', '-', '/' and the wildcards *, ** and ?";
  if (glob.length > 200) return "at most 200 characters";
  if (/\*{3,}/.test(glob)) return "use * or **, not more stars";
  if (!isValidDragonId(agent)) return `${agent} is not a valid agent id`;
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**", i)) {
      tokens.push({ kind: "globstar" });
      i++;
    } else if (glob[i] === "*") tokens.push({ kind: "star" });
    else if (glob[i] === "?") tokens.push({ kind: "any" });
    else tokens.push({ kind: "char", ch: glob[i] });
  }
  return { glob, agent, tokens };
}

/** True when `name` matches the glob, by a table over (token, position): O(tokens x characters). */
export function globMatches(glob: BranchGlob, name: string): boolean {
  if (name.length > MAX_BRANCH_CHARS) return false;
  const n = name.length;
  let row = new Array<boolean>(n + 1).fill(false);
  row[0] = true;
  for (const token of glob.tokens) {
    const next = new Array<boolean>(n + 1).fill(false);
    for (let j = 0; j <= n; j++) {
      switch (token.kind) {
        case "char":
          if (j > 0 && row[j - 1] && name[j - 1] === token.ch) next[j] = true;
          break;
        case "any":
          if (j > 0 && row[j - 1] && name[j - 1] !== "/") next[j] = true;
          break;
        case "star":
          next[j] = row[j] || (j > 0 && next[j - 1] && name[j - 1] !== "/");
          break;
        case "globstar":
          next[j] = row[j] || (j > 0 && next[j - 1]);
          break;
      }
    }
    row = next;
  }
  return row[n];
}

// ============ THE TASKS FILE ============

/** A branch a tasks file line names for its agent. */
export interface TaskBranch {
  line: number;
  agent: string;
  branch: string;
}

const BRANCH_TAG = /\(branch:\s*([^\s()]{1,255})\s*\)/g;
const PREFIX_TOPIC = /\(([A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,8})\)/g;

/**
 * The branches a tasks file names, per task line (as fill parses them; a
 * malformed line names none): `(branch: <name>)` or a `(<prefix>/<topic>)`
 * token in the description.
 */
export function branchesFromTasks(content: string): TaskBranch[] {
  const out: TaskBranch[] = [];
  for (const entry of parseTasksFile(content)) {
    if (entry.kind !== "task") continue;
    const named = new Set<string>();
    for (const pattern of [BRANCH_TAG, PREFIX_TOPIC]) {
      for (const match of entry.description.matchAll(pattern)) {
        if (isSafeBranchName(match[1])) named.add(match[1]);
      }
    }
    for (const branch of named) out.push({ line: entry.line, agent: entry.agent, branch });
  }
  return out;
}

/** agents.fill.tasks_file of the project's config, resolved against its repo, or null when not set. */
export function tasksFilePath(config: Pick<ProjectConfig, "agents" | "repo">): string | null {
  const fill = (config.agents as { fill?: unknown } | undefined)?.fill;
  const file = fill && typeof fill === "object" ? (fill as { tasks_file?: unknown }).tasks_file : undefined;
  if (typeof file !== "string" || file.length === 0) return null;
  return isAbsolute(file) ? file : resolve(config.repo, file);
}

/** A regular file of at most MAX_TASKS_FILE_BYTES, as text; never blocks on a FIFO. */
export function readTasksFile(path: string): { ok: true; text: string } | { ok: false; reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "does not exist" : `cannot be read (${code ?? "error"})` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { ok: false, reason: "is not a regular file" };
    if (stats.size > MAX_TASKS_FILE_BYTES) return { ok: false, reason: `is larger than ${MAX_TASKS_FILE_BYTES} bytes` };
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return { ok: true, text: buffer.subarray(0, length).toString("utf-8") };
  } catch {
    return { ok: false, reason: "cannot be read" };
  } finally {
    closeSync(fd);
  }
}

// ============ RESOLUTION ============

export interface AuthorMapping {
  branchPattern: RegExp | null;
  branches: BranchGlob[];
  fromTasksFile: boolean;
}

export interface MappedAuthor {
  agent: string | null;
  source: "branch" | "tasks_file" | null;
  /** Why it is unknown when a source matched or failed (ambiguous, the tasks file unreadable) */
  note: string | null;
}

/**
 * The agent a branch belongs to, by every configured mapping. Two sources (or
 * two entries of one) naming different agents leave it unknown, with a note.
 */
export function mapAuthor(
  mapping: AuthorMapping,
  branch: string,
  config: Pick<ProjectConfig, "agents" | "repo">,
): MappedAuthor {
  if (branch.length > MAX_BRANCH_CHARS) return { agent: null, source: null, note: null };
  const found: { agent: string; source: "branch" | "tasks_file"; why: string }[] = [];
  const notes: string[] = [];
  const fromPattern = mapping.branchPattern?.exec(branch)?.groups?.agent;
  if (fromPattern) found.push({ agent: fromPattern, source: "branch", why: "review.authors.branch_pattern" });
  for (const entry of mapping.branches) {
    if (globMatches(entry, branch)) {
      found.push({ agent: entry.agent, source: "branch", why: `review.authors.branches "${entry.glob}"` });
    }
  }
  if (mapping.fromTasksFile) {
    const path = tasksFilePath(config);
    if (!path) {
      notes.push("review.authors.from_tasks_file: no agents.fill.tasks_file is configured");
    } else {
      const read = readTasksFile(path);
      if (!read.ok) notes.push(`the tasks file ${read.reason}`);
      else {
        for (const entry of branchesFromTasks(read.text)) {
          if (entry.branch === branch) {
            found.push({ agent: entry.agent, source: "tasks_file", why: `tasks file line ${entry.line}` });
          }
        }
      }
    }
  }
  const agents = [...new Set(found.map((f) => f.agent))];
  if (agents.length === 1) {
    const source = found.some((f) => f.source === "branch") ? "branch" : "tasks_file";
    return { agent: agents[0], source, note: notes.length > 0 ? notes.join("; ") : null };
  }
  if (agents.length > 1) {
    const which = found.map((f) => `${f.agent} (${f.why})`).join(", ");
    return { agent: null, source: null, note: `ambiguous: branch ${branch} matches ${which}, so the author stays unknown` };
  }
  return { agent: null, source: null, note: notes.length > 0 ? notes.join("; ") : null };
}
