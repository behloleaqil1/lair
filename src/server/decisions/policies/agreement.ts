/**
 * Agreement (design §5): the trace joined to the answers people gave. Open, withdrawn and expired decisions
 * have no answer to compare with and are counted apart.
 */
import type { PolicyAgreementRow as AgreementRow } from "../../../shared/decision-types.js";
import type { PolicyTraceJoined } from "../store.js";

export type { AgreementRow };

export function agreementRows(traces: PolicyTraceJoined[]): AgreementRow[] {
  const rows = new Map<string, AgreementRow>();
  for (const t of traces) {
    const key = `${t.class}\u0000${t.proposer}\u0000${t.version}`;
    const r =
      rows.get(key) ??
      ({
        class: t.class, proposer: t.proposer, version: t.version, traced: 0, compared: 0, agreed: 0, disagreed: 0,
        abstained: 0, unsafeDisagreements: 0, pending: 0, withdrawn: 0, agreement: null, coverage: null,
      } satisfies AgreementRow);
    r.traced++;
    if (t.status === "open") r.pending++;
    else if (t.answer === null) r.withdrawn++;
    else {
      r.compared++;
      if (t.option === null) r.abstained++;
      else if (t.option === t.answer) r.agreed++;
      else {
        r.disagreed++;
        const effect = t.options.find((o) => o.id === t.option)?.effect;
        if (effect === "irreversible" || effect === "outward") r.unsafeDisagreements++;
      }
    }
    rows.set(key, r);
  }
  for (const r of rows.values()) {
    const proposed = r.agreed + r.disagreed;
    r.agreement = proposed > 0 ? r.agreed / proposed : null;
    r.coverage = r.compared > 0 ? proposed / r.compared : null;
  }
  return [...rows.values()].sort((a, b) => (a.class + a.version).localeCompare(b.class + b.version));
}
