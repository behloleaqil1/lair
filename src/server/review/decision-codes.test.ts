/**
 * The evidence codes of the two review classes of the policy table (docs/design/decision-policies.md §2):
 * C9 review.stuck (a reviewer run that ended without a review) and C10 review.merge_failed (an automatic
 * merge that did not happen, always the owner's).
 */
import { describe, expect, it } from "vitest";
import { KNOWN_DECISION_CLASSES, structureErrors } from "../decisions/structure.js";
import { RuleProposer } from "../decisions/policies/rules.js";
import { parsePolicyTable } from "../decisions/policies/table.js";
import type { Decision } from "../../shared/decision-types.js";
import { reviewStuckCode } from "./agent-assigner.js";
import { mergeFailedEvidence } from "./service.js";

describe("C9 review.stuck codes", () => {
  it("a missing run record is run_variables_lost, a failed or never started run is provider_error, anything else no_reviewer", () => {
    expect(reviewStuckCode(null)).toBe("run_variables_lost");
    expect(reviewStuckCode("failed")).toBe("provider_error");
    expect(reviewStuckCode("never_started")).toBe("provider_error");
    for (const state of ["done", "stopped", "cancelled", "succeeded", "running", ""]) expect(reviewStuckCode(state)).toBe("no_reviewer");
  });

  it("every code it gives is one the class takes", () => {
    for (const state of [null, "failed", "never_started", "done"]) {
      expect(KNOWN_DECISION_CLASSES["review.stuck"].codes).toContain(reviewStuckCode(state));
    }
  });

  it("the class takes no other code than those three", () => {
    expect([...KNOWN_DECISION_CLASSES["review.stuck"].codes].sort()).toEqual(["no_reviewer", "provider_error", "run_variables_lost"]);
    const options = [{ id: "a", effect: "outward" }, { id: "b", effect: "reversible" }];
    const evidence = (code: string) => ({ code, facts: {}, cause_cleared: false, linked_issue: null });
    expect(structureErrors({ class: "review.stuck", evidence: evidence("provider_error"), options, module: "review" })).toEqual([]);
    expect(structureErrors({ class: "review.stuck", evidence: evidence("merge_error"), options, module: "review" })[0]).toContain("evidence.code");
  });

  it("a rule can never propose review_it_yourself: it is an outward option", () => {
    const table = parsePolicyTable(
      "version: 1\npolicies:\n  - id: c9\n    class: review.stuck\n    answer: review_it_yourself\n    reason_code: r\n    state: shadow\n    max_tier: 2\n",
    );
    expect(table.errors).toEqual([]);
    const decision = {
      id: "d", project: "p", kind: "escalation", attention: "action", title: "t", context: "c", status: "open", raisedVia: "server",
      options: [
        { id: "review_it_yourself", label: "x", consequences: "c", effect: "outward" },
        { id: "request_agent_reviews_again", label: "y", consequences: "c", effect: "reversible" },
      ],
      class: "review.stuck",
      evidence: { code: "provider_error", facts: {}, cause_cleared: false, linked_issue: null },
    } as unknown as Decision;
    expect(new RuleProposer(() => table).propose(decision, new Date())).toMatchObject({ option: null, reasonCode: "effect_not_reversible" });
  });
});

describe("C10 review.merge_failed: merge_error_code", () => {
  it("names the refusing policy, 'exception' when the call threw, 'interrupted' for a restart", () => {
    expect(mergeFailedEvidence(7, "abc123", "tests_red")).toEqual({
      code: "merge_error",
      facts: { pr: 7, head_sha: "abc123", refused_by: "tests_red", merge_error_code: "tests_red" },
      cause_cleared: false,
      linked_issue: null,
    });
    expect(mergeFailedEvidence(7, "abc123", null).facts).toMatchObject({ refused_by: null, merge_error_code: "exception" });
    expect(mergeFailedEvidence(7, "abc123", "interrupted").facts).toMatchObject({ refused_by: "interrupted", merge_error_code: "interrupted" });
  });

  it("is accepted by the class, and always carries a code the owner can read", () => {
    const options = [{ id: "a", effect: "outward" }, { id: "b", effect: "reversible" }];
    for (const by of [null, "interrupted", "tests_red"]) {
      const evidence = mergeFailedEvidence(7, "abc", by);
      expect(structureErrors({ class: "review.merge_failed", evidence, options, module: "review" })).toEqual([]);
      expect(typeof evidence.facts.merge_error_code).toBe("string");
    }
  });
});
