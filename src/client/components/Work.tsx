/**
 * Work: every agent in one list (the old Dragons and Agents views), each row
 * the agent with its current run or task; a row opens the agent's detail
 * (#/work/<agent>). With the agents module on, the Tasks tab lists fill's
 * tasks_file lines and "Locks and budget" the launch locks and the project's
 * budget; with the planner on (planner.enabled), the Planner tab shows how
 * Lair keeps that file. Starting a run, and the start and stop commands of a
 * project's own launcher, are the owner's.
 */
import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useDragonsWebSocket } from "../hooks/useWebSocket";
import { fillWaitingText, workRows, type WorkRow } from "../work-view";
import { hasStartableDragons } from "../dragon-start";
import { startDragon } from "../owner-actions";
import { failureMessage, postJson, releaseFillHoldAction, runConfirmed } from "../agents-actions";
import { tabAvailable, tabDef } from "../nav";
import type { Dragon, DragonManagementConfig, DragonStartRequest } from "../../shared/types";
import type { AgentsStatusView, FillLineView } from "../../shared/agents-types";
import { BudgetLines } from "./Budget";
import { DataTable, type Column } from "./DataTable";
import { SectionHeader, type SectionProps } from "./Section";
import { AgentDetail } from "./AgentDetail";
import { StartRunForm } from "./StartRunForm";
import { DragonStartDialog } from "./DragonStartDialog";
import { Planner } from "./Planner";
import { EmptyState, ErrorState, Loading, ModuleOff, Time, muted, useOwnerSignedIn } from "./ui";

const actionButton = {
  padding: "0.4rem 0.9rem",
  borderRadius: "4px",
  border: "1px solid var(--accent)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
};

const COLUMNS: Column<WorkRow>[] = [
  {
    key: "agent",
    label: "Agent",
    sort: (r) => r.id,
    render: (r) => (
      <>
        <code>{r.id}</code>
        {r.name !== r.id && <div style={muted}>{r.name}</div>}
      </>
    ),
  },
  {
    key: "state",
    label: "State",
    sort: (r) => (r.attention ? 0 : r.badge === "badge-success" ? 1 : 2),
    render: (r) => (
      <>
        <span className={`badge ${r.badge}`}>{r.state}</span>
        {r.detail && <div style={{ ...muted, maxWidth: "22rem" }}>{r.detail}</div>}
      </>
    ),
  },
  { key: "task", label: "Task", sort: (r) => r.task, render: (r) => (r.task ? <code>{r.task}</code> : <span style={muted}>—</span>) },
  { key: "model", label: "Model", sort: (r) => r.model, render: (r) => <span style={muted}>{r.model ?? "—"}</span> },
  { key: "machine", label: "Machine", sort: (r) => r.machine, render: (r) => <span style={muted}>{r.machine ?? "—"}</span> },
  {
    key: "log",
    label: "Last log",
    sort: (r) => r.lastLogTime,
    render: (r) =>
      r.lastLogTime ? (
        <Time iso={r.lastLogTime} />
      ) : (
        <span style={muted} title="No log of it (<id>.log or <id>-<UTC time>.log) in agents_dir">
          unknown
        </span>
      ),
  },
  { key: "done", label: "Done (7 d)", align: "right", sort: (r) => r.done, render: (r) => r.done ?? "—" },
];

export function Work({ project, refreshKey, route, modules, readOnly, open }: SectionProps) {
  const [bump, setBump] = useState(0);
  const key = refreshKey + bump;
  const dragonsApi = useApi<Dragon[]>("/dragons", project, key);
  // One array per REST answer, so the WebSocket hook isn't reset on every render
  const restDragons = useMemo(() => dragonsApi.data ?? [], [dragonsApi.data]);
  const { dragons, isUsingWebSocket } = useDragonsWebSocket(project, restDragons);
  const agentsOn = modules?.agents === true;
  const status = useApi<AgentsStatusView>("/agents/status", project, key, { skip: !agentsOn });
  const dragonConfig = useApi<DragonManagementConfig>("/controls/dragon/config", project, key);
  const signedIn = useOwnerSignedIn(refreshKey);
  const [showStart, setShowStart] = useState(false);
  const [showDragonStart, setShowDragonStart] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The WebSocket list follows the REST one, and the agents module's state is merged in
  const list = isUsingWebSocket ? dragons : restDragons;
  const agents = status.data?.enabled ? status.data : null;
  const rows = useMemo(() => workRows(list, agents), [list, agents]);

  const tab = tabDef("work", route.tab);
  const header = (
    <SectionHeader title="Work" section="work" route={route} modules={modules}>
      {agents && !readOnly && (
        <button type="button" style={actionButton} onClick={() => setShowStart((s) => !s)} disabled={signedIn !== true}>
          {showStart ? "Close the form" : "Start a run"}
        </button>
      )}
      {!agentsOn && !readOnly && hasStartableDragons(dragonConfig.data?.dragons) && (
        <button type="button" style={actionButton} onClick={() => setShowDragonStart(true)} disabled={signedIn !== true}>
          Start an agent
        </button>
      )}
      {agents?.lastTick && (
        <span style={muted}>
          Last check <Time iso={agents.lastTick.at} />
        </span>
      )}
    </SectionHeader>
  );

  if (!tabAvailable("work", route.tab, modules)) {
    return (
      <div>
        {header}
        <ModuleOff what={tab?.label ?? "This tab"} enable={tab?.enable ?? ""} />
      </div>
    );
  }

  const releaseHold = async (line: FillLineView) => {
    if (!line.task || !line.agent) return;
    const result = await runConfirmed(releaseFillHoldAction(project, line.task, line.agent), (q) => window.confirm(q), postJson);
    if (!result.sent) return;
    setMessage(result.ok ? `Released: fill starts ${line.task} on its next check.` : failureMessage(result));
    setBump((n) => n + 1);
  };

  const handleDragonStart = async (request: DragonStartRequest) => {
    const data = await startDragon(project, request);
    if (!data.success) throw new Error(data.error || "Failed to start the agent");
    if (data.data?.exitCode !== 0) throw new Error(data.data?.stderr || "The start command failed");
    setBump((n) => n + 1);
  };

  const body = () => {
    // The planner (planner.enabled) keeps the tasks file: its own view, the owner's (it shows plan text)
    if (route.tab === "planner") return <Planner project={project} refreshKey={refreshKey} />;
    if (route.tab === "tasks") return <FillTab status={agents} readOnly={readOnly} signedIn={signedIn} onRelease={releaseHold} open={open} />;
    if (route.tab === "locks") return <LocksTab status={agents} />;
    if (dragonsApi.loading && !dragonsApi.data && rows.length === 0) return <Loading what="agents" />;
    if (dragonsApi.error && rows.length === 0) return <ErrorState what="the agents" error={dragonsApi.error} />;
    return (
      <div className="card">
        <DataTable
          label="Agents"
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          onOpen={(r) => open(r.id)}
          selected={route.detail}
          initialSort={{ key: "agent", dir: "asc" }}
          empty={
            <EmptyState title="No agents yet">
              List them in dragons.txt in the project&apos;s agents_dir, or under dragons: in its YAML. With agents.enabled:
              true, Lair starts and supervises their runs.
            </EmptyState>
          }
        />
      </div>
    );
  };

  return (
    <div>
      {header}
      {status.error && agentsOn && <ErrorState what="the agents module's state" error={status.error} />}
      {agents?.lastError && <div className="error">The agents module's last check failed: {agents.lastError}</div>}
      {agents?.errors.map((e) => (
        <div key={e} className="error">
          {e}
        </div>
      ))}
      {message && (
        <div className="card" style={muted} role="status">
          {message}
        </div>
      )}
      {showStart && agents && agents.agents.length > 0 && (
        <StartRunForm project={project} agents={agents.agents} refreshKey={refreshKey} onStarted={() => setBump((n) => n + 1)} />
      )}
      {body()}

      {route.detail && (
        <AgentDetail
          id={route.detail}
          project={project}
          refreshKey={key}
          dragons={list}
          status={agents}
          readOnly={readOnly}
          dragonConfig={dragonConfig.data}
          onChanged={() => setBump((n) => n + 1)}
          onClose={() => open(null)}
        />
      )}
      {showDragonStart && dragonConfig.data && (
        <DragonStartDialog
          dragons={dragonConfig.data.dragons ?? {}}
          availableModels={dragonConfig.data.available_models || []}
          defaultInstructions={dragonConfig.data.default_instructions}
          onStart={handleDragonStart}
          onClose={() => setShowDragonStart(false)}
        />
      )}
    </div>
  );
}

const FILL_BADGE: Record<string, string> = {
  started: "badge-success",
  done: "badge-neutral",
  held: "badge-warning",
  claimed: "badge-neutral",
  not_allowlisted: "badge-neutral",
  malformed: "badge-error",
};

function FillTab({
  status,
  readOnly,
  signedIn,
  onRelease,
  open,
}: {
  status: AgentsStatusView | null;
  readOnly: boolean;
  signedIn: boolean | null;
  onRelease: (line: FillLineView) => void;
  open: (detail: string | null) => void;
}) {
  const fill = status?.fill;
  if (!fill?.enabled) return <Loading what="the tasks file" />;
  const columns: Column<FillLineView>[] = [
    { key: "line", label: "Line", align: "right", sort: (l) => l.line, render: (l) => l.line },
    { key: "agent", label: "Agent", sort: (l) => l.agent, render: (l) => (l.agent ? <code>{l.agent}</code> : "—") },
    {
      key: "task",
      label: "Task",
      sort: (l) => l.task,
      render: (l) => (
        <>
          {l.task ? <code>{l.task}</code> : "—"}
          {l.description && <div style={muted}>{l.description}</div>}
        </>
      ),
    },
    {
      key: "state",
      label: "State",
      sort: (l) => l.state,
      render: (l) => (
        <>
          <span className={`badge ${FILL_BADGE[l.state] ?? "badge-neutral"}`}>
            {l.state.replace(/_/g, " ")}
            {l.hold ? `: ${l.hold.replace(/_/g, " ")}` : ""}
          </span>
          {l.waiting && <div className="waiting">{fillWaitingText(l.waiting)}</div>}
        </>
      ),
    },
    {
      key: "detail",
      label: "Detail",
      render: (l) => (
        <span style={muted}>
          {l.detail}{" "}
          {l.releasable && !readOnly && (
            <button
              type="button"
              className="small-button"
              disabled={signedIn !== true}
              title={signedIn === true ? undefined : "Sign in as the owner from Decisions first"}
              onClick={(e) => {
                e.stopPropagation();
                onRelease(l);
              }}
            >
              Release hold
            </button>
          )}
        </span>
      ),
    },
  ];
  return (
    <div className="card">
      <p style={muted}>
        {fill.tasksFile ?? "no tasks_file"}: last check <Time iso={fill.lastCheck} />, {fill.active} of {fill.maxActive} run(s)
        active, agents {fill.agents.join(", ") || "none"}
        {fill.running ? "" : " (not running)"}
      </p>
      {fill.lastError && <div className="error">Fill's last check failed: {fill.lastError}</div>}
      <DataTable
        label="Tasks file lines"
        columns={columns}
        rows={fill.lines}
        rowKey={(l) => String(l.line)}
        onOpen={(l) => l.agent && open(l.agent)}
        empty={<EmptyState title="No lines at the last check">Add tasks to the tasks file; fill reads it on every check.</EmptyState>}
      />
    </div>
  );
}

function LocksTab({ status }: { status: AgentsStatusView | null }) {
  if (!status) return <Loading what="locks and budgets" />;
  return (
    <>
      <div className="card">
        <h3>Launch locks</h3>
        {status.locks.length === 0 ? (
          <p style={muted}>No agents.locks configured.</p>
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
              {status.locks.map((lock) => (
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
                        : `pid ${lock.holderPid}${lock.holderAlive === null ? "" : lock.holderAlive ? " (alive)" : " (dead)"}`}
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
        <BudgetLines budget={status.projectBudget} />
      </div>
    </>
  );
}
