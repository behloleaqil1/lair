/**
 * Dragons view - agent status and stats with start/stop controls
 * Uses WebSocket for real-time updates with REST polling as fallback.
 */
import { useState, useEffect } from "react";
import { useApi } from "../hooks/useApi";
import { useDragonsWebSocket } from "../hooks/useWebSocket";
import { DragonStartDialog } from "./DragonStartDialog";
import { DragonStopDialog } from "./DragonStopDialog";
import { canStartDragon, hasStartableDragons } from "../dragon-start";
import { startDragon, stopDragon } from "../owner-actions";
import { SignInHint } from "./SignInHint";
import type {
  Dragon,
  QueueLine,
  DragonManagementConfig,
  DragonStartRequest,
  DragonStopRequest,
} from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Dragons({ project, refreshKey }: Props) {
  // Fetch dragons via REST (used as initial data and fallback)
  const {
    data: restDragons,
    loading,
    error,
  } = useApi<Dragon[]>("/dragons", project, refreshKey);

  // Use WebSocket for real-time updates
  const { dragons, connectionState, isUsingWebSocket } = useDragonsWebSocket(
    project,
    restDragons || [],
  );

  const { data: dragonConfig } = useApi<DragonManagementConfig>(
    "/controls/dragon/config",
    project,
    refreshKey,
  );
  const [selectedDragon, setSelectedDragon] = useState<string | null>(null);
  const [showStartDialog, setShowStartDialog] = useState(false);
  const [showStopDialog, setShowStopDialog] = useState(false);
  const [startDragonId, setStartDragonId] = useState<string | undefined>();
  const [stopDragon, setStopDragon] = useState<Dragon | null>(null);
  const [controlsReadOnly, setControlsReadOnly] = useState(true);

  // Check controls status
  useEffect(() => {
    fetch(`/api/controls/status?project=${project}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.data) {
          setControlsReadOnly(data.data.readOnly);
        }
      })
      .catch(() => {});
  }, [project, refreshKey]);

  if (loading && dragons.length === 0)
    return <div className="loading">Loading dragons...</div>;
  if (error && dragons.length === 0)
    return <div className="error">Error: {error}</div>;

  const selected = dragons.find((d) => d.id === selectedDragon);

  const handleStartClick = (dragonId?: string) => {
    setStartDragonId(dragonId);
    setShowStartDialog(true);
  };

  const handleStopClick = (dragon: Dragon) => {
    setStopDragon(dragon);
    setShowStopDialog(true);
  };

  const handleStartDragon = async (request: DragonStartRequest) => {
    const data = await startDragon(project, request);
    if (!data.success) {
      throw new Error(data.error || "Failed to start dragon");
    }
    if (data.data?.exitCode !== 0) {
      throw new Error(data.data?.stderr || "Command failed");
    }
  };

  const handleStopDragon = async (request: DragonStopRequest) => {
    const data = await stopDragon(project, request);
    if (!data.success) {
      throw new Error(data.error || "Failed to stop dragon");
    }
    if (data.data?.exitCode !== 0) {
      throw new Error(data.data?.stderr || "Command failed");
    }
  };

  // Dragons the server accepts for start/stop: the YAML dragons: map plus
  // dragons.txt (dragons.txt-only ones have no model or machine)
  const configuredDragons = dragonConfig?.dragons || {};
  const availableModels = dragonConfig?.available_models || [];
  const hasConfiguredDragons = hasStartableDragons(configuredDragons);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <h2>Dragons ({dragons.length})</h2>
          <span
            className={`badge ${isUsingWebSocket ? "badge-success" : "badge-neutral"}`}
            style={{ fontSize: "0.7rem" }}
            title={
              isUsingWebSocket
                ? "Real-time updates via WebSocket"
                : connectionState === "connecting"
                  ? "Connecting to WebSocket..."
                  : "Polling mode (WebSocket disconnected)"
            }
          >
            {isUsingWebSocket ? "⚡ Live" : connectionState === "connecting" ? "⏳" : "📡 Polling"}
          </span>
        </div>
        {!controlsReadOnly && hasConfiguredDragons && (
          <button
            onClick={() => handleStartClick()}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "4px",
              border: "none",
              background: "var(--primary)",
              color: "white",
              cursor: "pointer",
            }}
          >
            + Start Dragon
          </button>
        )}
      </div>

      {!controlsReadOnly && <SignInHint what="Starting and stopping dragons" refreshKey={refreshKey} />}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>ID</th>
              <th>Name</th>
              <th>Adapter</th>
              <th>Model</th>
              <th>Machine</th>
              <th>Task</th>
              <th>Last Log</th>
              <th>Done</th>
              <th>Pass Rate</th>
              {!controlsReadOnly && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {dragons.map((dragon) => (
              <tr
                key={dragon.id}
                className="clickable"
                onClick={() => setSelectedDragon(dragon.id)}
                style={
                  selectedDragon === dragon.id
                    ? { background: "rgba(233, 69, 96, 0.2)" }
                    : {}
                }
              >
                <td>
                  <span
                    className={`badge ${dragon.running ? "badge-success" : "badge-neutral"}`}
                  >
                    {dragon.running ? "Running" : "Idle"}
                  </span>
                </td>
                <td>
                  <code>{dragon.id}</code>
                </td>
                <td>{dragon.name}</td>
                <td>
                  <span
                    className="badge badge-neutral"
                    style={{ fontSize: "0.75rem" }}
                  >
                    {dragon.adapter || "kiro"}
                  </span>
                </td>
                <td
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  {dragon.model || "-"}
                </td>
                <td
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  {dragon.machine || "-"}
                </td>
                <td
                  style={{
                    maxWidth: "200px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dragon.task}
                </td>
                <td
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  {dragon.lastLogTime || "-"}
                </td>
                <td>{dragon.stats?.doneCount || 0}</td>
                <td>
                  {dragon.stats?.gatesSubmitted
                    ? `${dragon.stats.firstTimePassRate}%`
                    : "-"}
                </td>
                {!controlsReadOnly && (
                  <td onClick={(e) => e.stopPropagation()}>
                    {dragon.running ? (
                      <button
                        onClick={() => handleStopClick(dragon)}
                        style={{
                          padding: "0.25rem 0.5rem",
                          borderRadius: "4px",
                          border: "none",
                          background: "var(--error)",
                          color: "white",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                        }}
                      >
                        Stop
                      </button>
                    ) : (
                      canStartDragon(dragon.id, configuredDragons) && (
                        <button
                          onClick={() => handleStartClick(dragon.id)}
                          style={{
                            padding: "0.25rem 0.5rem",
                            borderRadius: "4px",
                            border: "1px solid var(--primary)",
                            background: "transparent",
                            color: "var(--primary)",
                            cursor: "pointer",
                            fontSize: "0.85rem",
                          }}
                        >
                          Start
                        </button>
                      )
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {selectedDragon && selected && (
        <>
          <div className="overlay" onClick={() => setSelectedDragon(null)} />
          <DragonDetail
            dragon={selected}
            project={project}
            refreshKey={refreshKey}
            onClose={() => setSelectedDragon(null)}
          />
        </>
      )}

      {/* Start dialog */}
      {showStartDialog && (
        <DragonStartDialog
          dragons={configuredDragons}
          availableModels={availableModels}
          defaultInstructions={dragonConfig?.default_instructions}
          selectedDragonId={startDragonId}
          onStart={handleStartDragon}
          onClose={() => {
            setShowStartDialog(false);
            setStartDragonId(undefined);
          }}
        />
      )}

      {/* Stop dialog */}
      {showStopDialog && stopDragon && (
        <DragonStopDialog
          dragon={stopDragon}
          onStop={handleStopDragon}
          onClose={() => {
            setShowStopDialog(false);
            setStopDragon(null);
          }}
        />
      )}
    </div>
  );
}

interface DragonDetailProps {
  dragon: Dragon;
  project: string;
  refreshKey: number;
  onClose: () => void;
}

function DragonDetail({
  dragon,
  project,
  refreshKey,
  onClose,
}: DragonDetailProps) {
  const { data: queueLines } = useApi<QueueLine[]>(
    `/dragons/${dragon.id}/queue`,
    project,
    refreshKey,
  );
  const { data: logData } = useApi<{ id: string; log: string | null }>(
    `/dragons/${dragon.id}/log`,
    project,
    refreshKey,
  );

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h2>
          {dragon.name}{" "}
          <span style={{ color: "var(--text-secondary)" }}>({dragon.id})</span>
        </h2>
        <button className="detail-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div style={{ marginBottom: "1.5rem" }}>
        <span
          className={`badge ${dragon.running ? "badge-success" : "badge-neutral"}`}
        >
          {dragon.running ? "Running" : "Idle"}
        </span>
        <span
          className="badge badge-neutral"
          style={{ marginLeft: "0.5rem" }}
        >
          {dragon.adapter || "kiro"}
        </span>
        {dragon.model && (
          <span
            className="badge badge-neutral"
            style={{ marginLeft: "0.5rem" }}
          >
            {dragon.model}
          </span>
        )}
        {dragon.machine && (
          <span
            className="badge badge-neutral"
            style={{ marginLeft: "0.5rem" }}
          >
            {dragon.machine}
          </span>
        )}
        <p style={{ marginTop: "0.5rem", color: "var(--text-secondary)" }}>
          {dragon.task}
        </p>
        {dragon.instructions && (
          <p
            style={{
              marginTop: "0.5rem",
              color: "var(--text-secondary)",
              fontSize: "0.85rem",
              fontStyle: "italic",
            }}
          >
            {dragon.instructions}
          </p>
        )}
      </div>

      {/* Stats */}
      {dragon.stats && (
        <div className="card">
          <h3>Stats (7 days)</h3>
          <div className="grid grid-3" style={{ marginTop: "0.75rem" }}>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.doneCount}
              </div>
              <div className="stat-label">Done</div>
            </div>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.blockedCount}
              </div>
              <div className="stat-label">Blocked</div>
            </div>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.gatesSubmitted}
              </div>
              <div className="stat-label">Gates</div>
            </div>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.gatesPassed}
              </div>
              <div className="stat-label">Passed</div>
            </div>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.firstTimePassRate}%
              </div>
              <div className="stat-label">Pass Rate</div>
            </div>
            <div className="stat">
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {dragon.stats.earlyStops}
              </div>
              <div className="stat-label">Early Stops</div>
            </div>
          </div>
        </div>
      )}

      {/* Queue lines */}
      <div className="card">
        <h3>Recent Queue Lines</h3>
        {queueLines && queueLines.length > 0 ? (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              maxHeight: "200px",
              overflowY: "auto",
            }}
          >
            {queueLines
              .slice(-10)
              .reverse()
              .map((line, i) => (
                <li
                  key={i}
                  style={{
                    padding: "0.5rem",
                    borderBottom: "1px solid var(--border)",
                    fontSize: "0.85rem",
                  }}
                >
                  <span
                    className={`badge ${
                      line.type === "DONE"
                        ? "badge-success"
                        : line.type === "BLOCKED"
                          ? "badge-error"
                          : line.type === "WAITING"
                            ? "badge-warning"
                            : "badge-neutral"
                    }`}
                    style={{ marginRight: "0.5rem" }}
                  >
                    {line.type}
                  </span>
                  {line.timestamp && (
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        marginRight: "0.5rem",
                      }}
                    >
                      {line.timestamp}
                    </span>
                  )}
                  <span>{line.task}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p style={{ color: "var(--text-secondary)" }}>No queue lines</p>
        )}
      </div>

      {/* Log tail */}
      <div className="card">
        <h3>Log Tail</h3>
        {logData?.log ? (
          <div className="code">{logData.log}</div>
        ) : (
          <p style={{ color: "var(--text-secondary)" }}>No log available</p>
        )}
      </div>
    </div>
  );
}
