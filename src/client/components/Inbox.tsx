/**
 * Inbox view - Owner instructions and replies
 */
import { useApi } from "../hooks/useApi";
import type { InboxItem } from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function Inbox({ project, refreshKey }: Props) {
  const {
    data: items,
    loading,
    error,
  } = useApi<InboxItem[]>("/controls/inbox", project, refreshKey);

  if (loading) return <div className="loading">Loading inbox...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!items) return null;

  const pending = items.filter((i) => i.status === "pending");
  const answered = items.filter((i) => i.status === "answered");

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
        <h2>Inbox ({pending.length} pending)</h2>
        <span
          className="badge badge-neutral"
          style={{ fontSize: "0.7rem" }}
          title="Polling mode - refresh interval 10s"
        >
          📡 Polling
        </span>
      </div>

      {/* Pending items */}
      <div className="card">
        <h3>Pending Instructions</h3>
        {pending.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            No pending instructions
          </p>
        ) : (
          <ul className="inbox-list">
            {pending.map((item) => (
              <li key={item.id} className="inbox-item pending">
                <div className="inbox-header">
                  <span className="badge badge-warning">PENDING</span>
                  <span className="inbox-id">[{item.id}]</span>
                  <span className="inbox-time">{item.timestamp}</span>
                </div>
                <p className="inbox-text">{item.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Answered items */}
      <div className="card">
        <h3>Answered</h3>
        {answered.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No answered items</p>
        ) : (
          <ul className="inbox-list">
            {answered
              .slice()
              .reverse()
              .slice(0, 10)
              .map((item) => (
                <li key={item.id} className="inbox-item answered">
                  <div className="inbox-header">
                    <span className="badge badge-success">ANSWERED</span>
                    <span className="inbox-id">[{item.id}]</span>
                    <span className="inbox-time">{item.timestamp}</span>
                  </div>
                  <p className="inbox-text">{item.text}</p>
                  {item.reply && (
                    <div className="inbox-reply">
                      <span className="reply-by">
                        Reply by {item.reply.agent} at {item.reply.timestamp}:
                      </span>
                      <p>{item.reply.text}</p>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
