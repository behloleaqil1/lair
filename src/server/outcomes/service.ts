/**
 * The outcome tracker: watches what follows each answered decision and
 * records good / bad / unknown with structured evidence on the decision.
 *
 * Read-only towards the rest of Lair. It listens to events, and it holds
 * two narrow things: a reader of answered decisions that also records an
 * outcome (once per answer), and its own fact log. It never answers,
 * retries, reverts or changes a decision; the only things it writes are the
 * outcome fields and an event.
 */
import type { Decision, DecisionOutcome } from "../../shared/decision-types.js";
import type { EventBus } from "../core/event-bus.js";
import { factsFromEvent, type FactLog } from "./facts.js";
import { ruleFor } from "./rules.js";
import type { Evidence, Verdict, WindowHours } from "./types.js";

/** What the tracker may do with the Decision Inbox: list answers waiting for a verdict, and record it. */
export interface OutcomeDecisions {
  awaitingOutcome(limit: number): Decision[];
  recordOutcome(id: string, answeredAt: string, outcome: DecisionOutcome, evidence: Evidence): boolean;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface OutcomeTrackerOptions {
  decisions: OutcomeDecisions;
  facts: FactLog;
  events: EventBus;
  windows: WindowHours;
  checkMinutes: number;
  clock?: () => Date;
  timers?: Timers;
  log?: (line: string) => void;
}

const BATCH = 500;
const EVENTS = [
  "agent.recovery",
  "agent.run.started",
  "agent.run.ended",
  "decision.raised",
  "planner.changed",
  "review.merged",
  "triage.revert_requested",
  "triage.culprit_found",
] as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class OutcomeTracker {
  private readonly clock: () => Date;
  private readonly timers: Timers;
  private handle: unknown = null;
  private unsubscribers: (() => void)[] = [];
  private sweeping = false;

  constructor(private readonly o: OutcomeTrackerOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.timers = o.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) };
  }

  /** Remember the events the rules use. */
  subscribe(): void {
    for (const type of EVENTS) {
      this.unsubscribers.push(
        this.o.events.on(type, (event) => {
          for (const fact of factsFromEvent(event)) this.o.facts.add(fact);
        }),
      );
    }
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.timers.setInterval(() => void this.sweep(), this.o.checkMinutes * 60_000);
    // A server restarted in the middle of a window picks it up from the fact log
    void this.sweep();
  }

  stop(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    if (this.handle !== null) this.timers.clearInterval(this.handle);
    this.handle = null;
  }

  /** The verdict for one answer now: a rule's, or unknown once its window has ended. */
  judge(d: Decision, now: Date): Verdict {
    const answeredAt = d.answeredAt && Number.isFinite(Date.parse(d.answeredAt)) ? d.answeredAt : null;
    if (answeredAt === null || !d.answer) return { outcome: "unknown", evidence: { reason: "no_answer_time" } };
    const rule = ruleFor(d);
    if (!rule) return { outcome: "unknown", evidence: { reason: "no_rule" } };
    const windowEnd = new Date(Date.parse(answeredAt) + this.o.windows[rule.window] * HOUR_MS);
    const until = windowEnd.getTime() < now.getTime() ? windowEnd : now;
    const verdict = rule.judge({ decision: d, answeredAt, windowEnd: until.toISOString(), facts: this.o.facts });
    if (verdict.outcome !== "pending") return verdict;
    return now.getTime() >= windowEnd.getTime()
      ? { outcome: "unknown", evidence: { rule: rule.name, reason: "window_ended" } }
      : verdict;
  }

  /** Look at every answer still waiting for a verdict. Returns how many got one. */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let recorded = 0;
    try {
      const now = this.clock();
      for (const d of this.o.decisions.awaitingOutcome(BATCH)) {
        const verdict = this.judge(d, now);
        if (verdict.outcome === "pending" || !d.answeredAt) continue;
        // Once per answer: the store refuses a second verdict, so a restart or a repeat sweep adds nothing
        if (!this.o.decisions.recordOutcome(d.id, d.answeredAt, verdict.outcome, verdict.evidence)) continue;
        recorded++;
        await this.o.events.emit("decision.outcome", {
          decisionId: d.id,
          project: d.project,
          module: d.source.module,
          optionId: d.answer?.optionId ?? null,
          outcome: verdict.outcome,
          evidence: verdict.evidence,
        });
      }
      // Facts only matter for the longest window
      const keep = Math.max(...Object.values(this.o.windows)) * HOUR_MS + DAY_MS;
      this.o.facts.prune(new Date(now.getTime() - keep).toISOString());
    } catch (e) {
      this.o.log?.(`[outcomes] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.sweeping = false;
    }
    return recorded;
  }
}
