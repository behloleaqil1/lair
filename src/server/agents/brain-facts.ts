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
export type ReviewAtHead = "approve" | "request_changes" | "none";
export type GateAtHead = "pass" | "fail" | "queued" | "none";
export type HolderRole = "owner" | "orchestrator" | "policy" | "agent";
export type NextMove = "agent" | "other";

/**
 * What the review module knows about one PR now (ReviewManager.brainPrFacts): read only, never a write. Every
 * field is what was read; a source that could not read the PR at all answers null instead.
 */
export interface PrHeadView {
  /** The PR's state on the git host; null: not read */
  state: "open" | "closed" | "merged" | null;
  /** The PR's head on the git host; null: not read */
  headSha: string | null;
  /** Each reviewer's latest verdict at exactly headSha (empty: no review there) */
  verdicts: ("approve" | "request_changes")[];
  /** Each required gate's status at exactly headSha; null: the project requires no gate, or it was not read */
  gate: ("passed" | "failed" | "pending" | "missing")[] | null;
  /** The unreleased merge holds on this PR or on every PR of the project: who added each (`by` is the caller's word) */
  holds: { byOwner: boolean; by: string }[];
}

/** Where the agents module reads a PR at its head (the review module's store, holds and gate; src/server/index.ts) */
export interface PrHeadSource {
  pr(project: string, pr: number): Promise<PrHeadView | null>;
}

/** How long one read of a PR may take: a source that does not answer in time is a fact that cannot be read */
export const PR_FACTS_TIMEOUT_MS = 10_000;

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
/**
 * The machine's load named as the obstacle, by a phrase that only means that ("load per cpu", "load average",
 * "load too high", "load above", "high load", "load > n"); not any "load" or "cpu" word near "over" or "high"
 */
const LOAD_REFERENCE =
  /\bload\s+per\s+cpu\b|\bload\s+average\b|\bload\s+(?:is\s+|was\s+)?too\s+high\b|\bload\s+(?:is\s+|was\s+)?above\b|\bhigh\s+load\b|\bload\s*[<>]\s*\d/i;

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
 * block clears once that PR is merged or closed (`blockedPr`: the PR as read, null: not read). The environment
 * is not read here yet (null).
 */
export function blockerCleared(
  blockClass: unknown,
  target: unknown,
  loadOk: boolean | null,
  blockedPr: PrHeadView | null = null,
): boolean | null {
  if (blockClass === "owner" || target === "unknown") return null;
  if (target === "host_load") return loadOk;
  if (target === "pr") return blockedPr?.state ? blockedPr.state !== "open" : null;
  return null;
}

/** The reviews at the PR's head: request_changes if any reviewer's latest asks for changes, else approve, else none. */
export function reviewAtHead(view: PrHeadView | null): ReviewAtHead | null {
  if (!view || view.headSha === null || view.state === null) return null;
  if (view.verdicts.includes("request_changes")) return "request_changes";
  return view.verdicts.includes("approve") ? "approve" : "none";
}

/**
 * The required gate at the PR's head: fail if any failed, else queued if any is still running, else pass when
 * every one passed, else none (one has no result yet). Null: no gate required, or it could not be read.
 */
export function gateAtHead(view: PrHeadView | null): GateAtHead | null {
  if (!view || view.headSha === null || view.state === null || view.gate === null || view.gate.length === 0) return null;
  if (view.gate.includes("failed")) return "fail";
  if (view.gate.includes("pending")) return "queued";
  return view.gate.every((g) => g === "passed") ? "pass" : "none";
}

/**
 * The open hold on the PR, as a role (never a name): `owner` when any was added from the owner's signed-in
 * browser, else `orchestrator` for any other caller, else `agent` when it names one of the project's agents
 * (the caller's own word, which only ever keeps a task held); `none` without one. Nothing adds a `policy` hold
 * to the review module today. Null: not read.
 */
export function holdOnPr(view: PrHeadView | null, agents: readonly string[]): HolderRole | "none" | null {
  if (!view) return null;
  if (view.holds.length === 0) return "none";
  if (view.holds.some((h) => h.byOwner)) return "owner";
  return view.holds.some((h) => !agents.includes(h.by)) ? "orchestrator" : "agent";
}

/**
 * Who moves the task next (docs/design/decision-brain.md §4.1), in this order: null with no PR, a failing gate,
 * an owner's hold or a hold that could not be read (a person decides); `other` while the gate runs, another role
 * holds it, or it is approved with a passing gate; `agent` when changes are requested or no gate ran yet; null
 * otherwise.
 */
export function nextMove(input: {
  pr: number | null;
  review: ReviewAtHead | null;
  gate: GateAtHead | null;
  hold: HolderRole | "none" | null;
}): NextMove | null {
  const { pr, review, gate, hold } = input;
  if (pr === null || gate === "fail" || hold === "owner" || hold === null) return null;
  if (gate === "queued" || hold !== "none" || (review === "approve" && gate === "pass")) return "other";
  if (review === "request_changes" || gate === "none") return "agent";
  return null;
}

/** The facts read at a PR's head, for a gave-up decision whose run named `pr` (all null without a PR). */
export function headFacts(pr: number | null, view: PrHeadView | null, agents: readonly string[]): Record<string, DecisionFactValue> {
  const seen = pr === null ? null : view;
  const review = reviewAtHead(seen);
  const gate = gateAtHead(seen);
  const hold = pr === null ? null : holdOnPr(seen, agents);
  return { review_at_head: review, gate_at_head: gate, hold_on_pr: hold, next_move: nextMove({ pr, review, gate, hold }) };
}

/** One read of a PR through `source`, bounded by PR_FACTS_TIMEOUT_MS: a failure or a timeout is null, never a value. */
export async function readPr(source: PrHeadSource | undefined, project: string, pr: number | null, timeoutMs = PR_FACTS_TIMEOUT_MS): Promise<PrHeadView | null> {
  if (!source || pr === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      source.pr(project, pr),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  /** The run's PR read at its head (readPr of `pr`), and the project's agents (holdOnPr) */
  prView?: PrHeadView | null;
  agents?: readonly string[];
  /** The PR the BLOCKED report waits on, as read (readPr of blockFacts' blocked_on_pr) */
  blockedPrView?: PrHeadView | null;
  now: number;
}): Record<string, DecisionFactValue> {
  const facts: Record<string, DecisionFactValue> = {
    task_state: input.taskState,
    pr: input.pr,
    fresh_sessions: input.freshSessions,
    ...headFacts(input.pr, input.prView ?? null, input.agents ?? []),
  };
  if (input.code === "blocked_reported") {
    const block = input.blockedReason !== undefined ? blockFacts(input.blockedReason) : { block_class: null, block_target: "unknown", blocked_on_pr: null };
    Object.assign(facts, block, {
      blocker_cleared: blockerCleared(block.block_class, block.block_target, input.loadOk ?? null, input.blockedPrView ?? null),
    });
  }
  if (input.code === "provider_limit") {
    facts.limit_resets_at = input.limitResetsAt ?? null;
    facts.limit_reset_passed = limitResetPassed(input.limitResetsAt, input.now);
  }
  return facts;
}
