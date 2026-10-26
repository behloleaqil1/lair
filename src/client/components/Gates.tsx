/**
 * Gates view - queue and results, and the pipelines section (runs and where
 * they ran).
 * Uses WebSocket for real-time updates with REST polling as fallback.
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useGatesWebSocket } from "../hooks/useWebSocket";
import { PipelineRuns } from "./PipelineRuns";
import type { Gate, GateResult } from "../../shared/types";

interface GatesData {
  queue: Gate[];
  results: GateResult[];
}

interface Props {
  project: string;
  refreshKey: number;
}

export function Gates({ project, refreshKey }: Props) {
  // Fetch gates via REST (used as initial data and fallback)
  const {
    data: restData,
    loading,
    error,
  } = useApi<GatesData>("/gates", project, refreshKey);
  const [selectedGate, setSelectedGate] = useState<string | null>(null);

  // Use WebSocket for real-time gate queue updates
  const { gates: wsGates, connected: wsConnected } = useGatesWebSocket(
    project,
    restData?.queue || [],
  );

  if (loading && wsGates.length === 0)
    return <div className="loading">Loading gates...</div>;
  if (error && wsGates.length === 0)
    return <div className="error">Error: {error}</div>;

  // Use WebSocket gates if connected, otherwise fall back to REST data
  const queue = wsConnected ? wsGates : restData?.queue || [];
  const results = restData?.results || [];

  // Group queue by lane
  const byLane = {
    heavy: queue.filter((g) => g.lane === "heavy"),
    light: queue.filter((g) => g.lane === "light"),
    remote: queue.filter((g) => g.lane === "remote"),
  };

  const running = queue.filter((g) => g.status === "running");
  const queued = queue.filter((g) => g.status === "queued");

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
        <h2>
          Gates ({running.length} running, {queued.length} queued)
        </h2>
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
        {/* Running gates */}
        <div className="card">
          <h3>Running</h3>
          {running.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No gates running</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>Track</th>
                  <th>Step</th>
                </tr>
              </thead>
              <tbody>
                {running.map((gate) => (
                  <tr
                    key={gate.id}
                    className="clickable"
                    onClick={() => setSelectedGate(gate.id)}
                  >
                    <td>
                      <span className="badge badge-success">{gate.lane}</span>
                    </td>
                    <td>{gate.track}</td>
                    <td style={{ color: "var(--text-secondary)" }}>
                      {gate.currentStep || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Queued gates */}
        <div className="card">
          <h3>Queued</h3>
          {queued.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No gates queued</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Pri</th>
                  <th>Lane</th>
                  <th>Track</th>
                </tr>
              </thead>
              <tbody>
                {queued.slice(0, 10).map((gate) => (
                  <tr
                    key={gate.id}
                    className="clickable"
                    onClick={() => setSelectedGate(gate.id)}
                  >
                    <td>{gate.priority}</td>
                    <td>
                      <span className="badge badge-neutral">{gate.lane}</span>
                    </td>
                    <td>{gate.track}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* By lane */}
      <div className="card">
        <h3>By Lane</h3>
        <div className="grid grid-3">
          {(["heavy", "light", "remote"] as const).map((lane) => (
            <div key={lane} className="lane-group">
              <div className="lane-title">
                <span className="lane-name">{lane}</span>
                <span className="lane-count">{byLane[lane].length}</span>
              </div>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {byLane[lane].slice(0, 5).map((gate) => (
                  <li
                    key={gate.id}
                    style={{
                      padding: "0.5rem",
                      marginBottom: "0.25rem",
                      background: "var(--bg-secondary)",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                    }}
                  >
                    <span
                      className={`badge ${
                        gate.status === "running"
                          ? "badge-success"
                          : "badge-neutral"
                      }`}
                    >
                      {gate.status}
                    </span>{" "}
                    {gate.track}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Recent results */}
      <div className="card">
        <h3>Recent Results (24h)</h3>
        {results.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No recent results</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>RC</th>
                <th>Gate ID</th>
                <th>Failed Steps</th>
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 15).map((result) => (
                <tr
                  key={result.id}
                  className="clickable"
                  onClick={() => setSelectedGate(result.id)}
                >
                  <td>
                    <span
                      className={`badge ${result.rc === 0 ? "badge-success" : "badge-error"}`}
                    >
                      {result.rc}
                    </span>
                  </td>
                  <td style={{ fontSize: "0.85rem" }}>{result.id}</td>
                  <td style={{ color: "var(--error)", fontSize: "0.85rem" }}>
                    {result.failedSteps?.join(", ") || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pipelines from the project config: runs, executors, fallbacks, minutes */}
      <PipelineRuns project={project} refreshKey={refreshKey} />

      {/* Gate log panel */}
      {selectedGate && (
        <>
          <div className="overlay" onClick={() => setSelectedGate(null)} />
          <GateLogPanel
            gateId={selectedGate}
            project={project}
            refreshKey={refreshKey}
            onClose={() => setSelectedGate(null)}
          />
        </>
      )}
    </div>
  );
}

interface GateLogPanelProps {
  gateId: string;
  project: string;
  refreshKey: number;
  onClose: () => void;
}

function GateLogPanel({
  gateId,
  project,
  refreshKey,
  onClose,
}: GateLogPanelProps) {
  const { data, loading } = useApi<{ id: string; log: string | null }>(
    `/gates/${gateId}/log`,
    project,
    refreshKey,
  );

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h2>Gate Log</h2>
        <button className="detail-panel-close" onClick={onClose}>
          ×
        </button>
      </div>
      <p
        style={{
          marginBottom: "1rem",
          fontSize: "0.85rem",
          color: "var(--text-secondary)",
        }}
      >
        {gateId}
      </p>
      {loading ? (
        <div className="loading">Loading log...</div>
      ) : data?.log ? (
        <div className="code">{data.log}</div>
      ) : (
        <p style={{ color: "var(--text-secondary)" }}>No log available</p>
      )}
    </div>
  );
}
