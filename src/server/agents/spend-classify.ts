/**
 * AI spend, part 2: classify every run (docs/design/ai-spend.md §4.2) as productive, idle or no_result, with one
 * reason, from facts Lair already recorded: the run's end, its own queue line (read once, when its row is written),
 * fill's events about its wait, the earlier rows of its task, and what the module that asked for it recorded (a
 * review, proposals, verdicts, an answer: SpendFacts, read from those modules' stores). No log is read for it.
 *
 * A run whose module hasn't recorded its result yet (a planner run still being read, a wait fill hasn't looked at)
 * is written `unclassified` and classified on a later tick; CLASSIFY_WAIT_MS after its end it gets the class the
 * facts give by then (what never came is "none": no_review, waiting_unnamed, ...).
 *
 * A BLOCKED line is compared by a key only: sha256 of its text (lowercased, whitespace and punctuation collapsed,
 * times, dates and the agent's attribution left out), the gate it names and the PR it names. The text is never stored.
 */
import { createHash } from "crypto";
import type { RunOrigin } from "../../shared/agents-types.js";
import { attributedAgent } from "../parsers/queue.js";
import type { AgentsStore } from "./store.js";
import type { AgentRun, RunEndKind, SpendRow } from "./types.js";
import { storedCaptures, wakeKey, wakeTargetOf, type WakeCaptures } from "./wake-events.js";

/** After this long, a run its facts can't classify yet gets the class they give by then */
export const CLASSIFY_WAIT_MS = 30 * 60_000;
/** Rows still unclassified this long after their end are left as they are (their module is not wired here) */
export const CLASSIFY_LOOKBACK_MS = 2 * 24 * 3600_000;
/** Unclassified rows looked at per tick */
export const CLASSIFY_PER_TICK = 50;

/** The run's own queue line for its task, as fill reads it: its kind, the line, and the gate it names (wake) */
export interface QueueOutcome {
  kind: "done" | "waiting" | "blocked";
  line: string;
  /** WAITING: the (?<wake>...) capture; BLOCKED: the blocked pattern's (?<wake>...) capture (the gate it names) */
  wake?: string | null;
  /** WAITING: the G3 captures, the PR, decision or bus message it names (null: none) */
  captures?: WakeCaptures | null;
}

/** A module's record of a run it asked for: pending until the module has read the run's result */
export type ModuleVerdict = "pending" | "productive" | "idle";

/** The run as a module looks it up (ids and times only) */
export interface SpendRunRef {
  id: string;
  agent: string;
  task: string;
  chainId: string;
  requestedAt: number;
  endedAt: number;
}

/**
 * What other modules recorded about runs they asked for (the server wires it from their stores). Each is read-only
 * and synchronous (SQLite), and returns null when the module has no record of the run. Absent: that module isn't
 * wired here, so its runs stay unclassified.
 */
export interface SpendFacts {
  /** A review run: whether a review by its agent for its head was recorded during it, and the head */
  review?(project: string, run: SpendRunRef, pr: number, headPrefix: string): { verdict: ModuleVerdict; headSha: string | null } | null;
  /** A planner run (by its chain): pending while the planner reads its output, then whether it wrote proposals */
  planner?(project: string, run: SpendRunRef): ModuleVerdict | null;
  /** A verifier run (by its chain): pending while it runs, then whether it wrote verdicts */
  verifier?(project: string, run: SpendRunRef): ModuleVerdict | null;
  /** A supervisor run: its question's turn, pending until answered or closed */
  supervisor?(project: string, run: SpendRunRef): ModuleVerdict | null;
  /** A PR's head as the review store last read it (null: unknown) */
  prHead?(project: string, pr: number): string | null;
  /** The planner's proposals and runs in a window (the spend API's planner acceptance) */
  plannerAcceptance?(project: string, from: number, to: number): PlannerAcceptance | null;
}

export interface PlannerAcceptance {
  runs: number;
  runsWithApplied: number;
  proposals: { applied: number; declined: number; rejected: number; pending: number };
  verdicts: { approve: number; reject: number; unsure: number; unverified: number };
}

export interface Classified {
  class: SpendRow["class"];
  reason: string;
  pr: number | null;
  headSha: string | null;
  blockerKey: string | null;
}

const MODULE_REASONS: Record<"review" | "planner" | "verifier" | "supervisor", [string, string]> = {
  review: ["review_recorded", "no_review"],
  planner: ["proposals", "no_proposals"],
  verifier: ["verdicts", "no_verdicts"],
  supervisor: ["answered", "no_answer"],
};

const BUILDER_ORIGINS: readonly (RunOrigin | "other")[] = ["fill", "owner", "other"];

const REVIEW_TASK = /^review-(\d{1,7})-([0-9a-f]{7,40})(?:-\d+)?$/;
const PR_NAMED = /(?:#|\bpr\s*#?\s*|\/pull\/)(\d{1,7})\b/i;
const DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:z|[+-]\d{2}:?\d{2})?\b/gi;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:z|utc|[ap]m)?\b/gi;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha256 = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");
const verdict = (cls: SpendRow["class"], reason: string, extra: Partial<Classified> = {}): Classified => ({
  class: cls,
  reason,
  pr: extra.pr ?? null,
  headSha: extra.headSha ?? null,
  blockerKey: extra.blockerKey ?? null,
});

/** The PR a line names (#42, PR 42, .../pull/42), or null. */
export function prNamed(line: string): number | null {
  const m = PR_NAMED.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * The key of a BLOCKED report (decision D1): sha256 of its text (lowercased, whitespace collapsed, times, dates and
 * the agent's "by <agent>" attribution left out), the gate it names and the PR it names. Only the key is kept.
 */
export function blockerKey(line: string, gate: string | null, pr: number | null): string {
  let text = line;
  const who = attributedAgent(line);
  if (who) text = text.replace(new RegExp(`\\bby\\s+${escapeRegExp(who)}\\b`, "i"), " ");
  // Punctuation goes too (an attribution's brackets, a time's colon): only words, numbers, '#' and '-' are compared
  text = text
    .replace(DATE_TIME, " ")
    .replace(TIME, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(`${text}\n${gate?.trim() ?? ""}\n${pr ?? ""}`);
}

/** A review run's PR and head prefix, from its task id (review-<pr>-<head>[-<slot>]). */
export function reviewTaskOf(task: string): { pr: number; headPrefix: string } | null {
  const m = REVIEW_TASK.exec(task);
  return m ? { pr: Number(m[1]), headPrefix: m[2] } : null;
}

const refOf = (run: AgentRun, endedAt: number): SpendRunRef => ({
  id: run.id,
  agent: run.agent,
  task: run.task,
  chainId: run.chainId,
  requestedAt: run.requestedAt,
  endedAt,
});

export interface ClassifierOptions {
  project: string;
  store: AgentsStore;
  /** fill follows a WAITING line's wake to a file (fill on, wake.file set): only then is a named wake watched */
  wakeWatched: () => boolean;
  /** fill watches the PR, decision or bus message a WAITING line names (G3: fill on, fill.wake.events not off) */
  wakeEvents?: () => boolean;
  facts: () => SpendFacts | undefined;
}

/**
 * The rules of §4.2 over recorded facts. `final`: the run ended CLASSIFY_WAIT_MS ago or more, so what hasn't been
 * recorded by now counts as never recorded. null: not yet (written unclassified, tried again on a later tick).
 */
export class SpendClassifier {
  constructor(private readonly o: ClassifierOptions) {}

  /**
   * A run as its row is written: its end, its queue line (null: none, or not a completed run), its origin. Never
   * null: what isn't known yet is `unclassified/pending`.
   */
  atEnd(run: AgentRun, end: RunEndKind, origin: RunOrigin | "other", outcome: QueueOutcome | null, endedAt: number, final: boolean): Classified {
    const review = origin === "review" ? reviewTaskOf(run.task) : null;
    const reviewPr = review ? { pr: review.pr, headSha: review.headPrefix } : {};
    if (end !== "completed") return verdict("no_result", end, reviewPr);
    if (!BUILDER_ORIGINS.includes(origin)) {
      return this.module(run, origin as keyof typeof MODULE_REASONS, endedAt, final) ?? verdict("unclassified", "pending", reviewPr);
    }
    if (outcome?.kind === "done") return verdict("productive", /^\s*-\s+READY\b/.test(outcome.line) ? "ready" : "done");
    if (outcome?.kind === "blocked") return this.blocked(run, outcome, endedAt, final);
    if (outcome?.kind === "waiting") return this.waiting(run, outcome.wake ?? null, outcome.captures ?? null, endedAt, final) ?? verdict("unclassified", "pending");
    return verdict("idle", "no_line");
  }

  /**
   * A row written unclassified, again. Its queue line isn't read again: a builder's row is unclassified for a
   * BLOCKED line (the row keeps the line's key, PR and head, and the same rule runs again on them) or for a WAITING
   * line, whose wake fill recorded (fill_waiting) when it looked at it.
   */
  later(row: SpendRow, run: AgentRun, final: boolean): Classified | null {
    if (!BUILDER_ORIGINS.includes(row.origin)) return this.module(run, row.origin as keyof typeof MODULE_REASONS, row.endedAt, final);
    if (row.blockerKey !== null) {
      const again = this.blockedRule(run, row.blockerKey, row.pr, row.headSha, row.endedAt, final);
      return again.class === "unclassified" ? null : again;
    }
    const seen = this.o.store.listEvents(this.o.project, { kinds: ["fill_waiting"], task: run.task, runId: run.id, limit: 1 })[0];
    if (!seen) return final ? verdict("idle", "waiting_unnamed") : null;
    return this.waiting(run, typeof seen.data.wake === "string" ? seen.data.wake : null, storedCaptures(seen.data.captures), row.endedAt, final);
  }

  /** What the module that asked for the run recorded. null: not yet. */
  private module(run: AgentRun, origin: keyof typeof MODULE_REASONS, endedAt: number, final: boolean): Classified | null {
    const facts = this.o.facts();
    const [productive, idle] = MODULE_REASONS[origin];
    const ref = refOf(run, endedAt);
    let seen: ModuleVerdict | null | undefined;
    let extra: Partial<Classified> = {};
    if (origin === "review") {
      const task = reviewTaskOf(run.task);
      if (!task) return verdict("idle", idle);
      extra = { pr: task.pr, headSha: task.headPrefix };
      const found = facts?.review ? facts.review(this.o.project, ref, task.pr, task.headPrefix) : undefined;
      if (found) extra.headSha = found.headSha ?? task.headPrefix;
      seen = found === undefined ? undefined : (found?.verdict ?? null);
    } else {
      const look = facts?.[origin];
      seen = look ? look.call(facts, this.o.project, ref) : undefined;
    }
    // Not wired here: nothing tells, so it stays unclassified
    if (seen === undefined) return null;
    if (seen === "productive") return verdict("productive", productive, extra);
    if (seen === "idle" || (final && (seen === "pending" || seen === null))) return verdict("idle", idle, extra);
    return null;
  }

  /**
   * WAITING (§4.2): idle when it names nothing Lair watches, or the same wake as the task's previous run; productive
   * (gate_queued) when fill found its wake absent when it looked (or the gate in the gate queue, or the result came
   * after the chain started): the run queued what it waits on. A wake whose result was there before the chain
   * started was no wait (fill_weak). null while fill hasn't looked. Without a gate fill follows, a wait on a PR, a
   * decision or a bus message is watched while G3 is on (waitingEvent).
   */
  private waiting(run: AgentRun, wake: string | null, captures: WakeCaptures | null, endedAt: number, final: boolean): Classified | null {
    const named = wake?.trim() || null;
    if (named === null || !this.o.wakeWatched()) {
      const target = this.o.wakeEvents?.() ? wakeTargetOf(captures).target : null;
      return target === null ? verdict("idle", "waiting_unnamed") : this.waitingEvent(run, wakeKey(target, run.agent), endedAt, final);
    }
    const previous = this.o.store.taskSpendBefore(this.o.project, run.task, endedAt, run.id, 10).find((r) => r.class !== "no_result");
    if (previous) {
      const before = this.o.store.listEvents(this.o.project, { kinds: ["fill_waiting"], task: run.task, runId: previous.runId, limit: 1 })[0];
      if (typeof before?.data.wake === "string" && before.data.wake.trim() === named) return verdict("idle", "waiting_same");
    }
    const kinds = new Set(
      this.o.store
        .listEvents(this.o.project, { kinds: ["fill_wake_absent", "fill_gate_queued", "fill_woken", "fill_weak"], task: run.task, runId: run.id, limit: 10 })
        .map((e) => e.kind),
    );
    if (kinds.has("fill_weak")) return verdict("idle", "waiting_unnamed");
    if (kinds.has("fill_wake_absent") || kinds.has("fill_gate_queued") || kinds.has("fill_woken")) return verdict("productive", "gate_queued");
    return final ? verdict("idle", "waiting_unnamed") : null;
  }

  /**
   * WAITING on a PR, a decision or a bus message (G3, `key` as wakeKey gives it): productive (woken_by_event) once
   * that event came after the run started, as fill recorded it (act: its fill_woken; observe: the guard_would of the
   * wake it would have made). Such a wait may rightly last longer than CLASSIFY_WAIT_MS (act has no fallback timer:
   * max_wait_minutes bounds it), so it is final only once the task has a later run (the event, the fallback timer or
   * the owner started it again) and the row is final. Not come by then: idle, waiting_same when the task's previous
   * run waited on the same one, else waiting_event. null until then.
   */
  private waitingEvent(run: AgentRun, key: string, endedAt: number, final: boolean): Classified | null {
    const { store, project } = this.o;
    const woken = store
      .listEvents(project, { kinds: ["fill_woken", "guard_would"], task: run.task, runId: run.id, limit: 10 })
      .some((e) => e.data.guard === "wake_events");
    if (woken) return verdict("productive", "woken_by_event");
    if (!final || store.latestRunForTask(project, run.task)?.id === run.id) return null;
    const previous = store.taskSpendBefore(project, run.task, endedAt, run.id, 10).find((r) => r.class !== "no_result");
    const before = previous ? store.listEvents(project, { kinds: ["fill_waiting"], task: run.task, runId: previous.runId, limit: 1 })[0] : undefined;
    const target = before ? wakeTargetOf(storedCaptures(before.data.captures)).target : null;
    return verdict("idle", target !== null && wakeKey(target, run.agent) === key ? "waiting_same" : "waiting_event");
  }

  /**
   * BLOCKED (decision D1): the first report of a blocker is productive (blocked); a repeat with the same key is idle
   * (blocked_repeat) when nothing was pushed since the earlier one: the PR it names is still at the same head, and
   * the task had no DONE, READY or queued gate in between. `unclassified/pending` while a row in between still
   * waits for its class; it keeps the key, PR and head, so later() runs the same rule again.
   */
  private blocked(run: AgentRun, outcome: QueueOutcome, endedAt: number, final: boolean): Classified {
    const pr = prNamed(outcome.line);
    const key = blockerKey(outcome.line, outcome.wake ?? null, pr);
    const headSha = pr === null ? null : (this.o.facts()?.prHead?.(this.o.project, pr) ?? null);
    return this.blockedRule(run, key, pr, headSha, endedAt, final);
  }

  /** The rule of blocked() over a blocker key, the PR the line named and that PR's head when the run ended. */
  private blockedRule(run: AgentRun, key: string, pr: number | null, headSha: string | null, endedAt: number, final: boolean): Classified {
    const extra = { pr, headSha, blockerKey: key };
    const earlier = this.o.store.taskSpendBefore(this.o.project, run.task, endedAt, run.id, 200);
    const same = earlier.findIndex((r) => r.blockerKey === key);
    if (same < 0) return verdict("productive", "blocked", extra);
    const between = earlier.slice(0, same);
    // Only a row whose class is still to come is waited on: a backfilled `not_recorded` row never gets one
    if (!final && between.some((r) => r.class === "unclassified" && r.reason === "pending")) return verdict("unclassified", "pending", extra);
    const pushed = between.some((r) => r.class === "productive" && (r.reason === "done" || r.reason === "ready" || r.reason === "gate_queued"));
    const moved = pr !== null && (earlier[same].headSha ?? null) !== headSha;
    return pushed || moved ? verdict("productive", "blocked", extra) : verdict("idle", "blocked_repeat", extra);
  }
}
