/**
 * Agreement (design §5): the trace joined to the answers people gave. Open, withdrawn and expired decisions
 * have no answer to compare with and are counted apart. The store counts in SQL (DecisionStore.policyAgreement),
 * so a request never loads the trace rows; this adds the two ratios.
 */
import type { PolicyAgreementRow as AgreementRow } from "../../../shared/decision-types.js";
import type { PolicyAgreementCounts } from "../store.js";

export type { AgreementRow };

export function agreementRows(counts: PolicyAgreementCounts[]): AgreementRow[] {
  return counts.map((c) => {
    const proposed = c.agreed + c.disagreed;
    return {
      ...c,
      agreement: proposed > 0 ? c.agreed / proposed : null,
      coverage: c.compared > 0 ? proposed / c.compared : null,
    };
  });
}
