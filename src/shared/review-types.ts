/**
 * Reviews and policy merge (docs/design/autonomy.md §5): the shapes the
 * review API returns. Shared by the server (src/server/review/,
 * src/server/policy/) and the Reviews view.
 */

/** Risk tier: red needs a strong reviewer, amber a peer, green the author's self-check. */
export type Tier = "red" | "amber" | "green";

/** Who wrote a review: a person, an agent, or one of Lair's own checks. */
export type ReviewerKind = "human" | "agent" | "check";

export interface ReviewerRef {
  id: string;
  kind: ReviewerKind;
  /** The model an agent ran on (compared with the author's for `different_model`) */
  model?: string;
}

/** Where a request came from, recorded with every review, resolution and merge. */
export interface ClientInfo {
  address: string | null;
  userAgent: string | null;
  /** The owner session (its public id) that made the request, for owner-only actions */
  ownerSession?: string;
}

export type Verdict = "approve" | "request_changes";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "open" | "resolved" | "dismissed";

export interface ReviewFinding {
  id: string;
  reviewId: string;
  pr: number;
  /** The head the review was given at */
  headSha: string;
  reviewer: ReviewerRef;
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  text: string;
  blocking: boolean;
  /** For check findings: the rule that fired (e.g. `skipped-test`) */
  rule: string | null;
  status: FindingStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedClient: ClientInfo | null;
  /** A later review by the same reviewer replaced this review's findings */
  superseded: boolean;
}

export interface ReviewRecord {
  id: string;
  project: string;
  pr: number;
  headSha: string;
  reviewer: ReviewerRef;
  verdict: Verdict;
  summary: string;
  createdAt: string;
  client: ClientInfo | null;
  findings: ReviewFinding[];
  /** Given at an older head: it no longer counts toward the required reviews */
  stale: boolean;
  /** The same reviewer reviewed this PR again later */
  superseded: boolean;
}

// ============ RISK ============

export interface RiskRuleMatch {
  id: string;
  tier: Tier;
  description: string | null;
  /** Why it matched, e.g. "kind migration: db/migrations/0002.sql" or "label security" */
  reasons: string[];
  /** The changed files it matched (empty for size and label rules) */
  files: string[];
}

export interface FileRisk {
  path: string;
  tier: Tier;
  /** Ids of the rules that matched this file (none: the default tier applies) */
  rules: string[];
}

export interface RiskAssessment {
  tier: Tier;
  defaultTier: Tier;
  rules: RiskRuleMatch[];
  files: FileRisk[];
  size: { files: number; additions: number; deletions: number };
  labels: string[];
}

// ============ REQUIRED REVIEWERS ============

export type ReviewerOption =
  | { kind: "human" }
  | { kind: "agent"; agent: string }
  | { kind: "peer" }
  | { kind: "self" };

/** One required review: any of the options fills it. */
export interface ReviewSlot {
  anyOf: ReviewerOption[];
  /** The reviewer must run on a different model from the author */
  differentModel: boolean;
}

export interface SlotStatus {
  slot: ReviewSlot;
  label: string;
  satisfiedBy: { reviewId: string; reviewer: ReviewerRef } | null;
  detail: string;
}

// ============ GATE, HOLDS, CONDITIONS ============

export type GateStatus = "passed" | "failed" | "pending" | "missing";

export interface GateCheck {
  name: string;
  status: GateStatus;
  /** The commit this result is for (always the PR head when it counts) */
  sha: string;
  detail: string;
  url: string | null;
}

export interface MergeHold {
  id: string;
  project: string;
  /** null: holds every PR of the project */
  pr: number | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

export type MergeConditionId =
  | "open"
  | "target"
  | "gate"
  | "reviews"
  | "changes_requested"
  | "findings"
  | "mergeable"
  | "up_to_date"
  | "holds";

export interface MergeCondition {
  id: MergeConditionId;
  ok: boolean;
  label: string;
  detail: string;
}

export type MergeMethod = "host" | "local";
export type MergeStrategy = "squash" | "merge" | "rebase" | "ff-only";

/** How a merge would run: on the git host, or in a local clone with the configured identity. */
export interface MergePlan {
  method: MergeMethod;
  strategy: MergeStrategy;
  /** Why this method may not merge at all (e.g. a host merge without host_email_private), or null */
  refusal: string | null;
  reason: string;
  warnings: string[];
}

// ============ API RESPONSES ============

export interface PrReviewStatus {
  project: string;
  number: number;
  title: string;
  url: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  defaultBranch: string | null;
  author: ReviewerRef | null;
  /** Where the author came from: registered with Lair, or parsed from the branch name */
  authorSource: "lair" | "branch" | null;
  /** The host account that opened the PR (agents often share one) */
  hostUser: string | null;
  labels: string[];
  risk: RiskAssessment;
  slots: SlotStatus[];
  reviews: ReviewRecord[];
  findings: ReviewFinding[];
  gate: GateCheck[];
  holds: MergeHold[];
  conditions: MergeCondition[];
  canMerge: boolean;
  /** One line per failed condition */
  reasons: string[];
  plan: MergePlan;
  readOnly: boolean;
  evaluatedAt: string;
}

export interface PrSummary {
  number: number;
  title: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  updatedAt: string | null;
  /** From the last evaluation at this head, if any */
  tier: Tier | null;
  canMerge: boolean | null;
  reasons: string[];
  evaluatedAt: string | null;
}

export interface ReviewMergeRecord {
  id: string;
  project: string;
  pr: number;
  headSha: string;
  method: MergeMethod;
  strategy: MergeStrategy;
  resultSha: string | null;
  initiatedBy: string;
  mergedAt: string;
  /** Commits whose author/committer emails were checked before publishing */
  commitsChecked: number;
  client: ClientInfo | null;
}

export interface MergeResponse {
  merged: boolean;
  record: ReviewMergeRecord | null;
  /** Why the merge was refused (empty when merged) */
  reasons: string[];
}

export interface ReviewProjectInfo {
  project: string;
  enabled: boolean;
  errors: string[];
  repo: string | null;
  readOnly: boolean;
}
