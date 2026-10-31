/**
 * Home → Health: Lair's own self-checks (the failing and warning ones with
 * their fix; SelfChecks.tsx, the owner's), then the progress watchdog: SLO
 * status per detector, breaches and playbook runs. Read-only; the watchdog
 * is configured in the project YAML (watchdog:, see
 * docs/configuration.md#watchdog), the self-checks in its supervisor: block.
 */
import { useApi } from "../hooks/useApi";
import { SelfChecks } from "./SelfChecks";
import { Badge } from "../ui/Badge";

interface Props {
  project: string;
  refreshKey: number;
}

type SloState = "ok" | "breached" | "inactive" | "error";

interface SloStatus {
  detector: string;
  state: SloState;
  openBreaches: number;
  detail: string;
  checkedAt: string;
}

interface WatchdogStatus {
  enabled: boolean;
  mode: "observe" | "act" | null;
  actBlocked: string | null;
  errors: string[];
  lastTick: { at: string } | null;
  lastError: string | null;
  slos: SloStatus[];
  playbooks: { id: string; detector: string; act: boolean; actionConfigured: boolean }[];
}

interface Breach {
  id: string;
  detector: string;
  summary: string;
  evidence: string[];
  status: "open" | "resolved";
  detectedAt: string;
  resolvedAt?: string;
  resolution?: string;
  escalatedAt?: string;
}

interface StepResult {
  type: string;
  status: string;
  error?: string;
  command?: { argv: string[]; code: number };
  plannedArgv?: string[];
}

interface PlaybookRun {
  id: string;
  playbookId: string;
  mode: "act" | "observe";
  status: string;
  outcome?: string;
  attempt: number;
  startedAt: string;
  steps: StepResult[];
  error?: string;
}

const STATE_BADGE: Record<SloState, string> = {
  ok: "badge-success",
  breached: "badge-error",
  inactive: "badge-neutral",
  error: "badge-warning",
};

const OUTCOME_BADGE: Record<string, string> = {
  recovered: "badge-success",
  cleared: "badge-success",
  acted: "badge-warning",
  failed: "badge-error",
  observed: "badge-neutral",
};

function time(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** The argv a run's act step ran, or would have run in observe mode. */
function commandOf(run: PlaybookRun): string {
  const act = run.steps.find((s) => s.type === "act");
  const argv = act?.command?.argv ?? act?.plannedArgv;
  return argv ? argv.join(" ") : "—";
}

export function Health({ project, refreshKey }: Props) {
  return (
    <div>
      <SelfChecks project={project} refreshKey={refreshKey} />
      <BusConsumerHealth project={project} refreshKey={refreshKey} />
      <WatchdogHealth project={project} refreshKey={refreshKey} />
    </div>
  );
}

function WatchdogHealth({ project, refreshKey }: Props) {
  const status = useApi<WatchdogStatus>("/watchdog/status", project, refreshKey);
  const breaches = useApi<Breach[]>("/watchdog/breaches", project, refreshKey);
  const runs = useApi<PlaybookRun[]>("/watchdog/runs", project, refreshKey);

  if (status.loading && !status.data) return <div className="loading">Loading health...</div>;
  if (status.error && !status.data) return <div className="error">Error: {status.error}</div>;
  const s = status.data;
  if (!s) return null;

  if (!s.enabled) {
    return (
      <div>
        <h2 className="mb-6">Watchdog</h2>
        <div className="card">
          <p>
            The watchdog is off for this project. Set <code>watchdog.enabled: true</code> in its YAML;
            it starts in observe mode, which only detects and escalates.
          </p>
          {s.errors.map((e) => (
            <p key={e} className="error spaced-lg">
              {e}
            </p>
          ))}
        </div>
      </div>
    );
  }

  const open = (breaches.data ?? []).filter((b) => b.status === "open");
  const resolved = (breaches.data ?? []).filter((b) => b.status === "resolved").slice(0, 10);
  const acting = s.mode === "act" && !s.actBlocked;

  return (
    <div>
      <div className="section-head">
        <h2>Watchdog</h2>
        <span className={`badge ${acting ? "badge-warning" : "badge-neutral"}`}>
          {acting ? "Act" : "Observe"}
        </span>
        {s.actBlocked && s.mode === "act" && <span className="muted small">Not acting: {s.actBlocked}</span>}
        <span className="muted small">Last check: {time(s.lastTick?.at)}</span>
      </div>

      {s.lastError && <div className="error">Last tick failed: {s.lastError}</div>}

      <div className="card">
        <h3>SLOs</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Detector</th>
              <th>State</th>
              <th>Open</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {s.slos.map((slo) => (
              <tr key={slo.detector}>
                <td>
                  <code>{slo.detector}</code>
                </td>
                <td>
                  <Badge tone={STATE_BADGE[slo.state] ?? "badge-neutral"}>{slo.state}</Badge>
                </td>
                <td>{slo.openBreaches}</td>
                <td className="muted small">{slo.detail}</td>
              </tr>
            ))}
            {s.slos.length === 0 && (
              <tr>
                <td colSpan={4} className="muted small">
                  No check has run yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Open breaches ({open.length})</h3>
        {open.length === 0 ? (
          <p className="muted small">None</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Detected</th>
                <th>Detector</th>
                <th>Breach</th>
                <th>Escalated</th>
              </tr>
            </thead>
            <tbody>
              {open.map((b) => (
                <tr key={b.id}>
                  <td className="muted small">{time(b.detectedAt)}</td>
                  <td>
                    <code>{b.detector}</code>
                  </td>
                  <td>
                    {b.summary}
                    <ul className="muted small sub-list">
                      {b.evidence.slice(0, 4).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="muted small">{b.escalatedAt ? time(b.escalatedAt) : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Playbook runs</h3>
        {(runs.data ?? []).length === 0 ? (
          <p className="muted small">None</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Playbook</th>
                <th>Outcome</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).slice(0, 25).map((run) => (
                <tr key={run.id}>
                  <td className="muted small">{time(run.startedAt)}</td>
                  <td>
                    <code>{run.playbookId}</code>
                    {run.mode === "act" && <span className="muted small"> #{run.attempt}</span>}
                  </td>
                  <td>
                    <span className={`badge ${OUTCOME_BADGE[run.outcome ?? run.status] ?? "badge-neutral"}`}>
                      {run.outcome ?? run.status}
                    </span>
                    {run.error && <div className="muted small">{run.error}</div>}
                  </td>
                  <td>
                    <code className="small">{commandOf(run)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {resolved.length > 0 && (
        <div className="card">
          <h3>Recently resolved</h3>
          <table className="table">
            <tbody>
              {resolved.map((b) => (
                <tr key={b.id}>
                  <td className="muted small">{time(b.resolvedAt)}</td>
                  <td>
                    <code>{b.detector}</code>
                  </td>
                  <td>{b.summary}</td>
                  <td className="muted small">{b.resolution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============ Bus Consumer Health (bus PR 2a) ============

interface BusConsumerHealthStatus {
  mode: "off" | "observe" | "on";
  observations: number;
  matches: number;
  mismatches: number;
  pending: number;
}

function BusConsumerHealth({ project, refreshKey }: Props) {
  const status = useApi<BusConsumerHealthStatus>("/bus/health", project, refreshKey);

  if (status.loading && !status.data) return null; // Show nothing while loading
  if (status.error && !status.data) return null; // Hide on error (bus may not be configured)
  const s = status.data;
  if (!s || s.mode === "off") return null; // Nothing to show when off

  return (
    <div>
      <div className="section-head">
        <h2>Bus Consumer</h2>
        <span className={`badge ${s.mode === "on" ? "badge-success" : "badge-neutral"}`}>
          {s.mode}
        </span>
      </div>

      {s.mode === "observe" && s.observations > 0 && (
        <div className="card">
          <h3>Observe mode comparison</h3>
          <p className="muted small">
            Comparing what bus events would do vs what the file reader does.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Observations</th>
                <th>Matches</th>
                <th>Mismatches</th>
                <th>Pending</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{s.observations}</td>
                <td>
                  <span className={`badge ${s.matches > 0 ? "badge-success" : "badge-neutral"}`}>
                    {s.matches}
                  </span>
                </td>
                <td>
                  <span className={`badge ${s.mismatches > 0 ? "badge-error" : "badge-neutral"}`}>
                    {s.mismatches}
                  </span>
                </td>
                <td>
                  <span className={`badge badge-neutral`}>{s.pending}</span>
                </td>
              </tr>
            </tbody>
          </table>
          {s.mismatches > 0 && (
            <p className="warning spaced-lg">
              {s.mismatches} mismatch(es) detected. Check the event vs file reader actions before enabling.
            </p>
          )}
        </div>
      )}

      {s.mode === "on" && (
        <div className="card">
          <p className="muted small">
            Bus events drive state changes. Mirrored lines are skipped.
          </p>
        </div>
      )}
    </div>
  );
}
