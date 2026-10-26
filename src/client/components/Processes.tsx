/**
 * Processes view - Lair process manager UI
 *
 * Features:
 * - List of processes with status badges
 * - Start/Stop/Restart buttons
 * - Expandable log viewer per process
 */
import { useState, useEffect } from "react";
import { useApi } from "../hooks/useApi";
import type {
  ProcessState,
  ProcessListResponse,
  ProcessLogsResponse,
  ProcessStatus,
} from "../../shared/process-types";

interface Props {
  project: string;
  refreshKey: number;
}

const STATUS_BADGE_CLASS: Record<ProcessStatus, string> = {
  running: "badge-success",
  stopped: "badge-neutral",
  starting: "badge-warning",
  stopping: "badge-warning",
  failed: "badge-error",
  unhealthy: "badge-error",
};

const STATUS_ICONS: Record<ProcessStatus, string> = {
  running: "▶",
  stopped: "■",
  starting: "⟳",
  stopping: "⏳",
  failed: "✗",
  unhealthy: "⚠",
};

export function Processes({ project, refreshKey }: Props) {
  const {
    data: processData,
    loading,
    error,
  } = useApi<ProcessListResponse>("/processes", project, refreshKey);
  const [expandedProcess, setExpandedProcess] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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

  if (loading) return <div className="loading">Loading processes...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!processData) return null;

  const { processes, supervisorRunning } = processData;

  const handleAction = async (
    processId: string,
    action: "start" | "stop" | "restart",
  ) => {
    setActionLoading(`${processId}-${action}`);
    setActionError(null);

    try {
      const response = await fetch(
        `/api/processes/${processId}/${action}?project=${encodeURIComponent(project)}`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!data.success) {
        setActionError(data.error || `Failed to ${action} process`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleExpand = (processId: string) => {
    setExpandedProcess(expandedProcess === processId ? null : processId);
  };

  const formatUptime = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
    return `${Math.round(ms / 86400000)}d`;
  };

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
          <h2>Processes ({processes.length})</h2>
          <span
            className="badge badge-neutral"
            style={{ fontSize: "0.7rem" }}
            title="Polling mode - refresh interval 10s"
          >
            📡 Polling
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            className={`badge ${supervisorRunning ? "badge-success" : "badge-error"}`}
          >
            Supervisor: {supervisorRunning ? "Running" : "Stopped"}
          </span>
        </div>
      </div>

      {actionError && (
        <div
          className="card"
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            borderColor: "var(--error)",
            marginBottom: "1rem",
          }}
        >
          <p style={{ color: "var(--error)", margin: 0 }}>{actionError}</p>
        </div>
      )}

      {processes.length === 0 ? (
        <div className="card">
          <p style={{ color: "var(--text-secondary)" }}>
            No processes configured. Add a <code>processes</code> section to
            your project YAML to manage background processes.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>PID</th>
                <th>Uptime</th>
                <th>Restarts</th>
                <th>Health</th>
                {!controlsReadOnly && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {processes.map((proc) => (
                <>
                  <tr
                    key={proc.id}
                    className="clickable"
                    onClick={() => toggleExpand(proc.id)}
                    style={
                      expandedProcess === proc.id
                        ? { background: "rgba(233, 69, 96, 0.1)" }
                        : {}
                    }
                  >
                    <td>
                      <span
                        className={`badge ${STATUS_BADGE_CLASS[proc.status]}`}
                      >
                        {STATUS_ICONS[proc.status]} {proc.status}
                      </span>
                    </td>
                    <td>
                      <strong>{proc.name}</strong>
                      <br />
                      <code
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {proc.id}
                      </code>
                    </td>
                    <td>
                      {proc.pid ? (
                        <code>{proc.pid}</code>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>
                          -
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.status === "running" &&
                      proc.metrics.uptimeMs > 0 ? (
                        formatUptime(proc.metrics.uptimeMs)
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>
                          -
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.restartCount > 0 ? (
                        <span
                          style={{
                            color:
                              proc.restartCount > 5
                                ? "var(--error)"
                                : "var(--text-secondary)",
                          }}
                        >
                          {proc.restartCount}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>
                          0
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.config.healthCheck ? (
                        <span
                          className={`badge ${proc.healthy ? "badge-success" : "badge-error"}`}
                        >
                          {proc.healthy ? "✓" : "✗"}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-secondary)" }}>
                          -
                        </span>
                      )}
                    </td>
                    {!controlsReadOnly && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: "flex", gap: "0.25rem" }}>
                          {proc.status === "running" ? (
                            <>
                              <button
                                onClick={() => handleAction(proc.id, "stop")}
                                disabled={actionLoading === `${proc.id}-stop`}
                                style={{
                                  padding: "0.25rem 0.5rem",
                                  borderRadius: "4px",
                                  border: "none",
                                  background: "var(--error)",
                                  color: "white",
                                  cursor: "pointer",
                                  fontSize: "0.85rem",
                                  opacity:
                                    actionLoading === `${proc.id}-stop`
                                      ? 0.6
                                      : 1,
                                }}
                              >
                                {actionLoading === `${proc.id}-stop`
                                  ? "..."
                                  : "Stop"}
                              </button>
                              <button
                                onClick={() => handleAction(proc.id, "restart")}
                                disabled={
                                  actionLoading === `${proc.id}-restart`
                                }
                                style={{
                                  padding: "0.25rem 0.5rem",
                                  borderRadius: "4px",
                                  border: "1px solid var(--warning)",
                                  background: "transparent",
                                  color: "var(--warning)",
                                  cursor: "pointer",
                                  fontSize: "0.85rem",
                                  opacity:
                                    actionLoading === `${proc.id}-restart`
                                      ? 0.6
                                      : 1,
                                }}
                              >
                                {actionLoading === `${proc.id}-restart`
                                  ? "..."
                                  : "Restart"}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleAction(proc.id, "start")}
                              disabled={
                                actionLoading === `${proc.id}-start` ||
                                proc.status === "starting"
                              }
                              style={{
                                padding: "0.25rem 0.5rem",
                                borderRadius: "4px",
                                border: "none",
                                background: "var(--success)",
                                color: "white",
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                opacity:
                                  actionLoading === `${proc.id}-start` ||
                                  proc.status === "starting"
                                    ? 0.6
                                    : 1,
                              }}
                            >
                              {actionLoading === `${proc.id}-start`
                                ? "..."
                                : "Start"}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                  {expandedProcess === proc.id && (
                    <tr key={`${proc.id}-detail`}>
                      <td
                        colSpan={controlsReadOnly ? 6 : 7}
                        style={{ padding: 0 }}
                      >
                        <ProcessDetail
                          process={proc}
                          project={project}
                          refreshKey={refreshKey}
                        />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ProcessDetailProps {
  process: ProcessState;
  project: string;
  refreshKey: number;
}

function ProcessDetail({ process, project, refreshKey }: ProcessDetailProps) {
  const { data: logsData } = useApi<ProcessLogsResponse>(
    `/processes/${process.id}/logs?tail=100`,
    project,
    refreshKey,
  );

  return (
    <div
      style={{
        padding: "1rem",
        background: "rgba(0, 0, 0, 0.2)",
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* Process Info */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h4
            style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
          >
            Command
          </h4>
          <code style={{ fontSize: "0.85rem", wordBreak: "break-all" }}>
            {process.config.command.join(" ")}
          </code>
        </div>
        {process.config.cwd && (
          <div>
            <h4
              style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
            >
              Working Directory
            </h4>
            <code style={{ fontSize: "0.85rem" }}>{process.config.cwd}</code>
          </div>
        )}
        <div>
          <h4
            style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
          >
            Restart Policy
          </h4>
          <span>
            {process.config.restart}
            {process.config.maxRestarts !== -1 &&
              ` (max ${process.config.maxRestarts})`}
          </span>
        </div>
        {process.lastRestartReason && (
          <div>
            <h4
              style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
            >
              Last Restart Reason
            </h4>
            <span style={{ color: "var(--warning)" }}>
              {process.lastRestartReason}
            </span>
          </div>
        )}
        {process.exitCode !== undefined && (
          <div>
            <h4
              style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
            >
              Last Exit Code
            </h4>
            <span
              style={{
                color:
                  process.exitCode === 0 ? "var(--success)" : "var(--error)",
              }}
            >
              {process.exitCode}
              {process.exitSignal && ` (${process.exitSignal})`}
            </span>
          </div>
        )}
        {process.config.healthCheck && (
          <div>
            <h4
              style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}
            >
              Health Check
            </h4>
            <span>
              {process.config.healthCheck.type}
              {process.metrics.healthCheckFailures > 0 && (
                <span style={{ color: "var(--error)", marginLeft: "0.5rem" }}>
                  ({process.metrics.healthCheckFailures} failures)
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Logs */}
      <div>
        <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--text-secondary)" }}>
          Recent Logs
        </h4>
        <div
          className="code"
          style={{
            maxHeight: "300px",
            overflow: "auto",
            fontSize: "0.8rem",
            fontFamily: "monospace",
          }}
        >
          {logsData?.logs && logsData.logs.length > 0 ? (
            logsData.logs.map((line, i) => (
              <div
                key={i}
                style={{
                  color:
                    line.stream === "stderr" ? "var(--error)" : "var(--text)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                <span
                  style={{
                    color: "var(--text-secondary)",
                    marginRight: "0.5rem",
                  }}
                >
                  {new Date(line.timestamp).toLocaleTimeString()}
                </span>
                {line.text}
              </div>
            ))
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>
              No logs available
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
