/**
 * The machine-readable side of a decision (docs/design/decision-policies.md
 * §2 and §4): a policy `class`, an `evidence` object and an `effect` on each
 * option. The prose in `context` stays for the person; nothing but the
 * schema check below reads these fields yet.
 */
import { z } from "zod";
import { DECISION_EFFECTS, type DecisionEvidence } from "../../shared/decision-types.js";

/** True for a string with a control character (kept here: validate.ts imports this file). */
const hasControl = (s: string): boolean => [...s].some((ch) => ch < " " || ch === "\u007f");

/** `module.name`: the match key of a policy. Never derived from a title. */
const CLASS_ID = /^[a-z][a-z0-9_-]{0,39}\.[a-z][a-z0-9_]{0,59}$/;
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const FACT_KEY = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * A known class: its policy, the evidence codes it allows, and its `live` facts: the facts its module may
 * re-read and change while the decision is open (docs/design/decision-brain.md §4.1). `cause_cleared` and
 * `linked_issue` move by event and are in no list.
 */
export interface KnownDecisionClass {
  policy: string;
  codes: readonly string[];
  live?: readonly string[];
}

/**
 * The classes of the policy table (C1-C16) with the evidence codes each
 * allows. A class outside this table is allowed but flagged; a known class
 * takes only its own codes.
 */
export const KNOWN_DECISION_CLASSES: Readonly<Record<string, KnownDecisionClass>> = {
  "agents.provider_limit": { policy: "C1", codes: ["provider_rate_limit", "provider_quota", "provider_unreachable"] },
  "supervisor.check_failing": { policy: "C2", codes: ["check_failing"] },
  "watchdog.idle_capacity": { policy: "C3", codes: ["idle_capacity"] },
  "watchdog.orphan_claim": { policy: "C4", codes: ["claim_orphan"] },
  "agents.gave_up": {
    policy: "C5",
    codes: ["provider_limit", "dead_on_start", "exit0_no_report", "blocked_reported", "repeated_failure"],
    // hold_on_pr is next_move's input, so the two move together
    live: ["task_state", "next_move", "review_at_head", "gate_at_head", "hold_on_pr", "blocker_cleared", "limit_reset_passed"],
  },
  "planner.proposal": { policy: "C6", codes: ["verifier_rejected", "verifier_passed", "verifier_missing", "writer_conflict"] },
  "planner.unblock": { policy: "C7", codes: ["infra", "waiting_on_gate", "needs_owner"] },
  // The planner guards' notices (G6, docs/design/ai-spend.md §4.5): what observe mode would do, or a kept change
  "planner.guard_notice": { policy: "C15", codes: ["would_skip", "would_apply", "tasks_file_kept"] },
  // planner.mode: act without the guards act mode needs, in warn mode (docs/design/planner-act.md §4.3, D1)
  "planner.act_rules": { policy: "C16", codes: ["act_rules_missing"] },
  "triage.gate_failure": {
    policy: "C8",
    codes: ["infra_download", "docker_down", "test_assertion", "unknown_failure", "infra_other", "same_failure_again"],
  },
  "review.stuck": { policy: "C9", codes: ["run_variables_lost", "provider_error", "no_reviewer"] },
  "review.merge_failed": { policy: "C10", codes: ["merge_error"] },
  "agents.cannot_start": { policy: "C11", codes: ["probe_failed", "fill_waiting"] },
  "host-services.service_down": { policy: "C12", codes: ["start_failed", "flapping", "not_started", "probe_timeout"] },
  "pr_health.notice": { policy: "C13", codes: ["no_owner", "delivery_failed", "unfixed"] },
  "agents.spend_notice": { policy: "C14", codes: ["waste_share", "task_attempts", "would_park", "would_cool", "budget_soft", "would_block", "would_wake"] },
};

export function isKnownDecisionClass(id: string): boolean {
  return Object.hasOwn(KNOWN_DECISION_CLASSES, id);
}

/** The facts a class's module may change on an open decision ([] for an unknown class or one without a list). */
export function liveFactsOf(id: string | undefined): readonly string[] {
  return id !== undefined && isKnownDecisionClass(id) ? (KNOWN_DECISION_CLASSES[id].live ?? []) : [];
}

/** One fact value as the evidence takes it (a string of one line, a finite number, a boolean or null). */
export function isFactValue(value: unknown): value is string | number | boolean | null {
  return FactValue.safeParse(value).success;
}

const FactValue = z.union([
  z
    .string()
    .max(200)
    .refine((s) => !hasControl(s), "must be one line without control characters"),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** The most facts one decision's evidence holds, at the raise and after any update */
export const MAX_EVIDENCE_FACTS = 30;

export const EvidenceSchema = z
  .object({
    code: z.string().regex(CODE, "use lowercase letters, digits and '_', starting with a letter (at most 60)"),
    facts: z
      .record(z.string().regex(FACT_KEY, "fact names use lowercase letters, digits and '_'"), FactValue)
      .refine((facts) => Object.keys(facts).length <= MAX_EVIDENCE_FACTS, `at most ${MAX_EVIDENCE_FACTS} facts`),
    cause_cleared: z.boolean(),
    linked_issue: z.number().int().positive().nullable(),
  })
  .strict();

export const ClassSchema = z.string().regex(CLASS_ID, "use module.name in lowercase letters, digits, '_' and '-'");
export const EffectSchema = z.enum(DECISION_EFFECTS);

/**
 * Cross-field rules of the structured fields, on a decision whose shape
 * already parsed. Returns the errors (each names its field); an empty list
 * means valid. A decision with neither class nor evidence is allowed (it is
 * never for a rule); one with only one of them is not.
 */
export function structureErrors(input: {
  class?: string;
  evidence?: DecisionEvidence;
  options: { id: string; effect?: string }[];
  module: string;
}): string[] {
  const errors: string[] = [];
  const { class: id, evidence } = input;
  if (id === undefined && evidence === undefined) {
    const effects = input.options.filter((o) => o.effect !== undefined);
    if (effects.length > 0) errors.push("class: options carry an effect, so the decision needs a class and evidence");
    return errors;
  }
  if (id === undefined) errors.push("class: evidence needs a class");
  if (evidence === undefined) errors.push("evidence: a class needs evidence");
  if (id !== undefined) {
    if (id.slice(0, id.indexOf(".")) !== input.module) {
      errors.push("class: must start with the raising module's name and a '.'");
    } else if (evidence !== undefined && isKnownDecisionClass(id)) {
      const { codes } = KNOWN_DECISION_CLASSES[id];
      if (!codes.includes(evidence.code)) {
        errors.push(`evidence.code: ${id} takes one of ${codes.join(", ")}`);
      }
    }
  }
  input.options.forEach((o, i) => {
    if (o.effect === undefined) errors.push(`options.${i}.effect: a decision with a class needs an effect on every option`);
  });
  return errors;
}
