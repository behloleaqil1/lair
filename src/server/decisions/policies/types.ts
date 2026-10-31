/**
 * The policy table and the proposer interface (docs/design/decision-policies.md §3 and §5).
 * Nothing here answers a decision: a proposal is a row in the policy trace, compared with the answer a
 * person gave later.
 */
import type { Decision } from "../../../shared/decision-types.js";

/** `off`: loaded, never proposes. `shadow`: proposes into the trace only. `suggest` and `act` are not built yet. */
export const POLICY_STATES = ["off", "shadow"] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

export const CONDITION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "present"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * One test on the evidence. `fact` is a key of `evidence.facts`, or one of the two top-level fields
 * `cause_cleared` and `linked_issue`. A fact that is missing, or of another type than the value, never
 * satisfies a condition (fail closed): in `unless` that means the guard cannot be evaluated, so the
 * proposer abstains.
 */
export interface Condition {
  fact: string;
  op: ConditionOp;
  value?: string | number | boolean | null | (string | number | boolean)[];
}

export interface Policy {
  /** Stable id, e.g. "c1-wait" */
  id: string;
  /** The decision class it covers (a class of the table in ../structure.ts) */
  class: string;
  /** Evidence codes it covers; empty: every code the class allows */
  codes: string[];
  /** The option it proposes. It must be offered on the decision, and not irreversible or outward */
  answer: string;
  /** A code (not prose) for why */
  reasonCode: string;
  state: PolicyState;
  /** 1: rules; 2: may also be a small model's; 3: stays with the owner (never proposed) */
  maxTier: 1 | 2 | 3;
  /** Every condition must hold */
  when: Condition[];
  /** Any condition that holds (or cannot be evaluated) makes the proposer abstain */
  unless: Condition[];
  /** ISO-8601; past it the policy abstains */
  expires?: string;
}

export interface PolicyTable {
  policies: Policy[];
  /** Entries refused at load, each naming its policy and field; shown to the owner */
  errors: string[];
  /** Short content hash: the version a trace row carries, so any change to the table starts a new comparison */
  version: string;
}

/** What a proposer says about one decision. `option` is null when it abstains. */
export interface Proposal {
  option: string | null;
  /** The policy id that matched (or blocked) */
  policy: string;
  reasonCode: string;
  confidence: number;
}

/** A rule, later a classifier or a model. It reads a decision and proposes; it holds no means to answer. */
export interface Proposer {
  readonly id: string;
  version(): string;
  /** null: the proposer has no policy for this decision (nothing is traced) */
  propose(decision: Decision, now: Date): Proposal | null;
}
