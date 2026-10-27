/**
 * Pipelines section of the Gates view: where jobs can run (executor
 * availability, CI minutes, warnings), pipeline runs with the executor and
 * the fallback reasons of every step, and the workflow file a project
 * commits to use GitHub Actions. Calls /api/pipelines/* (see
 * docs/configuration.md#gate-pipelines).
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { cancelPipelineRun, startPipelineRun, type ApiEnvelope } from "../owner-actions";
import { SignInHint } from "./SignInHint";
import type {
  PipelineAttempt,
  PipelineRun,
  PipelinesStatus,
} from "../../shared/pipeline-types";

interface Props {
  project: string;
  refreshKey: number;
}

interface WorkflowFile {
  path: string;
  content: string;
  version: string;
  allowSelfHosted: boolean;
  visibility: string | null;
  instructions: string[];
}

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

const STATUS_BADGE: Record<string, string> = {
  passed: "badge-success",
  completed: "badge-success",
  failed: "badge-error",
  error: "badge-error",
  timed_out: "badge-error",
  running: "badge-warning",
  queued: "badge-neutral",
  waiting: "badge-warning",
  cancelling: "badge-warning",
  dispatching: "badge-neutral",
  fell_back: "badge-warning",
  skipped: "badge-neutral",
  cancelled: "badge-neutral",
  interrupted: "badge-neutral",
  pending: "badge-neutral",
};

function badge(status: string) {
  return <span className={`badge ${STATUS_BADGE[status] ?? "badge-neutral"}`}>{status.replace("_", " ")}</span>;
}

function time(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/** The data of an owner request (owner-actions.ts), or its error thrown. */
async function unwrap<T>(request: Promise<ApiEnvelope<T>>): Promise<T> {
  const json = await request;
  if (!json.success || json.data === undefined) throw new Error(json.error ?? "Request failed");
  return json.data;
}

/** Where a run's jobs ran, e.g. "local machine, GitHub-hosted runner (ubuntu-latest)" */
function whereOf(run: PipelineRun): string {
  const places = [...new Set(run.jobs.map((j) => j.where).filter(Boolean))];
  return places.length > 0 ? places.join(", ") : "—";
}

export function PipelineRuns({ project, refreshKey }: Props) {
  const [tick, setTick] = useState(0);
  const key = refreshKey + tick;
  const status = useApi<PipelinesStatus>("/pipelines/status", project, key);
  const runs = useApi<PipelineRun[]>("/pipelines/runs", project, key);
  const [selected, setSelected] = useState<string | null>(null);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [pipeline, setPipeline] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const s = status.data;
  if (!s) {
    return status.error ? <div className="error">Pipelines: {status.error}</div> : null;
  }

  if (!s.configured) {
    return (
      <div className="card">
        <h3>Pipelines</h3>
        <p style={muted}>
          No pipelines for this project. Add a <code>pipelines:</code> block to its YAML: Lair runs each job on the
          repository&apos;s CI runners first (GitHub Actions) and on this machine last.
        </p>
        {s.errors.map((e) => (
          <p key={e} className="error" style={{ marginTop: "0.5rem" }}>
            {e}
          </p>
        ))}
      </div>
    );
  }

  const chosen = pipeline || s.pipelines[0]?.name || "";
  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const run = await unwrap(
        startPipelineRun<PipelineRun>(project, {
          pipeline: chosen,
          ...(branch.trim() ? { branch: branch.trim() } : {}),
        }),
      );
      setMessage(`Started ${run.id} at ${run.commitSha.slice(0, 10)}`);
      setSelected(run.id);
      setTick((t) => t + 1);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SignInHint what="Starting and cancelling pipeline runs" refreshKey={refreshKey} />
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Pipelines</h3>
          <span style={muted}>Order: {s.order.join(" → ")}</span>
          <span style={muted}>
            GitHub-hosted minutes this month: {s.minutes.usedThisMonth}
            {s.minutes.budget > 0 ? ` of ${s.minutes.budget}` : ""}
          </span>
          <button className="nav-button" onClick={() => setShowWorkflow(true)}>
            Workflow file
          </button>
        </div>

        {s.github.warnings.map((w) => (
          <p key={w} className="error" style={{ marginTop: "0.75rem" }}>
            {w}
          </p>
        ))}

        <table className="table" style={{ marginTop: "0.75rem" }}>
          <thead>
            <tr>
              <th>Executor</th>
              <th>Available</th>
              <th>Why not</th>
            </tr>
          </thead>
          <tbody>
            {s.executors.map((e) => (
              <tr key={e.executor}>
                <td>
                  <code>{e.executor}</code>
                </td>
                <td>
                  <span className={`badge ${e.available ? "badge-success" : "badge-neutral"}`}>
                    {e.available ? "yes" : "no"}
                  </span>
                </td>
                <td style={muted}>
                  {e.reason ?? ""}
                  {e.unavailableUntil ? ` (until ${time(e.unavailableUntil)})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...muted, marginTop: "0.5rem" }}>
          GitHub: {s.github.repo ?? "no repository"} · token {s.github.tokenEnv}{" "}
          {s.github.tokenSet ? "set" : "not set"}
          {s.github.visibility ? ` · ${s.github.visibility}` : ""}
          {s.github.runners.length > 0
            ? ` · runners: ${s.github.runners.map((r) => `${r.name} (${r.status}${r.busy ? ", busy" : ""})`).join(", ")}`
            : ""}
        </p>
        {s.decisions.length > 0 && (
          <div style={{ marginTop: "0.5rem" }}>
            {s.decisions.map((d) => (
              <p key={d.id} style={muted}>
                Needs a decision ({d.kind}): {d.question}
              </p>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <select className="project-select" value={chosen} onChange={(e) => setPipeline(e.target.value)}>
            {s.pipelines.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({p.lanes.map((l) => l.name).join(", ")})
              </option>
            ))}
          </select>
          <input
            className="command-input"
            style={{ maxWidth: "16rem" }}
            placeholder="branch (default: HEAD)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
          <button className="command-submit" disabled={busy || s.readOnly || !chosen} onClick={start}>
            Run
          </button>
          {s.readOnly && <span style={muted}>Read-only project: runs can't be started here</span>}
          {message && <span style={muted}>{message}</span>}
        </div>
      </div>

      <div className="card">
        <h3>Pipeline runs</h3>
        {(runs.data ?? []).length === 0 ? (
          <p style={muted}>No runs yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Pipeline</th>
                <th>Commit</th>
                <th>Status</th>
                <th>Where</th>
                <th>Minutes</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).slice(0, 20).map((run) => (
                <tr key={run.id} className="clickable" onClick={() => setSelected(run.id)}>
                  <td style={muted}>{time(run.createdAt)}</td>
                  <td>{run.pipeline}</td>
                  <td>
                    <code>{run.commitSha.slice(0, 10)}</code>
                  </td>
                  <td>{badge(run.status)}</td>
                  <td style={muted}>{whereOf(run)}</td>
                  <td>
                    {run.minutes}
                    {run.billedMinutes > 0 ? ` (${run.billedMinutes} billed)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <>
          <div className="overlay" onClick={() => setSelected(null)} />
          <RunPanel
            id={selected}
            project={project}
            refreshKey={key}
            readOnly={s.readOnly}
            onChanged={() => setTick((t) => t + 1)}
            onClose={() => setSelected(null)}
          />
        </>
      )}
      {showWorkflow && (
        <>
          <div className="overlay" onClick={() => setShowWorkflow(false)} />
          <WorkflowPanel project={project} refreshKey={key} onClose={() => setShowWorkflow(false)} />
        </>
      )}
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: PipelineAttempt }) {
  return (
    <tr>
      <td>
        <code>{attempt.executor}</code>
      </td>
      <td>{badge(attempt.status)}</td>
      <td style={muted}>
        {attempt.reason ?? attempt.where ?? ""}
        {attempt.ciRunUrl && (
          <>
            {" "}
            <a href={attempt.ciRunUrl} target="_blank" rel="noreferrer">
              CI run
            </a>
          </>
        )}
      </td>
      <td>{attempt.minutes ?? 0}</td>
    </tr>
  );
}

function RunPanel({
  id,
  project,
  refreshKey,
  readOnly,
  onChanged,
  onClose,
}: {
  id: string;
  project: string;
  refreshKey: number;
  readOnly: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { data: run, error } = useApi<PipelineRun>(`/pipelines/runs/${id}`, project, refreshKey);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = async () => {
    setCancelError(null);
    try {
      await unwrap(cancelPipelineRun<PipelineRun>(project, id));
      onChanged();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h2>Pipeline run</h2>
        <button className="detail-panel-close" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {run && (
        <>
          <p style={muted}>
            {run.pipeline} at <code>{run.commitSha}</code>
            {run.branch ? ` (${run.branch})` : ""} · {badge(run.status)} · {run.minutes} CI minute(s)
            {run.billedMinutes > 0 ? `, ${run.billedMinutes} billed` : ""}
          </p>
          {run.error && <p className="error">{run.error}</p>}
          {!run.completedAt && !readOnly && (
            <button className="nav-button" onClick={cancel} style={{ marginBottom: "0.5rem" }}>
              Cancel run
            </button>
          )}
          {cancelError && <p className="error">{cancelError}</p>}

          <h3>Steps</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Lane</th>
                <th>Status</th>
                <th>Exit</th>
                <th>Time</th>
                <th>Where it ran</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((step) => (
                <tr key={`${step.lane}/${step.name}`}>
                  <td>{step.name}</td>
                  <td style={muted}>{step.lane}</td>
                  <td>
                    {badge(step.status)}
                    {step.error && <div style={muted}>{step.error}</div>}
                  </td>
                  <td>{step.exitCode ?? "—"}</td>
                  <td>{duration(step.durationMs)}</td>
                  <td style={muted}>{step.where ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {run.jobs.map((job) => (
            <div key={job.id} style={{ marginTop: "1rem" }}>
              <h3>
                Lane {job.lane} {badge(job.status)}
              </h3>
              {job.waitReason && <p style={muted}>{job.waitReason}</p>}
              {job.error && <p className="error">{job.error}</p>}
              <table className="table">
                <thead>
                  <tr>
                    <th>Executor</th>
                    <th>Attempt</th>
                    <th>Why / where</th>
                    <th>Minutes</th>
                  </tr>
                </thead>
                <tbody>
                  {job.attempts.map((attempt, i) => (
                    <AttemptRow key={i} attempt={attempt} />
                  ))}
                </tbody>
              </table>
              {job.artifacts.length > 0 && (
                <p style={muted}>Artifacts: {job.artifacts.map((a) => `${a.name} (${a.sizeBytes} bytes)`).join(", ")}</p>
              )}
              {job.log && <div className="code">{job.log}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function WorkflowPanel({
  project,
  refreshKey,
  onClose,
}: {
  project: string;
  refreshKey: number;
  onClose: () => void;
}) {
  const { data, error } = useApi<WorkflowFile>("/pipelines/workflow", project, refreshKey);
  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h2>Workflow file</h2>
        <button className="detail-panel-close" onClick={onClose}>
          ×
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <ol style={{ ...muted, paddingLeft: "1.25rem" }}>
            {data.instructions.map((line) => (
              <li key={line} style={{ marginBottom: "0.5rem" }}>
                {line}
              </li>
            ))}
          </ol>
          <p style={muted}>
            <code>{data.path}</code> · version {data.version}
          </p>
          <div className="code">{data.content}</div>
        </>
      )}
    </div>
  );
}
