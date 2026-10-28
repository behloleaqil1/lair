/**
 * LiveFeed - Home's recent activity: the agents' reports and claims, live
 * from the fleet bus (SSE). The agent, gate and PR of an event link to their
 * detail.
 *
 * The stream (hooks/event-stream.ts) reconnects with backoff when the server
 * goes away and comes back (a restart), and the header says "Reconnecting…"
 * meanwhile.
 */
import { useState, useEffect, useRef } from "react";
import type { BoardOutput, ReportKind } from "../../shared/types";
import { EventStream } from "../hooks/event-stream";
import { connectionLabel, type ConnectionStatus } from "../hooks/reconnect";
import { linkTo } from "../router";
import { Time } from "./ui";
import { Badge } from "../ui/Badge";
import type { Tone } from "../ui/tokens";

interface LiveFeedProps {
  project: string;
  /** At most this many events are shown */
  limit?: number;
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

/** Each report kind's tone: its colour and icon beside the word */
const KIND_TONE: Record<ReportKind, Tone> = {
  DONE: "success",
  WAITING: "warning",
  BLOCKED: "danger",
  PROGRESS: "info",
  TICK: "neutral",
};

export function LiveFeed({ project, limit = 20 }: LiveFeedProps) {
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
    setEvents([]);

    const onBoard = (data: string) => {
      try {
        const newBoard = JSON.parse(data) as BoardOutput;

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

  return (
    <div className="card live-feed">
      <div className="feed-header">
        <h3>Recent activity</h3>
        <Badge
          tone={status === "connected" ? "success" : status === "closed" ? "danger" : "warning"}
          title={retryInMs !== null ? `Next try in ${Math.ceil(retryInMs / 1000)} s` : undefined}
          className={`connection-status ${status === "connected" ? "connected" : status === "closed" ? "disconnected" : "reconnecting"}`}
        >
          {connectionLabel(status)}
        </Badge>
      </div>

      {error && (
        <div className="error live-feed-error" role="alert">
          {error}
        </div>
      )}

      <div className="live-feed-events">
        {events.length === 0 ? (
          <div className="live-feed-empty muted">
            No recent activity: agents&apos; reports (WAITING, DONE, BLOCKED) show here as they write them.
          </div>
        ) : (
          events.slice(0, limit).map((event) => (
            <div key={event.id} className={`feed-event feed-event-${event.type}`}>
              <span className="feed-time">
                <Time iso={event.time} />
              </span>

              {event.type === "report" && event.kind && (
                <Badge tone={KIND_TONE[event.kind]} className="feed-kind">
                  {event.kind}
                </Badge>
              )}

              {event.type === "claim" && (
                <Badge tone="info" className="feed-kind feed-claim">
                  CLAIM
                </Badge>
              )}

              <span className="feed-task">{event.task}</span>

              {event.agent && (
                <span className="feed-agent">
                  by <a href={linkTo("work", event.agent)}>{event.agent}</a>
                </span>
              )}

              {event.summary && (
                <span className="feed-summary">{event.summary}</span>
              )}

              {event.gate_id && (
                <a className="feed-gate" href={linkTo("gates", event.gate_id)} title={event.gate_id}>
                  Gate
                </a>
              )}

              {event.pr && (
                <a className="feed-pr" href={linkTo("prs", String(event.pr))}>
                  PR #{event.pr}
                </a>
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

    </div>
  );
}
