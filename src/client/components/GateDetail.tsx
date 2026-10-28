/**
 * A gate's detail (#/gates/<id>, GET /api/dashboard/gates/:id): track, sha,
 * branch, lane and machine; each step with its result and duration;
 * triage's verdict per cause and what it did; placement's advice; for a Lair
 * pipeline run, its jobs and where they ran. For the owner only (GET
 * /api/dashboard/gates/:id/output): the failing tests with their messages
 * and the log tail.
 */
import { useApi } from "../hooks/useApi";
import { CLASS_BADGE, STEP_BADGE, gateBadge, gateFacts, outputEndpoint, placementLine, testsHeading } from "../gate-detail-view";
import { durationText } from "../time";
import type { GateDetailView, GateOutputView } from "../../shared/dashboard-types";
import { DetailPanel, DetailSection } from "./DetailPanel";
import { PipelineJobs } from "./PipelineRuns";
import { TriageRecordDetail } from "./Triage";
import { ErrorState, KeyValues, Loading, OwnerOnlyNotice, Time, useOwnerSignedIn } from "./ui";
import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";

interface Props {
  id: string;
  project: string;
  refreshKey: number;
  readOnly: boolean;
  triageOn: boolean;
  onClose: () => void;
}

export function GateDetail({ id, project, refreshKey, readOnly, triageOn, onClose }: Props) {
  const signedIn = useOwnerSignedIn(refreshKey);
  const detail = useApi<GateDetailView>(`/dashboard/gates/${encodeURIComponent(id)}`, project, refreshKey);
  const output = useApi<GateOutputView>(outputEndpoint(id), project, refreshKey, { owner: true, skip: signedIn !== true });
  const gate = detail.data;

  if (!gate) {
    return (
      <DetailPanel title="Gate" subtitle={<code>{id}</code>} onClose={onClose}>
        {detail.error ? (
          <ErrorState
            what={`gate ${id}`}
            error={detail.error}
            hint="It may have left the queue without a result, or the link may be for another project."
          />
        ) : (
          <Loading what={`gate ${id}`} />
        )}
      </DetailPanel>
    );
  }

  const placement = placementLine(gate);
  return (
    <DetailPanel
      title={gate.track ?? gate.pipeline ?? "Gate"}
      subtitle={
        <>
          <Badge tone={gateBadge(gate.status)}>{gate.status}</Badge> <code className="muted small">{id}</code>
        </>
      }
      onClose={onClose}
    >
      <KeyValues
        rows={[
          ...gateFacts(gate).map(([label, value]): [string, string] => [label, value]),
          ["Started", gate.startedAt ? <Time iso={gate.startedAt} /> : null],
          ["Finished", gate.finishedAt ? <Time iso={gate.finishedAt} /> : null],
          ["Running step", gate.currentStep],
        ]}
      />

      <DetailSection title="Steps">
        {gate.steps.length === 0 ? (
          <p className="muted small">
            {gate.hasLog ? "Its log names no steps Lair can read." : "No log yet: steps show once the gate writes its log."}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Result</th>
                <th className="align-right">Duration</th>
                {gate.source === "pipeline" && <th>Where</th>}
              </tr>
            </thead>
            <tbody>
              {gate.steps.map((step) => (
                <tr key={`${step.lane ?? ""}/${step.name}`}>
                  <td>
                    <code>{step.name}</code>
                    {step.lane && gate.source === "pipeline" && <span className="muted small"> ({step.lane})</span>}
                  </td>
                  <td>
                    <Badge tone={STEP_BADGE[step.state]}>{step.state.replace("_", " ")}</Badge>
                    {step.exitCode !== undefined && <span className="muted small"> exit {step.exitCode}</span>}
                    {step.error && <div className="muted small">{step.error}</div>}
                  </td>
                  <td className="align-right">{durationText(step.durationSeconds)}</td>
                  {gate.source === "pipeline" && <td className="muted small">{step.where ?? "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailSection>

      {gate.triage ? (
        <DetailSection title="Triage">
          <p>
            {gate.triage.verdict ? (
              <Badge tone={CLASS_BADGE[gate.triage.verdict]}>{gate.triage.verdict}</Badge>
            ) : (
              <span className="muted small">no verdict</span>
            )}{" "}
            {gate.triage.blocking ? "blocks a merge" : "does not block a merge"}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Cause</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {gate.triage.causes.map((c, i) => (
                <tr key={i}>
                  <td>
                    <Badge tone={CLASS_BADGE[c.class]}>{c.class}</Badge>
                  </td>
                  <td>
                    {c.summary}
                    <div className="muted small">
                      {c.kind}
                      {c.step ? ` in ${c.step}` : ""}
                      {c.testCount > 0 ? ` · ${c.testCount} test(s)` : ""} · confidence {c.confidence}
                    </div>
                  </td>
                  <td>
                    <code>{c.rule}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TriageRecordDetail id={gate.triage.recordId} project={project} refreshKey={refreshKey} />
        </DetailSection>
      ) : (
        triageOn &&
        gate.status !== "running" &&
        gate.status !== "queued" && (
          <DetailSection title="Triage">
            <p className="muted small">Triage has no record of this result{gate.source === "queue" ? " (send it with lair gate-result)" : ""}.</p>
          </DetailSection>
        )
      )}

      {gate.placement && (
        <DetailSection title="Placement">
          <p>{placement ?? (gate.placement.job ? "No advice: it stays where it is." : "Placement does not see it in the queue.")}</p>
          {gate.placement.job?.advice && <p className="muted small">{gate.placement.job.advice.explanation}</p>}
          {gate.placement.job?.held && <p className="muted small">Never moved: {gate.placement.job.held}</p>}
        </DetailSection>
      )}

      {gate.source === "pipeline" && gate.runId && (
        <DetailSection title="Jobs">
          <PipelineJobs id={gate.runId} project={project} refreshKey={refreshKey} readOnly={readOnly} />
        </DetailSection>
      )}

      <DetailSection title="Failing tests and log">
        {signedIn !== true ? (
          <OwnerOnlyNotice text="Test output and logs can hold anything a test printed, so they are shown to the owner only." />
        ) : output.error ? (
          <ErrorState what="the gate's output" error={output.error} />
        ) : !output.data ? (
          <Loading what="the gate's output" />
        ) : (
          <>
            {output.data.tests.length > 0 && (
              <>
                <h4>{testsHeading(output.data)}</h4>
                <table className="table">
                  <tbody>
                    {output.data.tests.map((t) => (
                      <tr key={`${t.id}-${t.step ?? ""}`}>
                        <td>
                          <code>{t.name}</code>
                          <div className="muted small">
                            {t.suite}
                            {t.file && t.file !== t.suite ? ` · ${t.file}` : ""}
                            {t.step ? ` · ${t.step}` : ""}
                          </div>
                        </td>
                        <td className="small">
                          {t.class && <Badge tone={CLASS_BADGE[t.class]}>{t.class}</Badge>} {t.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {output.data.evidence.length > 0 && (
              <>
                <h4>Evidence</h4>
                <CodeBlock label="Evidence">{output.data.evidence.join("\n")}</CodeBlock>
              </>
            )}
            {output.data.log ? (
              <>
                <h4>Log</h4>
                <p className="muted small">
                  {output.data.log.file}, written <Time iso={output.data.log.modifiedAt} />
                  {output.data.log.truncated ? `; the last ${output.data.log.lines.length} lines` : ""}
                </p>
                <CodeBlock label="Gate log">{output.data.log.lines.join("\n")}</CodeBlock>
              </>
            ) : (
              <p className="muted small">No log for this gate.</p>
            )}
          </>
        )}
      </DetailSection>
    </DetailPanel>
  );
}
