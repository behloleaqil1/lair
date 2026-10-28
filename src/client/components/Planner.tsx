/**
 * Planner view - how Lair keeps the tasks file (docs/design/planner.md):
 * its sources and how they parsed, open tasks, the planner agent and its
 * next run, proposals waiting for the owner (approve or reject, each with a
 * confirmation), recent runs, and the history of changes with their diffs.
 * It shows plan text, so it needs this browser signed in as the owner (from
 * the Decisions view). Configured in the project YAML (planner:, see
 * docs/configuration.md#planner).
 */
import { useEffect, useState } from "react";
import type { ChangeView, PlannerOverviewView, PlannerRunView, ProposalView } from "../../shared/planner-types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import {
  checkNowAction,
  getHistory,
  getOverview,
  getProposals,
  getRuns,
  proposalAction,
  resumeAction,
  runAction,
  send,
  type PlannerAction,
} from "../planner-api";

interface Props {
  project: string;
  refreshKey: number;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-warning",
  applied: "badge-success",
  planned: "badge-neutral",
  rejected: "badge-error",
  declined: "badge-neutral",
  failed: "badge-error",
  done: "badge-success",
  running: "badge-warning",
};

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

interface Data {
  overview: PlannerOverviewView;
  pending: ProposalView[];
  recent: ProposalView[];
  runs: PlannerRunView[];
  history: ChangeView[];
}

export function Planner({ project, refreshKey }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (!project) return;
    let live = true;
    Promise.all([getOverview(project), getProposals(project, "pending"), getProposals(project), getRuns(project), getHistory(project)])
      .then(([overview, pending, recent, runs, history]) => {
        if (!live) return;
        setData({ overview, pending, recent: recent.filter((p) => p.status !== "pending").slice(0, 50), runs, history });
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [project, refreshKey, bump]);

  const act = async (action: PlannerAction) => {
    if (!window.confirm(action.question)) return;
    const failed = await send(action);
    setNotice(failed ? `Refused: ${failed}` : "Done.");
    setBump((n) => n + 1);
  };

  const checkNow = async () => {
    const failed = await send(checkNowAction(project));
    setNotice(failed ? `Refused: ${failed}` : "Checked.");
    setBump((n) => n + 1);
  };

  if (error) {
    return (
      <div className="card">
        <h2>Planner</h2>
        <p>{error}</p>
        <p className="muted small">The Planner view shows plan text, so it needs this browser signed in as the owner (Decisions view).</p>
      </div>
    );
  }
  if (!data) return <div className="loading">Loading the planner...</div>;
  const { overview: o, pending, recent, runs, history } = data;

  return (
    <div>
      <div className="card">
        <h2>Planner</h2>
        <p>
          <Badge tone={o.mode === "act" ? "badge-warning" : "badge-neutral"}>{o.mode}</Badge>{" "}
          {o.running ? "running" : "stopped"} · last cycle {time(o.lastCycle)}
          {o.paused && <> · <strong>planner runs paused</strong>{o.pausedReason ? `: ${o.pausedReason}` : ""}</>}
        </p>
        {o.lastError && <p className="error">Last error: {o.lastError}</p>}
        {o.errors.map((e) => (
          <p key={e} className="error">{e}</p>
        ))}
        {o.warnings.map((w) => (
          <p key={w} className="muted small">Warning: {w}</p>
        ))}
        <p className="muted small">Tasks file: <code>{o.tasksFile}</code> · allowlist: {o.allowlist.join(", ") || "none"} · idle: {o.idleAgents.join(", ") || "none"}</p>
        {o.agent ? (
          <p className="muted small">
            Planner agent <code>{o.agent.id}</code> (prompt <code>{o.agent.promptFile}</code>, at most {o.agent.maxProposals} proposals,
            every {o.agent.minIntervalSeconds} s at most, {o.agent.runsInDay} of {o.agent.maxRunsPerDay} runs in the last 24 h) · next
            run: {o.agent.nextRunAt ? time(o.agent.nextRunAt) : "no trigger pending"}
            {o.activeRun && <> · running since {time(o.activeRun.requestedAt)}</>}
          </p>
        ) : (
          <p className="muted small">No planner agent: only the rules run.</p>
        )}
        <Button size="sm" variant="primary" onClick={checkNow}>Check now</Button>
        {o.paused && <Button size="sm" variant="primary" onClick={() => act(resumeAction(project))}>Resume planner runs</Button>}
        {notice && <span className="muted small">{notice}</span>}
      </div>

      <div className="card">
        <h3>Waiting for you ({pending.length})</h3>
        {pending.length === 0 ? (
          <p className="muted small">No proposal waits.</p>
        ) : (
          <table className="table">
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.op}</code></td>
                  <td><code>{p.task}</code>{p.agent && <> → {p.agent}</>}</td>
                  <td>{p.text && <div>“{p.text}”</div>}<div className="muted small">{p.reason}</div></td>
                  <td className="nowrap">
                    <Button size="sm" variant="primary" onClick={() => act(proposalAction(project, p, "approve"))}>Approve</Button>
                    <Button size="sm" onClick={() => act(proposalAction(project, p, "reject"))}>Reject</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Sources</h3>
        <table className="table">
          <tbody>
            {o.sources.map((s) => (
              <tr key={s.name}>
                <td><code>{s.name}</code> <span className="muted small">{s.kind}</span></td>
                <td><Badge tone={s.ok ? "badge-success" : "badge-error"}>{s.ok ? "ok" : "error"}</Badge></td>
                <td>
                  {s.kind === "markdown_plan" || s.kind === "backlog_file"
                    ? `${s.tasks} tasks: ${s.open} open, ${s.done} done, ${s.withoutId} without an id, ${s.duplicates} duplicate ids`
                    : `${s.items} item(s)`}
                  {s.files.map((f) => (
                    <div key={f.path} className="muted small">
                      <code>{f.path}</code> {f.ok ? `${f.bytes} bytes, ${f.lines} lines${f.truncated ? " (cut)" : ""}` : f.error}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Tasks file ({o.lines.length} open, {o.doneTasks.length} done)</h3>
        <table className="table">
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.task}>
                <td>{l.line}</td>
                <td>{l.agent}</td>
                <td><code>{l.task}</code></td>
                <td className="muted small">{l.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {o.malformed.map((m) => (
          <p key={m.line} className="error">Line {m.line}: {m.reason}</p>
        ))}
      </div>

      {(o.triggers.length > 0 || o.blocked.length > 0) && (
        <div className="card">
          <h3>Triggers and blocked tasks</h3>
          {o.triggers.map((t, i) => (
            <p key={`t${i}`} className="muted small"><code>{t.kind}</code> {t.agent ?? ""} {t.task ?? ""}: {t.detail}</p>
          ))}
          {o.blocked.map((b) => (
            <p key={b.task}>
              <code>{b.task}</code> ({b.agent ?? "?"}): <Badge tone="neutral">{b.class}</Badge> {b.reason}
              <span className="muted small"> · {b.route} · attempts {b.attempts}</span>
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Open plan tasks ({o.openTasks.length})</h3>
        <table className="table">
          <tbody>
            {o.openTasks.slice(0, 100).map((t) => (
              <tr key={`${t.file}:${t.line}`}>
                <td>{t.id ? <code>{t.id}</code> : <span className="muted small">line {t.line}</span>}</td>
                <td>{t.ready ? <Badge tone="success">ready</Badge> : <span className="muted small">waits on {t.waitingOn.join(", ")}</span>}</td>
                <td>{t.text}<div className="muted small">{t.section}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Planner runs</h3>
        <table className="table">
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{time(r.requestedAt)}</td>
                <td><Badge tone={STATUS_BADGE[r.state] ?? "badge-neutral"}>{r.state}</Badge></td>
                <td>
                  {r.triggers.map((t) => t.kind).join(", ") || "—"}
                  <div className="muted small">{r.detail}</div>
                </td>
                <td className="nowrap">
                  {r.pending > 0 && (
                    <>
                      <Button size="sm" variant="primary" onClick={() => act(runAction(project, r.id, r.pending, "approve"))}>Approve all</Button>
                      <Button size="sm" onClick={() => act(runAction(project, r.id, r.pending, "reject"))}>Reject all</Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length > 0 && (
          <>
            <h4>Decided proposals</h4>
            {recent.map((p) => (
              <p key={p.id} className="muted small">
                <Badge tone={STATUS_BADGE[p.status] ?? "badge-neutral"}>{p.status}</Badge> {p.op} {p.task}
                {p.refusal ? `: ${p.refusal}` : ""}
              </p>
            ))}
          </>
        )}
      </div>

      <div className="card">
        <h3>History</h3>
        {history.length === 0 && <p className="muted small">No change yet.</p>}
        {history.map((c) => (
          <div key={c.id} className="mb-3">
            <div>
              <Badge tone={STATUS_BADGE[c.outcome] ?? "badge-neutral"}>{c.outcome}</Badge> <code>{c.op}</code> {c.task ?? ""}{" "}
              <span className="muted small">· {c.source} · {time(c.at)}</span>
            </div>
            <div className="muted small">{c.reason}</div>
            {c.diff.length > 0 && <pre className="code-block">{c.diff.join("\n")}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
