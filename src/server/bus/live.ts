/**
 * The fleet bus, live on the dashboard's WebSocket (docs/design/phase3-bus.md §2): a report stored, a message
 * sent, read or acknowledged, and a claim taken or released go out on the project's `bus` channel while its
 * bus.consume isn't off. The socket carries no owner session, so only what any dashboard viewer may see goes out:
 * a message's ids, sender, recipient and state (never its text or ack note: GET /api/bus/activity gives those to
 * the owner's session), a report's fields with its summary cut to BUS_SUMMARY_MAX characters, and nothing of a
 * token (no event here carries one).
 *
 * Bursts are coalesced as the file watcher does: a project's events wait QUIET_MS for more (at most MAX_WAIT_MS
 * after the first), then go out as one update of at most MAX_BATCH events; older ones past that are counted in
 * `dropped` (the Bus tab then reloads its first page).
 */
import type { EventBus } from "../core/event-bus.js";
import type { Event, EventType } from "../../shared/server-types.js";
import { BUS_SUMMARY_MAX, type BusLiveEvent, type BusLiveUpdate } from "../../shared/bus-live.js";
import { validateBusMessageEvent, validateBusReportEvent, type BusConsumeMode } from "./consumers.js";

export const BUS_LIVE_QUIET_MS = 100;
export const BUS_LIVE_MAX_WAIT_MS = 1000;
export const BUS_LIVE_MAX_BATCH = 50;
/** Ids, agents and tasks are cut to this many characters */
const MAX_NAME = 200;

const LIVE_TYPES: readonly EventType[] = ["bus.report", "bus.message", "bus.message_read", "bus.message_acked", "agent.run.started", "agent.run.ended", "agent.claim.released"];

const name = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, MAX_NAME) : null;

/** The live events of one server event, and its project; null for an event that isn't a bus action or doesn't check. */
export function liveEvents(event: Event): { project: string; events: BusLiveEvent[] } | null {
  const data = event.data;
  const project = name(data.project);
  if (!project) return null;
  const at = event.timestamp;
  switch (event.type) {
    case "bus.report": {
      const checked = validateBusReportEvent(data);
      if (!checked.ok) return null;
      const r = checked.value;
      const summary = typeof data.summary === "string" ? data.summary.slice(0, BUS_SUMMARY_MAX) : "";
      return {
        project,
        events: [
          { type: "report", id: r.id, at, agent: r.agent, task: r.task, kind: r.kind, summary, gateId: r.gateId ?? null, pr: r.pr ?? null, sha: r.sha ?? null },
        ],
      };
    }
    case "bus.message": {
      const checked = validateBusMessageEvent(data);
      if (!checked.ok) return null;
      const m = checked.value;
      return { project, events: [{ type: "message", id: m.id.slice(0, MAX_NAME), at, from: m.from.slice(0, MAX_NAME), to: m.to.slice(0, MAX_NAME), state: "sent" }] };
    }
    case "bus.message_read": {
      const to = name(data.agent);
      if (!to || !Array.isArray(data.ids)) return null;
      const ids = data.ids.slice(-BUS_LIVE_MAX_BATCH).map(name).filter((id): id is string => id !== null);
      return { project, events: ids.map((id) => ({ type: "message", id, at, to, state: "read" })) };
    }
    case "bus.message_acked": {
      const to = name(data.agent);
      const id = name(data.id);
      if (!to || !id) return null;
      return { project, events: [{ type: "message", id, at, to, state: "acknowledged" }] };
    }
    case "agent.run.started":
    case "agent.run.ended":
    case "agent.claim.released": {
      const agent = name(data.agent);
      const task = name(data.task);
      if (!agent || !task) return null;
      return { project, events: [{ type: "claim", at, agent, task, claim: event.type === "agent.run.started" ? "taken" : "released" }] };
    }
    default:
      return null;
  }
}

export interface BusLiveOptions {
  events: EventBus;
  /** The project's bus.consume: nothing goes out while it is off */
  mode: (project: string) => BusConsumeMode;
  /** One update on the project's `bus` channel (the WebSocket server's broadcast) */
  publish: (project: string, update: BusLiveUpdate) => void;
  quietMs?: number;
  maxWaitMs?: number;
}

interface Pending {
  events: BusLiveEvent[];
  dropped: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BusLive {
  private readonly pending = new Map<string, Pending>();
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly options: BusLiveOptions) {}

  start(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe = LIVE_TYPES.map((type) => this.options.events.on(type, (event) => this.add(event)));
  }

  /** Stop listening; updates not sent yet are dropped. */
  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  private add(event: Event): void {
    const live = liveEvents(event);
    if (!live || live.events.length === 0 || this.options.mode(live.project) === "off") return;
    const now = Date.now();
    let p = this.pending.get(live.project);
    if (!p) {
      p = { events: [], dropped: 0, deadline: now + (this.options.maxWaitMs ?? BUS_LIVE_MAX_WAIT_MS), timer: null };
      this.pending.set(live.project, p);
    }
    p.events.push(...live.events);
    const over = p.events.length - BUS_LIVE_MAX_BATCH;
    if (over > 0) {
      p.events.splice(0, over);
      p.dropped += over;
    }
    if (p.timer) clearTimeout(p.timer);
    const wait = Math.max(0, Math.min(this.options.quietMs ?? BUS_LIVE_QUIET_MS, p.deadline - now));
    p.timer = setTimeout(() => this.flush(live.project), wait);
    p.timer.unref?.();
  }

  private flush(project: string): void {
    const p = this.pending.get(project);
    this.pending.delete(project);
    if (!p || p.events.length === 0) return;
    try {
      this.options.publish(project, { events: p.events, dropped: p.dropped });
    } catch (e) {
      console.warn(`[bus-live] ${project}: an update was not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
