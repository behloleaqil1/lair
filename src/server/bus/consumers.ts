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

// ============ Report kinds for validation ============

const VALID_REPORT_KINDS: readonly ReportKind[] = ["DONE", "WAITING", "BLOCKED", "PROGRESS"];

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

// ============ Marker parsing ============

/** The marker the mirror adds to lines: `[bus:<id>]` at the end */
const BUS_MARKER_PATTERN = /\[bus:(\d+)\]\s*$/;

/** Extract the bus id from a mirrored line, or null if not a mirrored line */
export function extractBusId(line: string): number | null {
  const match = BUS_MARKER_PATTERN.exec(line);
  return match ? parseInt(match[1], 10) : null;
}

// ============ Runtime validators ============

/**
 * Validate and extract a BusReportEvent from raw event data.
 * Returns null if the data is invalid; invalid events are ignored and audited.
 */
export function validateBusReportEvent(data: Record<string, unknown>): BusReportEvent | null {
  if (typeof data !== "object" || data === null) return null;
  if (typeof data.project !== "string") return null;
  if (typeof data.id !== "number" || !Number.isInteger(data.id)) return null;
  if (typeof data.agent !== "string") return null;
  if (typeof data.kind !== "string" || !VALID_REPORT_KINDS.includes(data.kind as ReportKind)) return null;
  if (typeof data.task !== "string") return null;
  // Optional fields
  if (data.gateId !== undefined && typeof data.gateId !== "string") return null;
  if (data.pr !== undefined && (typeof data.pr !== "number" || !Number.isInteger(data.pr))) return null;
  if (data.sha !== undefined && typeof data.sha !== "string") return null;
  
  return {
    project: data.project,
    id: data.id,
    agent: data.agent,
    kind: data.kind as ReportKind,
    task: data.task,
    gateId: data.gateId as string | undefined,
    pr: data.pr as number | undefined,
    sha: data.sha as string | undefined,
  };
}

/**
 * Validate and extract a BusMessageEvent from raw event data.
 * Returns null if the data is invalid; invalid events are ignored and audited.
 */
export function validateBusMessageEvent(data: Record<string, unknown>): BusMessageEvent | null {
  if (typeof data !== "object" || data === null) return null;
  if (typeof data.project !== "string") return null;
  if (typeof data.id !== "string") return null;
  if (typeof data.from !== "string") return null;
  if (typeof data.to !== "string") return null;
  if (typeof data.priority !== "number" || !Number.isInteger(data.priority)) return null;
  
  return {
    project: data.project,
    id: data.id,
    from: data.from,
    to: data.to,
    priority: data.priority,
  };
}

// ============ Consumer state ============

/** Per-project consumer state */
interface ConsumerState {
  mode: BusConsumeMode;
  /** Consumed event ids: Map for O(1) lookup (key: busId, value: consumedAt) */
  consumed: Map<number, number>;
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
  /** Audit invalid events (for acceptance test 5) */
  onInvalidEvent?: (project: string, reason: string, data: Record<string, unknown>) => void;
  /** Load persisted consumed ids for a project (for restart persistence, M2) */
  loadConsumed?: (project: string) => Map<number, number>;
  /** Save consumed ids for a project (for restart persistence, M2) */
  saveConsumed?: (project: string, consumed: Map<number, number>) => void;
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

    // Load persisted consumed ids if available
    const loadedConsumed = this.options.loadConsumed?.(project) ?? new Map<number, number>();

    // Off mode: no subscriptions
    if (mode === "off") {
      this.states.set(project, {
        mode,
        consumed: existing?.consumed ?? loadedConsumed,
        observed: [],
        unsubscribes: [],
      });
      return;
    }

    // observe or on: subscribe to events
    const state: ConsumerState = {
      mode,
      consumed: existing?.consumed ?? loadedConsumed,
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
    return state.consumed.has(busId);
  }

  /** Mark a bus id as consumed and persist */
  markConsumed(project: string, busId: number): void {
    const state = this.states.get(project);
    if (!state) return;

    const now = this.options.clock.now();

    // Prune old entries
    const cutoff = now - CONSUMED_EVENT_TTL_MS;
    for (const [id, consumedAt] of state.consumed) {
      if (consumedAt <= cutoff) {
        state.consumed.delete(id);
      }
    }

    // Add new entry
    state.consumed.set(busId, now);

    // Bound the size (remove oldest entries if over limit)
    if (state.consumed.size > MAX_CONSUMED_EVENTS) {
      const sorted = Array.from(state.consumed.entries()).sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, sorted.length - MAX_CONSUMED_EVENTS);
      for (const [id] of toRemove) {
        state.consumed.delete(id);
      }
    }

    // Persist
    this.options.saveConsumed?.(project, state.consumed);
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
    // Runtime validation (M3: no more `as unknown as` casts)
    const validated = validateBusReportEvent(event.data);
    if (!validated) {
      // Invalid event: ignore and audit (acceptance test 5)
      this.options.onInvalidEvent?.(project, "invalid bus.report event data", event.data);
      return;
    }
    
    if (validated.project !== project) return;

    // Call the handler with the mode
    this.options.onReport(project, validated, state.mode);

    // In on mode, mark as consumed so the mirrored line is skipped
    if (state.mode === "on") {
      this.markConsumed(project, validated.id);
    }
  }

  private handleMessage(project: string, event: Event, state: ConsumerState): void {
    // Runtime validation (M3: no more `as unknown as` casts)
    const validated = validateBusMessageEvent(event.data);
    if (!validated) {
      // Invalid event: ignore and audit (acceptance test 5)
      this.options.onInvalidEvent?.(project, "invalid bus.message event data", event.data);
      return;
    }
    
    if (validated.project !== project) return;

    // Call the handler with the mode
    this.options.onMessage(project, validated, state.mode);
  }
}
