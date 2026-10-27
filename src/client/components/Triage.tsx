/**
 * The Triage tab of Gates - failure triage, bisect and revert: the gate
 * failures (a row opens the gate's detail, with each cause's verdict, what
 * triage did, and for the owner the failing tests), the default branch's
 * incident with its bisect status, tasks and flaky tests. Configured in the
 * project YAML (triage:, see docs/configuration.md#triage).
 *
 * Revert and protect are the owner's: they send this browser's owner session
 * (sign in from the Decisions view) and ask for confirmation first; an
 * unproven suspect asks a second time.
 *
 * With triage.recheck.mode on, each failure also shows its re-check in the
 * project's gate system (would re-check, queued, passed, failed again,
 * expired, ...), and the flaky-test list is always shown.
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { ownerHeaders } from "../owner-session";
import { DataTable, type Column } from "./DataTable";
import { Time } from "./ui";
import type {
  GateRecheck,
  GateRecheckStatus,
  Incident,
  Recheck,
  TriageAction,
  TriageClass,
  TriageProjectStatus,
  TriageRecord,
  TriageTask,
  FlakyTest,
} from "../../shared/triage-types";

/** A gate system re-check's state, as the view names it */
const GATE_RECHECK_LABEL: Record<GateRecheckStatus, string> = {
  would: "would re-check",
  waiting: "waiting (cool-down)",
  running: "queuing",
  queued: "queued",
  not_queued: "not queued",
  refused: "not re-checked",
  passed: "passed",
  unproven: "unproven",
  failed_again: "failed again",
  failed_differently: "failed differently",
  expired: "expired",
};

const GATE_RECHECK_BADGE: Record<GateRecheckStatus, string> = {
  would: "badge-neutral",
  waiting: "badge-warning",
  running: "badge-warning",
  queued: "badge-warning",
  not_queued: "badge-error",
  refused: "badge-neutral",
  passed: "badge-success",
  unproven: "badge-error",
  failed_again: "badge-error",
  failed_differently: "badge-neutral",
  expired: "badge-error",
};

function GateRecheckBadge({ recheck }: { recheck: GateRecheck }) {
  return (
    <span className={`badge ${GATE_RECHECK_BADGE[recheck.status]}`} title={recheck.detail}>
      {GATE_RECHECK_LABEL[recheck.status]}
    </span>
  );
}

function GateRechecks({ rechecks }: { rechecks: GateRecheck[] }) {
  return (
    <table className="table">
      <tbody>
        {rechecks.map((r) => (
          <tr key={r.id}>
            <td style={{ whiteSpace: "nowrap" }}>{time(r.createdAt)}</td>
            <td>
              {r.gateId} <span style={muted}>#{r.attempt} {r.kind}</span>
            </td>
            <td>
              <GateRecheckBadge recheck={r} />
            </td>
            <td>
              {r.detail}
              {r.runId && <div style={muted}>its result: {r.runId}</div>}
              {r.passedTests.length > 0 && <div style={muted}>passed: {r.passedTests.join(", ")}</div>}
              {r.argv && (
                <div style={muted}>
                  <code>{r.argv.join(" ")}</code>
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

/**
 * What triage did about one failure, for the gate's detail: its resolution,
 * the re-checks it asked for (and those in the project's gate system), and
 * its actions. The causes and their verdicts are in the gate detail itself;
 * the failing tests and log lines are the owner's (GET
 * /api/dashboard/gates/:id/output).
 */
export function TriageRecordDetail({ id, project, refreshKey }: { id: string; project: string; refreshKey: number }) {
  const detail = useApi<{ record: TriageRecord; actions: TriageAction[]; rechecks: Recheck[]; gateRechecks?: GateRecheck[] }>(
    `/triage/failures/${encodeURIComponent(id)}`,
    project,
    refreshKey,
  );
  if (!detail.data) return <p style={muted}>{detail.error ?? "Loading..."}</p>;
  const { record, actions, rechecks } = detail.data;
  const gateRechecks = detail.data.gateRechecks ?? [];
  return (
    <div>
      {record.resolution && <p style={muted}>{record.resolution}</p>}
      <p style={muted}>
        Retries: {record.retries}
        {rechecks.length > 0 &&
          ` · re-checks: ${rechecks.map((r) => `#${r.attempt} ${r.status}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}`}
      </p>
      {gateRechecks.length > 0 && (
        <>
          <p style={muted}>Re-checks in the gate system:</p>
          <GateRechecks rechecks={gateRechecks} />
        </>
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

/** The failures table's columns; with gate system re-checks on, each failure's newest one too. */
function failureColumns(withRecheck: boolean, latest: ReadonlyMap<string, GateRecheck>): Column<TriageRecord>[] {
  return [
    { key: "received", label: "Received", sort: (r) => r.receivedAt, render: (r) => <Time iso={r.receivedAt} /> },
    {
      key: "gate",
      label: "Gate",
      sort: (r) => r.gateId,
      render: (r) => (
        <>
          {r.gateId}
          {r.purpose !== "gate" && <span style={muted}> ({r.purpose})</span>}
        </>
      ),
    },
    {
      key: "commit",
      label: "Commit",
      render: (r) => (
        <>
          <code>{short(r.sha)}</code> <span style={muted}>{r.branch}</span>
        </>
      ),
    },
    {
      key: "verdict",
      label: "Verdict",
      sort: (r) => r.verdict,
      render: (r) => (r.verdict ? <span className={`badge ${CLASS_BADGE[r.verdict]}`}>{r.verdict}</span> : "—"),
    },
    { key: "blocking", label: "Blocking", sort: (r) => r.blocking, render: (r) => (r.blocking ? "yes" : "no") },
    { key: "retries", label: "Retries", align: "right", sort: (r) => r.retries, render: (r) => r.retries },
    ...(withRecheck
      ? [
          {
            key: "recheck",
            label: "Re-check",
            render: (r: TriageRecord) => {
              const recheck = latest.get(r.id);
              return recheck ? <GateRecheckBadge recheck={recheck} /> : "—";
            },
          },
        ]
      : []),
    { key: "status", label: "Status", render: (r) => <span style={muted}>{r.resolution ?? ""}</span> },
  ];
}

export function Triage({ project, refreshKey, openGate }: Props & { openGate: (gateId: string) => void }) {
  const [bump, setBump] = useState(0);
  const key = refreshKey + bump;
  const status = useApi<TriageProjectStatus>("/triage/status", project, key);
  const failures = useApi<TriageRecord[]>("/triage/failures", project, key);
  const tasks = useApi<TriageTask[]>("/triage/tasks", project, key);
  const flaky = useApi<FlakyTest[]>("/triage/flaky", project, key);
  const gateRechecks = useApi<GateRecheck[]>("/triage/gate-rechecks", project, key);

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
  const gate = s.gateRecheck && s.gateRecheck.mode !== "off" ? s.gateRecheck : null;
  // The newest gate system re-check of each failure (the list is newest first)
  const latestRecheck = new Map<string, GateRecheck>();
  for (const r of gateRechecks.data ?? []) if (!latestRecheck.has(r.recordId)) latestRecheck.set(r.recordId, r);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
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
        <DataTable
          label="Gate failures"
          columns={failureColumns(gate !== null, latestRecheck)}
          rows={failures.data ?? []}
          rowKey={(r) => r.id}
          onOpen={(r) => openGate(r.gateId)}
          empty={<p style={muted}>No failed gate results yet: triage lists them as the results come in.</p>}
        />
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

      {gate && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>Re-checks in the gate system</h3>
            <span className={`badge ${gate.blocked ? "badge-neutral" : "badge-warning"}`}>{gate.blocked ? "Observe" : "Act"}</span>
            <span style={muted}>
              {gate.pending} pending{gate.blocked ? ` · not run: ${gate.blocked}` : ""}
            </span>
          </div>
          {(gateRechecks.data ?? []).length === 0 ? (
            <p style={muted}>No re-checks yet: infra, timeout and flaky failures are re-checked; real failures never are.</p>
          ) : (
            <GateRechecks rechecks={gateRechecks.data ?? []} />
          )}
        </div>
      )}

      {gate && (flaky.data ?? []).length === 0 && (
        <div className="card">
          <h3>Flaky tests</h3>
          <p style={muted}>None yet. A test that timed out and passed on a quiet re-check is listed here.</p>
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
