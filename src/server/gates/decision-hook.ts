/**
 * How the pipeline module asks the human for a decision. The Decision Inbox
 * (docs/design/autonomy.md §1) is a separate module: it can implement
 * DecisionHook directly, or listen for the "decision.needed" event that the
 * default hook emits on the event bus.
 */
import type { EventBus } from "../core/event-bus.js";

export type DecisionKind = "product" | "spend" | "legal" | "security" | "credential" | "release" | "escalation" | "other";

/** A decision request, in the shape autonomy.md §1 describes */
export interface DecisionRequest {
  /** Stable key: the same key is raised only once */
  key: string;
  project: string;
  kind: DecisionKind;
  question: string;
  /** Markdown */
  context: string;
  options: string[];
  recommended: string;
  why: string;
  reversible: boolean;
  /** `spend` decisions always wait */
  onTimeout: "wait" | "recommended" | "cancel";
  requestedBy: string;
}

export interface DecisionHook {
  needsDecision(request: DecisionRequest): Promise<void>;
}

/** The default hook: emits "decision.needed" with the request as its data */
export class EventBusDecisionHook implements DecisionHook {
  constructor(private events?: EventBus) {}

  async needsDecision(request: DecisionRequest): Promise<void> {
    await this.events?.emit("decision.needed", { ...request });
  }
}
