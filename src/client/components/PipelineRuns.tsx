/**
 * The Pipelines tab of Gates: where jobs can run (executor availability, CI
 * minutes, warnings), the pipeline runs (a row opens the run's gate detail,
 * #/gates/<run id>?tab=pipelines, with its steps and PipelineJobs), and the
 * workflow file a project commits to use GitHub Actions. Calls
 * /api/pipelines/* (see docs/configuration.md#gate-pipelines).
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { cancelPipelineRun, startPipelineRun, type ApiEnvelope } from "../owner-actions";
import { SignInHint } from "./SignInHint";
import { DataTable, type Column } from "./DataTable";
import { DetailPanel } from "./DetailPanel";
import { Time } from "./ui";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";
import { Select } from "../ui/Select";
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
  return <Badge tone={STATUS_BADGE[status] ?? "badge-neutral"}>{status.replace("_", " ")}</Badge>;
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

export function PipelineRuns({ project, refreshKey, openRun }: Props & { openRun: (id: string) => void }) {
  const [tick, setTick] = useState(0);
  const key = refreshKey + tick;
  const status = useApi<PipelinesStatus>("/pipelines/status", project, key);
  const runs = useApi<PipelineRun[]>("/pipelines/runs", project, key);
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
        <p className="muted small">
          No pipelines for this project. Add a <code>pipelines:</code> block to its YAML: Lair runs each job on the
          repository&apos;s CI runners first (GitHub Actions) and on this machine last.
        </p>
        {s.errors.map((e) => (
          <p key={e} className="error spaced-sm">
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
      setTick((t) => t + 1);
      openRun(run.id);
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
        <div className="row row-lg">
          <h3 className="m-0">Pipelines</h3>
          <span className="muted small">Order: {s.order.join(" → ")}</span>
          <span className="muted small">
            GitHub-hosted minutes this month: {s.minutes.usedThisMonth}
            {s.minutes.budget > 0 ? ` of ${s.minutes.budget}` : ""}
          </span>
          <Button size="sm" onClick={() => setShowWorkflow(true)}>
            Workflow file
          </Button>
        </div>

        {s.github.warnings.map((w) => (
          <p key={w} className="error spaced">
            {w}
          </p>
        ))}

        <table className="table spaced">
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
                <td className="muted small">
                  {e.reason ?? ""}
                  {e.unavailableUntil ? ` (until ${time(e.unavailableUntil)})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small mt-2">
          GitHub: {s.github.repo ?? "no repository"} · token {s.github.tokenEnv}{" "}
          {s.github.tokenSet ? "set" : "not set"}
          {s.github.visibility ? ` · ${s.github.visibility}` : ""}
          {s.github.runners.length > 0
            ? ` · runners: ${s.github.runners.map((r) => `${r.name} (${r.status}${r.busy ? ", busy" : ""})`).join(", ")}`
            : ""}
        </p>
        {s.decisions.length > 0 && (
          <div className="spaced-sm">
            {s.decisions.map((d) => (
              <p key={d.id} className="muted small">
                Needs a decision ({d.kind}): {d.question}
              </p>
            ))}
          </div>
        )}

        <div className="row mt-4">
          <Select value={chosen} onChange={(e) => setPipeline(e.target.value)} aria-label="Pipeline">
            {s.pipelines.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({p.lanes.map((l) => l.name).join(", ")})
              </option>
            ))}
          </Select>
          <input
            className="input"
            style={{ maxWidth: "16rem" }}
            placeholder="branch (default: HEAD)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
          <Button variant="primary" disabled={busy || s.readOnly || !chosen} onClick={start}>
            Run
          </Button>
          {s.readOnly && <span className="muted small">Read-only project: runs can't be started here</span>}
          {message && <span className="muted small">{message}</span>}
        </div>
      </div>

      <div className="card">
        <h3>Pipeline runs</h3>
        <DataTable
          label="Pipeline runs"
          columns={RUN_COLUMNS}
          rows={(runs.data ?? []).slice(0, 50)}
          rowKey={(run) => run.id}
          onOpen={(run) => openRun(run.id)}
          empty={<p className="muted small">No runs yet: start one above, or let a module start them.</p>}
        />
      </div>

      {showWorkflow && <WorkflowPanel project={project} refreshKey={key} onClose={() => setShowWorkflow(false)} />}
    </div>
  );
}

const RUN_COLUMNS: Column<PipelineRun>[] = [
  { key: "started", label: "Started", sort: (run) => run.createdAt, render: (run) => <Time iso={run.createdAt} /> },
  { key: "pipeline", label: "Pipeline", sort: (run) => run.pipeline, render: (run) => run.pipeline },
  { key: "commit", label: "Commit", render: (run) => <code>{run.commitSha.slice(0, 10)}</code> },
  { key: "status", label: "Status", sort: (run) => run.status, render: (run) => badge(run.status) },
  { key: "where", label: "Where", render: (run) => <span className="muted small">{whereOf(run)}</span> },
  {
    key: "minutes",
    label: "Minutes",
    align: "right",
    sort: (run) => run.minutes,
    render: (run) => `${run.minutes}${run.billedMinutes > 0 ? ` (${run.billedMinutes} billed)` : ""}`,
  },
];

function AttemptRow({ attempt }: { attempt: PipelineAttempt }) {
  return (
    <tr>
      <td>
        <code>{attempt.executor}</code>
      </td>
      <td>{badge(attempt.status)}</td>
      <td className="muted small">
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

/**
 * A pipeline run's jobs in the gate detail: where each lane's job went and
 * why (every executor tried, its fallback reason), its artifacts and
 * minutes, and Cancel while it runs (the owner's). Its steps are in the
 * gate detail; its log tail is the owner's (GET /api/dashboard/gates/:id/output).
 */
export function PipelineJobs({
  id,
  project,
  refreshKey,
  readOnly,
}: {
  id: string;
  project: string;
  refreshKey: number;
  readOnly: boolean;
}) {
  const [tick, setTick] = useState(0);
  const { data: run, error } = useApi<PipelineRun>(`/pipelines/runs/${encodeURIComponent(id)}`, project, refreshKey + tick);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = async () => {
    if (!window.confirm(`Cancel run ${id}? Jobs still running are stopped.`)) return;
    setCancelError(null);
    try {
      await unwrap(cancelPipelineRun<PipelineRun>(project, id));
      setTick((t) => t + 1);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error) return <div className="error">Could not load run {id}: {error}</div>;
  if (!run) return <p className="muted small">Loading the run's jobs…</p>;
  return (
    <>
      <p className="muted small">
        {run.minutes} CI minute(s){run.billedMinutes > 0 ? `, ${run.billedMinutes} billed` : ""}
      </p>
      {run.error && <p className="error">{run.error}</p>}
      {!run.completedAt && !readOnly && (
        <Button size="sm" variant="danger" onClick={() => void cancel()}>
          Cancel run
        </Button>
      )}
      {cancelError && <p className="error">{cancelError}</p>}
      {run.jobs.map((job) => (
        <div key={job.id} className="spaced-lg">
          <h4>
            Lane {job.lane} {badge(job.status)} <span className="muted small">{duration(job.minutes * 60_000)}</span>
          </h4>
          {job.waitReason && <p className="muted small">{job.waitReason}</p>}
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
            <p className="muted small">Artifacts: {job.artifacts.map((a) => `${a.name} (${a.sizeBytes} bytes)`).join(", ")}</p>
          )}
        </div>
      ))}
    </>
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
    <DetailPanel title="Workflow file" crumbs={[{ label: "Gates" }, { label: "Pipelines" }, { label: "Workflow file" }]} onClose={onClose}>
      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <ol className="muted small">
            {data.instructions.map((line) => (
              <li key={line} className="mb-2">
                {line}
              </li>
            ))}
          </ol>
          <p className="muted small">
            <code>{data.path}</code> · version {data.version}
          </p>
          <CodeBlock label="Workflow file" wrap={false}>
            {data.content}
          </CodeBlock>
        </>
      )}
    </DetailPanel>
  );
}
