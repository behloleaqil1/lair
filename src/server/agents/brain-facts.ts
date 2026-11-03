/**
 * Evidence v3 for the agents module's `agents.gave_up` decisions (docs/design/decision-brain.md §4.1): the facts
 * that decide them, read from what the module already has (the tasks file's lines, its runs, a BLOCKED line, the
 * machine's load). Facts are codes, ids, numbers and booleans, never prose; a fact that cannot be read is null, so
 * a rule that needs it abstains. Nothing here answers, withdraws or raises a decision.
 */
import type { DecisionFactValue } from "../../shared/decision-types.js";
import type { FillLineView } from "../../shared/agents-types.js";
import { classifyBlocked } from "../planner/blocked.js";
import { DEFAULT_ENVIRONMENT_PATTERNS, DEFAULT_OWNER_PATTERNS } from "../planner/config.js";

export type TaskState = "open" | "closed" | "reassigned";
export type BlockTarget = "pr" | "host_load" | "environment" | "unknown";

/** Whether the module adds these facts at the raise, and whether it re-reads the live ones at each check. */
export interface BrainFactsMode {
  live: boolean;
}

const MAX_TEXT = 1000;

/** The planner's default patterns (planner/config.ts), compiled once: the same classifier as its BLOCKED handling */
const BLOCK_PATTERNS = {
  owner: DEFAULT_OWNER_PATTERNS.map((p) => new RegExp(p, "i")),
  environment: DEFAULT_ENVIRONMENT_PATTERNS.map((p) => new RegExp(p, "i")),
};

/** A PR reference: "PR 12", "PR #12", "pull request #12" or ".../pull/12". A bare "#12" may be an issue: not one. */
const PR_REFERENCE = /\b(?:PR|pull request)\s*#?(\d{1,7})\b|\/pull\/(\d{1,7})\b/i;
/** The machine's load named as the obstacle (the planner's load patterns, and "load average"), not any "load" word */
const LOAD_REFERENCE = /\b(?:load|cpu)\b.{0,20}\b(?:above|over|too high|high)\b|\bload\s*[<>]|\bload average\b/i;

/** The PR a report line names, or null. */
export function prOfLine(line: string): number | null {
  const m = PR_REFERENCE.exec(line.slice(0, MAX_TEXT));
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * What a BLOCKED report waits on: the planner's class (owner, environment or task) first, then a fixed list (a PR
 * reference, a load reference). Only the reason is read, as the planner reads it: a bus report's summary, or what a
 * hand-written line says after its first ": " (never the task id or the agent's name). Anything else is
 * `unknown`, never a guess.
 */
export function blockFacts(reason: string): { block_class: string; block_target: BlockTarget; blocked_on_pr: number | null } {
  const text = reason.slice(0, MAX_TEXT);
  const blockClass = classifyBlocked(text, BLOCK_PATTERNS).class;
  const pr = prOfLine(text);
  const target: BlockTarget =
    pr !== null ? "pr" : LOAD_REFERENCE.test(text) ? "host_load" : blockClass === "environment" ? "environment" : "unknown";
  return { block_class: blockClass, block_target: target, blocked_on_pr: pr };
}

/**
 * Whether what blocked the task cleared: only a person clears an owner block or an unknown one (null). A load
 * block clears once the load per CPU is below fill's start limit (`loadOk`, null: no limit or no reading). A PR
 * and the environment are not read here yet (null).
 */
export function blockerCleared(blockClass: unknown, target: unknown, loadOk: boolean | null): boolean | null {
  if (blockClass === "owner" || target === "unknown") return null;
  return target === "host_load" ? loadOk : null;
}

/**
 * The task's state in the tasks file, from one check's lines: `closed` once its line is done, `reassigned` when
 * only another agent's line names it, else `open`. Undefined: no line names it in this check (the caller counts
 * that, see LINE_GONE_CHECKS).
 */
export function taskStateOf(lines: readonly FillLineView[], task: string, agent: string | null): TaskState | undefined {
  const named = lines.filter((l) => l.task === task);
  if (named.length === 0) return undefined;
  const own = named.filter((l) => l.agent === null || agent === null || l.agent === agent);
  if (own.length === 0) return "reassigned";
  return own.some((l) => l.state === "done") ? "closed" : "open";
}

/** A BLOCKED report's reason, as the planner reads it: the bus report's summary, else the line after its first ": ". */
export function blockReason(line: string, summary: string | undefined): string {
  if (summary !== undefined) return summary;
  // planner/sources.ts reasonOf: what follows the first ": " (the whole line without one)
  const i = line.indexOf(": ");
  return i >= 0 ? line.slice(i + 2) : line;
}

/** A fact reader that fails is a fact that cannot be read: null, never a decision that is not raised. */
export function readOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** A provider limit's reset passed: true or false from the `limit_resets_at` fact, null without one. */
export function limitResetPassed(resetsAt: unknown, now: number): boolean | null {
  const at = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(at) ? at <= now : null;
}

/** The facts every `agents.gave_up` decision carries at the raise, on top of agent, task, attempt_count and last_exit. */
export function raiseFacts(input: {
  code: string;
  taskState: TaskState | null;
  pr: number | null;
  freshSessions: number | null;
  /** The BLOCKED report's reason (blockReason) */
  blockedReason?: string;
  loadOk?: boolean | null;
  limitResetsAt?: string | null;
  now: number;
}): Record<string, DecisionFactValue> {
  const facts: Record<string, DecisionFactValue> = { task_state: input.taskState, pr: input.pr, fresh_sessions: input.freshSessions };
  if (input.code === "blocked_reported") {
    const block = input.blockedReason !== undefined ? blockFacts(input.blockedReason) : { block_class: null, block_target: "unknown", blocked_on_pr: null };
    Object.assign(facts, block, { blocker_cleared: blockerCleared(block.block_class, block.block_target, input.loadOk ?? null) });
  }
  if (input.code === "provider_limit") {
    facts.limit_resets_at = input.limitResetsAt ?? null;
    facts.limit_reset_passed = limitResetPassed(input.limitResetsAt, input.now);
  }
  return facts;
}
