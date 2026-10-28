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
import { processAction } from "../owner-actions";
import { SignInHint } from "./SignInHint";
import { Badge, StatusBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";
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
      const data = await processAction(project, processId, action);
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
      <PageHeader
        title={`Processes (${processes.length})`}
        status={
          <Badge tone="info" title="Polling mode - refresh interval 10s">
            Polling
          </Badge>
        }
        actions={
          <Badge tone={supervisorRunning ? "success" : "danger"}>Supervisor: {supervisorRunning ? "Running" : "Stopped"}</Badge>
        }
      />

      {!controlsReadOnly && <SignInHint what="Starting, stopping and restarting processes" refreshKey={refreshKey} />}

      {actionError && (
        <Callout tone="danger" alert>
          {actionError}
        </Callout>
      )}

      {processes.length === 0 ? (
        <div className="card">
          <p className="muted">
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
                    className={`clickable${expandedProcess === proc.id ? " selected" : ""}`}
                    onClick={() => toggleExpand(proc.id)}
                  >
                    <td>
                      <Badge tone={STATUS_BADGE_CLASS[proc.status]}>{proc.status}</Badge>
                    </td>
                    <td>
                      <strong>{proc.name}</strong>
                      <br />
                      <code className="muted small">
                        {proc.id}
                      </code>
                    </td>
                    <td>
                      {proc.pid ? (
                        <code>{proc.pid}</code>
                      ) : (
                        <span className="muted">
                          -
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.status === "running" &&
                      proc.metrics.uptimeMs > 0 ? (
                        formatUptime(proc.metrics.uptimeMs)
                      ) : (
                        <span className="muted">
                          -
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.restartCount > 0 ? (
                        <span className={proc.restartCount > 5 ? "text-danger" : "muted"}>
                          {proc.restartCount}
                        </span>
                      ) : (
                        <span className="muted">
                          0
                        </span>
                      )}
                    </td>
                    <td>
                      {proc.config.healthCheck ? (
                        <StatusBadge status={proc.healthy ? "ok" : "failing"} />
                      ) : (
                        <span className="muted">
                          -
                        </span>
                      )}
                    </td>
                    {!controlsReadOnly && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row">
                          {proc.status === "running" ? (
                            <>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => handleAction(proc.id, "stop")}
                                disabled={actionLoading === `${proc.id}-stop`}
                              >
                                {actionLoading === `${proc.id}-stop` ? "..." : "Stop"}
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => handleAction(proc.id, "restart")}
                                disabled={actionLoading === `${proc.id}-restart`}
                              >
                                {actionLoading === `${proc.id}-restart` ? "..." : "Restart"}
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => handleAction(proc.id, "start")}
                              disabled={actionLoading === `${proc.id}-start` || proc.status === "starting"}
                            >
                              {actionLoading === `${proc.id}-start` ? "..." : "Start"}
                            </Button>
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
    <div className="process-detail">
      {/* Process Info */}
      <div className="process-facts">
        <div>
          <h4 className="process-fact">
            Command
          </h4>
          <code className="small">
            {process.config.command.join(" ")}
          </code>
        </div>
        {process.config.cwd && (
          <div>
            <h4 className="process-fact">
              Working Directory
            </h4>
            <code className="small">{process.config.cwd}</code>
          </div>
        )}
        <div>
          <h4 className="process-fact">
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
            <h4 className="process-fact">
              Last Restart Reason
            </h4>
            <span className="text-warning">
              {process.lastRestartReason}
            </span>
          </div>
        )}
        {process.exitCode !== undefined && (
          <div>
            <h4 className="process-fact">
              Last Exit Code
            </h4>
            <span className={process.exitCode === 0 ? "text-success" : "text-danger"}>
              {process.exitCode}
              {process.exitSignal && ` (${process.exitSignal})`}
            </span>
          </div>
        )}
        {process.config.healthCheck && (
          <div>
            <h4 className="process-fact">
              Health Check
            </h4>
            <span>
              {process.config.healthCheck.type}
              {process.metrics.healthCheckFailures > 0 && (
                <span className="text-danger"> 
                  ({process.metrics.healthCheckFailures} failures)
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Logs */}
      <div>
        <h4 className="process-fact">
          Recent Logs
        </h4>
        <div className="code" style={{ maxHeight: "300px" }} tabIndex={0} role="region" aria-label="Recent logs">
          {logsData?.logs && logsData.logs.length > 0 ? (
            logsData.logs.map((line, i) => (
              <div key={i} className={line.stream === "stderr" ? "log-line text-danger" : "log-line"}>
                <span className="log-time muted">
                  {new Date(line.timestamp).toLocaleTimeString()}
                </span>
                {line.text}
              </div>
            ))
          ) : (
            <span className="muted">
              No logs available
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
