/**
 * The outcome rules: each a small function over one answered decision and the
 * facts that followed it. A rule says good or bad only when the facts say so;
 * otherwise the answer is pending until its window ends and then unknown.
 * Nothing is guessed, and nothing here changes anything.
 *
 * Window: facts after the answer (excluded) up to the window's end (included).
 */
import type { Decision } from "../../shared/decision-types.js";
import { DECISION_FRESH, DECISION_RELEASE, DECISION_STOP, DECISION_WAIT } from "../agents/service.js";
import { holdFamily, taskOfRefs, tasksOfRefs } from "./facts.js";
import type { Fact, FactCode, Rule, RuleInput, Verdict } from "./types.js";

const PENDING: Verdict = { outcome: "pending" };
/** A planner proposal's edits are applied right after the answer; this long after it they still count as its. */
export const PLANNER_APPLY_SECONDS = 600;
const PR_REF = /(?:^|:)pr:(\d{1,9})$/;

const answerOf = (d: Decision) => d.answer?.optionId ?? "";
const taskOf = (d: Decision) => taskOfRefs(d.blocks);
const sameTask = (f: Fact, task: string | null) => task !== null && f.task === task;

function firstOf(facts: Fact[], pick: (f: Fact) => boolean): Fact | undefined {
  return facts.find(pick);
}
const has = (f: Fact, ...codes: FactCode[]) => codes.includes(f.code);

function evidenceOf(rule: string, fact: Fact, extra: Record<string, string | number | boolean | null> = {}) {
  return { rule, fact: fact.code, factAt: fact.at, ...(fact.task ? { task: fact.task } : {}), ...extra };
}

/** Facts after the answer, in the rule's window. */
const window = (i: RuleInput): Fact[] => i.facts.between(i.decision.project, i.answeredAt, i.windowEnd);

/**
 * Agent restart answer: good when the task is marked done within the window (a run that exits 0 may leave it open);
 * bad when it fails or is paused again. The first of these in time settles it.
 */
export const restartRule: Rule = {
  name: "restart",
  window: "restart",
  applies: (d) => d.source.module === "agents" && d.key.startsWith("escalation:") && answerOf(d) === DECISION_FRESH,
  judge(i) {
    const task = taskOf(i.decision);
    if (task === null) return { outcome: "unknown", evidence: { rule: "restart", reason: "no_task" } };
    const fact = firstOf(window(i), (f) => sameTask(f, task) && has(f, "task_done", "task_failed", "task_paused"));
    if (!fact) return PENDING;
    return { outcome: has(fact, "task_done") ? "good" : "bad", evidence: evidenceOf("restart", fact) };
  },
};

/**
 * Wait / hold answer: good when a run of a held task completes (the cause cleared; a start proves nothing, Lair probes
 * one start at a time during an outage); bad when a hold for the same cause (the module and the ref: one tool or
 * provider or chain) is raised again. A hold with no cause or no held task is judged only on the bad side.
 */
export const holdRule: Rule = {
  name: "hold",
  window: "hold",
  applies: (d) => d.source.module === "agents" && answerOf(d) === DECISION_WAIT,
  judge(i) {
    const d = i.decision;
    if (!d.source.ref) return { outcome: "unknown", evidence: { rule: "hold", reason: "no_cause" } };
    const family = holdFamily(d.source.module, d.source.ref);
    const held = tasksOfRefs(d.blocks);
    const fact = firstOf(window(i), (f) => (f.code === "hold_raised" ? f.family === family : f.task !== undefined && held.includes(f.task) && has(f, "run_completed", "task_done")));
    if (!fact) return PENDING;
    return { outcome: fact.code === "hold_raised" ? "bad" : "good", evidence: evidenceOf("hold", fact, { family }) };
  },
};

/** Release / stand-down answer: bad when the same task is escalated again; otherwise nothing says it was right. */
export const releaseRule: Rule = {
  name: "release",
  window: "release",
  applies: (d) => d.source.module === "agents" && (answerOf(d) === DECISION_RELEASE || answerOf(d) === DECISION_STOP),
  judge(i) {
    const task = taskOf(i.decision);
    if (task === null) return { outcome: "unknown", evidence: { rule: "release", reason: "no_task" } };
    const fact = firstOf(window(i), (f) => sameTask(f, task) && has(f, "task_paused"));
    return fact ? { outcome: "bad", evidence: evidenceOf("release", fact) } : PENDING;
  },
};

/**
 * Planner proposals approved: the tasks the planner added right after the
 * answer are judged. One dropped or reworded within the window is bad; all of
 * them done is good.
 */
export const plannerRule: Rule = {
  name: "planner",
  window: "planner",
  applies: (d) => d.source.module === "planner" && d.key.startsWith("approve:") && ["approve_all", "follow_verifier"].includes(answerOf(d)),
  judge(i) {
    const facts = window(i);
    const applyEnd = new Date(Date.parse(i.answeredAt) + PLANNER_APPLY_SECONDS * 1000).toISOString();
    const added = [...new Set(facts.filter((f) => f.code === "task_added" && f.at <= applyEnd && f.task).map((f) => f.task as string))];
    if (added.length === 0) return PENDING;
    const bad = firstOf(facts, (f) => added.includes(f.task ?? "") && has(f, "task_dropped", "task_reworded") && f.at > applyEnd);
    if (bad) return { outcome: "bad", evidence: evidenceOf("planner", bad, { added: added.length }) };
    const done = added.filter((t) => facts.some((f) => f.task === t && has(f, "task_done", "run_completed")));
    if (done.length === added.length) {
      const last = facts.filter((f) => has(f, "task_done", "run_completed") && added.includes(f.task ?? "")).at(-1) as Fact;
      return { outcome: "good", evidence: evidenceOf("planner", last, { added: added.length, done: done.length }) };
    }
    return PENDING;
  },
};

/** The pull request a decision is about, from its ref or the refs it blocks (`...:pr:<n>`). */
function prOf(d: Decision): number | null {
  for (const ref of [d.source.ref, ...d.blocks]) {
    const m = PR_REF.exec(ref);
    if (m) return Number(m[1]);
  }
  return null;
}

/**

 * A merge a person released: bad when the default branch is proven red on the
 * merged commit (a culprit with the same sha) or a revert of it lands, within
 * the window counted from the merge. A merge on another sha (a squash against
 * the head) stays unknown. It never says good.
 */
export const mergeRule: Rule = {
  name: "merge",
  window: "merge",
  applies: (d) => prOf(d) !== null && answerOf(d) === "release",
  windowEnd(i) {
    const pr = prOf(i.decision);
    const merged = i.facts.between(i.decision.project, i.answeredAt, i.now.toISOString()).find((f) => f.code === "merged" && f.pr === pr);
    // Until it merges, the wait for the merge is bounded by the same number of hours
    return new Date((merged ? Date.parse(merged.at) : Date.parse(i.answeredAt)) + i.hours * 3_600_000);
  },
  judge(i) {
    const pr = prOf(i.decision);
    const facts = window(i);
    const merge = firstOf(facts, (f) => f.code === "merged" && f.pr === pr && f.sha !== undefined);
    if (!merge) return PENDING;
    const bad = firstOf(facts, (f) => f.at >= merge.at && f.sha === merge.sha && has(f, "reverted", "default_red"));
    if (!bad) return PENDING;
    return { outcome: "bad", evidence: { ...evidenceOf("merge", bad), pr: pr as number, review_miss: true } };
  },
};

export const RULES: readonly Rule[] = [restartRule, holdRule, releaseRule, plannerRule, mergeRule];

/** The rule that judges this answer, or null (it stays unknown). */
export function ruleFor(d: Decision): Rule | null {
  return RULES.find((r) => r.applies(d)) ?? null;
}
