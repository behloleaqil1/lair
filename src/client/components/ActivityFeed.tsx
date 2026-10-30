/**
 * ActivityFeed - Live feed of bus reports and messages.
 *
 * Shows structured cards for:
 * - Reports: WAITING, DONE, BLOCKED, PROGRESS from agents
 * - Messages: Instructions between agents, owner and orchestrator
 *
 * Each card shows:
 * - The agent and kind (icon + badge)
 * - The summary or message text
 * - Links to gate id and PR number
 * - Delivery state for messages
 *
 * Receives live updates via useLiveUpdates hook.
 */
import { useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useLiveUpdates, type LiveUpdateHandler } from "../hooks/useLiveUpdates";
import { getReportKindDisplay, getDeliveryStateDisplay } from "../hooks/useBusEvents";
import type { BusReport, BusMessage } from "../../shared/bus-types";
import type { BusReportLiveData, BusMessageLiveData, ChangeKind } from "../../shared/live-types";
import { linkTo } from "../router";
import { Icon } from "../ui/Icon";
import { Badge } from "../ui/Badge";
import { Time } from "./ui";
import "./ActivityFeed.css";

const MAX_ITEMS = 50;

type FeedItem =
  | { type: "report"; data: BusReport; timestamp: string }
  | { type: "message"; data: BusMessage; timestamp: string };

interface ActivityFeedProps {
  project: string;
  /** Maximum items to show */
  limit?: number;
}

export function ActivityFeed({ project, limit = MAX_ITEMS }: ActivityFeedProps) {
  // Initial load from REST
  const reportsApi = useApi<BusReport[]>("/bus/reports", project, 0);
  const messagesApi = useApi<BusMessage[]>("/bus/messages", project, 0);

  // Local state for live updates
  const [liveReports, setLiveReports] = useState<BusReport[]>([]);
  const [liveMessages, setLiveMessages] = useState<BusMessage[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Handle live updates
  const handler: LiveUpdateHandler<BusReportLiveData | BusMessageLiveData> = useMemo(
    () => ({
      onUpdate: (id: string, change: ChangeKind, data?: BusReportLiveData | BusMessageLiveData) => {
        if (!data) return;

        // Determine if it's a report or message based on the id prefix
        if (id.startsWith("report:")) {
          const reportData = data as BusReportLiveData;
          if (change === "insert") {
            const report: BusReport = {
              id: reportData.id,
              agent: reportData.agent,
              kind: reportData.kind,
              task: reportData.task,
              summary: reportData.summary,
              timestamp: new Date().toISOString(),
              gateId: reportData.gateId,
              prNumber: reportData.prNumber,
              sha: reportData.sha,
            };
            setLiveReports((prev) => [report, ...prev].slice(0, MAX_ITEMS));
          }
        } else if (id.startsWith("message:")) {
          const messageData = data as BusMessageLiveData;
          if (change === "insert") {
            const message: BusMessage = {
              id: messageData.id,
              from: messageData.from,
              to: messageData.to,
              text: messageData.text,
              timestamp: new Date().toISOString(),
              priority: messageData.priority,
              state: messageData.state,
              ackNote: messageData.ackNote,
            };
            setLiveMessages((prev) => [message, ...prev].slice(0, MAX_ITEMS));
          }
        }
      },
      onRefresh: () => setRefreshKey((k) => k + 1),
    }),
    [],
  );

  const liveState = useLiveUpdates({
    project,
    topics: ["bus"],
    handler,
  });

  // Refetch on reconnect
  const restReports = useApi<BusReport[]>("/bus/reports", project, refreshKey);
  const restMessages = useApi<BusMessage[]>("/bus/messages", project, refreshKey);

  // Merge REST and live data, deduplicating by id
  const allReports = useMemo(() => {
    const byId = new Map<number, BusReport>();
    for (const r of reportsApi.data ?? []) byId.set(r.id, r);
    for (const r of restReports.data ?? []) byId.set(r.id, r);
    for (const r of liveReports) byId.set(r.id, r);
    return Array.from(byId.values());
  }, [reportsApi.data, restReports.data, liveReports]);

  const allMessages = useMemo(() => {
    const byId = new Map<number, BusMessage>();
    for (const m of messagesApi.data ?? []) byId.set(m.id, m);
    for (const m of restMessages.data ?? []) byId.set(m.id, m);
    for (const m of liveMessages) byId.set(m.id, m);
    return Array.from(byId.values());
  }, [messagesApi.data, restMessages.data, liveMessages]);

  // Combine and sort by timestamp
  const items: FeedItem[] = useMemo(() => {
    const combined: FeedItem[] = [
      ...allReports.map((r) => ({ type: "report" as const, data: r, timestamp: r.timestamp })),
      ...allMessages.map((m) => ({ type: "message" as const, data: m, timestamp: m.timestamp })),
    ];
    return combined
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }, [allReports, allMessages, limit]);

  const loading = reportsApi.loading || messagesApi.loading;
  const error = reportsApi.error || messagesApi.error;

  if (loading && items.length === 0) {
    return (
      <div className="activity-feed">
        <p className="muted">Loading activity...</p>
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="activity-feed">
        <p className="error">Failed to load activity: {error}</p>
      </div>
    );
  }

  return (
    <div className="activity-feed" data-live={liveState.live ? "true" : "false"}>
      {items.length === 0 ? (
        <p className="muted">No activity yet. Reports from agents will appear here.</p>
      ) : (
        <ul className="activity-list">
          {items.map((item) =>
            item.type === "report" ? (
              <ReportCard key={`report-${item.data.id}`} report={item.data} />
            ) : (
              <MessageCard key={`message-${item.data.id}`} message={item.data} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: BusReport }) {
  const kindDisplay = getReportKindDisplay(report.kind);

  return (
    <li className={`activity-card activity-report ${kindDisplay.className}`}>
      <div className="activity-header">
        <span className="activity-kind">
          <span className="kind-icon">{kindDisplay.icon}</span>
          <Badge tone={kindBadgeTone(report.kind)}>{kindDisplay.label}</Badge>
        </span>
        <code className="activity-agent">{report.agent}</code>
        <span className="activity-time">
          <Time iso={report.timestamp} />
        </span>
      </div>

      {report.task && (
        <div className="activity-task">
          <code>{report.task}</code>
        </div>
      )}

      <div className="activity-summary">{report.summary}</div>

      {(report.gateId || report.prNumber || report.sha) && (
        <div className="activity-links">
          {report.gateId && (
            <a href={linkTo("gates", report.gateId)} className="activity-link">
              <Icon name="info" size={14} />
              <code>{report.gateId}</code>
            </a>
          )}
          {report.prNumber && (
            <a href={linkTo("prs", String(report.prNumber))} className="activity-link">
              <Icon name="eye" size={14} />
              PR #{report.prNumber}
            </a>
          )}
          {report.sha && (
            <span className="activity-link">
              <Icon name="dot" size={14} />
              <code>{report.sha.slice(0, 7)}</code>
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function MessageCard({ message }: { message: BusMessage }) {
  const stateDisplay = getDeliveryStateDisplay(message.state);

  return (
    <li className="activity-card activity-message">
      <div className="activity-header">
        <span className="activity-kind">
          <Icon name="user" size={14} />
          <span className="message-direction">
            <code>{message.from}</code>
            <Icon name="chevron-right" size={12} />
            <code>{message.to}</code>
          </span>
        </span>
        <span className={`message-state ${stateDisplay.className}`}>
          {stateDisplay.icon} {stateDisplay.label}
        </span>
        <span className="activity-time">
          <Time iso={message.timestamp} />
        </span>
      </div>

      <div className="activity-summary message-text">{message.text}</div>

      {message.priority && message.priority > 1 && (
        <div className="message-priority">
          Priority: {message.priority}
        </div>
      )}

      {message.ackNote && (
        <div className="message-ack-note">
          <Icon name="check-circle" size={12} />
          {message.ackNote}
        </div>
      )}
    </li>
  );
}

function kindBadgeTone(kind: BusReport["kind"]): "badge-success" | "badge-warning" | "badge-error" | "badge-neutral" {
  switch (kind) {
    case "DONE":
      return "badge-success";
    case "WAITING":
    case "PROGRESS":
      return "badge-neutral";
    case "BLOCKED":
      return "badge-error";
    case "TICK":
      return "badge-neutral";
  }
}
