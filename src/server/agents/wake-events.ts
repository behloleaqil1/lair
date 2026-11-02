/**
 * G3, waiting agents woken by the awaited event (agents.fill.wake.events, docs/design/ai-spend.md §4.5). A waiting
 * line may name, through waiting_pattern's captures, what it waits on besides a gate:
 * - (?<pr>\d{1,7}): a review of that PR (review.submitted), its reviews made stale by a new head
 *   (review.invalidated), its merge (review.merged) or a merge refusal (review.merge_refused);
 * - (?<decision>[A-Za-z0-9_-]{1,64}): that Decision Inbox decision answered (decision.answered, or decision.expired,
 *   which answers it with its default);
 * - (?<message>bus): a bus message to the agent (bus.message).
 *
 * Two ways tell fill an event came, so a missed one can't strand a wait: the server events as they come (kept in
 * memory, WakeArrivals), and the current state, read from the other modules' records (WakeFacts: reviewed or merged,
 * answered, an unread message) on the first look after a start and then at most every wake.poll_seconds.
 *
 * Everything here is data: a capture that isn't a PR number, a decision id or "bus" is refused, and shown.
 */
import { WAKE_EVENT_GROUPS } from "./config.js";

/** What a wait names as its event */
export type WakeTarget = { kind: "pr"; pr: number } | { kind: "decision"; id: string } | { kind: "message" };

/** A waiting line's raw captures, as written (cut, never a path or a prompt) */
export type WakeCaptures = Partial<Record<(typeof WAKE_EVENT_GROUPS)[number], string>>;

/** The server events that wake a wait, by what they are about */
export const WAKE_EVENT_TYPES = [
  "review.submitted",
  "review.invalidated",
  "review.merged",
  "review.merge_refused",
  "decision.answered",
  "decision.expired",
  "bus.message",
] as const;
export type WakeEventType = (typeof WAKE_EVENT_TYPES)[number];

/** An event that came for a target: what it was, when, and where it was read from */
export interface WakeCame {
  event: WakeEventType;
  at: number;
  /** event: the server event as it came; state: the module's record (on a start, or a poll) */
  source: "event" | "state";
}

const PR = /^\d{1,7}$/;
const DECISION = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTURE_SHOWN = 64;

/** The captures a match carries (only the G3 groups, trimmed and cut), or null when it has none */
export function wakeCapturesOf(groups: Record<string, string | undefined> | undefined): WakeCaptures | null {
  if (!groups) return null;
  const captures: WakeCaptures = {};
  for (const group of WAKE_EVENT_GROUPS) {
    const value = groups[group]?.trim();
    if (value) captures[group] = value.slice(0, CAPTURE_SHOWN * 2);
  }
  return Object.keys(captures).length > 0 ? captures : null;
}

/** Captures kept in a fill_waiting event's data (a rotated queue file keeps them), or null */
export function storedCaptures(value: unknown): WakeCaptures | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const groups: Record<string, string | undefined> = {};
  for (const group of WAKE_EVENT_GROUPS) {
    const v = (value as Record<string, unknown>)[group];
    if (typeof v === "string") groups[group] = v;
  }
  return wakeCapturesOf(groups);
}

/**
 * The target the captures name: a PR first, then a decision, then a bus message. A capture that isn't one (a PR
 * that isn't 1 to 7 digits, a decision id with other characters, a message other than "bus") is refused, with why.
 */
export function wakeTargetOf(captures: WakeCaptures | null): { target: WakeTarget | null; refused: string | null } {
  if (!captures) return { target: null, refused: null };
  const shown = (v: string) => JSON.stringify(v.slice(0, CAPTURE_SHOWN));
  if (captures.pr !== undefined) {
    const n = Number(captures.pr);
    if (PR.test(captures.pr) && n > 0) return { target: { kind: "pr", pr: n }, refused: null };
    return { target: null, refused: `PR ${shown(captures.pr)} is not a PR number (1 to 7 digits)` };
  }
  if (captures.decision !== undefined) {
    if (DECISION.test(captures.decision)) return { target: { kind: "decision", id: captures.decision }, refused: null };
    return { target: null, refused: `decision ${shown(captures.decision)} is not a decision id (letters, digits, _ and -, at most 64)` };
  }
  if (captures.message !== undefined) {
    if (captures.message.toLowerCase() === "bus") return { target: { kind: "message" }, refused: null };
    return { target: null, refused: `message ${shown(captures.message)} is not "bus"` };
  }
  return { target: null, refused: null };
}

/** A target's key: per PR, per decision, and per agent for its messages */
export function wakeKey(target: WakeTarget, agent: string): string {
  return target.kind === "pr" ? `pr:${target.pr}` : target.kind === "decision" ? `decision:${target.id}` : `message:${agent}`;
}

/** A target in words, for a line's detail, a notice and an event's summary */
export function wakeLabel(target: WakeTarget): string {
  return target.kind === "pr"
    ? `PR ${target.pr} (a review, a merge or a merge refusal)`
    : target.kind === "decision"
      ? `decision ${target.id} (its answer)`
      : "a bus message to it";
}

/** A target's facts for an event or a notice: numbers and ids only */
export function wakeFacts(target: WakeTarget): Record<string, string | number> {
  return target.kind === "pr" ? { target: "pr", pr: target.pr } : target.kind === "decision" ? { target: "decision", decision: target.id } : { target: "message" };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The key a server event wakes, for `project`, from its data as the emitters send it (ReviewService.emit adds the
 * project; DecisionInbox's decision.answered and decision.expired carry decisionId and project; BusService's
 * bus.message carries project and to). null for another project's event, or data that doesn't check.
 */
export function wakeKeyOfEvent(type: string, data: unknown, project: string): { key: string; event: WakeEventType } | null {
  if (!isRecord(data) || data.project !== project) return null;
  switch (type) {
    case "review.submitted":
    case "review.invalidated":
    case "review.merged":
    case "review.merge_refused":
      return positiveInt(data.pr) && data.pr < 10_000_000 ? { key: `pr:${data.pr}`, event: type } : null;
    case "decision.answered":
    case "decision.expired":
      return typeof data.decisionId === "string" && DECISION.test(data.decisionId) ? { key: `decision:${data.decisionId}`, event: type } : null;
    case "bus.message":
      return typeof data.to === "string" && data.to.length > 0 && data.to.length <= 200 ? { key: `message:${data.to}`, event: type } : null;
    default:
      return null;
  }
}

/** At most this many keys are kept (the newest arrivals win); a wait missed here is found by the state check */
const MAX_ARRIVALS = 2000;

/** The latest arrival of each key, in memory: a restart loses them, and the state check finds what they said */
export class WakeArrivals {
  private latest = new Map<string, { event: WakeEventType; at: number }>();

  note(key: string, event: WakeEventType, at: number): void {
    this.latest.delete(key);
    this.latest.set(key, { event, at });
    if (this.latest.size > MAX_ARRIVALS) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
  }

  /** The latest arrival for `key` at or after `since`, or null */
  since(key: string, since: number): WakeCame | null {
    const found = this.latest.get(key);
    return found && found.at >= since ? { event: found.event, at: found.at, source: "event" } : null;
  }
}

/**
 * The other modules' records the state check reads (the server wires them from their stores: src/server/index.ts).
 * Each may be absent (that module isn't on) and returns null when nothing came. Read-only.
 */
export interface WakeFacts {
  /** The first review of the PR, or its merge, recorded after `since` (ms) */
  pr?(project: string, pr: number, since: number): { event: "review.submitted" | "review.merged"; at: number } | null | Promise<{ event: "review.submitted" | "review.merged"; at: number } | null>;
  /**
   * The decision, when it is the project's and closed with an answer (answered, or expired with its default), at its
   * answer's time; wakeStateOf counts it only when that is at or after the run's start
   */
  decision?(project: string, id: string): { event: "decision.answered" | "decision.expired"; at: number } | null | Promise<{ event: "decision.answered" | "decision.expired"; at: number } | null>;
  /** The first bus message to the agent sent after `since` that it hasn't read */
  message?(project: string, agent: string, since: number): { at: number } | null | Promise<{ at: number } | null>;
}

/**
 * What the state check found for a target since `since` (the run's start), or null (nothing yet, or no record to
 * read). A record from before `since` is none, as an arrival from before it is: the run could read it already, so a
 * run that ends waiting on it again (a decision answered before it started, say) waits for a newer one and is held at
 * max_wait_minutes, instead of being started again at once, run after run.
 */
export async function wakeStateOf(facts: WakeFacts | undefined, project: string, agent: string, target: WakeTarget, since: number): Promise<WakeCame | null> {
  if (!facts) return null;
  let found: { event: WakeEventType; at: number } | null | undefined;
  if (target.kind === "pr") found = await facts.pr?.(project, target.pr, since);
  else if (target.kind === "decision") found = await facts.decision?.(project, target.id);
  else {
    const message = await facts.message?.(project, agent, since);
    found = message ? { event: "bus.message", at: message.at } : null;
  }
  return found && found.at >= since ? { event: found.event, at: found.at, source: "state" } : null;
}

/** The fields of a Decision Inbox decision the decision fact reads */
export interface DecisionRecord {
  project: string;
  status: string;
  answeredAt?: string;
  closedAt?: string;
}

/**
 * The decision fact from a Decision Inbox decision: the project's, answered or expired (with its default answer), at
 * its answer's time. Open, withdrawn, another project's or unknown: null.
 */
export function decisionWake(decision: DecisionRecord | null, project: string): { event: "decision.answered" | "decision.expired"; at: number } | null {
  if (!decision || decision.project !== project) return null;
  if (decision.status !== "answered" && decision.status !== "expired") return null;
  const when = decision.answeredAt ?? decision.closedAt;
  const at = when ? Date.parse(when) : NaN;
  if (!Number.isFinite(at)) return null;
  return { event: decision.status === "answered" ? "decision.answered" : "decision.expired", at };
}
