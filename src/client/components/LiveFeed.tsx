/**
 * LiveFeed - Real-time activity feed using SSE from the fleet bus
 *
 * The stream (hooks/event-stream.ts) reconnects with backoff when the server
 * goes away and comes back (a restart), and the header says "Reconnecting…"
 * meanwhile.
 */
import { useState, useEffect, useRef } from "react";
import type { BoardOutput, ReportKind } from "../../shared/types";
import { EventStream } from "../hooks/event-stream";
import { connectionLabel, type ConnectionStatus } from "../hooks/reconnect";

interface LiveFeedProps {
  project: string;
}

interface FeedEvent {
  id: string;
  time: string;
  type: "report" | "claim" | "message";
  agent?: string;
  task?: string;
  kind?: ReportKind;
  summary?: string;
  gate_id?: string;
  pr?: number;
  sha?: string;
}

const KIND_COLORS: Record<ReportKind, string> = {
  DONE: "#4caf50",
  WAITING: "#ff9800",
  BLOCKED: "#f44336",
  PROGRESS: "#2196f3",
  TICK: "#9e9e9e",
};

const KIND_ICONS: Record<ReportKind, string> = {
  DONE: "✅",
  WAITING: "⏳",
  BLOCKED: "🚫",
  PROGRESS: "🔄",
  TICK: "⏱️",
};

export function LiveFeed({ project }: LiveFeedProps) {
  const [board, setBoard] = useState<BoardOutput | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [retryInMs, setRetryInMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousBoardRef = useRef<BoardOutput | null>(null);

  useEffect(() => {
    if (!project) return;
    let active = true;
    // Another project's board is no baseline for this one's changes
    previousBoardRef.current = null;
    setBoard(null);
    setEvents([]);

    const onBoard = (data: string) => {
      try {
        const newBoard = JSON.parse(data) as BoardOutput;
        setBoard(newBoard);

        // Generate events from board changes
        if (previousBoardRef.current) {
          const newEvents = generateEvents(previousBoardRef.current, newBoard);
          if (newEvents.length > 0) {
            setEvents((prev) => [...newEvents, ...prev].slice(0, 100));
          }
        } else {
          // Initial load - show recent reports
          const initialEvents = newBoard.tasks
            .filter((t) => t.last_report)
            .map((t) => ({
              id: `${t.task}-${t.last_report!.time}`,
              time: t.last_report!.time,
              type: "report" as const,
              agent: t.owner ?? undefined,
              task: t.task,
              kind: t.last_report!.kind,
              summary: t.last_report!.summary,
              gate_id: t.last_report!.gate_id,
              pr: t.last_report!.pr,
              sha: t.last_report!.sha,
            }))
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
            .slice(0, 20);
          setEvents(initialEvents);
        }

        previousBoardRef.current = newBoard;
      } catch (err) {
        console.error("Failed to parse board event:", err);
      }
    };

    // The server's own "error" event: it could not read the board
    const onServerError = (data: string) => {
      try {
        const parsed = JSON.parse(data) as { error?: unknown };
        if (typeof parsed.error === "string") setError(parsed.error);
      } catch {
        // Ignore parse errors
      }
    };

    const stream = new EventStream({
      url: `/api/bus/events?project=${encodeURIComponent(project)}`,
      events: ["board", "error"],
      onEvent: (name, data) => {
        if (!active) return;
        if (name === "board") onBoard(data);
        else if (name === "error") onServerError(data);
      },
      onState: (s) => {
        if (!active) return;
        setStatus(s.status);
        setRetryInMs(s.retryInMs);
        if (s.status === "connected") setError(null);
      },
    });
    stream.start();

    return () => {
      active = false;
      stream.stop();
    };
  }, [project]);

  function generateEvents(oldBoard: BoardOutput, newBoard: BoardOutput): FeedEvent[] {
    const events: FeedEvent[] = [];
    const now = new Date().toISOString();

    // Check for new reports
    for (const task of newBoard.tasks) {
      const oldTask = oldBoard.tasks.find((t) => t.task === task.task);

      if (
        task.last_report &&
        (!oldTask?.last_report || task.last_report.time !== oldTask.last_report.time)
      ) {
        events.push({
          id: `${task.task}-${task.last_report.time}`,
          time: task.last_report.time,
          type: "report",
          agent: task.owner ?? undefined,
          task: task.task,
          kind: task.last_report.kind,
          summary: task.last_report.summary,
          gate_id: task.last_report.gate_id,
          pr: task.last_report.pr,
          sha: task.last_report.sha,
        });
      }

      // Check for ownership changes
      if (task.owner && (!oldTask || task.owner !== oldTask.owner)) {
        events.push({
          id: `claim-${task.task}-${now}`,
          time: now,
          type: "claim",
          agent: task.owner,
          task: task.task,
          summary: oldTask?.owner
            ? `${task.owner} claimed (was ${oldTask.owner})`
            : `${task.owner} claimed`,
        });
      }
    }

    return events;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  }

  return (
    <div className="live-feed">
      <div className="live-feed-header">
        <h3>
          🔴 Live Feed
          <span
            className={`connection-status ${status === "connected" ? "connected" : status === "closed" ? "disconnected" : "reconnecting"}`}
            title={retryInMs !== null ? `Next try in ${Math.ceil(retryInMs / 1000)} s` : undefined}
          >
            {connectionLabel(status)}
          </span>
        </h3>
      </div>

      {error && <div className="live-feed-error">{error}</div>}

      {board && (
        <div className="live-feed-summary">
          <span>{board.tasks.length} tasks</span>
          <span>{board.agents.length} agents</span>
          <span>
            {board.tasks.filter((t) => t.owner).length} active
          </span>
        </div>
      )}

      <div className="live-feed-events">
        {events.length === 0 ? (
          <div className="live-feed-empty">No recent activity</div>
        ) : (
          events.map((event) => (
            <div key={event.id} className={`feed-event feed-event-${event.type}`}>
              <span className="feed-time">{formatTime(event.time)}</span>

              {event.type === "report" && event.kind && (
                <span
                  className="feed-kind"
                  style={{ backgroundColor: KIND_COLORS[event.kind] }}
                >
                  {KIND_ICONS[event.kind]} {event.kind}
                </span>
              )}

              {event.type === "claim" && (
                <span className="feed-kind feed-claim">🎯 CLAIM</span>
              )}

              <span className="feed-task">{event.task}</span>

              {event.agent && (
                <span className="feed-agent">by {event.agent}</span>
              )}

              {event.summary && (
                <span className="feed-summary">{event.summary}</span>
              )}

              {event.gate_id && (
                <span className="feed-gate" title={event.gate_id}>
                  🚦 Gate
                </span>
              )}

              {event.pr && (
                <span className="feed-pr">PR #{event.pr}</span>
              )}

              {event.sha && (
                <span className="feed-sha" title={event.sha}>
                  {event.sha.slice(0, 7)}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      <style>{`
        .live-feed {
          background: var(--bg-secondary, #1e1e1e);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
        }

        .live-feed-header {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
        }

        .live-feed-header h3 {
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .connection-status {
          font-size: 12px;
          padding: 2px 8px;
          border-radius: 12px;
          font-weight: normal;
        }

        .connection-status.connected {
          background: #4caf50;
          color: white;
        }

        .connection-status.disconnected {
          background: #f44336;
          color: white;
        }

        .connection-status.reconnecting {
          background: #ff9800;
          color: white;
        }

        .live-feed-error {
          background: #f44336;
          color: white;
          padding: 8px;
          border-radius: 4px;
          margin-bottom: 12px;
        }

        .live-feed-summary {
          display: flex;
          gap: 16px;
          margin-bottom: 12px;
          font-size: 14px;
          color: var(--text-secondary, #888);
        }

        .live-feed-events {
          max-height: 400px;
          overflow-y: auto;
        }

        .live-feed-empty {
          text-align: center;
          color: var(--text-secondary, #888);
          padding: 20px;
        }

        .feed-event {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--border-color, #333);
          font-size: 14px;
        }

        .feed-event:last-child {
          border-bottom: none;
        }

        .feed-time {
          color: var(--text-secondary, #888);
          font-family: monospace;
          min-width: 70px;
        }

        .feed-kind {
          padding: 2px 8px;
          border-radius: 4px;
          color: white;
          font-size: 12px;
          font-weight: bold;
        }

        .feed-claim {
          background: #9c27b0;
        }

        .feed-task {
          font-weight: bold;
          color: var(--text-primary, #fff);
        }

        .feed-agent {
          color: var(--text-secondary, #888);
        }

        .feed-summary {
          color: var(--text-secondary, #aaa);
          flex: 1;
          min-width: 200px;
        }

        .feed-gate,
        .feed-pr,
        .feed-sha {
          font-size: 12px;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--bg-tertiary, #2d2d2d);
        }

        .feed-sha {
          font-family: monospace;
        }
      `}</style>
    </div>
  );
}
