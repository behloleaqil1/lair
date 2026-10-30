/**
 * Decision Inbox types (docs/design/autonomy.md §1), shared by the server
 * (src/server/decisions/) and the dashboard.
 *
 * A decision is a question only a human can answer. A module raises it with
 * the options and a recommended one, the work it blocks waits for the
 * answer, and the module resumes once the answer is delivered to it.
 */

export const DECISION_KINDS = [
  "pricing",
  "legal",
  "spend",
  "account",
  "credentials",
  "go_no_go",
  "security",
  "escalation",
  "other",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * Kinds that always wait for a human: a decision of one of these kinds can't
 * carry a default, so nothing is ever decided for the human when it expires.
 */
export const NEVER_DEFAULT_KINDS: readonly DecisionKind[] = [
  "pricing",
  "legal",
  "spend",
  "account",
  "credentials",
  "go_no_go",
  "security",
];

/** Kinds whose answer must be confirmed (the API requires `confirm: true`). */
export const CONFIRM_KINDS: readonly DecisionKind[] = ["spend", "go_no_go"];

/**
 * What a decision asks of the owner: an `action` needs their answer (it
 * counts toward the nav badge and Home's "Needs you", and it may notify
 * them); a `notice` is for their information only (nothing to choose, e.g.
 * a watchdog breach with no playbook to run): listed apart, never counted,
 * never notified.
 */
export const DECISION_ATTENTIONS = ["action", "notice"] as const;
export type DecisionAttention = (typeof DECISION_ATTENTIONS)[number];

export const DECISION_STATUSES = ["open", "answered", "expired", "withdrawn"] as const;
/**
 * open: waiting for an answer (also past its expiry when it has no default);
 * answered: a human chose an option; expired: its default was applied at
 * expiry; withdrawn: the module that raised it took it back
 */
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionOption {
  /** Stable id the producer acts on, e.g. "approve" */
  id: string;
  label: string;
  /** What happens if this option is chosen */
  consequences: string;
  /** credentials decisions: choosing this option means supplying the secret */
  suppliesSecret?: boolean;
}

/** Who raised the decision: a module, and its own reference (a breach, a task, ...). */
export interface DecisionSource {
  module: string;
  ref: string;
}

export interface DecisionLink {
  label: string;
  url: string;
}

/** How an answered decision turned out (the outcome tracker, src/server/outcomes/). */
export const DECISION_OUTCOMES = ["good", "bad", "unknown"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface DecisionAnswer {
  optionId: string;
  note?: string;
  /**
   * credentials decisions: the human supplied the secret, and it went to the
   * secret store. The value itself is never kept or returned.
   */
  secretSupplied?: boolean;
}

export type DecisionAuditAction =
  | "raised"
  | "raised_again"
  | "answered"
  | "overdue"
  | "expired"
  | "withdrawn"
  | "delivered"
  | "delivery_failed"
  | "reopened";

export interface DecisionAuditEntry {
  at: string;
  action: DecisionAuditAction;
  /** "owner", a module name, or "lair" for the inbox itself */
  actor: string;
  detail: string;
}

export interface Decision {
  id: string;
  project: string;
  kind: DecisionKind;
  /** action: needs the owner's answer; notice: for their information only (DECISION_ATTENTIONS) */
  attention: DecisionAttention;
  /** One plain sentence: what waits and why */
  title: string;
  /** What is blocked and why (markdown) */
  context: string;
  options: DecisionOption[];
  recommended: { optionId: string; reasoning: string };
  source: DecisionSource;
  /** The producer's dedupe key: one open decision per project, module and key */
  key: string;
  /** References of the work that waits for this decision */
  blocks: string[];
  links: DecisionLink[];
  /** credentials decisions: the name the secret is stored under */
  secretName?: string;
  /** The option applied when the decision expires unanswered */
  defaultOptionId?: string;
  createdAt: string;
  expiresAt?: string;
  /** Open and past expiresAt with no default: still waiting */
  overdue: boolean;
  status: DecisionStatus;
  answer?: DecisionAnswer;
  /** "owner" for a human answer, "lair" for a default applied at expiry */
  answeredBy?: string;
  answeredAt?: string;
  withdrawnReason?: string;
  /** When it stopped being open (answered, expired or withdrawn) */
  closedAt?: string;
  /** When the producer received the answer */
  deliveredAt?: string;
  /** "http": raised over the API, so `source.module` is only what the caller said; "server": by a module inside Lair */
  raisedVia: "server" | "http";
  /** Set once by the outcome tracker, when it is on; absent until then */
  outcome?: DecisionOutcome;
  outcomeAt?: string;
  /** Codes and ids only, no prose: `{ rule, ... }` */
  outcomeEvidence?: Record<string, string | number | boolean | null>;
  /** Only in GET /api/decisions/:id */
  audit?: DecisionAuditEntry[];
}

export interface DecisionCounts {
  /** Every open decision, notices included */
  open: number;
  /** Open action decisions past their expiry */
  overdue: number;
  /** Open decisions that need the owner's answer: what the nav badge and "Needs you" count */
  action: number;
  /** Open notices (for information only) */
  notices: number;
}
