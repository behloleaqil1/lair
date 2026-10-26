/**
 * Orchestrator view - tick lines and status
 * Uses WebSocket for real-time updates with REST polling as fallback.
 */
import { useApi } from "../hooks/useApi";
import { useOrchestratorWebSocket } from "../hooks/useWebSocket";
import type { OrchestratorStatus } from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Orchestrator({ project, refreshKey }: Props) {
  // Fetch orchestrator status via REST (used as initial data and fallback)
  const {
    data: restData,
    loading,
    error,
  } = useApi<OrchestratorStatus>("/orchestrator", project, refreshKey);

  // Use WebSocket for real-time orchestrator updates
  const { status: wsStatus, connected: wsConnected } = useOrchestratorWebSocket(
    project,
    restData,
  );

  if (loading && !wsStatus)
    return <div className="loading">Loading orchestrator status...</div>;
  if (error && !wsStatus) return <div className="error">Error: {error}</div>;

  // Use WebSocket status if connected, otherwise fall back to REST data
  const data = wsConnected && wsStatus ? wsStatus : restData;
  if (!data) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <h2>Orchestrator</h2>
        <span
          className={`badge ${wsConnected ? "badge-success" : "badge-neutral"}`}
          style={{ fontSize: "0.7rem" }}
          title={
            wsConnected
              ? "Real-time updates via WebSocket"
              : "Polling mode (WebSocket disconnected)"
          }
        >
          {wsConnected ? "⚡ Live" : "📡 Polling"}
        </span>
      </div>

      {/* Status cards */}
      <div className="grid grid-3" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="stat-value" style={{ fontSize: "1.5rem" }}>
            {data.launchdLoaded ? "🟢" : "🔴"}
          </div>
          <div className="stat-label">LaunchAgent</div>
          <div style={{ marginTop: "0.5rem" }}>
            <span
              className={`badge ${data.launchdLoaded ? "badge-success" : "badge-error"}`}
            >
              {data.launchdLoaded ? "Loaded" : "Not loaded"}
            </span>
          </div>
        </div>

        <div className="card stat">
          <div className="stat-value" style={{ fontSize: "1.5rem" }}>
            {data.stopFileExists ? "🛑" : "✅"}
          </div>
          <div className="stat-label">STOP File</div>
          <div style={{ marginTop: "0.5rem" }}>
            <span
              className={`badge ${data.stopFileExists ? "badge-error" : "badge-success"}`}
            >
              {data.stopFileExists ? "Exists (paused)" : "Not present"}
            </span>
          </div>
        </div>

        <div className="card stat">
          <div className="stat-value" style={{ fontSize: "1.5rem" }}>
            {data.tickLines.length}
          </div>
          <div className="stat-label">Recent Ticks</div>
        </div>
      </div>

      {/* Tick lines */}
      <div className="card">
        <h3>Recent TICK Lines</h3>
        {data.tickLines.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No tick lines found</p>
        ) : (
          <div style={{ maxHeight: "500px", overflowY: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "100px" }}>Time</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {data.tickLines
                  .slice()
                  .reverse()
                  .map((line, i) => (
                    <tr key={i}>
                      <td
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {line.timestamp || "-"}
                      </td>
                      <td style={{ fontSize: "0.9rem" }}>{line.message}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
