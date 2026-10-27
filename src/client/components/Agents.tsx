/**
 * Agents view - the agents module (agents: in the project YAML, see
 * docs/configuration.md#agents): per agent its state, current run, claims,
 * budget and recent recoveries; the launch locks and their holders. The
 * owner starts a run from the "Start a run" form (agent, task, model, prompt,
 * optionally loaded from a file in prompts_dir). Starting a run, releasing a
 * claim and starting a fresh session ask for confirmation first.
 */
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import {
  failureMessage,
  freshSessionAction,
  listPrompts,
  loadPrompt,
  modelsOf,
  postJson,
  releaseClaimAction,
  runConfirmed,
  startRunAction,
  type ConfirmableAction,
} from "../agents-actions";
import { SignInHint } from "./SignInHint";
import type {
  AgentEventView,
  AgentState,
  AgentsStatusView,
  AgentView,
  BudgetScopeView,
  ClaimView,
  PromptFileView,
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

const field = {
  padding: "0.4rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text)",
};
const fieldLabel = { display: "flex", flexDirection: "column" as const, gap: "0.25rem", ...muted };

/**
 * Start a run (POST /api/agents/runs, owner only): the task is claimed when
 * the request is accepted, and the run starts on the next check. Disabled
 * until this browser is known to be signed in as the owner.
 */
function StartRunForm({
  project,
  agents,
  refreshKey,
  onStarted,
}: {
  project: string;
  agents: AgentView[];
  refreshKey: number;
  onStarted: () => void;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [agentId, setAgentId] = useState("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<PromptFileView[]>([]);
  const [file, setFile] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // The prompt files are the owner's to read: list them only once signed in
  useEffect(() => {
    if (signedIn !== true) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listPrompts(project)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((e) => {
        if (!cancelled) setFileError(`Could not list the prompt files: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project, signedIn, refreshKey]);

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const models = agent ? modelsOf(agent) : [];
  // A model chosen for another agent is not this one's: the default applies
  const chosenModel = models.includes(model) ? model : "";
  const disabled = signedIn !== true || busy;
  const ready = !!agent && task.trim().length > 0 && prompt.trim().length > 0;

  const load = async (name: string) => {
    setFile(name);
    setFileError(null);
    if (!name) return;
    if (prompt.trim() && !window.confirm(`Replace the prompt you typed with ${name}?`)) return;
    try {
      const loaded = await loadPrompt(project, name);
      setPrompt(loaded.text);
    } catch (e) {
      setFileError(`Could not load ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const start = async () => {
    if (!agent || !ready) return;
    setBusy(true);
    setResult(null);
    try {
      const action = startRunAction(project, { agent: agent.id, task, prompt, model: chosenModel });
      const sent = await runConfirmed(action, (q) => window.confirm(q), postJson);
      if (!sent.sent) return;
      if (sent.ok) {
        setResult({ ok: true, text: `Run queued: ${agent.id} on ${task.trim()} starts on the next check.` });
        setTask("");
        setPrompt("");
        setFile("");
        onStarted();
      } else {
        setResult({ ok: false, text: failureMessage(sent) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-form="start-run">
      <h3>Start a run</h3>
      <SignInHint what="Starting a run" refreshKey={refreshKey} onStatus={setSignedIn} />
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <label style={fieldLabel}>
          Agent
          <select
            style={field}
            value={agent?.id ?? ""}
            disabled={disabled}
            onChange={(e) => {
              setAgentId(e.target.value);
              setModel("");
            }}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Task
          <input
            style={field}
            value={task}
            disabled={disabled}
            maxLength={128}
            placeholder="feat-login"
            onChange={(e) => setTask(e.target.value)}
          />
        </label>
        <label style={fieldLabel}>
          Model
          <select style={field} value={chosenModel} disabled={disabled} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default{models[0] ? ` (${models[0]})` : ""}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Load a prompt (optional)
          <select style={field} value={file} disabled={disabled} onChange={(e) => void load(e.target.value)}>
            <option value="">{files.length === 0 ? "No files in prompts_dir" : "Choose a file"}</option>
            {files.map((f) => (
              <option key={f.name} value={f.name} disabled={f.tooLarge}>
                {f.name}
                {f.tooLarge ? " (too large)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={fieldLabel}>
        Prompt
        <textarea
          style={{ ...field, minHeight: "8rem", fontFamily: "monospace" }}
          value={prompt}
          disabled={disabled}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "0.75rem" }}>
        <button style={{ ...actionButton, padding: "0.4rem 0.9rem" }} disabled={disabled || !ready} onClick={() => void start()}>
          {busy ? "Starting..." : "Start run"}
        </button>
        <span style={muted}>{prompt.length} characters</span>
      </div>
      {fileError && (
        <div className="error" style={{ marginTop: "0.75rem" }}>
          {fileError}
        </div>
      )}
      {result && (
        <div className={result.ok ? undefined : "error"} style={{ ...(result.ok ? muted : {}), marginTop: "0.75rem" }}>
          {result.text}
        </div>
      )}
    </div>
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
    setMessage(result.ok ? "Done. The next check carries it out." : failureMessage(result));
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
          Starting a run, releasing a claim and starting a fresh session are the owner&apos;s: this browser must be
          signed in as the owner (from the Decisions view).
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

      {!s.readOnly && s.agents.length > 0 && (
        <StartRunForm project={project} agents={s.agents} refreshKey={refreshKey} onStarted={() => setBump((n) => n + 1)} />
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
