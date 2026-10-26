/**
 * Overview view - main dashboard
 * Uses WebSocket for real-time stats updates.
 */
import { useApi } from "../hooks/useApi";
import { useDragonsWebSocket, useGatesWebSocket } from "../hooks/useWebSocket";
import { LiveFeed } from "./LiveFeed";
import type { OverviewData } from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Overview({ project, refreshKey }: Props) {
  const { data, loading, error } = useApi<OverviewData>(
    "/overview",
    project,
    refreshKey,
  );

  // Use WebSocket for real-time dragon/gate counts
  // Create empty initial arrays - the hooks will update when REST data arrives
  const { dragons, connectionState: dragonsConnState } = useDragonsWebSocket(
    project,
    [],
  );
  const { gates, connected: gatesConnected } = useGatesWebSocket(project, []);

  if (loading) return <div className="loading">Loading overview...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  // Calculate real-time counts from WebSocket if connected
  const wsConnected = dragonsConnState === "connected" && gatesConnected;
  const runningDragons =
    wsConnected && dragons.length > 0
      ? dragons.filter((d) => d.running).length
      : data.agentCounts.running;
  const idleDragons =
    wsConnected && dragons.length > 0
      ? dragons.filter((d) => !d.running).length
      : data.agentCounts.idle;
  const runningGates =
    wsConnected && gates.length > 0
      ? gates.filter((g) => g.status === "running").length
      : data.gateCounts.running;
  const queuedGates =
    wsConnected && gates.length > 0
      ? gates.filter((g) => g.status === "queued").length
      : data.gateCounts.queued;

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
        <h2>Overview: {data.project}</h2>
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

      {/* Live Feed */}
      <LiveFeed project={project} />

      {/* Stats row */}
      <div className="grid grid-4" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="stat-value">{runningDragons}</div>
          <div className="stat-label">Dragons Running</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{idleDragons}</div>
          <div className="stat-label">Dragons Idle</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{runningGates}</div>
          <div className="stat-label">Gates Running</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{queuedGates}</div>
          <div className="stat-label">Gates Queued</div>
        </div>
      </div>

      <div className="grid grid-2">
        {/* Main info */}
        <div className="card">
          <h3>Repository</h3>
          <table className="table">
            <tbody>
              <tr>
                <td style={{ width: "40%" }}>Main Head</td>
                <td>
                  <code>{data.mainHead}</code>
                </td>
              </tr>
              <tr>
                <td>Last Commit</td>
                <td>{data.mainDate}</td>
              </tr>
              {data.localStackHead && (
                <tr>
                  <td>Local Stack</td>
                  <td>
                    <code>{data.localStackHead}</code>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Recent merges */}
        <div className="card">
          <h3>Recent Merges (24h)</h3>
          {data.recentMerges.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>
              No merges in the last 24 hours
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {data.recentMerges.slice(0, 5).map((pr) => (
                <li key={pr.number} style={{ marginBottom: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    #{pr.number}
                  </span>{" "}
                  {pr.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Problems */}
      <div className="card">
        <h3>Problems</h3>
        {data.problems.length === 0 ? (
          <p style={{ color: "var(--success)" }}>✓ No problems detected</p>
        ) : (
          <div>
            {data.problems.map((problem, i) => (
              <div key={i} className={`problem problem-${problem.severity}`}>
                <span className="problem-icon">
                  {problem.severity === "error" ? "🔴" : "🟡"}
                </span>
                <div className="problem-content">
                  <div className="problem-message">{problem.message}</div>
                  {problem.details && (
                    <div className="problem-details">{problem.details}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
