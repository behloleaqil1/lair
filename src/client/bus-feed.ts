/**
 * The Home → Bus feed (components/BusPanel.tsx): the first page from GET
 * /api/bus/activity, then the `bus` WebSocket channel's updates merged in
 * (src/server/bus/live.ts). At most MAX_FEED items, newest first; a message
 * appears once, at its latest delivery state.
 */
import type { BusActivity, BusLiveEvent, BusMessageState } from "../shared/bus-live";
import type { ReportKind } from "../shared/types";

export const MAX_FEED = 200;

export type FeedItem = BusLiveEvent & { key: string };

const STATE_RANK: Record<BusMessageState, number> = { sent: 0, read: 1, acknowledged: 2 };
const KINDS: readonly string[] = ["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"];

function keyOf(item: BusLiveEvent): string {
  if (item.type === "report") return `report:${item.id}`;
  if (item.type === "message") return `message:${item.id}`;
  return `claim:${item.claim}:${item.agent}:${item.task}:${item.at}`;
}

const keyed = (item: BusLiveEvent): FeedItem => ({ ...item, key: keyOf(item) });

/** The first page as feed items. */
export function feedFromActivity(activity: BusActivity): FeedItem[] {
  return mergeFeed(
    [],
    [
      ...activity.reports.map(keyed),
      ...activity.messages.map((m) => keyed({ type: "message", ...m })),
      ...activity.claims.map((c) => keyed({ type: "claim", claim: "taken", ...c })),
    ],
  );
}

/** `incoming` merged into `current`: a message keeps its first time, its text and its highest state. */
export function mergeFeed(current: readonly FeedItem[], incoming: readonly FeedItem[]): FeedItem[] {
  const byKey = new Map(current.map((item) => [item.key, item]));
  for (const item of incoming) {
    const old = byKey.get(item.key);
    if (!old) byKey.set(item.key, item);
    else if (old.type === "message" && item.type === "message") {
      const later = STATE_RANK[item.state] > STATE_RANK[old.state] ? item : old;
      byKey.set(item.key, {
        ...old,
        state: later.state,
        from: old.from ?? item.from,
        text: old.text ?? item.text,
        ackNote: item.ackNote ?? old.ackNote,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_FEED);
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One `bus` channel item checked field by field, or null. */
function parseEvent(e: unknown): FeedItem | null {
  if (!isRecord(e) || !str(e.at)) return null;
  if (e.type === "report" && typeof e.id === "number" && str(e.agent) && str(e.task) && str(e.kind) && KINDS.includes(e.kind)) {
    return keyed({
      type: "report",
      id: e.id,
      at: e.at,
      agent: e.agent,
      task: e.task,
      kind: e.kind as ReportKind,
      summary: typeof e.summary === "string" ? e.summary : "",
      gateId: str(e.gateId) ? e.gateId : null,
      pr: typeof e.pr === "number" ? e.pr : null,
      sha: str(e.sha) ? e.sha : null,
    });
  }
  if (e.type === "message" && str(e.id) && str(e.to) && (e.state === "sent" || e.state === "read" || e.state === "acknowledged")) {
    return keyed({ type: "message", id: e.id, at: e.at, to: e.to, state: e.state, ...(str(e.from) ? { from: e.from } : {}) });
  }
  if (e.type === "claim" && str(e.agent) && str(e.task) && (e.claim === "taken" || e.claim === "released")) {
    return keyed({ type: "claim", at: e.at, agent: e.agent, task: e.task, claim: e.claim });
  }
  return null;
}

/** A `bus` channel update's items (what doesn't check is left out), and how many older ones the server dropped. */
export function parseBusUpdate(data: unknown): { items: FeedItem[]; dropped: number } | null {
  if (!isRecord(data) || !Array.isArray(data.events)) return null;
  const events: unknown[] = data.events;
  const items = events.map(parseEvent).filter((item): item is FeedItem => item !== null);
  return { items, dropped: typeof data.dropped === "number" && data.dropped > 0 ? data.dropped : 0 };
}
