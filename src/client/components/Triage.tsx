/**
 * Triage view - failure triage, bisect and revert: per gate failure the
 * verdict of each cause with its evidence, the actions taken and the retry
 * count; the default branch's incident with its bisect status. Configured in
 * the project YAML (triage:, see docs/configuration.md#triage).
 *
 * Revert and protect are the owner's: they send this browser's owner session
 * (sign in from the Decisions view) and ask for confirmation first; an
 * unproven suspect asks a second time.
 */
import { Fragment, useState } from "react";
import { useApi } from "../hooks/useApi";
import { ownerHeaders } from "../owner-session";
import type {
  Incident,
  Recheck,
  TriageAction,
  TriageClass,
  TriageProjectStatus,
  TriageRecord,
  TriageTask,
  FlakyTest,
} from "../../shared/triage-types";

interface Props {
  project: string;
  refreshKey: number;
}

const CLASS_BADGE: Record<TriageClass, string> = {
  code: "badge-error",
  infra: "badge-warning",
  flaky: "badge-neutral",
  "pre-existing": "badge-neutral",
};

const ACTION_BADGE: Record<string, string> = {
  done: "badge-success",
  recorded: "badge-neutral",
  planned: "badge-neutral",
  waiting: "badge-warning",
  failed: "badge-error",
  skipped: "badge-neutral",
};

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const button = {
  padding: "0.4rem 0.9rem",
  borderRadius: "4px",
  border: "none",
  background: "var(--primary)",
  color: "white",
  cursor: "pointer",
};

function time(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

/** An owner-only request: the owner session goes in its header, never a cookie. */
async function post(path: string, project: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(`/api${path}?project=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders() },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { success: boolean; error?: string };
    return data.success ? null : (data.error ?? "Request failed");
  } catch (e) {
    return e instanceof Error ? e.message : "Network error";
  }
}

function Actions({ actions }: { actions: TriageAction[] }) {
  if (actions.length === 0) return <p style={muted}>No actions.</p>;
  return (
    <table className="table">
      <tbody>
        {actions.map((a) => (
          <tr key={a.id}>
            <td style={{ whiteSpace: "nowrap" }}>{time(a.at)}</td>
            <td>{a.kind}</td>
            <td>
              <span className={`badge ${ACTION_BADGE[a.status] ?? "badge-neutral"}`}>{a.status}</span>
            </td>
            <td>
              {a.detail}
              {a.actor && <div style={muted}>by {a.actor}</div>}
              {a.argv && <div style={muted}><code>{a.argv.join(" ")}</code></div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FailureDetail({ id, project, refreshKey }: { id: string; project: string; refreshKey: number }) {
  const detail = useApi<{ record: TriageRecord; actions: TriageAction[]; rechecks: Recheck[] }>(
    `/triage/failures/${id}`,
    project,
    refreshKey,
  );
  if (!detail.data) return <p style={muted}>{detail.error ?? "Loading..."}</p>;
  const { record, actions, rechecks } = detail.data;
  return (
    <div style={{ padding: "0.5rem 0" }}>
      {record.resolution && <p style={muted}>{record.resolution}</p>}
      {record.causes.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className={`badge ${CLASS_BADGE[c.verdict.class]}`}>{c.verdict.class}</span>
            <code>{c.verdict.rule}</code>
            <span style={muted}>
              {c.cause.kind}
              {c.cause.step ? ` in ${c.cause.step}` : ""} · {c.cause.parser} · confidence {c.verdict.confidence}
              {c.cause.testCount > 0 ? ` · ${c.cause.testCount} test(s)` : ""}
            </span>
          </div>
          <p style={{ margin: "0.5rem 0" }}>
            {c.cause.type ? `${c.cause.type}: ` : ""}
            {c.cause.message}
          </p>
          {c.cause.causedBy.length > 0 && <p style={muted}>Root cause: {c.cause.rootCause}</p>}
          <ul style={{ margin: "0.25rem 0 0.5rem 1rem" }}>
            {c.verdict.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {c.cause.tests.length > 0 && (
            <p style={muted}>
              Tests: {c.cause.tests.slice(0, 8).map((t) => t.id).join(", ")}
              {c.cause.testCount > 8 ? ", ..." : ""}
            </p>
          )}
          <pre style={{ ...muted, whiteSpace: "pre-wrap", margin: 0 }}>{c.cause.evidence.join("\n")}</pre>
        </div>
      ))}
      {rechecks.length > 0 && (
        <p style={muted}>
          Re-checks:{" "}
          {rechecks.map((r) => `#${r.attempt} ${r.status}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}
        </p>
      )}
      <Actions actions={actions} />
    </div>
  );
}

function IncidentCard({ incident, project, onChange }: { incident: Incident; project: string; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const b = incident.bisect;
  const culprit = b.culprit;
  const act = async (path: string, body: unknown) => {
    setError(await post(path, project, body));
    onChange();
  };
  const revert = (sha: string) => {
    const proven = b.proven && sha === culprit;
    if (!window.confirm(`Open a revert of ${short(sha)} on ${incident.branch}? It goes through the gate and the merge policy.`)) return;
    if (
      !proven &&
      !window.confirm(`${short(sha)} is NOT proven to have broken ${incident.branch}. Revert it anyway, as your own decision?`)
    ) {
      return;
    }
    void act(`/triage/owner/incidents/${incident.id}/revert`, { sha, ...(proven ? {} : { acknowledgeUnproven: true }) });
  };
  const protect = (sha: string) => {
    if (!window.confirm(`Protect ${short(sha)}? Lair will never revert it automatically.`)) return;
    void act("/triage/owner/protected", { sha, note: "protected from the Triage view" });
  };
  return (
    <div className="card">
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>
          {incident.branch} {incident.status === "open" ? "is red" : "was red"}
        </h3>
        <span className={`badge ${incident.status === "open" ? "badge-error" : "badge-success"}`}>{incident.status}</span>
        <span style={muted}>
          red at {short(incident.redSha)} · last green {short(incident.lastGreenSha)} · opened {time(incident.openedAt)}
        </span>
      </div>
      <p style={{ margin: "0.5rem 0" }}>
        Bisect: <strong>{b.status}</strong> · {b.candidates.length} commit(s) · {b.detail}
      </p>
      {culprit && (
        <p>
          Culprit <code>{short(culprit)}</code> {b.proven ? "(proven)" : "(suspected, not proven)"} · revert:{" "}
          <strong>{incident.revert.status}</strong>
          {incident.revert.detail ? ` · ${incident.revert.detail}` : ""}
          {incident.revert.ref ? ` · ${incident.revert.ref}` : ""}
          {incident.revert.by ? ` · asked by ${incident.revert.by}` : ""}
        </p>
      )}
      {b.suspects && b.suspects.length > 1 && <p style={muted}>Suspects: {b.suspects.map(short).join(", ")}</p>}
      {b.probes.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Commit</th>
              <th>Probe</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {b.probes.map((p, i) => (
              <tr key={`${p.sha}-${i}`}>
                <td>
                  <code>{short(p.sha)}</code>
                </td>
                <td>{p.recheckId ? (p.confirm ? "confirmation" : "probe") : "red gate"}</td>
                <td>
                  {p.outcome}
                  {p.detail ? <span style={muted}> · {p.detail}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {incident.status === "open" && culprit && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          {incident.revert.status !== "opened" && incident.revert.status !== "opening" && (
            <button style={button} onClick={() => revert(culprit)}>
              Open revert of {short(culprit)}
              {b.proven ? "" : " (not proven)"}
            </button>
          )}
          {!incident.revert.protected && (
            <button style={button} onClick={() => protect(culprit)}>
              Protect {short(culprit)}
            </button>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function Triage({ project, refreshKey }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const key = refreshKey + bump;
  const status = useApi<TriageProjectStatus>("/triage/status", project, key);
  const failures = useApi<TriageRecord[]>("/triage/failures", project, key);
  const tasks = useApi<TriageTask[]>("/triage/tasks", project, key);
  const flaky = useApi<FlakyTest[]>("/triage/flaky", project, key);

  if (status.loading && !status.data) return <div className="loading">Loading triage...</div>;
  if (status.error && !status.data) return <div className="error">Error: {status.error}</div>;
  const s = status.data;
  if (!s) return null;

  if (!s.enabled) {
    return (
      <div>
        <h2 style={{ marginBottom: "1.5rem" }}>Triage</h2>
        <div className="card">
          <p>
            Triage is off for this project. Set <code>triage.enabled: true</code> in its YAML. It reads the results of
            your gate pipelines, and signed results from the nodes in <code>triage.trusted_nodes</code>. It starts in
            observe mode: it classifies and records, and runs none of your commands.
          </p>
          {s.errors.map((e) => (
            <p key={e} className="error" style={{ marginTop: "1rem" }}>
              {e}
            </p>
          ))}
        </div>
      </div>
    );
  }

  const acting = s.mode === "act" && !s.actBlocked;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <h2>Triage</h2>
        <span className={`badge ${acting ? "badge-warning" : "badge-neutral"}`}>{acting ? "Act" : "Observe"}</span>
        {s.actBlocked && s.mode === "act" && <span style={muted}>Not acting: {s.actBlocked}</span>}
        <span style={muted}>
          {s.counts.failures} failure(s), {s.counts.blocking} blocking · {s.pendingRechecks} re-check(s) pending ·{" "}
          {s.openTasks} open task(s) · {s.quarantined}/{s.quarantineCap ?? 0} quarantined
        </span>
      </div>

      {s.incident && <IncidentCard incident={s.incident} project={project} onChange={() => setBump((n) => n + 1)} />}

      <div className="card">
        <h3>Gate failures</h3>
        {(failures.data ?? []).length === 0 ? (
          <p style={muted}>No failed gate results yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Gate</th>
                <th>Commit</th>
                <th>Verdict</th>
                <th>Blocking</th>
                <th>Retries</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(failures.data ?? []).map((r) => (
                <Fragment key={r.id}>
                  <tr onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: "pointer" }}>
                    <td style={{ whiteSpace: "nowrap" }}>{time(r.receivedAt)}</td>
                    <td>
                      {r.gateId}
                      {r.purpose !== "gate" && <span style={muted}> ({r.purpose})</span>}
                    </td>
                    <td>
                      <code>{short(r.sha)}</code> <span style={muted}>{r.branch}</span>
                    </td>
                    <td>{r.verdict ? <span className={`badge ${CLASS_BADGE[r.verdict]}`}>{r.verdict}</span> : "—"}</td>
                    <td>{r.blocking ? "yes" : "no"}</td>
                    <td>{r.retries}</td>
                    <td style={muted}>{r.resolution ?? ""}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={7}>
                        <FailureDetail id={r.id} project={project} refreshKey={key} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(tasks.data ?? []).length > 0 && (
        <div className="card">
          <h3>Tasks</h3>
          <table className="table">
            <tbody>
              {(tasks.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{t.kind}</td>
                  <td>{t.title}</td>
                  <td>{t.status}</td>
                  <td style={muted}>{t.ref ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(flaky.data ?? []).length > 0 && (
        <div className="card">
          <h3>Flaky tests</h3>
          <table className="table">
            <tbody>
              {(flaky.data ?? []).map((f) => (
                <tr key={f.key}>
                  <td>
                    <code>{f.key}</code>
                  </td>
                  <td>{f.occurrences} time(s)</td>
                  <td>{f.quarantinedAt ? `quarantined ${time(f.quarantinedAt)}` : "watching"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
