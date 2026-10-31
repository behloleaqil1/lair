/**
 * Bus consumers (bus PR 2a): fill and the planner read agents' structured
 * bus reports instead of parsing the free text of the queue lines the bus
 * mirrors, behind `bus.consume: off | observe | on` per project (default off).
 *
 * One read path, so a report is applied exactly once:
 * - The bus writes the report to its store, appends the mirrored line (which
 *   ends with `[bus:<id>]`) to the queue file, then emits `bus.report`.
 * - The mirrored line is where the report sits in the queue's order (a run's
 *   window, the agent's latest line). In `on` mode fill and the planner take
 *   the report's own fields (kind, task, agent, gate id, PR, sha) for that
 *   line from the bus store and never match their patterns against its text.
 *   Hand-written lines (no marker) are read exactly as before.
 * - The event changes no state itself: it makes fill check and the planner
 *   run a cycle at once, instead of at their next interval. So the event and
 *   the line can't count twice, and a restart between them changes nothing:
 *   what each module did is kept in its own store (fill's events, keyed by
 *   the report's id; the planner's applied ids), with the change itself.
 *
 * `observe` changes nothing (the patterns read every line, as with `off`)
 * and writes nothing: it keeps, in memory, what the report would have been
 * read as next to what the patterns read the same line as, for Home → Health.
 *
 * An event that fails validation, or that doesn't match the report the bus
 * stored under its id, is refused with the reason (logged, shown on Health,
 * and emitted as `bus.consume_refused`). A report for a task or agent fill
 * doesn't know is ignored the same way.
 */
import type { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import type { ReportKind } from "../../bus/types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { isValidTaskId } from "../agents/types.js";
import type { BusReport } from "./store.js";

// ============ Config ============

export type BusConsumeMode = "off" | "observe" | "on";

export const BUS_CONSUME_MODES: readonly BusConsumeMode[] = ["off", "observe", "on"];

const REPORT_KINDS: readonly ReportKind[] = ["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"];

const MAX_GATE_ID = 200;
const MAX_MESSAGE_ID = 20;

// ============ The marker ============

/** The marker the mirror ends a mirrored line with: `[bus:<id>]`, the report's id in the project's bus store */
const BUS_MARKER = /\s*\[bus:([1-9]\d{0,14})\]\s*$/;

/** The report id a mirrored line ends with, or null (a hand-written line). */
export function extractBusId(line: string): number | null {
  const match = BUS_MARKER.exec(line);
  return match ? Number(match[1]) : null;
}

/** The line without its trailing bus marker (what the agent's report said). */
export function stripBusMarker(line: string): string {
  return line.replace(BUS_MARKER, "");
}

// ============ Structured reports ============

/** A report as the bus stored it: what fill and the planner read in place of its mirrored line. */
export interface StructuredReport {
  id: number;
  agent: string;
  runId: string;
  kind: ReportKind;
  task: string;
  summary: string;
  gateId: string | null;
  pr: number | null;
  sha: string | null;
  createdAt: number;
}

export function structuredReport(report: BusReport): StructuredReport {
  return {
    id: report.id,
    agent: report.agent,
    runId: report.runId,
    kind: report.kind,
    task: report.task,
    summary: report.summary,
    gateId: report.gateId,
    pr: report.pr,
    sha: report.sha,
    createdAt: report.createdAt,
  };
}

/**
 * Whether a queue line is the mirror's line for this report: it starts as
 * the mirror writes it (`- <KIND> <task> by <agent> `). A hand-written line
 * that ends with another report's marker is not.
 */
export function isMirrorOf(line: string, report: Pick<StructuredReport, "kind" | "task" | "agent">): boolean {
  return line.trim().startsWith(`- ${report.kind} ${report.task} by ${report.agent} `);
}

/**
 * The report a queue line ending with marker `id` mirrors, or null: when the
 * bus store has no such report, or the line isn't its mirrored line, the
 * line is read as a hand-written one and the reason is audited.
 */
export function mirroredReport(bus: BusLineSource, line: string, id: number, reports: Map<number, StructuredReport>): StructuredReport | null {
  const report = reports.get(id);
  if (!report) {
    bus.ignored(id, "a queue line ends with this report's marker, but the bus store has no such report: read as a hand-written line");
    return null;
  }
  if (!isMirrorOf(line, report)) {
    bus.ignored(id, `a queue line ends with this report's marker but is not its mirrored line (${report.kind} ${report.task} by ${report.agent}): read as a hand-written line`);
    return null;
  }
  return report;
}

/** What a module made of a mirrored line, for observe mode's comparison. */
export interface BusObservation {
  /** fill or planner */
  consumer: "fill" | "planner";
  busId: number;
  task: string;
  agent: string;
  /** How the report reads (its kind, and the gate a WAITING report waits on) */
  report: string;
  /** How the module's patterns read the same line */
  file: string;
}

/**
 * A project's bus, as fill and the planner read it at one check: null while
 * `bus.consume` is off. Reports are read from the bus store by id, once (a
 * report never changes), and kept in memory.
 */
export interface BusLineSource {
  readonly mode: "observe" | "on";
  /** The reports stored under these ids (an id the store doesn't have is missing from the map) */
  reports(ids: number[]): Map<number, StructuredReport>;
  /** A mirrored line or report a module didn't take: the reason is audited once per report and reason */
  ignored(busId: number, reason: string): void;
  /** observe: what a report would have been read as, next to what the patterns read */
  observed(observation: BusObservation): void;
}

// ============ Validation ============

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A `bus.report` event's data, as BusService emits it. */
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

/** A `bus.message` event's data, as BusService emits it. */
export interface BusMessageEvent {
  project: string;
  id: string;
  from: string;
  to: string;
  priority: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isReportKind = (value: unknown): value is ReportKind => typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);

/** Check every field of a `bus.report` event: the typed event, or the reason it is refused. */
export function validateBusReportEvent(data: unknown): Validated<BusReportEvent> {
  if (!isRecord(data)) return { ok: false, reason: "the event has no data object" };
  const { project, id, agent, kind, task, gateId, pr, sha } = data;
  if (typeof project !== "string" || project.length === 0) return { ok: false, reason: "project is not a name" };
  if (!positiveInt(id)) return { ok: false, reason: "id is not a positive integer" };
  if (typeof agent !== "string" || !isValidDragonId(agent)) return { ok: false, reason: "agent is not a valid agent id" };
  if (!isReportKind(kind)) return { ok: false, reason: `kind is not one of ${REPORT_KINDS.join(", ")}` };
  if (!isValidTaskId(task)) return { ok: false, reason: "task is not a valid task id" };
  if (gateId !== undefined && (typeof gateId !== "string" || gateId.length === 0 || gateId.length > MAX_GATE_ID)) {
    return { ok: false, reason: `gateId is not a string of 1 to ${MAX_GATE_ID} characters` };
  }
  if (pr !== undefined && !positiveInt(pr)) return { ok: false, reason: "pr is not a positive integer" };
  if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{1,64}$/i.test(sha))) return { ok: false, reason: "sha is not a hex commit id" };
  const value: BusReportEvent = { project, id, agent, kind, task };
  if (gateId !== undefined) value.gateId = gateId;
  if (pr !== undefined) value.pr = pr;
  if (sha !== undefined) value.sha = sha;
  return { ok: true, value };
}

/** Check every field of a `bus.message` event: the typed event, or the reason it is refused. */
export function validateBusMessageEvent(data: unknown): Validated<BusMessageEvent> {
  if (!isRecord(data)) return { ok: false, reason: "the event has no data object" };
  const { project, id, from, to, priority } = data;
  if (typeof project !== "string" || project.length === 0) return { ok: false, reason: "project is not a name" };
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_MESSAGE_ID) return { ok: false, reason: "id is not a message id" };
  if (typeof from !== "string" || from.length === 0) return { ok: false, reason: "from is not a sender id" };
  if (typeof to !== "string" || to.length === 0) return { ok: false, reason: "to is not a recipient id" };
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 10) {
    return { ok: false, reason: "priority is not an integer from 1 to 10" };
  }
  return { ok: true, value: { project, id, from, to, priority } };
}

/** The reason an event doesn't match the report the bus stored under its id, or null when it does. */
export function eventMismatch(event: BusReportEvent, stored: StructuredReport | null): string | null {
  if (!stored) return `the bus store has no report ${event.id}`;
  if (stored.agent !== event.agent || stored.task !== event.task || stored.kind !== event.kind) {
    return `the event does not match report ${event.id} as stored (${stored.kind} ${stored.task} by ${stored.agent})`;
  }
  if ((stored.gateId ?? undefined) !== event.gateId || (stored.pr ?? undefined) !== event.pr || (stored.sha ?? undefined) !== event.sha) {
    return `the event's gate, PR or sha do not match report ${event.id} as stored`;
  }
  return null;
}

// ============ Health ============

export interface BusRefusal {
  at: string;
  /** The report's id; null when the event had none that could be read */
  busId: number | null;
  reason: string;
}

export type BusObservationView = BusObservation & { at: string; match: boolean };

export interface BusConsumerHealth {
  mode: BusConsumeMode;
  /** Reports received over the bus since the server started (valid events that match the store) */
  received: number;
  /** Events refused, and reports a module ignored, newest first (at most 20) */
  refused: BusRefusal[];
  refusedCount: number;
  /** observe: reports whose mirrored line both readings saw; the recent differences, newest first */
  observations: { total: number; matches: number; mismatches: number; recent: BusObservationView[] };
}

const MAX_REFUSED = 20;
const MAX_OBSERVED = 500;
const MAX_RECENT_MISMATCHES = 20;
/** Reasons already audited, per project (a report a later check reads again is not audited again) */
const MAX_AUDITED_KEYS = 2000;

/** Reports kept in memory per project (they never change once stored) */
const MAX_CACHED_REPORTS = 10_000;

interface ProjectState {
  mode: BusConsumeMode;
  /** Reports read from the store (id -> report), oldest read first */
  cache: Map<number, StructuredReport>;
  received: number;
  refused: BusRefusal[];
  refusedCount: number;
  audited: Set<string>;
  /** observe: consumer|busId -> what both readings made of it (oldest first) */
  observed: Map<string, BusObservationView>;
}

// ============ BusConsumers ============

export interface BusConsumersOptions {
  events: EventBus;
  clock: { now(): number };
  /** The reports stored under these ids in the project's bus store (none when the store can't be read) */
  reports: (project: string, ids: number[]) => StructuredReport[];
  /** Why no module will read an accepted report (fill doesn't know its task or agent), or null: it is audited */
  problem?: (project: string, report: StructuredReport) => string | null;
  /** An accepted report in `on` mode: fill checks now and the planner runs a cycle now */
  onReport: (project: string, report: StructuredReport) => void;
  /** A message to the orchestrator in `on` mode: the planner runs a cycle now (it reads the owner's messages) */
  onMessage: (project: string, message: BusMessageEvent) => void;
  /** A run ended in `on` mode: fill checks now, so the report the run ended on is read without waiting */
  onRunEnded: (project: string) => void;
  /** Where refusals are logged (console.warn in the server) */
  warn?: (text: string) => void;
}

/**
 * The bus consumers of every project: one subscription per event type for
 * the whole server, dispatched by the event's project.
 */
export class BusConsumers {
  private projects = new Map<string, ProjectState>();
  private unsubscribes: (() => void)[] = [];

  constructor(private options: BusConsumersOptions) {}

  /** Subscribe to the server's events (once). */
  start(): void {
    if (this.unsubscribes.length > 0) return;
    const { events } = this.options;
    this.unsubscribes.push(
      events.on("bus.report", (event) => this.handleReport(event)),
      events.on("bus.message", (event) => this.handleMessage(event)),
      events.on("agent.run.ended", (event) => this.handleRunEnded(event)),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** A project's mode, from its `bus.consume` (on load and on every reload). */
  setMode(project: string, mode: BusConsumeMode): void {
    const state = this.state(project);
    if (state.mode === mode) return;
    state.mode = mode;
    state.observed.clear();
  }

  mode(project: string): BusConsumeMode {
    return this.projects.get(project)?.mode ?? "off";
  }

  /** The projects whose bus is not off. */
  enabled(): string[] {
    return [...this.projects].filter(([, s]) => s.mode !== "off").map(([name]) => name);
  }

  /** The project's bus as fill and the planner read it at one check; null while it is off. */
  lineSource(project: string): BusLineSource | null {
    const state = this.projects.get(project);
    if (!state || state.mode === "off") return null;
    const mode = state.mode;
    return {
      mode,
      reports: (ids) => this.reports(project, ids),
      ignored: (busId, reason) => this.refuse(project, busId, reason),
      observed: (observation) => {
        if (mode === "observe") this.observe(project, observation);
      },
    };
  }

  health(project: string): BusConsumerHealth {
    const state = this.projects.get(project);
    if (!state) {
      return { mode: "off", received: 0, refused: [], refusedCount: 0, observations: { total: 0, matches: 0, mismatches: 0, recent: [] } };
    }
    const all = [...state.observed.values()];
    const mismatches = all.filter((o) => !o.match);
    return {
      mode: state.mode,
      received: state.received,
      refused: [...state.refused],
      refusedCount: state.refusedCount,
      observations: {
        total: all.length,
        matches: all.length - mismatches.length,
        mismatches: mismatches.length,
        recent: mismatches.slice(-MAX_RECENT_MISMATCHES).reverse(),
      },
    };
  }

  // ============ Events ============

  private projectOf(event: Event): string | null {
    return isRecord(event.data) && typeof event.data.project === "string" ? event.data.project : null;
  }

  private handleReport(event: Event): void {
    const project = this.projectOf(event);
    if (project === null) {
      // No project to file it under: logged only
      this.options.warn?.("[bus-consumers] a bus.report event was refused: it names no project");
      return;
    }
    const state = this.projects.get(project);
    if (!state || state.mode === "off") return;
    const checked = validateBusReportEvent(event.data);
    if (!checked.ok) {
      const id = isRecord(event.data) && positiveInt(event.data.id) ? event.data.id : null;
      this.refuse(project, id, `bus.report refused: ${checked.reason}`);
      return;
    }
    const stored = this.reports(project, [checked.value.id]).get(checked.value.id) ?? null;
    const mismatch = eventMismatch(checked.value, stored);
    if (mismatch !== null || stored === null) {
      this.refuse(project, checked.value.id, `bus.report refused: ${mismatch ?? "no such report"}`);
      return;
    }
    state.received++;
    const problem = this.options.problem?.(project, stored) ?? null;
    if (problem !== null) {
      // An unknown task or agent: nothing reads it, so nothing is woken for it
      this.refuse(project, stored.id, `bus.report ignored: ${problem}`);
      return;
    }
    // PROGRESS and TICK change no state: nothing to read sooner
    if (state.mode === "on" && (stored.kind === "DONE" || stored.kind === "WAITING" || stored.kind === "BLOCKED")) this.options.onReport(project, stored);
  }

  private handleMessage(event: Event): void {
    const project = this.projectOf(event);
    if (project === null || this.mode(project) === "off") return;
    const checked = validateBusMessageEvent(event.data);
    if (!checked.ok) {
      this.refuse(project, null, `bus.message refused: ${checked.reason}`);
      return;
    }
    if (this.mode(project) === "on" && checked.value.to === "orchestrator") this.options.onMessage(project, checked.value);
  }

  private handleRunEnded(event: Event): void {
    const project = this.projectOf(event);
    if (project === null || this.mode(project) !== "on") return;
    this.options.onRunEnded(project);
  }

  // ============ Reports, audit and observations ============

  private state(project: string): ProjectState {
    let state = this.projects.get(project);
    if (!state) {
      state = { mode: "off", cache: new Map(), received: 0, refused: [], refusedCount: 0, audited: new Set(), observed: new Map() };
      this.projects.set(project, state);
    }
    return state;
  }

  /** The reports under these ids: from memory, else one read of the store for the rest. */
  private reports(project: string, ids: number[]): Map<number, StructuredReport> {
    const state = this.state(project);
    const found = new Map<number, StructuredReport>();
    const missing: number[] = [];
    for (const id of ids) {
      const cached = state.cache.get(id);
      if (cached) found.set(id, cached);
      else missing.push(id);
    }
    if (missing.length === 0) return found;
    let read: StructuredReport[] = [];
    try {
      read = this.options.reports(project, missing);
    } catch (e) {
      this.options.warn?.(`[bus-consumers] ${project}: the bus store could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const wanted = new Set(missing);
    for (const report of read) {
      if (!wanted.has(report.id)) continue;
      found.set(report.id, report);
      state.cache.set(report.id, report);
    }
    while (state.cache.size > MAX_CACHED_REPORTS) {
      const oldest = state.cache.keys().next().value;
      if (oldest === undefined) break;
      state.cache.delete(oldest);
    }
    return found;
  }

  private refuse(project: string, busId: number | null, reason: string): void {
    const state = this.state(project);
    const key = `${busId ?? "-"}|${reason}`;
    if (state.audited.has(key)) return;
    if (state.audited.size >= MAX_AUDITED_KEYS) state.audited.clear();
    state.audited.add(key);
    state.refused.unshift({ at: new Date(this.options.clock.now()).toISOString(), busId, reason });
    state.refused.length = Math.min(state.refused.length, MAX_REFUSED);
    state.refusedCount++;
    this.options.warn?.(`[bus-consumers] ${project}: ${busId === null ? "" : `report ${busId}: `}${reason}`);
    void this.options.events.emit("bus.consume_refused", { project, busId, reason });
  }

  private observe(project: string, observation: BusObservation): void {
    const state = this.state(project);
    const key = `${observation.consumer}|${observation.busId}`;
    if (state.observed.has(key)) return;
    state.observed.set(key, { ...observation, at: new Date(this.options.clock.now()).toISOString(), match: observation.report === observation.file });
    while (state.observed.size > MAX_OBSERVED) {
      const oldest = state.observed.keys().next().value;
      if (oldest === undefined) break;
      state.observed.delete(oldest);
    }
  }
}
