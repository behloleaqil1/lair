/**
 * What the review module needs from other modules, as small interfaces:
 *
 * - DecisionSink: raise an item in the Decision Inbox (docs/design/autonomy.md §1),
 *   e.g. "review this red-tier PR" or "a merge was refused over a private email";
 * - ReviewAssigner: hand a review (or the author's self-check) to an agent;
 * - ReviewerRuns: the agents module, for reviews by agents (agent-assigner.ts).
 *
 * The server raises decisions in the Decision Inbox (inboxDecisionSink). The
 * event-bus defaults are for a server without one: a module that implements
 * the real thing can subscribe without touching this one, or be passed to
 * ReviewManager directly.
 */
import { createHash } from "crypto";
import type { EventBus } from "../core/event-bus.js";
import type { Tier } from "../../shared/review-types.js";
import type { AgentRunState, AgentRunView, AgentsStatusView } from "../../shared/agents-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import { toDecisionInput } from "../decisions/request-bridge.js";

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
  /** Stable key: while a decision with it is open, the same request is not raised again */
  key?: string;
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
  /** The slot needs a model other than the author's (`differentModelFrom` is null when that model is unknown) */
  differentModel: boolean;
  /** The slot's index in the tier's reviewers */
  slot: number;
  /** The request's round for this slot and head (its record, with the token's hash, is written before assign) */
  round: number;
  /** The PR's author, when known */
  author: string | null;
  /** Reviewer agents to pick a peer from: the slot's pool, else review.reviewers_pool.<tier> */
  pool: string[] | null;
  repo: string;
  base: string;
  url: string | null;
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
  /**
   * `agent`: the agent it was given to, when the assigner knows (it then binds
   * the token); `model`: the model that agent runs on, when the assigner
   * started its run (recorded with its review instead of the model the review
   * claims); `channel`: how it was handed on, for the request record.
   */
  assign(
    assignment: ReviewAssignment,
  ): Promise<{ assigned: boolean; agent: string | null; detail: string; model?: string | null; channel?: string }>;
}

/**
 * What reviews by agents need from the agents module (AgentsManager has it):
 * the in-process run request, the agents' states and profiles, a chain's
 * runs (to see a review run end, and which profile it runs on), and a
 * project's service, to stop a review run that is no longer needed.
 */
export interface ReviewerRuns {
  requestRun(
    project: string,
    input: { agent: string; task: string; prompt: string; variables: Record<string, string> },
  ): Promise<AgentRunView>;
  status(project: string): AgentsStatusView;
  managedRuns(project: string): ReadonlyMap<string, unknown>;
  getStore(): {
    chainRuns(chainId: string): {
      id: string;
      agent: string;
      task: string;
      state: AgentRunState;
      detail: string;
      profile: { model?: string };
    }[];
  } | null;
  get(project: string): { releaseClaim(task: string, why?: string): Promise<unknown> } | undefined;
}

/**
 * Raise decisions in the Decision Inbox (src/server/decisions/), as module
 * `review`. A request without a key gets one from its project and question,
 * so the same question is not asked twice while it is open.
 */
export function inboxDecisionSink(inbox: Pick<DecisionProducer, "raise">): DecisionSink {
  return {
    async raise(request) {
      const key =
        request.key ?? `review:${createHash("sha256").update(`${request.project}\n${request.question}`).digest("hex").slice(0, 24)}`;
      const input = toDecisionInput({
        key,
        project: request.project,
        kind: request.kind,
        question: request.question,
        context: request.context.trim() || request.question,
        options: request.options,
        recommended: request.recommended ?? request.options[0] ?? "",
        why: request.why,
        reversible: request.reversible,
        onTimeout: "wait",
        requestedBy: request.requestedBy,
      });
      const { decision } = await inbox.raise({ ...input, links: request.links.slice(0, 20) });
      return { id: decision.id, channel: `decision inbox (${decision.id})` };
    },
  };
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
