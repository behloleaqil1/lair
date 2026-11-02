/**
 * Home → Bus (docs/design/phase3-bus.md §2): the fleet bus's activity, live
 * (reports as cards with their gate and PR links, claims, and messages with
 * their delivery state: sent, read, acknowledged), and the bus consumers'
 * comparison (observe mode: matches and mismatches).
 *
 * The first page is GET /api/bus/activity (bounded); updates come on the
 * `bus` WebSocket channel and are merged in (bus-feed.ts). The socket carries
 * no message texts: they come with the first page, for the owner's session
 * only. While the project's bus.consume is off the tab says so and asks for
 * nothing but the consumers' status (the bus routes answer 404 then).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { connectionLabel, type ConnectionStatus } from "../hooks/reconnect";
import { feedFromActivity, mergeFeed, parseBusUpdate, type FeedItem } from "../bus-feed";
import type { BusActivity, BusMessageState } from "../../shared/bus-live";
import type { ReportKind } from "../../shared/types";
import { linkTo } from "../router";
import { Badge } from "../ui/Badge";
import type { Tone } from "../ui/tokens";
import { BusConsumersView, type BusConsumersStatus } from "./Health";
import { ErrorState, Loading, ModuleOff, Time, useOwnerSignedIn } from "./ui";

interface Props {
  project: string;
  refreshKey: number;
}

/** How many of each kind the first page asks for (the server allows at most 200) */
const FIRST_PAGE = 100;

const KIND_TONE: Record<ReportKind, Tone> = { DONE: "success", WAITING: "warning", BLOCKED: "danger", PROGRESS: "info", TICK: "neutral" };
const STATE: Record<BusMessageState, { label: string; tone: Tone }> = {
  sent: { label: "Sent", tone: "neutral" },
  read: { label: "Read", tone: "info" },
  acknowledged: { label: "Acknowledged", tone: "success" },
};

export const BUS_OFF_ENABLE =
  "Set bus.consume: observe (or on) in the project's YAML: agents' runs then post their reports to the bus (docs/configuration.md#fleet-bus).";

export function BusPanel({ project, refreshKey }: Props) {
  const consumers = useApi<BusConsumersStatus>("/bus/consumers", project, refreshKey);
  if (!consumers.data) {
    return consumers.error ? <ErrorState what="the bus" error={consumers.error} /> : <Loading what="the bus" />;
  }
  if (consumers.data.mode === "off") return <ModuleOff what="The bus" enable={BUS_OFF_ENABLE} />;
  return (
    <div className="bus-panel">
      <BusLiveFeed project={project} />
      <BusConsumersView status={consumers.data} />
    </div>
  );
}

function BusLiveFeed({ project }: { project: string }) {
  const signedIn = useOwnerSignedIn();
  // Bumped to load the first page again: after a reconnect (updates may have been missed) or a burst the server cut
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const activity = useApi<BusActivity>(`/bus/activity?limit=${FIRST_PAGE}`, project, reloadKey, {
    owner: signedIn === true,
    skip: signedIn === null,
  });
  const [items, setItems] = useState<FeedItem[]>([]);
  const everConnected = useRef(false);

  useEffect(() => setItems([]), [project]);
  useEffect(() => {
    if (activity.data) setItems((prev) => mergeFeed(prev, feedFromActivity(activity.data!)));
  }, [activity.data]);

  const socket = useWebSocket({
    project,
    channels: ["bus"],
    onBusUpdate: (data) => {
      const update = parseBusUpdate(data);
      if (!update) return;
      setItems((prev) => mergeFeed(prev, update.items));
      // A cut burst, or an acknowledgement whose note only the first page carries (for the owner)
      if (update.dropped > 0 || (signedIn === true && update.items.some((i) => i.type === "message" && i.state === "acknowledged"))) reload();
    },
    onConnectionChange: (connected) => {
      if (connected && everConnected.current) reload();
      if (connected) everConnected.current = true;
    },
  });

  return (
    <BusFeedView
      items={items}
      status={socket.status}
      owner={activity.data?.owner === true}
      error={activity.data ? null : activity.error}
    />
  );
}

export interface BusFeedViewProps {
  items: readonly FeedItem[];
  status: ConnectionStatus;
  /** Message texts are shown (the first page came with the owner's session) */
  owner: boolean;
  error: string | null;
}

/** The feed itself. Stateless: BusLiveFeed holds the state. */
export function BusFeedView({ items, status, owner, error }: BusFeedViewProps) {
  return (
    <div className="card live-feed bus-feed">
      <div className="feed-header">
        <h3>Bus activity</h3>
        <Badge tone={status === "connected" ? "success" : status === "closed" ? "danger" : "warning"}>{connectionLabel(status)}</Badge>
      </div>
      {error && (
        <div className="error live-feed-error" role="alert">
          {error}
        </div>
      )}
      {!owner && (
        <p className="muted small" data-bus="no-texts">
          Message texts show only to the owner: <a href={linkTo("decisions")}>sign in</a> to see them.
        </p>
      )}
      {items.length === 0 ? (
        <div className="live-feed-empty muted">No bus activity yet: agents&apos; reports, claims and messages show here as they happen.</div>
      ) : (
        <ul className="live-feed-events bus-feed-items">
          {items.map((item) => (
            <li key={item.key} className={`feed-event feed-event-${item.type}`} data-bus-item={item.type}>
              <span className="feed-time">
                <Time iso={item.at} />
              </span>
              <FeedItemBody item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const agentLink = (agent: string) => <a href={linkTo("work", agent)}>{agent}</a>;

function FeedItemBody({ item }: { item: FeedItem }) {
  if (item.type === "report") {
    return (
      <>
        <Badge tone={KIND_TONE[item.kind]} className="feed-kind">
          {item.kind}
        </Badge>
        <span className="feed-task">{item.task}</span> <span className="feed-agent">by {agentLink(item.agent)}</span>
        {item.summary && <span className="feed-summary">{item.summary}</span>}
        {item.gateId && (
          <a className="feed-gate" href={linkTo("gates", item.gateId)} title={item.gateId}>
            Gate {item.gateId}
          </a>
        )}
        {item.pr !== null && (
          <a className="feed-pr" href={linkTo("prs", String(item.pr))}>
            PR #{item.pr}
          </a>
        )}
        {item.sha && (
          <span className="feed-sha" title={item.sha}>
            {item.sha.slice(0, 7)}
          </span>
        )}
      </>
    );
  }
  if (item.type === "claim") {
    return (
      <>
        <Badge tone="info" className="feed-kind feed-claim">
          {item.claim === "taken" ? "CLAIMED" : "RELEASED"}
        </Badge>
        <span className="feed-task">{item.task}</span> <span className="feed-agent">by {agentLink(item.agent)}</span>
      </>
    );
  }
  const state = STATE[item.state];
  return (
    <>
      <Badge tone="neutral" plain className="feed-kind">
        MESSAGE
      </Badge>
      <span className="feed-agent">
        {item.from ? <>{item.from} → </> : "to "}
        {item.to}
      </span>
      <Badge tone={state.tone} className="bus-message-state">
        {state.label}
      </Badge>
      {item.text && <span className="feed-summary">{item.text}</span>}
      {item.ackNote && <span className="feed-summary muted">Note: {item.ackNote}</span>}
    </>
  );
}
