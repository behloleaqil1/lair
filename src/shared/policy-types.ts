/**
 * M2 types: gates, policies, verification.
 * These types power the policy engine and control-plane merge.
 */

// ============ GATE PIPELINE TYPES ============

/** A step in a gate pipeline */
export interface GateStep {
  /** Unique step name within the pipeline */
  name: string;
  /** Command to execute (runs in a sandbox) */
  command: string;
  /**
   * The command as an argv array (no shell). When set, executors run this and
   * `command` is only its display form.
   */
  argv?: string[];
  /** Timeout in seconds */
  timeoutSeconds: number;
  /** Required node capabilities (e.g., "docker", "gpu") */
  requires?: string[];
  /** Continue to next step even if this one fails */
  continueOnFailure?: boolean;
  /** Environment variables to set */
  env?: Record<string, string>;
}

/** Scope rules to determine which steps run based on changed files */
export interface GateScopeRule {
  /** Glob patterns for files that trigger this rule */
  patterns: string[];
  /** Steps to run when these files change */
  steps: string[];
}

/** A gate pipeline configuration */
export interface GatePipeline {
  /** Pipeline identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** All steps in execution order */
  steps: GateStep[];
  /** Scope rules: which file changes trigger which steps */
  scope: GateScopeRule[];
  /** Default steps when no scope rule matches */
  defaultSteps: string[];
  /** Container image to use (pinned by digest recommended) */
  image?: string;
  /** Global timeout for entire pipeline (seconds) */
  timeoutSeconds: number;
}

/** Per-project gate configuration */
export interface ProjectGateConfig {
  /** Project identifier */
  projectId: string;
  /** Pipelines available for this project */
  pipelines: GatePipeline[];
  /** Default pipeline to use */
  defaultPipeline: string;
}

// ============ GATE RESULT TYPES ============

/** Result of a single gate step */
export interface GateStepResult {
  /** Step name */
  name: string;
  /** Status */
  status: "passed" | "failed" | "skipped" | "timed_out";
  /** Exit code (if executed) */
  exitCode?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Truncated output (last N lines) */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Timestamp when started */
  startedAt?: string;
  /** Timestamp when completed */
  completedAt?: string;
}

/** Complete gate result */
export interface GateResult {
  /** Unique gate run ID */
  id: string;
  /** Pipeline ID that was run */
  pipelineId: string;
  /** Exact commit SHA that was tested */
  commitSha: string;
  /** Branch name */
  branch: string;
  /** Project identifier */
  projectId: string;
  /** Node that ran the gate */
  nodeId: string;
  /** Overall status */
  status: "passed" | "failed" | "error";
  /** Individual step results */
  steps: GateStepResult[];
  /** Which steps were selected to run (based on scope) */
  selectedSteps: string[];
  /** Total duration in milliseconds */
  durationMs: number;
  /** When the gate started */
  startedAt: string;
  /** When the gate completed */
  completedAt: string;
  /** Pipeline version hash (for reproducibility) */
  pipelineVersion: string;
}

/** Signed gate result from a node */
export interface SignedGateResult {
  /** The gate result */
  result: GateResult;
  /** Ed25519 signature over the result JSON */
  signature: string;
  /** Node's public key (for verification) */
  nodePublicKey: string;
}

// ============ POLICY TYPES ============

/** Risk tier for a path pattern */
export type RiskTier = "red" | "amber" | "green";

/** Path-based risk tier rule */
export interface RiskTierRule {
  /** Glob patterns that match this tier */
  patterns: string[];
  /** Risk tier */
  tier: RiskTier;
  /** Human-readable description */
  description?: string;
}

/** Review requirements */
export interface ReviewRequirement {
  /** Minimum number of approving reviews */
  count: number;
  /** Reviews must be from distinct agents */
  distinctAgents: boolean;
  /** Reviews must be from distinct models (for red tier) */
  distinctModels?: boolean;
  /** Require at least one human reviewer */
  humanRequired?: boolean;
}

/** Protected test rule (tests that cannot be weakened) */
export interface ProtectedTestRule {
  /** Glob patterns for protected test files */
  patterns: string[];
  /** These patterns in the diff indicate weakening */
  weakeningPatterns: string[];
  /** Description of what these tests protect */
  description?: string;
}

/** Merge window (when merges are allowed) */
export interface MergeWindow {
  /** Days of week (0=Sunday, 6=Saturday) */
  daysOfWeek: number[];
  /** Start hour (0-23, in UTC) */
  startHour: number;
  /** End hour (0-23, in UTC) */
  endHour: number;
}

/** Complete policy configuration for a project */
export interface PolicyConfig {
  /** Project identifier */
  projectId: string;
  /** Risk tier rules (checked in order, first match wins) */
  riskTiers: RiskTierRule[];
  /** Review requirements by tier */
  reviewRequirements: Partial<Record<RiskTier, ReviewRequirement>>;
  /** Gates required at exact head SHA */
  requiredGates: string[];
  /** Protected tests that cannot be weakened */
  protectedTests: ProtectedTestRule[];
  /** Maximum PR size (lines changed) */
  maxPrSize?: number;
  /** Merge windows (if empty, always allowed) */
  mergeWindows?: MergeWindow[];
  /** Block patterns: PRs touching these cannot merge */
  blockedPatterns?: string[];
}

// ============ POLICY EVALUATION TYPES ============

/** A single policy violation */
export interface PolicyViolation {
  /** Rule that was violated */
  rule: string;
  /** Human-readable message */
  message: string;
  /** Severity */
  severity: "error" | "warning";
  /** Details (file paths, etc.) */
  details?: Record<string, unknown>;
}

/** Result of policy evaluation */
export interface PolicyEvaluation {
  /** Did the policy pass? */
  passed: boolean;
  /** Computed risk tier for this PR */
  tier: RiskTier;
  /** All violations found */
  violations: PolicyViolation[];
  /** Warnings (non-blocking) */
  warnings: PolicyViolation[];
  /** Evidence checked */
  evidence: {
    /** Gate results verified */
    gates: { id: string; status: string; commitSha: string; verified: boolean }[];
    /** Reviews counted */
    reviews: { agent: string; model?: string; approved: boolean }[];
    /** Files changed */
    changedFiles: string[];
  };
  /** When evaluation was performed */
  evaluatedAt: string;
}

// ============ MERGE TYPES ============

/** A pull request ready for merge evaluation */
export interface PullRequest {
  /** PR identifier */
  id: string;
  /** PR number on the git host */
  number: number;
  /** Source branch */
  sourceBranch: string;
  /** Target branch */
  targetBranch: string;
  /** Head commit SHA */
  headSha: string;
  /** Base commit SHA */
  baseSha: string;
  /** Changed files */
  changedFiles: string[];
  /** Lines added */
  linesAdded: number;
  /** Lines deleted */
  linesDeleted: number;
  /** Reviews */
  reviews: PullRequestReview[];
  /** Associated gate results */
  gateResults: SignedGateResult[];
  /** Project identifier */
  projectId: string;
}

/** A review on a pull request */
export interface PullRequestReview {
  /** Reviewer identifier (agent ID or user ID) */
  reviewerId: string;
  /** Is this an AI agent? */
  isAgent: boolean;
  /** Model used (if agent) */
  model?: string;
  /** Review state */
  state: "approved" | "changes_requested" | "commented";
  /** At which commit SHA */
  commitSha: string;
  /** When submitted */
  submittedAt: string;
}

/** Merge record (audit trail) */
export interface MergeRecord {
  /** Unique merge ID */
  id: string;
  /** PR that was merged */
  prId: string;
  /** Commit SHA that was merged */
  commitSha: string;
  /** Resulting merge commit SHA */
  mergeCommitSha: string;
  /** Policy evaluation at time of merge */
  policyEvaluation: PolicyEvaluation;
  /** Who/what initiated the merge */
  initiatedBy: string;
  /** When merged */
  mergedAt: string;
  /** Why merge was allowed (for audit) */
  reason: string;
}

/** Revert record */
export interface RevertRecord {
  /** Unique revert ID */
  id: string;
  /** Original merge that was reverted */
  originalMergeId: string;
  /** Revert commit SHA */
  revertCommitSha: string;
  /** Why it was reverted */
  reason: string;
  /** Gate result that triggered revert (if automatic) */
  triggeringGateId?: string;
  /** When reverted */
  revertedAt: string;
  /** Was this automatic? */
  automatic: boolean;
}
