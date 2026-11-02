/**
 * Shadow agreement of the decision policies (docs/design/decision-policies.md §5) on the Decisions page: per class
 * and proposer version, how often a rule's proposal equals the answer a person gave. Owner only. Read-only: nothing
 * here answers a decision or changes a policy.
 */
import { useEffect, useState } from "react";
import type { DecisionPoliciesStatus } from "../../shared/decision-types";
import { decisionPolicies, percent } from "../decisions-api";
import { Button } from "../ui/Button";

export function PolicyAgreementView({ status }: { status: DecisionPoliciesStatus }) {
  return (
    <div data-policy-agreement="view">
      {!status.enabled && (
        <p className="muted small" data-policy-agreement="off">
          Decision policies are off: nothing is proposed or traced. Set <code>decision_policies.enabled: true</code> in
          data/server.yaml and restart Lair to start the shadow comparison.
        </p>
      )}
      <p className="muted small">
        Policy table: {status.source === "file" ? "data/policies.yaml" : "built-in"} ({status.policies.length} policies, all in shadow:
        they propose into a trace and answer nothing). Agreement is the proposals that equal your answer, of those compared.
      </p>
      {status.errors.length > 0 && (
        <div className="error" role="alert">
          {status.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      {!status.enabled ? null : status.agreement.length === 0 ? (
        <p className="muted small">No proposals yet: one is written when a decision of a covered class is raised.</p>
      ) : (
        <table className="table" aria-label="Shadow agreement per class">
          <thead>
            <tr>
              <th>Class</th>
              <th>Proposer</th>
              <th>Compared</th>
              <th>Agreed</th>
              <th>Disagreed</th>
              <th>Abstained</th>
              <th>Agreement</th>
              <th>Coverage</th>
              <th>Unsafe</th>
              <th>Open</th>
              <th>Withdrawn</th>
            </tr>
          </thead>
          <tbody>
            {status.agreement.map((r) => (
              <tr key={`${r.class}/${r.proposer}/${r.version}`}>
                <td>{r.class}</td>
                <td>
                  {r.proposer} <span className="muted small">{r.version}</span>
                </td>
                <td>{r.compared}</td>
                <td>{r.agreed}</td>
                <td>{r.disagreed}</td>
                <td>{r.abstained}</td>
                <td>{percent(r.agreement)}</td>
                <td>{percent(r.coverage)}</td>
                <td>{r.unsafeDisagreements}</td>
                <td>{r.pending}</td>
                <td>{r.withdrawn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PolicyAgreement() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DecisionPoliciesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    decisionPolicies()
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the decision policies");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div className="card" data-policy-agreement="card">
      <div className="row row-lg">
        <h3>Policy agreement</h3>
        <span className="muted small">What Lair&apos;s rules would have answered, against what you answered.</span>
        <Button size="sm" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && error && <div className="error">{error}</div>}
      {open && status && <PolicyAgreementView status={status} />}
    </div>
  );
}
