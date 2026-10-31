/**
 * A vitest setup file (vite.config.ts): in the tests of the modules that
 * raise decisions, every decision raised through a real DecisionInbox must
 * carry a class, evidence that the schema accepts and an effect on each
 * option, and must be raised with the structure kept (one the inbox refused
 * would be raised without it). A test that raises one without fails after it
 * runs, so a new or edited raiser that sets none is caught by its module's
 * own tests, decision by decision. Other tests (the inbox, notifications, the
 * supervisor) raise hand-made decisions and are left out.
 */
import { afterEach, expect } from "vitest";
import { DecisionInbox } from "../service.js";
import { EvidenceSchema, structureErrors } from "../structure.js";
import type { RaiseDecisionInput } from "../types.js";

const REAL_MODULE_TESTS = /[\\/]src[\\/]server[\\/](?:agents|planner|review|triage|watchdog|gates|infra-monitor)[\\/][^\\/]*\.test\.ts$/;

let problems: string[] = [];

const original = DecisionInbox.prototype.raise;
DecisionInbox.prototype.raise = function raiseChecked(this: DecisionInbox, input: RaiseDecisionInput) {
  if (REAL_MODULE_TESTS.test(expect.getState().testPath ?? "")) {
    const who = `${input.source?.module}/${input.key}`;
    if (input.class === undefined || input.evidence === undefined) {
      problems.push(`${who}: raised without a class and evidence`);
    } else {
      const evidence = EvidenceSchema.safeParse(input.evidence);
      if (!evidence.success) problems.push(`${who}: evidence refused: ${evidence.error.issues[0]?.message}`);
      const errors = structureErrors({
        class: input.class,
        evidence: input.evidence,
        options: input.options ?? [],
        module: input.source?.module ?? "",
      });
      if (errors.length > 0) problems.push(`${who}: ${errors.join("; ")}`);
    }
  }
  return original.call(this, input);
};

afterEach(() => {
  const found = problems;
  problems = [];
  if (found.length > 0) throw new Error(`decisions raised without a valid structure:\n${found.join("\n")}`);
});
