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

/**
 * What choosing an option does (docs/design/decision-policies.md §4):
 * reversible: it can be undone later; frees_task: it stops waiting and frees
 * the task; irreversible: it can't be undone; outward: it acts outside Lair
 * (a merge, a spend). irreversible and outward are never for a rule to
 * answer.
 */
export const DECISION_EFFECTS = ["reversible", "frees_task", "irreversible", "outward"] as const;
export type DecisionEffect = (typeof DECISION_EFFECTS)[number];

/** A fact on a decision: flat, numbers as numbers, times as ISO-8601, ids rather than names. */
export type DecisionFactValue = string | number | boolean | null;

/**
 * The machine-readable evidence of a decision (the prose stays in `context`
 * for the person). `code` is one value of a fixed set per class.
 */
export interface DecisionEvidence {
  code: string;
  facts: Record<string, DecisionFactValue>;
  /** Set by the module that raised the decision; true when the cause is gone */
  cause_cleared: boolean;
  /** Issue number when a known cause is tracked */
  linked_issue: number | null;
}

export interface DecisionOption {
  /** Stable id the producer acts on, e.g. "approve" */
  id: string;
  label: string;
  /** What happens if this option is chosen */
  consequences: string;
  /** Absent on decisions raised before options carried it */
  effect?: DecisionEffect;
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
  | "structure_refused"
  | "evidence_updated"
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
  /**
   * The policy class, "module.name" (docs/design/decision-policies.md §2).
   * Absent on decisions raised without one: they are never for a rule.
   */
  class?: string;
  /** True when `class` is in the policy table (src/server/decisions/structure.ts) */
  classKnown?: boolean;
  evidence?: DecisionEvidence;
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

/** The class and evidence a module attaches to a request for a decision (options carry their own effect). */
export interface DecisionStructure {
  class: string;
  evidence: DecisionEvidence;
}

/**
 * Shadow policy agreement (docs/design/decision-policies.md §5): one proposer version's proposals for a class
 * compared with the answers people gave. Nothing here answers a decision.
 */
export interface PolicyAgreementRow {
  class: string;
  proposer: string;
  version: string;
  /** Rows in the policy trace */
  traced: number;
  /** Answered by a person, so comparable */
  compared: number;
  /** Proposed an option, and a person chose the same one */
  agreed: number;
  /** Proposed an option, and a person chose another */
  disagreed: number;
  /** Abstained on a decision a person answered */
  abstained: number;
  /** Disagreed where the proposal was an irreversible or outward option: one blocks promotion */
  unsafeDisagreements: number;
  /** Still open */
  pending: number;
  /** Withdrawn or expired: nobody needed to answer */
  withdrawn: number;
  /** agreed / (agreed + disagreed); null before any proposal was compared */
  agreement: number | null;
  /** proposed / compared; null before any comparison */
  coverage: number | null;
}

/** GET /api/owner/decision-policies */
export interface DecisionPoliciesStatus {
  /** data/server.yaml decision_policies.enabled: off, nothing is proposed or traced and `agreement` is empty */
  enabled: boolean;
  source: "file" | "built-in";
  version: string;
  policies: { id: string; class: string; codes: string[]; answer: string; state: string; maxTier: number }[];
  /** Entries of data/policies.yaml that were refused, each naming its policy, and a refused decision_policies section */
  errors: string[];
  agreement: PolicyAgreementRow[];
}
