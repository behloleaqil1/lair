/** The shadow agreement table on the Decisions page, rendered with the real component. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionPoliciesStatus } from "../../shared/decision-types";
import { percent } from "../decisions-api";
import { PolicyAgreement, PolicyAgreementView } from "./PolicyAgreement";

const status = (over: Partial<DecisionPoliciesStatus> = {}): DecisionPoliciesStatus => ({
  source: "built-in",
  version: "ab12cd34",
  policies: [{ id: "c1-wait", class: "agents.provider_limit", codes: [], answer: "wait", state: "shadow", maxTier: 1 }],
  errors: [],
  agreement: [],
  ...over,
});

describe("policy agreement", () => {
  it("says there are no proposals yet, and that every policy is shadow", () => {
    const html = renderToStaticMarkup(createElement(PolicyAgreementView, { status: status() }));
    expect(html).toContain("No proposals yet");
    expect(html).toContain("built-in");
    expect(html).toContain("answer nothing");
  });

  it("shows agreement and coverage per class, and the refused entries of the file", () => {
    const html = renderToStaticMarkup(
      createElement(PolicyAgreementView, {
        status: status({
          source: "file",
          errors: ["policy c9: class: nope.nope is not in the policy table of classes"],
          agreement: [
            { class: "agents.provider_limit", proposer: "rules", version: "ab12cd34", traced: 5, compared: 3, agreed: 1, disagreed: 1, abstained: 1, unsafeDisagreements: 0, pending: 1, withdrawn: 1, agreement: 0.5, coverage: 2 / 3 },
          ],
        }),
      }),
    );
    expect(html).toContain("agents.provider_limit");
    expect(html).toContain("50%");
    expect(html).toContain("67%");
    expect(html).toContain("data/policies.yaml");
    expect(html).toContain("nope.nope is not in the policy table");
    expect(html).toContain('role="alert"');
  });

  it("percent shows a dash while there is nothing to compare", () => {
    expect(percent(null)).toBe("-");
    expect(percent(0.955)).toBe("96%");
    expect(percent(1)).toBe("100%");
  });

  it("the card is collapsed until opened and loads nothing on first render", () => {
    const html = renderToStaticMarkup(createElement(PolicyAgreement));
    expect(html).toContain("Policy agreement");
    expect(html).toContain("Show");
    expect(html).not.toContain("Shadow agreement per class");
  });
});
