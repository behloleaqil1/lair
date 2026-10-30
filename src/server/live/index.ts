/**
 * Live update publisher - pushes changes to WebSocket clients per topic.
 *
 * Modules emit changes by calling publish(). The publisher:
 * 1. Coalesces bursts: at most one message per row per 250ms
 * 2. Caps message size: drops data over 8KB
 * 3. Broadcasts to subscribed clients
 *
 * The flow:
 * - Module emits event (event-bus.ts) -> LivePublisher subscribes to it
 * - LivePublisher queues the update with coalescing
 * - After 250ms (or immediately if different row), broadcasts to WebSocket
 */
import type { LairWebSocketServer } from "../websocket.js";
import type { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import type {
  LiveTopic,
  ChangeKind,
  LiveUpdate,
  DragonLiveData,
  GateLiveData,
  DecisionLiveData,
  MachineLiveData,
  BusReportLiveData,
  BusMessageLiveData,
} from "../../shared/live-types.js";

const COALESCE_MS = 250;
const MAX_DATA_BYTES = 8192;

interface QueuedUpdate {
  topic: LiveTopic;
  id: string;
  change: ChangeKind;
  data?: unknown;
  project?: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Live update publisher.
 * Subscribes to events and pushes topic-based updates to WebSocket clients.
 */
export class LivePublisher {
  private pending = new Map<string, QueuedUpdate>();
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly ws: LairWebSocketServer,
    private readonly events: EventBus,
  ) {
    this.subscribeToEvents();
  }

  /**
   * Publish a live update. Coalesces updates to the same row.
   */
  publish(
    topic: LiveTopic,
    id: string,
    change: ChangeKind,
    data?: unknown,
    project?: string,
  ): void {
    const key = `${project ?? ""}:${topic}:${id}`;
    const existing = this.pending.get(key);

    // Cancel pending timer for this row
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Check data size
    let safeData = data;
    if (data !== undefined) {
      const json = JSON.stringify(data);
      if (json.length > MAX_DATA_BYTES) {
        // Drop large data, send just the id so client refetches
        safeData = undefined;
      }
    }

    // Queue with coalesce delay
    const timer = setTimeout(() => {
      this.flush(key);
    }, COALESCE_MS);

    this.pending.set(key, { topic, id, change, data: safeData, project, timer });
  }

  /**
   * Flush a pending update to WebSocket clients.
   */
  private flush(key: string): void {
    const update = this.pending.get(key);
    if (!update) return;
    this.pending.delete(key);

    const message: LiveUpdate = {
      topic: update.topic,
      id: update.id,
      change: update.change,
      data: update.data,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to the topic channel
    this.ws.broadcast(update.topic, message, { project: update.project });
  }

  /**
   * Subscribe to server events and convert them to live updates.
   */
  private subscribeToEvents(): void {
    // Dragons: status changes from file watcher
    // Already handled by websocket.ts broadcastDragonUpdate

    // Decisions: raised, answered, withdrawn
    this.unsubscribers.push(
      this.events.on("decision.raised", (e) => this.onDecision(e, "insert")),
      this.events.on("decision.answered", (e) => this.onDecision(e, "update")),
      this.events.on("decision.expired", (e) => this.onDecision(e, "update")),
      this.events.on("decision.withdrawn", (e) => this.onDecision(e, "delete")),
    );

    // Gate pipeline events
    this.unsubscribers.push(
      this.events.on("pipeline.run.started", (e) => this.onGate(e, "insert")),
      this.events.on("pipeline.run.completed", (e) => this.onGate(e, "update")),
      this.events.on("gate.completed", (e) => this.onGateResult(e)),
    );

    // Machines
    this.unsubscribers.push(
      this.events.on("placement.machine_up", (e) => this.onMachine(e, true)),
      this.events.on("placement.machine_down", (e) => this.onMachine(e, false)),
    );

    // Reviews and PRs
    this.unsubscribers.push(
      this.events.on("review.submitted", (e) => this.onPr(e)),
      this.events.on("review.merged", (e) => this.onPr(e)),
      this.events.on("review.merge_refused", (e) => this.onPr(e)),
    );

    // Bus reports and messages
    this.unsubscribers.push(
      this.events.on("bus.report", (e) => this.onBusReport(e)),
      this.events.on("bus.message", (e) => this.onBusMessage(e)),
    );

    // Agent runs
    this.unsubscribers.push(
      this.events.on("agent.run.started", (e) => this.onAgentRun(e, "insert")),
      this.events.on("agent.run.ended", (e) => this.onAgentRun(e, "update")),
    );

    // Planner
    this.unsubscribers.push(
      this.events.on("planner.changed", (e) => this.onPlanner(e)),
      this.events.on("planner.proposals_pending", (e) => this.onPlanner(e)),
    );

    // Delivery
    this.unsubscribers.push(
      this.events.on("delivery.started", (e) => this.onDelivery(e)),
      this.events.on("delivery.finished", (e) => this.onDelivery(e)),
    );

    // Triage
    this.unsubscribers.push(
      this.events.on("triage.classified", (e) => this.onTriage(e)),
      this.events.on("triage.recheck_resolved", (e) => this.onTriage(e)),
    );

    // Placement
    this.unsubscribers.push(
      this.events.on("placement.moved", (e) => this.onPlacement(e)),
    );

    // Watchdog
    this.unsubscribers.push(
      this.events.on("slo.breached", (e) => this.onWatchdog(e)),
      this.events.on("slo.recovered", (e) => this.onWatchdog(e)),
    );
  }

  private onDecision(event: Event, change: ChangeKind): void {
    const { project, decision } = event.data as { project?: string; decision?: { id: string; status?: string; answeredBy?: string; answeredAt?: string } };
    if (!decision?.id) return;
    const data: DecisionLiveData = {
      id: decision.id,
      status: decision.status as DecisionLiveData["status"],
      answeredBy: decision.answeredBy,
      answeredAt: decision.answeredAt,
    };
    this.publish("decisions", decision.id, change, data, project);
  }

  private onGate(event: Event, change: ChangeKind): void {
    const { project, runId, gate, status, rc } = event.data as {
      project?: string;
      runId?: string;
      gate?: string;
      status?: string;
      rc?: number;
    };
    const id = runId ?? gate;
    if (!id) return;
    const data: GateLiveData = {
      id,
      status: status as GateLiveData["status"],
      rc,
    };
    this.publish("gates", id, change, data, project);
  }

  private onGateResult(event: Event): void {
    const { project, result } = event.data as { project?: string; result?: { id: string; rc?: number; failedSteps?: string[] } };
    if (!result?.id) return;
    const data: GateLiveData = {
      id: result.id,
      status: "completed",
      rc: result.rc,
    };
    this.publish("gates", result.id, "update", data, project);
  }

  private onMachine(event: Event, up: boolean): void {
    const { project, machine } = event.data as { project?: string; machine?: string };
    if (!machine) return;
    const data: MachineLiveData = {
      name: machine,
      up,
      lastCheck: new Date().toISOString(),
    };
    this.publish("machines", machine, "update", data, project);
  }

  private onPr(event: Event): void {
    const { project, number, state, verdict } = event.data as {
      project?: string;
      number?: number;
      state?: string;
      verdict?: string;
    };
    if (!number) return;
    this.publish("prs", String(number), "update", { number, state, verdict }, project);
  }

  private onBusReport(event: Event): void {
    const { project, report } = event.data as { project?: string; report?: BusReportLiveData };
    if (!report?.id) return;
    this.publish("bus", `report:${report.id}`, "insert", report, project);
  }

  private onBusMessage(event: Event): void {
    const { project, message } = event.data as { project?: string; message?: BusMessageLiveData };
    if (!message?.id) return;
    this.publish("bus", `message:${message.id}`, "insert", message, project);
  }

  private onAgentRun(event: Event, change: ChangeKind): void {
    const { project, runId, agent, state } = event.data as {
      project?: string;
      runId?: string;
      agent?: string;
      state?: string;
    };
    if (!runId) return;
    this.publish("agents", runId, change, { runId, agent, state }, project);
  }

  private onPlanner(event: Event): void {
    const { project } = event.data as { project?: string };
    // Planner changes are project-wide, signal a refresh
    this.publish("planner", "tasks", "update", {}, project);
  }

  private onDelivery(event: Event): void {
    const { project, environment, status } = event.data as { project?: string; environment?: string; status?: string };
    if (!environment) return;
    this.publish("delivery", environment, "update", { environment, status }, project);
  }

  private onTriage(event: Event): void {
    const { project, gateId, classification } = event.data as { project?: string; gateId?: string; classification?: string };
    if (!gateId) return;
    this.publish("triage", gateId, "update", { gateId, classification }, project);
  }

  private onPlacement(event: Event): void {
    const { project, jobId, machine } = event.data as { project?: string; jobId?: string; machine?: string };
    if (!jobId) return;
    this.publish("placement", jobId, "update", { jobId, machine }, project);
  }

  private onWatchdog(event: Event): void {
    const { project, sloId, state } = event.data as { project?: string; sloId?: string; state?: string };
    if (!sloId) return;
    this.publish("watchdog", sloId, "update", { sloId, state }, project);
  }

  /**
   * Stop the publisher: clear timers and unsubscribe from events.
   */
  close(): void {
    for (const [, update] of this.pending) {
      clearTimeout(update.timer);
    }
    this.pending.clear();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
