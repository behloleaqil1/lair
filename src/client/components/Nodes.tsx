/**
 * Nodes view - M1 Core node management.
 * Shows registered nodes, their capacity, and scheduler status.
 */
import { useState, useEffect } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import type {
  Node,
  SchedulerState,
  ListNodesResponse,
} from "../../shared/server-types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Nodes({ project, refreshKey }: Props) {
  const [data, setData] = useState<ListNodesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch nodes
  useEffect(() => {
    setLoading(true);
    fetch("/api/nodes")
      .then((res) => res.json())
      .then((response) => {
        if (response.success) {
          setData(response.data);
          setError(null);
        } else {
          setError(response.error || "Unknown error");
        }
      })
      .catch((err) => {
        setError(err.message || "Network error");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [refreshKey]);

  // WebSocket for real-time updates
  const { connectionState } = useWebSocket(project, {
    channels: ["nodes"],
    onConnectionChange: () => {
      // Refetch on reconnect
    },
  });

  if (loading && !data) {
    return <div className="loading">Loading nodes...</div>;
  }

  if (error && !data) {
    return <div className="error">Error: {error}</div>;
  }

  const { nodes = [], scheduler } = data || {};

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
        <h2>Nodes ({nodes.length})</h2>
        <span
          className={`badge ${connectionState === "connected" ? "badge-success" : "badge-neutral"}`}
          style={{ fontSize: "0.7rem" }}
        >
          {connectionState === "connected" ? "⚡ Live" : "📡 Polling"}
        </span>
      </div>

      {/* Scheduler Status */}
      {scheduler && <SchedulerStatus scheduler={scheduler} />}

      {/* Nodes Table */}
      <div className="card">
        <h3>Registered Nodes</h3>
        {nodes.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
            No nodes registered. Run <code>lair node join</code> on a machine to connect it.
          </p>
        ) : (
          <table className="table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Capacity</th>
                <th>Used</th>
                <th>Jobs</th>
                <th>Runtime</th>
                <th>Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <NodeRow key={node.id} node={node} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SchedulerStatus({ scheduler }: { scheduler: SchedulerState }) {
  const usedCoresPercent =
    scheduler.totalCapacity.cores > 0
      ? Math.round((scheduler.usedCapacity.cores / scheduler.totalCapacity.cores) * 100)
      : 0;
  const usedRamPercent =
    scheduler.totalCapacity.ramMb > 0
      ? Math.round((scheduler.usedCapacity.ramMb / scheduler.totalCapacity.ramMb) * 100)
      : 0;

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      <h3>Scheduler</h3>
      <div className="grid grid-3" style={{ marginTop: "1rem" }}>
        <div className="stat">
          <div className="stat-value">{scheduler.nodesOnline}/{scheduler.nodesTotal}</div>
          <div className="stat-label">Nodes Online</div>
        </div>
        <div className="stat">
          <div className="stat-value">{scheduler.queuedTasks}</div>
          <div className="stat-label">Queued Tasks</div>
        </div>
        <div className="stat">
          <div className="stat-value">{scheduler.runningJobs}</div>
          <div className="stat-label">Running Jobs</div>
        </div>
        <div className="stat">
          <div className="stat-value">{scheduler.activeAgents}/{scheduler.maxAgents}</div>
          <div className="stat-label">Agents</div>
        </div>
        <div className="stat">
          <div className="stat-value">{usedCoresPercent}%</div>
          <div className="stat-label">
            CPU ({scheduler.usedCapacity.cores}/{scheduler.totalCapacity.cores})
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{usedRamPercent}%</div>
          <div className="stat-label">
            RAM ({Math.round(scheduler.usedCapacity.ramMb / 1024)}GB/{Math.round(scheduler.totalCapacity.ramMb / 1024)}GB)
          </div>
        </div>
      </div>
      <div style={{ marginTop: "1rem" }}>
        <span
          className={`badge ${scheduler.running ? "badge-success" : "badge-warning"}`}
        >
          {scheduler.running ? "Running" : "Stopped"}
        </span>
        {scheduler.lastTickAt && (
          <span style={{ marginLeft: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Last tick: {new Date(scheduler.lastTickAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

function NodeRow({ node }: { node: Node }) {
  const statusColor =
    node.status === "online"
      ? "badge-success"
      : node.status === "draining"
        ? "badge-warning"
        : "badge-error";

  const capacityStr = `${node.capacity.cores} cores, ${Math.round(node.capacity.ramMb / 1024)}GB RAM`;
  const usedStr = `${node.usedCapacity.cores} cores, ${Math.round(node.usedCapacity.ramMb / 1024)}GB RAM`;

  const lastHeartbeat = node.lastHeartbeat
    ? new Date(node.lastHeartbeat).toLocaleTimeString()
    : "-";

  return (
    <tr>
      <td>
        <span className={`badge ${statusColor}`}>
          {node.status}
        </span>
      </td>
      <td>
        <strong>{node.name}</strong>
        <br />
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {node.os} {node.arch}
        </span>
      </td>
      <td style={{ fontSize: "0.85rem" }}>{capacityStr}</td>
      <td style={{ fontSize: "0.85rem" }}>{usedStr}</td>
      <td>{node.activeJobs}</td>
      <td>
        <span className="badge badge-neutral" style={{ fontSize: "0.75rem" }}>
          {node.capacity.containerRuntime || "none"}
        </span>
      </td>
      <td style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
        {lastHeartbeat}
      </td>
    </tr>
  );
}
