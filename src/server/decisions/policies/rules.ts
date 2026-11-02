/**
 * The rule proposer: the policy table over a decision's structured evidence (design §3, tier 1). It reads a
 * decision and returns a proposal; it holds no means to answer, and every doubt is an abstain.
 */
import { NEVER_DEFAULT_KINDS, type Decision, type DecisionFactValue } from "../../../shared/decision-types.js";
import type { Condition, PolicyTable, Proposal, Proposer } from "./types.js";

export const RULES_PROPOSER = "rules";

function lookup(decision: Decision, fact: string): DecisionFactValue | undefined {
  const e = decision.evidence;
  if (!e) return undefined;
  if (fact === "cause_cleared") return e.cause_cleared;
  if (fact === "linked_issue") return e.linked_issue;
  return Object.hasOwn(e.facts, fact) ? e.facts[fact] : undefined;
}

/** true / false, or null when it cannot be evaluated (missing fact, or a type the operator does not compare). */
export function holds(c: Condition, decision: Decision): boolean | null {
  const v = lookup(decision, c.fact);
  if (v === undefined) return null;
  if (c.op === "present") return v !== null;
  if (v === null) return null;
  switch (c.op) {
    case "eq":
      return typeof v === typeof c.value ? v === c.value : null;
    case "ne":
      return typeof v === typeof c.value ? v !== c.value : null;
    case "in":
      return Array.isArray(c.value) && c.value.some((x) => typeof x === typeof v) ? c.value.includes(v as never) : null;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof v !== "number" || typeof c.value !== "number") return null;
      return c.op === "gt" ? v > c.value : c.op === "gte" ? v >= c.value : c.op === "lt" ? v < c.value : v <= c.value;
    }
  }
}

export class RuleProposer implements Proposer {
  readonly id = RULES_PROPOSER;

  constructor(private readonly table: () => PolicyTable) {}

  version(): string {
    return this.table().version;
  }

  propose(decision: Decision, now: Date): Proposal | null {
    const e = decision.evidence;
    if (!decision.class || !e) return null;
    const candidates = this.table().policies.filter(
      (p) => p.state !== "off" && p.class === decision.class && (p.codes.length === 0 || p.codes.includes(e.code)),
    );
    if (candidates.length === 0) return null;
    let blocked: Proposal | null = null;
    for (const p of candidates) {
      const abstain = (reasonCode: string): Proposal => ({ option: null, policy: p.id, reasonCode, confidence: 0 });
      // The kinds that always wait, notices of tier 3 and anything with a doubt are never proposed
      if (p.maxTier === 3 || NEVER_DEFAULT_KINDS.includes(decision.kind)) {
        blocked ??= abstain("tier_3");
        continue;
      }
      if (p.expires !== undefined && Date.parse(p.expires) <= now.getTime()) {
        blocked ??= abstain("policy_expired");
        continue;
      }
      const offered = decision.options.find((o) => o.id === p.answer);
      if (!offered) {
        blocked ??= abstain("option_not_offered");
        continue;
      }
      if (offered.effect === undefined || offered.effect === "irreversible" || offered.effect === "outward") {
        blocked ??= abstain("effect_not_reversible");
        continue;
      }
      if (!p.when.every((c) => holds(c, decision) === true)) {
        blocked ??= abstain("conditions_not_met");
        continue;
      }
      // A guard that holds, or cannot be evaluated, blocks
      if (p.unless.some((c) => holds(c, decision) !== false)) {
        blocked ??= abstain("guard");
        continue;
      }
      return { option: p.answer, policy: p.id, reasonCode: p.reasonCode, confidence: 1 };
    }
    return blocked;
  }
}
