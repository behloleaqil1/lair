/**
 * G6, the planner guards (docs/design/ai-spend.md §4.5): propose only what can apply. The pure parts live here: which
 * work is closed, which PR is a task's own, and the hash of a run's inputs. Each part has its own mode (off,
 * observe, act); all are cheap and deterministic: no model is called and no network is used. They read only local
 * records: the tasks file, the queue lines the planner already reads, and the review store (review.db).
 */
import type { BlockedView, PlanTaskView, TriggerView } from "../../shared/planner-types.js";
import { anyAgentPatternFor, doneLineMatches, type GuardMode } from "../agents/config.js";
import { sha256 } from "./files.js";
import type { OwnerMessage } from "./sources.js";

export interface PlannerGuards {
  prefilterClosed: GuardMode;
  handledMessages: GuardMode;
  skipUnchanged: { mode: GuardMode; maxSkipMs: number };
  recheckOnChange: GuardMode;
  dedupePending: GuardMode;
}

/** The guards with every part off (the default) */
export const GUARDS_OFF: PlannerGuards = {
  prefilterClosed: "off",
  handledMessages: "off",
  skipUnchanged: { mode: "off", maxSkipMs: 24 * 3_600_000 },
  recheckOnChange: "off",
  dedupePending: "off",
};

/** A PR the review store records as merged (review_merges, or the state the review module last read from the host). */
export interface MergedPr {
  pr: number;
  /** Its head branch as the review module last read it; null when it never read one */
  branch: string | null;
  /** When it merged (or when the review module read it as merged); ISO */
  at: string | null;
}

/** The review module's merged PRs, newest first, at most `limit` (review.db only: no network). */
export interface PlannerPrs {
  mergedPrs(project: string, limit: number): MergedPr[];
}

/** The merged PRs the planner reads per run, and lists (the newest) in a run's context */
export const MAX_MERGED_PRS = 1000;
export const MAX_CLOSED_LISTED = 200;

/** A task id or a branch name, cut into its '/'-separated parts, lowercased. */
const parts = (text: string): string[] => text.toLowerCase().split("/");

/**
 * Whether a branch names a task id: the id's '/'-separated parts are consecutive whole parts of the branch, ignoring
 * case (`agent/worker-a/t-42` names `t-42`; `agent/t-420` and `agent/t-42-fix` don't, `t-42-fix` being another id).
 */
export function branchNamesTask(branch: string, task: string): boolean {
  const b = parts(branch);
  const t = parts(task);
  for (let i = 0; i + t.length <= b.length; i++) {
    if (t.every((part, j) => b[i + j] === part)) return true;
  }
  return false;
}

/**
 * The merged PRs by every run of consecutive parts of their branch (a branch has a few parts, so a few keys each):
 * a task's own merged PR by branch is then one lookup. The newest PR wins a key.
 */
export function branchIndex(merged: MergedPr[]): Map<string, MergedPr> {
  const index = new Map<string, MergedPr>();
  for (const pr of merged) {
    if (!pr.branch) continue;
    const p = parts(pr.branch).slice(0, 12);
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j <= p.length; j++) {
        const key = p.slice(i, j).join("/");
        if (!index.has(key)) index.set(key, pr);
      }
    }
  }
  return index;
}

export interface ClosedWork {
  /** Closed task ids, with why each is closed (in the order they were found) */
  tasks: Map<string, string>;
}

/**
 * A task's own READY line, by any agent: `- READY <task> ...`, the READY keyword where the default done_pattern has
 * DONE (AI spend's run classes read a READY line the same way). A project whose done_pattern also reads READY lines
 * has them as done lines already.
 */
export const READY_LINE_PATTERN = "^-\\s+READY\\s+{task}(?=\\s|$)";

/** Whether a queue line is `task`'s own READY line (READY_LINE_PATTERN, by any agent; the task id as written). */
export function readyLineMatches(line: string, task: string): boolean {
  const pattern = anyAgentPatternFor(READY_LINE_PATTERN, task);
  return pattern !== null && doneLineMatches(pattern, line);
}

/**
 * Why a task's **own** PR counts as merged, or null. A task's own PR is one whose head branch names the task id
 * (branchNamesTask), or the PR its own READY or DONE line names (`linePr`, read as the ready guard reads it). A task
 * whose text only mentions a merged PR (a follow-up: "fix the regression from #42") is not closed by it.
 */
export function ownMergedPr(merged: MergedPr[], linePr: (task: string) => number | null): (task: string) => string | null {
  const byBranch = branchIndex(merged);
  const numbers = new Set(merged.map((m) => m.pr));
  return (task) => {
    const own = byBranch.get(parts(task).join("/"));
    if (own) return `its own PR #${own.pr} (branch ${own.branch}) merged`;
    const named = linePr(task);
    return named !== null && numbers.has(named) ? `its own PR #${named}, which its READY or DONE line names, merged` : null;
  };
}

/** Which of `ids` are closed work: a done id of the tasks file, or a task whose own PR merged (ownMergedPr). */
export function closedWork(ids: Iterable<string>, done: { has(task: string): boolean }, ownMerged: (task: string) => string | null): ClosedWork {
  const tasks = new Map<string, string>();
  for (const id of ids) {
    if (tasks.has(id)) continue;
    if (done.has(id)) {
      tasks.set(id, "a done id of the tasks file");
      continue;
    }
    const why = ownMerged(id);
    if (why) tasks.set(id, why);
  }
  return { tasks };
}

/** The `closed` part of a run's context (prefilter_closed act): what is finished, so the model sees it too. */
export interface ContextClosed {
  tasks: { id: string; why: string }[];
  mergedPrs: { pr: number; branch: string | null }[];
}

export function contextClosed(closed: ClosedWork, merged: MergedPr[]): ContextClosed {
  return {
    tasks: [...closed.tasks].slice(-MAX_CLOSED_LISTED).map(([id, why]) => ({ id, why })),
    mergedPrs: merged.slice(0, MAX_CLOSED_LISTED).map((m) => ({ pr: m.pr, branch: m.branch })),
  };
}

/**
 * Triggers that stay once closed work is dropped: a trigger about a closed task goes, except done_no_next, whose
 * point is the agent left with no next task (its task is the one it just finished).
 */
export function openTriggers(triggers: TriggerView[], closed: ClosedWork): TriggerView[] {
  return triggers.filter((t) => t.kind === "done_no_next" || t.task === null || !closed.tasks.has(t.task));
}

/** The inputs that decide what a run can propose, and only those (skip_unchanged). */
export interface RunInputs {
  tasksText: string;
  openTasks: PlanTaskView[];
  messages: OwnerMessage[];
  blocked: BlockedView[];
  closed: ContextClosed | null;
  allowlist: string[];
  idle: string[];
}

/**
 * sha256 over a run's inputs: the tasks file's text, the open tasks (id, source, text), the open owner messages (id,
 * text), the blocked tasks (task, class, reason), the closed work, the allowlist and the idle agents. Recent queue
 * events, the triggers and every time field are left out: they change at every check, so a hash over them would
 * never repeat.
 */
export function inputsHash(inputs: RunInputs): string {
  return sha256(
    JSON.stringify({
      tasksFile: inputs.tasksText,
      openTasks: inputs.openTasks.map((t) => [t.id, t.source, t.text]),
      ownerMessages: inputs.messages.map((m) => [m.id, m.text]),
      blocked: inputs.blocked.map((b) => [b.task, b.class, b.reason]),
      closed: inputs.closed,
      allowlist: [...inputs.allowlist].sort(),
      idle: [...inputs.idle].sort(),
    }),
  );
}
