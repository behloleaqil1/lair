/** Types of the outcome tracker (docs/design/decision-policies.md §4, "Outcomes"). */
import type { Decision, DecisionOutcome } from "../../shared/decision-types.js";

/**
 * A thing that happened, reduced to codes and ids (never prose). The tracker
 * keeps these for a while so a rule can look at what followed an answer.
 */
export interface Fact {
  /** ISO-8601 */
  at: string;
  project: string;
  code: FactCode;
  /** The task it is about */
  task?: string;
  /** A group of related holds, e.g. the key prefix of a hold decision */
  family?: string;
  /** A pull request number */
  pr?: number;
  /** A commit */
  sha?: string;
}

export const FACT_CODES = [
  /** A run of the task failed, never started, hung or lost its claim */
  "task_failed",
  /** The task was escalated: its automatic recovery is used up */
  "task_paused",
  /** A run of the task started */
  "run_started",
  /** A run of the task ended well */
  "run_completed",
  /** The task's line was marked done */
  "task_done",
  /** A hold or escalation decision was raised again (task and family tell which) */
  "hold_raised",
  /** The planner applied an `add` / `drop` / `reword` / `reassign` of the task */
  "task_added",
  "task_dropped",
  "task_reworded",
  /** A pull request was merged (sha: the resulting commit) */
  "merged",
  /** A commit was reverted, or found to have turned the default branch red */
  "reverted",
  "default_red",
] as const;
export type FactCode = (typeof FACT_CODES)[number];

/** What a rule says about one answer. `pending`: the window is still open and nothing decided it. */
export type Verdict =
  | { outcome: "good" | "bad"; evidence: Evidence }
  | { outcome: "pending" }
  | { outcome: "unknown"; evidence: Evidence };

/** Codes and ids only. */
export type Evidence = Record<string, string | number | boolean | null>;

/** The facts a rule may look at, read-only. */
export interface FactView {
  /** Facts of the project after `from` (excluded) up to `to` (included), oldest first */
  between(project: string, from: string, to: string): Fact[];
}

export interface RuleInput {
  decision: Decision;
  /** ISO-8601: when the answer was given */
  answeredAt: string;
  /** The end of the window, ISO-8601 */
  windowEnd: string;
  facts: FactView;
}

export interface Rule {
  name: string;
  /** Whether the rule judges this answer */
  applies(decision: Decision): boolean;
  /** Which of the settings' windows the rule uses */
  window: keyof WindowHours;
  judge(input: RuleInput): Verdict;
}

export interface WindowHours {
  restart: number;
  hold: number;
  release: number;
  planner: number;
  merge: number;
}

export type { DecisionOutcome };
