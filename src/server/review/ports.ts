/**
 * What the review module needs from other modules, as small interfaces:
 *
 * - DecisionSink: raise an item in the Decision Inbox (docs/design/autonomy.md §1),
 *   e.g. "review this red-tier PR" or "a merge was refused over a private email";
 * - ReviewAssigner: hand a review (or the author's self-check) to an agent.
 *
 * The defaults publish events on the bus, so a module that implements the
 * real thing can subscribe without touching this one; it can also be passed
 * to ReviewManager directly.
 */
import type { EventBus } from "../core/event-bus.js";
import type { Tier } from "../../shared/review-types.js";

export type DecisionKind =
  | "product"
  | "spend"
  | "legal"
  | "security"
  | "credential"
  | "release"
  | "escalation"
  | "other";

export interface DecisionRequest {
  project: string;
  question: string;
  /** Markdown */
  context: string;
  options: string[];
  recommended: string | null;
  why: string;
  kind: DecisionKind;
  reversible: boolean;
  requestedBy: string;
  links: { label: string; url: string }[];
}

export interface DecisionSink {
  raise(request: DecisionRequest): Promise<{ id: string | null; channel: string }>;
}

export interface ReviewAssignment {
  project: string;
  pr: number;
  headSha: string;
  tier: Tier;
  /** A named reviewer agent, or null for any peer */
  reviewer: string | null;
  /** Agents that must not get it (the author, for a peer review) */
  exclude: string[];
  role: "review" | "self-check";
  /** The reviewer must run on a model other than this one */
  differentModelFrom: string | null;
  reason: string;
  /**
   * The assignment token: give it only to the agent that does the review,
   * which sends it as `assignment_token`. Lair accepts an agent's review only
   * with the token of an assignment for that PR, head and agent; one without
   * a named reviewer binds to the first agent (not in `exclude`) that uses it.
   */
  token: string;
}

export interface ReviewAssigner {
  /** `agent`: the agent it was given to, when the assigner knows (it then binds the token) */
  assign(assignment: ReviewAssignment): Promise<{ assigned: boolean; agent: string | null; detail: string }>;
}

/** For a server without an event bus: nothing receives the request, and the result says so. */
export const unwiredDecisionSink: DecisionSink = {
  async raise() {
    return { id: null, channel: "none (no Decision Inbox is wired)" };
  },
};

export const unwiredAssigner: ReviewAssigner = {
  async assign() {
    return { assigned: false, agent: null, detail: "no agent assigner is wired" };
  },
};

/** Publish decisions as `review.decision_requested` events. */
export function eventBusDecisionSink(bus: EventBus): DecisionSink {
  return {
    async raise(request) {
      await bus.emit("review.decision_requested", { ...request });
      return { id: null, channel: "event:review.decision_requested" };
    },
  };
}

/** Publish assignments as `review.assignment_requested` events. */
export function eventBusAssigner(bus: EventBus): ReviewAssigner {
  return {
    async assign(assignment) {
      await bus.emit("review.assignment_requested", { ...assignment });
      return { assigned: false, agent: null, detail: "requested on the event bus (review.assignment_requested)" };
    },
  };
}
