/**
 * Machines view - machine and runner status
 * Uses WebSocket for real-time updates with REST polling as fallback.
 */
import { useApi } from "../hooks/useApi";
import { useMachinesWebSocket } from "../hooks/useWebSocket";
import type { MachineStatus } from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Machines({ project, refreshKey }: Props) {
  // Fetch machines via REST (used as initial data and fallback)
  const {
    data: restMachines,
    loading,
    error,
  } = useApi<MachineStatus[]>("/machines", project, refreshKey);

  // Use WebSocket for real-time machine updates
  const { machines: wsMachines, connected: wsConnected } = useMachinesWebSocket(
    project,
    restMachines || [],
  );

  if (loading && wsMachines.length === 0)
    return <div className="loading">Loading machines...</div>;
  if (error && wsMachines.length === 0)
    return <div className="error">Error: {error}</div>;

  // Use WebSocket machines if connected, otherwise fall back to REST data
  const machines = wsConnected ? wsMachines : restMachines || [];

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
        <h2>Machines ({machines.length})</h2>
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

      <div className="grid grid-2">
        {machines.map((machine) => (
          <div key={machine.name} className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {machine.name}
                <span
                  style={{
                    marginLeft: "0.5rem",
                    color: "var(--text-secondary)",
                    fontWeight: "normal",
                    fontSize: "0.9rem",
                  }}
                >
                  ({machine.type})
                </span>
              </h3>
              <span
                className={`badge ${machine.up ? "badge-success" : "badge-error"}`}
              >
                {machine.up ? "Online" : "Offline"}
              </span>
            </div>

            {/* Runners */}
            {machine.runners && machine.runners.length > 0 && (
              <div>
                <h4
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                    marginBottom: "0.5rem",
                  }}
                >
                  Runners
                </h4>
                <div
                  style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                >
                  {machine.runners.map((runner) => (
                    <div
                      key={runner.lane}
                      style={{
                        background: "var(--bg-secondary)",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "4px",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background: runner.running
                            ? "var(--success)"
                            : "var(--error)",
                        }}
                      />
                      <span style={{ textTransform: "capitalize" }}>
                        {runner.lane}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Last check */}
            {machine.lastCheck && (
              <p
                style={{
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color: "var(--text-secondary)",
                }}
              >
                Last check: {new Date(machine.lastCheck).toLocaleTimeString()}
              </p>
            )}

            {/* Last gate time */}
            {machine.lastGateTime && (
              <p
                style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}
              >
                Last gate: {new Date(machine.lastGateTime).toLocaleString()}
              </p>
            )}
          </div>
        ))}
      </div>

      {machines.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--text-secondary)" }}>
            No machines configured
          </p>
        </div>
      )}
    </div>
  );
}
