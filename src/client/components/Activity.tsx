/**
 * Activity view - Live activity feed from the bus
 *
 * Shows two sections:
 * 1. Live reports from the bus (WAITING/DONE/BLOCKED/PROGRESS)
 * 2. Audit log of control actions (legacy)
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useBusEvents, getReportKindDisplay } from "../hooks/useBusEvents";
import type { AuditEntry } from "../../shared/types";
import type { BusReport } from "../../shared/bus-types";
import { Icon } from "../ui/Icon";

interface Props {
  project: string;
  refreshKey: number;
}

type ViewMode = "live" | "audit";

export function Activity({ project, refreshKey }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("live");

  // Bus events for live feed
  const [busState] = useBusEvents(project, viewMode === "live");

  // Audit log (legacy)
  const {
    data: auditEntries,
    loading: auditLoading,
    error: auditError,
  } = useApi<AuditEntry[]>("/controls/audit", project, refreshKey);

  return (
    <div>
      <div className="section-head">
        <h2 className="m-0">Activity</h2>
        <div className="segmented" role="group" aria-label="Activity view">
          <button
            type="button"
            className="mode-button"
            aria-pressed={viewMode === "live"}
            onClick={() => setViewMode("live")}
          >
            <Icon name="dot" size={10} className={busState.connected ? "text-success" : "text-danger"} />
            Live Feed
            {busState.connected && <span className="muted xsmall">connected</span>}
          </button>
          <button
            type="button"
            className="mode-button"
            aria-pressed={viewMode === "audit"}
            onClick={() => setViewMode("audit")}
          >
            Audit Log
          </button>
        </div>
      </div>

      {viewMode === "live" ? (
        <LiveFeed
          reports={busState.reports}
          connected={busState.connected}
          error={busState.error}
        />
      ) : (
        <AuditLog
          entries={auditEntries}
          loading={auditLoading}
          error={auditError}
        />
      )}
    </div>
  );
}

/**
 * Live feed of bus reports
 */
function LiveFeed({
  reports,
  connected,
  error,
}: {
  reports: BusReport[];
  connected: boolean;
  error: string | null;
}) {
  if (error && !connected) {
    return (
      <div className="card">
        <div className="error row">
          <Icon name="alert" />
          <span>Connection error: {error}</span>
          <span className="muted small">Reconnecting...</span>
        </div>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          {connected
            ? "No activity yet. Reports from dragons will appear here."
            : "Connecting to bus..."}
        </p>
      </div>
    );
  }

  return (
    <div className="activity-feed">
      {reports.map((report) => (
        <ReportCard key={report.id} report={report} />
      ))}
    </div>
  );
}

/**
 * Report card component
 */
function ReportCard({ report }: { report: BusReport }) {
  const kindDisplay = getReportKindDisplay(report.kind);

  return (
    <div className={`card report-card ${kindDisplay.className}`}>
      <div className="report-header">
        <span className="report-kind">
          <span className="kind-icon">{kindDisplay.icon}</span>
          <span className="kind-label">{kindDisplay.label}</span>
        </span>
        <span className="report-agent">
          {report.agent}
        </span>
        <span className="report-time">
          {formatRelativeTime(report.timestamp)}
        </span>
      </div>

      {report.task && (
        <div className="report-task">
          <code>{report.task}</code>
        </div>
      )}

      <div className="report-summary">
        {report.summary}
      </div>

      {(report.gateId || report.prNumber || report.sha) && (
        <div className="report-links">
          {report.gateId && (
            <span className="report-link">
              🚪 <code>{report.gateId}</code>
            </span>
          )}
          {report.prNumber && (
            <span className="report-link">
              📝 PR #{report.prNumber}
            </span>
          )}
          {report.sha && (
            <span className="report-link">
              🔗 <code>{report.sha.slice(0, 7)}</code>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Audit log view (legacy)
 */
function AuditLog({
  entries,
  loading,
  error,
}: {
  entries: AuditEntry[] | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <div className="loading">Loading audit log...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!entries) return null;

  return (
    <div className="card">
      {entries.length === 0 ? (
        <p className="muted">No audit entries recorded</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Exit</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {entries
              .slice()
              .reverse()
              .map((entry) => (
                <tr key={entry.id}>
                  <td className="small nowrap">
                    {new Date(entry.timestamp).toLocaleString()}
                  </td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    <span
                      className={`badge ${entry.exitCode === 0 ? "badge-success" : "badge-error"}`}
                    >
                      {entry.exitCode}
                    </span>
                  </td>
                  <td className="muted small truncate">
                    {entry.outputTail || "-"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Format timestamp as relative time
 */
function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) {
    return "just now";
  } else if (diffMin < 60) {
    return `${diffMin}m ago`;
  } else if (diffHour < 24) {
    return `${diffHour}h ago`;
  } else {
    return date.toLocaleDateString();
  }
}
