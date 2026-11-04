/**
 * The Planner view's readiness panel (docs/design/planner-act.md §4.4): for each part, whether the last days' evidence
 * says it may switch from observe to act, and, for a part in act, the changes behind "switch back recommended". The
 * switch itself stays the owner's config change.
 */
import type { PlannerReadinessView, ReadinessVerdict } from "../../shared/planner-types";
import { Badge } from "../ui/Badge";

const VERDICT: Record<ReadinessVerdict, { label: string; tone: string }> = {
  ready: { label: "ready", tone: "badge-success" },
  not_yet: { label: "not yet", tone: "badge-neutral" },
  switch_back: { label: "switch back recommended", tone: "badge-warning" },
};

export function ReadinessPanel({ report }: { report: PlannerReadinessView }) {
  return (
    <div className="card" data-testid="planner-readiness">
      <h3>Ready for act? (last {report.days} days)</h3>
      <p className="muted small">
        Each part needs {report.minSamples} samples and {report.minAgreement} agreement. Lair never switches a mode: set it in the
        project's config.
      </p>
      <table className="table">
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.part}>
              <td><code>{row.part}</code> <span className="muted small">{row.mode}</span></td>
              <td><Badge tone={VERDICT[row.verdict].tone}>{VERDICT[row.verdict].label}</Badge></td>
              <td>
                {row.criteria
                  .filter((c) => !c.ok)
                  .map((c) => (
                    <div key={c.id} className="small">{c.label}: {c.detail}</div>
                  ))}
                {row.failed.length > 0 && <div className="muted small">Failed samples: {row.failed.join(", ")}</div>}
                {row.undone.map((u) => (
                  <div key={u.change} className="small">
                    {u.op} {u.task ?? ""} ({u.how})
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
