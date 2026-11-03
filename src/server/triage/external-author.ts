/**
 * The author of a result that names none (triage.external_author:
 * tasks_file). A result from an external gate runner (a signed result over
 * HTTP, or an in-process one without context.agent) carries no agent, so
 * triage can't route its failure. With this on, its author is the agent of
 * the one open line of agents.fill's tasks file that names the result:
 *
 * - a line names it when its task id is the result's branch, the branch's
 *   last path segment (`<prefix>/<task>`) or the result's pipeline (track),
 *   or when its description has the branch as a whole word;
 * - only some of these show who wrote the branch: the whole branch, or the
 *   last segment when an earlier segment is the line's own agent
 *   (`kiro/<agent>/<task>`, `<agent>/<task>`). The last segment alone, the
 *   pipeline alone (a line `e2e` would name every e2e failure; a held line
 *   `fix-login` would name `other/fix-login` after a takeover) or the
 *   description (a review line "review kiro/a/fix-login" is not its author)
 *   count as naming the result, so they make a match ambiguous, but never
 *   pick an author on their own;
 * - a line is open when it has an agent and a task and fill's last check
 *   saw it started or held (not done, claimed by another, unassigned,
 *   malformed or not allowlisted);
 * - exactly one such line, naming it in a way that shows its author: its
 *   agent is the author. None, two or more, or one that names it only by
 *   pipeline or last segment: no author, and the route goes to the owner.
 *
 * Trust follows fill's wake files: only the tasks file is read (the owner's
 * or the planner's file, never the queue, bus reports or a WAITING line's
 * wake, which agents write), and only when fill's last check read it without
 * an error, recently (within two of its intervals), while fill runs, and
 * its real path is outside the project's repository, where an agent could
 * replace it. Anything else (fill off or stopped, not checked yet or not
 * lately, an error, a file inside the repository) finds no author.
 */
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { FillLineView, FillStatusView } from "../../shared/agents-types.js";

/** What triage reads: fill's status at its last check (AgentsService.fillStatus), or null without fill. */
export type TaskLinesSource = () => FillStatusView | null;

export interface AuthorSubject {
  branch: string;
  pipelineId: string;
}

export interface AuthorLine {
  line: number;
  agent: string;
  task: string;
  /**
   * How the line names the result: `branch` (the whole branch), `agent_branch`
   * (the last segment, with the line's agent as an earlier one) show its
   * author; `description`, `segment` (the last segment only) and `pipeline`
   * don't, so they never pick an author alone.
   */
  by: "branch" | "agent_branch" | "description" | "segment" | "pipeline";
}

/** How a note says a line names the result */
export const NAMED_BY: Record<AuthorLine["by"], string> = {
  branch: "branch",
  agent_branch: "agent and task in the branch",
  description: "description only",
  segment: "branch's last segment only",
  pipeline: "pipeline only",
};

/** The ways of naming a result that show who wrote the branch */
const SHOWS_AUTHOR: ReadonlySet<AuthorLine["by"]> = new Set(["branch", "agent_branch"]);

export type AuthorMatch =
  | { kind: "one"; author: AuthorLine }
  | { kind: "none"; detail: string }
  | { kind: "ambiguous"; lines: AuthorLine[]; detail: string }
  | { kind: "unavailable"; detail: string };

const AGENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const OPEN_STATES: ReadonlySet<FillLineView["state"]> = new Set(["started", "held"]);
/** Characters a branch name may hold: a description names a branch only with none of them on either side */
const BRANCH_CHAR = /[A-Za-z0-9._/-]/;

function inside(file: string, dir: string): boolean {
  let root: string;
  try {
    root = realpathSync.native(resolve(dir));
  } catch {
    root = resolve(dir);
  }
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `text` has `word` with no branch character right before or after it (a sentence's closing "." is not one). */
function namesWord(text: string, word: string): boolean {
  let at = text.indexOf(word);
  while (at >= 0) {
    const before = at > 0 ? text[at - 1] : "";
    const end = at + word.length;
    const after = text[end] ?? "";
    const closing = after === "." && !BRANCH_CHAR.test(text[end + 1] ?? "");
    if (!BRANCH_CHAR.test(before) && (closing || !BRANCH_CHAR.test(after))) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

function namedBy(line: FillLineView & { task: string }, subject: AuthorSubject): AuthorLine["by"] | null {
  const branch = subject.branch;
  if (line.task === branch) return "branch";
  // The branch shape first (#343 review N1): a line whose description quotes its own branch is still its agent's
  if (branch.endsWith(`/${line.task}`)) {
    const prefix = branch.slice(0, branch.length - line.task.length - 1).split("/");
    return line.agent !== null && prefix.includes(line.agent) ? "agent_branch" : "segment";
  }
  // A namespaced branch only: a bare word like "fix" names too much
  if (branch.includes("/") && line.description && namesWord(line.description, branch)) return "description";
  if (line.task === subject.pipelineId) return "pipeline";
  return null;
}

/** The open lines that name the result (pure: fill's lines as its last check saw them). */
export function matchAuthorLines(lines: FillLineView[], subject: AuthorSubject): AuthorLine[] {
  const out: AuthorLine[] = [];
  for (const line of lines) {
    if (!OPEN_STATES.has(line.state) || line.agent === null || line.task === null || !AGENT.test(line.agent)) continue;
    const by = namedBy({ ...line, task: line.task }, subject);
    if (by) out.push({ line: line.line, agent: line.agent, task: line.task, by });
  }
  return out;
}

/** The result's author from the tasks file, when it can be trusted and exactly one open line names it. */
export function findExternalAuthor(view: FillStatusView | null, repo: string, subject: AuthorSubject, now: number): AuthorMatch {
  if (!view || !view.enabled) return { kind: "unavailable", detail: "agents.fill is off: no tasks file to read the author from" };
  if (!view.running) return { kind: "unavailable", detail: "agents.fill is stopped: its last check may be out of date" };
  if (view.lastCheck === null) return { kind: "unavailable", detail: "agents.fill has not read its tasks file yet" };
  if (view.lastError !== null) return { kind: "unavailable", detail: "agents.fill's last check failed: its tasks file is not trusted" };
  const checked = Date.parse(view.lastCheck);
  if (!Number.isFinite(checked) || now - checked > 2 * Math.max(1, view.intervalSeconds) * 1000) {
    return { kind: "unavailable", detail: `agents.fill's last check (${view.lastCheck}) is older than two intervals: its lines may be out of date` };
  }
  if (!view.tasksFile) return { kind: "unavailable", detail: "agents.fill has no tasks file" };
  let file: string;
  try {
    // native: the path's real case too, so a case-insensitive file system can't put it "outside" the repository
    file = realpathSync.native(view.tasksFile);
  } catch {
    return { kind: "unavailable", detail: "agents.fill's tasks file cannot be read" };
  }
  if (inside(file, repo)) {
    return { kind: "unavailable", detail: "agents.fill's tasks file is inside the project's repository, where an agent could change it" };
  }
  const lines = matchAuthorLines(view.lines, subject);
  const what = `branch ${subject.branch} or pipeline ${subject.pipelineId}`;
  if (lines.length === 1) {
    const [only] = lines;
    if (SHOWS_AUTHOR.has(only.by)) return { kind: "one", author: only };
    return {
      kind: "none",
      detail: `only line ${only.line} (${only.agent}, ${only.task}) names ${what}, by its ${NAMED_BY[only.by]}, which does not show who wrote the branch`,
    };
  }
  if (lines.length === 0) return { kind: "none", detail: `no open tasks file line names ${what}` };
  return {
    kind: "ambiguous",
    lines,
    detail: `${lines.length} open tasks file lines name ${what}: ${lines
      .slice(0, 5)
      .map((l) => `line ${l.line} (${l.agent}, ${l.task})`)
      .join(", ")}`,
  };
}
