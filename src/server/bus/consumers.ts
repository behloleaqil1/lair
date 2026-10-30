/**
 * Bus consumers: the agents and planner modules subscribe to bus events
 * (bus.report, bus.message) and react to them, so a DONE or BLOCKED reaches
 * fill's state in under 2 seconds (event-driven, no file poll in the path).
 *
 * Configuration (bus.consume: off | observe | on):
 * - off: the file reader is the only source (current behavior)
 * - observe: record what the event WOULD have done next to what the file
 *   reader did, exposed on Home → Health (for comparison before switching)
 * - on: events drive the state; mirrored lines are skipped
 *
 * The mirror appends a marker (`[bus:<id>]`) to mirrored lines. When an event
 * is consumed, the consumer records its bus id; when the file reader sees a
 * line with a marker whose id was already consumed, it skips it.
 */
import type { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import type { ReportKind } from "../../bus/types.js";

// ============ Types ============

export type BusConsumeMode = "off" | "observe" | "on";

/** A bus report event's data (bus.report) */
export interface BusReportEvent {
  project: string;
  id: number;
  agent: string;
  kind: ReportKind;
  task: string;
  gateId?: string;
  pr?: number;
  sha?: string;
}

/** A bus message event's data (bus.message) */
export interface BusMessageEvent {
  project: string;
  id: string;
  from: string;
  to: string;
  priority: number;
}

/** What an event would have done (for observe mode) */
export interface ObservedTransition {
  busId: number | string;
  kind: "report" | "message";
  agent: string;
  task: string | null;
  reportKind?: ReportKind;
  /** What the event handler would have done */
  wouldDo: string;
  /** When the event was received */
  receivedAt: number;
  /** What the file reader did for the same logical event */
  fileDid?: string;
  /** When the file reader acted */
  fileActedAt?: number;
  /** Whether they match */
  match?: boolean;
}

/** A consumed bus event: its id, to skip the mirrored line */
interface ConsumedEvent {
  busId: number;
  consumedAt: number;
}

// ============ Marker parsing ============

/** The marker the mirror adds to lines: `[bus:<id>]` at the end */
const BUS_MARKER_PATTERN = /\[bus:(\d+)\]\s*$/;

/** Extract the bus id from a mirrored line, or null if not a mirrored line */
export function extractBusId(line: string): number | null {
  const match = BUS_MARKER_PATTERN.exec(line);
  return match ? parseInt(match[1], 10) : null;
}

// ============ Consumer state ============

/** Per-project consumer state */
interface ConsumerState {
  mode: BusConsumeMode;
  /** Consumed event ids (bounded: only the last N) */
  consumed: ConsumedEvent[];
  /** Observed transitions (for observe mode, bounded) */
  observed: ObservedTransition[];
  /** Handler subscriptions */
  unsubscribes: Array<() => void>;
}

const MAX_CONSUMED_EVENTS = 10_000;
const MAX_OBSERVED_TRANSITIONS = 1_000;
const CONSUMED_EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============ BusConsumers ============

export interface BusConsumersOptions {
  /** Event bus to subscribe to */
  events: EventBus;
  /** Clock for timestamps */
  clock: { now(): number };
  /** Handler for report events (from fill) */
  onReport: (project: string, event: BusReportEvent, mode: BusConsumeMode) => void;
  /** Handler for message events (from planner, for owner messages) */
  onMessage: (project: string, event: BusMessageEvent, mode: BusConsumeMode) => void;
}

/**
 * Manages bus event consumers for all projects. Each project can be in
 * off/observe/on mode. In on mode, events drive state changes; in observe
 * mode, what would have happened is recorded for comparison.
 */
export class BusConsumers {
  private states = new Map<string, ConsumerState>();
  private options: BusConsumersOptions;

  constructor(options: BusConsumersOptions) {
    this.options = options;
  }

  /** Set the consume mode for a project (called on config load/reload) */
  setMode(project: string, mode: BusConsumeMode): void {
    const existing = this.states.get(project);
    if (existing?.mode === mode) return;

    // Unsubscribe from previous mode
    if (existing) {
      for (const unsub of existing.unsubscribes) {
        unsub();
      }
    }

    // Off mode: no subscriptions
    if (mode === "off") {
      this.states.set(project, {
        mode,
        consumed: [],
        observed: [],
        unsubscribes: [],
      });
      return;
    }

    // observe or on: subscribe to events
    const state: ConsumerState = {
      mode,
      consumed: existing?.consumed ?? [],
      observed: existing?.observed ?? [],
      unsubscribes: [],
    };

    state.unsubscribes.push(
      this.options.events.on("bus.report", (event) => {
        this.handleReport(project, event, state);
      }),
    );

    state.unsubscribes.push(
      this.options.events.on("bus.message", (event) => {
        this.handleMessage(project, event, state);
      }),
    );

    this.states.set(project, state);
  }

  /** Get the current mode for a project */
  getMode(project: string): BusConsumeMode {
    return this.states.get(project)?.mode ?? "off";
  }

  /** Check if a bus id was consumed (for skipping mirrored lines) */
  wasConsumed(project: string, busId: number): boolean {
    const state = this.states.get(project);
    if (!state || state.mode !== "on") return false;
    return state.consumed.some((c) => c.busId === busId);
  }

  /** Mark a bus id as consumed */
  markConsumed(project: string, busId: number): void {
    const state = this.states.get(project);
    if (!state) return;

    const now = this.options.clock.now();

    // Prune old entries
    const cutoff = now - CONSUMED_EVENT_TTL_MS;
    state.consumed = state.consumed.filter((c) => c.consumedAt > cutoff);

    // Add new entry
    state.consumed.push({ busId, consumedAt: now });

    // Bound the size
    if (state.consumed.length > MAX_CONSUMED_EVENTS) {
      state.consumed = state.consumed.slice(-MAX_CONSUMED_EVENTS);
    }
  }

  /** Record an observation (for observe mode) */
  recordObservation(project: string, obs: Omit<ObservedTransition, "receivedAt">): void {
    const state = this.states.get(project);
    if (!state || state.mode !== "observe") return;

    state.observed.push({
      ...obs,
      receivedAt: this.options.clock.now(),
    });

    // Bound the size
    if (state.observed.length > MAX_OBSERVED_TRANSITIONS) {
      state.observed = state.observed.slice(-MAX_OBSERVED_TRANSITIONS);
    }
  }

  /** Record what the file reader did for comparison (observe mode) */
  recordFileAction(project: string, busId: number, action: string): void {
    const state = this.states.get(project);
    if (!state || state.mode !== "observe") return;

    const obs = state.observed.find((o) => o.busId === busId);
    if (obs && obs.fileDid === undefined) {
      obs.fileDid = action;
      obs.fileActedAt = this.options.clock.now();
      obs.match = obs.wouldDo === action;
    }
  }

  /** Get observations for a project (for Health display) */
  getObservations(project: string): ObservedTransition[] {
    const state = this.states.get(project);
    return state?.observed ?? [];
  }

  /** Get the health summary for observe mode */
  getHealthSummary(project: string): {
    mode: BusConsumeMode;
    observations: number;
    matches: number;
    mismatches: number;
    pending: number;
  } {
    const state = this.states.get(project);
    if (!state) {
      return { mode: "off", observations: 0, matches: 0, mismatches: 0, pending: 0 };
    }

    let matches = 0;
    let mismatches = 0;
    let pending = 0;

    for (const obs of state.observed) {
      if (obs.match === undefined) pending++;
      else if (obs.match) matches++;
      else mismatches++;
    }

    return {
      mode: state.mode,
      observations: state.observed.length,
      matches,
      mismatches,
      pending,
    };
  }

  /** Stop all consumers (cleanup) */
  stop(): void {
    for (const state of this.states.values()) {
      for (const unsub of state.unsubscribes) {
        unsub();
      }
    }
    this.states.clear();
  }

  // ============ Event handlers ============

  private handleReport(project: string, event: Event, state: ConsumerState): void {
    const data = event.data as unknown as BusReportEvent;
    if (data.project !== project) return;

    // Call the handler with the mode
    this.options.onReport(project, data, state.mode);

    // In on mode, mark as consumed so the mirrored line is skipped
    if (state.mode === "on") {
      this.markConsumed(project, data.id);
    }
  }

  private handleMessage(project: string, event: Event, state: ConsumerState): void {
    const data = event.data as unknown as BusMessageEvent;
    if (data.project !== project) return;

    // Call the handler with the mode
    this.options.onMessage(project, data, state.mode);
  }
}
