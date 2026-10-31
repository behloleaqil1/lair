/**
 * The producer interface of the Decision Inbox: what other modules call to
 * ask the human, park their work, and resume once the answer arrives.
 */
import type {
  Decision,
  DecisionAttention,
  DecisionEvidence,
  DecisionKind,
  DecisionLink,
  DecisionOption,
  DecisionSource,
} from "../../shared/decision-types.js";

/** What a producer passes to raise(). Validated at runtime (see validate.ts). */
export interface RaiseDecisionInput {
  project: string;
  kind: DecisionKind;
  /**
   * action (the default): it needs the owner's answer; notice: for their
   * information only, nothing to choose. Notices are listed apart, never
   * counted in the badge and never notified.
   */
  attention?: DecisionAttention;
  /** One line, at most 200 characters: a plain sentence saying what waits and why */
  title: string;
  /** What is blocked and why (markdown) */
  context: string;
  options: DecisionOption[];
  recommended: { optionId: string; reasoning: string };
  source: DecisionSource;
  /** Dedupe key: while a decision with this project, module and key is open, raise() returns it */
  key: string;
  /** References of the work that waits, e.g. "deploy:production" */
  blocks?: string[];
  links?: DecisionLink[];
  /** credentials decisions only: the name the secret is stored under */
  secretName?: string;
  /** ISO-8601 time; must be in the future */
  expiresAt?: string;
  /**
   * The option applied at expiresAt when nobody answered. Refused for the
   * kinds that always wait (NEVER_DEFAULT_KINDS); needs expiresAt.
   */
  defaultOptionId?: string;
  /**
   * The policy class ("module.name", see structure.ts), with its evidence and
   * an effect on every option. Neither is needed yet; one without the other,
   * or a class without effects, is refused.
   */
  class?: string;
  evidence?: DecisionEvidence;
}

export interface RaiseResult {
  decision: Decision;
  /** false: an open decision with the same key already existed and was returned */
  created: boolean;
}

export interface AnswerInput {
  optionId: string;
  /** Not for credentials decisions (a secret could end up in it) */
  note?: string;
  /** Required for the CONFIRM_KINDS (spend, go_no_go) */
  confirm?: boolean;
  /**
   * credentials decisions, with an option that supplies the secret: the
   * value, handed to the secret store and never kept anywhere else
   */
  secret?: string;
}

/**
 * Where an answer came from, for its audit entry. The answerer is always
 * the owner: the server decides that, never the request.
 */
export interface AnswerContext {
  remoteAddress?: string;
  userAgent?: string;
}

export interface WithdrawInput {
  /** Must be the module that raised the decision */
  module: string;
  reason: string;
}

/** What a producer receives once its decision is answered or expires with its default. */
export interface DecisionResolution {
  decision: Decision;
  outcome: "answered" | "expired";
  optionId: string;
  note?: string;
  secretSupplied: boolean;
  by: string;
}

export type ResolutionHandler = (resolution: DecisionResolution) => void | Promise<void>;

/**
 * The Decision Inbox as other modules see it.
 *
 * - raise(): ask; the same project + module + key while open returns the
 *   open decision (its blocked refs are merged) instead of a second one.
 * - blockedOn(): is this piece of work parked on an open decision?
 * - onResolved(): resume. The handler gets every answer to the module's
 *   decisions (for one project, or all), including answers given while the
 *   module wasn't listening, e.g. before a restart: a resolution counts as
 *   delivered only once a handler returns without throwing.
 * - withdraw(): the question is moot (the producer fixed it some other way).
 * - find(): the latest decision the module raised with this key (an open one
 *   first), whatever its status, or null: a producer that keeps one
 *   decision per condition reads it to tell "asked and answered" from
 *   "never asked" or "withdrawn", across restarts.
 * - openOf(): the module's open decisions in a project, to withdraw those
 *   whose condition is gone.
 */
export interface DecisionProducer {
  raise(input: RaiseDecisionInput): Promise<RaiseResult>;
  withdraw(id: string, input: WithdrawInput): Promise<Decision>;
  blockedOn(ref: string): Decision | null;
  onResolved(module: string, handler: ResolutionHandler, options?: { project?: string }): () => void;
  find(project: string, module: string, key: string): Decision | null;
  openOf(project: string, module: string): Decision[];
}

export interface Clock {
  now(): number;
}
