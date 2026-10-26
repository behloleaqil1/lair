/**
 * Agents view - the agents module (agents: in the project YAML, see
 * docs/configuration.md#agents): per agent its state, current run, claims,
 * budget and recent recoveries; the launch locks and their holders. Releasing
 * a claim and starting a fresh session ask for confirmation first.
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { freshSessionAction, postJson, releaseClaimAction, runConfirmed, type ConfirmableAction } from "../agents-actions";
import type {
  AgentEventView,
  AgentState,
  AgentsStatusView,
  AgentView,
  BudgetScopeView,
  ClaimView,
} from "../../shared/agents-types";

interface Props {
  project: string;
  refreshKey: number;
}

const STATE_BADGE: Record<AgentState, string> = {
  idle: "badge-neutral",
  starting: "badge-neutral",
  working: "badge-success",
  waiting_on_lock: "badge-warning",
  hung: "badge-error",
  stopping: "badge-warning",
  never_started: "badge-error",
  failed_over: "badge-warning",
  over_budget: "badge-error",
  failed: "badge-error",
};

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const actionButton = {
  padding: "0.2rem 0.5rem",
  borderRadius: "4px",
  border: "1px solid var(--warning)",
  background: "transparent",
  color: "var(--warning)",
  cursor: "pointer",
  fontSize: "0.8rem",
};

function time(iso: string | undefined | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function label(state: string): string {
  return state.replace(/_/g, " ");
}

function BudgetLines({ budget }: { budget: BudgetScopeView | null }) {
  if (!budget || budget.lines.length === 0) return <span style={muted}>no limits</span>;
  return (
    <ul style={{ ...muted, margin: 0, paddingLeft: "1rem" }}>
      {budget.lines.map((line) => (
        <li key={line.metric}>
          <span className={`badge ${line.level === "hard" ? "badge-error" : line.level === "soft" ? "badge-warning" : "badge-neutral"}`}>
            {line.level}
          </span>{" "}
          {label(line.metric)} {line.period}: {line.used}
          {line.soft !== undefined && ` / soft ${line.soft}`}
          {line.hard !== undefined && ` / hard ${line.hard}`}
        </li>
      ))}
    </ul>
  );
}

function Recoveries({ events }: { events: AgentEventView[] }) {
  if (events.length === 0) return <span style={muted}>none</span>;
  return (
    <ul style={{ ...muted, margin: 0, paddingLeft: "1rem" }}>
      {events.slice(0, 5).map((e) => (
        <li key={e.id} title={e.evidence.join("\n")}>
          {time(e.at)} <code>{e.kind}</code> {e.summary}
        </li>
      ))}
    </ul>
  );
}

export function Agents({ project, refreshKey }: Props) {
  const [bump, setBump] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const status = useApi<AgentsStatusView>("/agents/status", project, refreshKey + bump);

  if (status.loading && !status.data) return <div className="loading">Loading agents...</div>;
  if (status.error && !status.data) return <div className="error">Error: {status.error}</div>;
  const s = status.data;
  if (!s) return null;

  if (!s.enabled) {
    return (
      <div>
        <h2 style={{ marginBottom: "1.5rem" }}>Agents</h2>
        <div className="card">
          <p>
            The agents module is off for this project. Set <code>agents.enabled: true</code> in its YAML to let
            Lair start agent runs with pid-owned claims and locks, session recovery, failover and budgets.
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

  const act = async (action: ConfirmableAction) => {
    const result = await runConfirmed(action, (q) => window.confirm(q), postJson);
    if (!result.sent) return;
    setMessage(result.ok ? "Done. The next check carries it out." : `Failed: ${result.error}`);
    setBump((n) => n + 1);
  };

  const claimRow = (claim: ClaimView, agent: AgentView | undefined) => (
    <li key={claim.task}>
      <code>{claim.task}</code> run {claim.runId.slice(0, 8)}, owner pid {claim.ownerPid}{" "}
      {claim.ownerAlive === null ? "" : claim.ownerAlive ? "(alive)" : "(dead)"}{" "}
      {!s.readOnly && (
        <button style={actionButton} onClick={() => act(releaseClaimAction(project, claim.task, agent?.id ?? claim.agent))}>
          Release
        </button>
      )}
    </li>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h2>Agents</h2>
        {s.readOnly && <span className="badge badge-neutral">read_only: nothing is started or stopped</span>}
        <span style={muted}>Last check: {time(s.lastTick?.at)}</span>
      </div>
      {!s.readOnly && (
        <p style={{ ...muted, marginBottom: "1rem" }}>
          Releasing a claim and starting a fresh session are the owner&apos;s: this browser must be signed in as the
          owner (from the Decisions view).
        </p>
      )}

      {s.lastError && <div className="error">Last check failed: {s.lastError}</div>}
      {s.errors.map((e) => (
        <div key={e} className="error">
          {e}
        </div>
      ))}
      {message && (
        <div className="card" style={muted}>
          {message}
        </div>
      )}

      <div className="card">
        <h3>Agents</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>State</th>
              <th>Run</th>
              <th>Claims</th>
              <th>Budget</th>
              <th>Recent recoveries</th>
            </tr>
          </thead>
          <tbody>
            {s.agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <code>{agent.id}</code>
                  <div style={muted}>{agent.profiles.map((p) => `${p.adapter}${p.model ? `/${p.model}` : ""}`).join(" → ")}</div>
                </td>
                <td>
                  <span className={`badge ${STATE_BADGE[agent.state] ?? "badge-neutral"}`}>{label(agent.state)}</span>
                  <div style={muted}>{agent.detail}</div>
                  {agent.run?.waitingLock && (
                    <div style={muted}>
                      lock {agent.run.waitingLock.lock}: holder pid {agent.run.waitingLock.holderPid ?? "none"} (
                      {agent.run.waitingLock.holderAlive ? "alive" : "not alive"})
                    </div>
                  )}
                </td>
                <td>
                  {agent.run ? (
                    <>
                      <code>{agent.run.task}</code>
                      <div style={muted}>
                        attempt {agent.run.attempt}, {agent.run.sessionMode} session {agent.run.sessionId.slice(0, 8)}
                        {agent.run.pid !== undefined && `, pid ${agent.run.pid}`}
                      </div>
                      {!s.readOnly && agent.run.state !== "completed" && agent.run.state !== "stopping" && (
                        <button
                          style={actionButton}
                          onClick={() =>
                            agent.run && act(freshSessionAction(project, agent.run.id, agent.id, agent.run.task))
                          }
                        >
                          Fresh session
                        </button>
                      )}
                    </>
                  ) : (
                    <span style={muted}>—</span>
                  )}
                </td>
                <td>
                  {agent.claims.length === 0 ? (
                    <span style={muted}>none</span>
                  ) : (
                    <ul style={{ ...muted, margin: 0, paddingLeft: "1rem" }}>
                      {agent.claims.map((claim) => claimRow(claim, agent))}
                    </ul>
                  )}
                </td>
                <td>
                  <BudgetLines budget={agent.budget} />
                </td>
                <td>
                  <Recoveries events={agent.recoveries} />
                </td>
              </tr>
            ))}
            {s.agents.length === 0 && (
              <tr>
                <td colSpan={6} style={muted}>
                  No agents: add them under dragons: or to dragons.txt
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Locks</h3>
        {s.locks.length === 0 ? (
          <p style={muted}>No agents.locks configured</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Lock</th>
                <th>Holder</th>
                <th>Broken</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {s.locks.map((lock) => (
                <tr key={lock.name}>
                  <td>
                    <code>{lock.name}</code>
                    <div style={muted}>
                      {lock.path} (hold: {lock.hold})
                    </div>
                  </td>
                  <td>
                    {!lock.exists
                      ? "free"
                      : lock.holderPid === null
                        ? "no pid"
                        : `pid ${lock.holderPid} ${lock.holderAlive === null ? "" : lock.holderAlive ? "(alive)" : "(dead)"}`}
                  </td>
                  <td>{lock.breaks}</td>
                  <td style={muted}>{lock.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Project budget</h3>
        <BudgetLines budget={s.projectBudget} />
      </div>
    </div>
  );
}
