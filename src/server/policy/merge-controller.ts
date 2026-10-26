/**
 * Merge controller.
 * Only the control plane can merge. This is the single point of merge authority.
 */
import { randomUUID } from "crypto";
import type {
  PullRequest,
  PolicyConfig,
  PolicyEvaluation,
  MergeRecord,
  RevertRecord,
  SignedGateResult,
} from "../../shared/policy-types.js";
import { evaluatePolicy, EvaluatePolicyOptions } from "./policy-evaluator.js";

/** Git host adapter interface */
export interface GitHostAdapter {
  /** Merge a PR */
  mergePullRequest(prNumber: number, options: MergeOptions): Promise<MergeResult>;
  /** Create a revert commit */
  createRevert(commitSha: string, message: string): Promise<RevertResult>;
  /** Get PR details */
  getPullRequest(prNumber: number): Promise<PullRequest>;
  /** Get diff content */
  getDiffContent(prNumber: number): Promise<string>;
  /** Post a status check */
  postStatusCheck(commitSha: string, status: StatusCheck): Promise<void>;
}

export interface MergeOptions {
  /** Commit message */
  message?: string;
  /** Merge method */
  method?: "merge" | "squash" | "rebase";
  /** Expected head SHA (for safety) */
  expectedHeadSha: string;
}

export interface MergeResult {
  success: boolean;
  mergeCommitSha?: string;
  error?: string;
}

export interface RevertResult {
  success: boolean;
  revertCommitSha?: string;
  error?: string;
}

export interface StatusCheck {
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string;
  targetUrl?: string;
}

/** Options for merge attempt */
export interface MergeAttemptOptions {
  /** PR number to merge */
  prNumber: number;
  /** Who initiated the merge */
  initiatedBy: string;
  /** Project's policy config */
  policy: PolicyConfig;
  /** Map of nodeId -> publicKey */
  nodePublicKeys: Map<string, string>;
  /** Map of pipelineId -> expected pipeline version (see EvaluatePolicyOptions) */
  expectedPipelineVersions: Map<string, string>;
  /** Git host adapter */
  gitHost: GitHostAdapter;
  /** Store merge record */
  storeMergeRecord: (record: MergeRecord) => Promise<void>;
}

/** Result of a merge attempt */
export interface MergeAttemptResult {
  success: boolean;
  mergeRecord?: MergeRecord;
  policyEvaluation: PolicyEvaluation;
  error?: string;
}

/**
 * Attempt to merge a PR.
 * This is the ONLY way a PR gets merged - through the control plane.
 */
export async function attemptMerge(options: MergeAttemptOptions): Promise<MergeAttemptResult> {
  const {
    prNumber,
    initiatedBy,
    policy,
    nodePublicKeys,
    expectedPipelineVersions,
    gitHost,
    storeMergeRecord,
  } = options;

  // 1. Get PR details
  let pr: PullRequest;
  let diffContent: string;
  try {
    pr = await gitHost.getPullRequest(prNumber);
    diffContent = await gitHost.getDiffContent(prNumber);
  } catch (error) {
    return {
      success: false,
      policyEvaluation: createFailedEvaluation("Failed to fetch PR details"),
      error: `Failed to fetch PR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 2. Evaluate policy
  const evalOptions: EvaluatePolicyOptions = {
    pr,
    policy,
    diffContent,
    nodePublicKeys,
    expectedPipelineVersions,
  };
  const evaluation = evaluatePolicy(evalOptions);

  // 3. Post status check (informational)
  try {
    await gitHost.postStatusCheck(pr.headSha, {
      context: "lair/policy",
      state: evaluation.passed ? "success" : "failure",
      description: evaluation.passed
        ? `Policy passed (${evaluation.tier} tier)`
        : `Policy failed: ${evaluation.violations.length} violation(s)`,
    });
  } catch {
    // Status check failure is not fatal
  }

  // 4. If policy fails, reject
  if (!evaluation.passed) {
    return {
      success: false,
      policyEvaluation: evaluation,
      error: `Policy check failed: ${evaluation.violations.map((v) => v.message).join("; ")}`,
    };
  }

  // 5. Attempt merge
  const mergeResult = await gitHost.mergePullRequest(prNumber, {
    expectedHeadSha: pr.headSha,
    method: "merge",
  });

  if (!mergeResult.success) {
    return {
      success: false,
      policyEvaluation: evaluation,
      error: `Merge failed: ${mergeResult.error}`,
    };
  }

  // 6. Record the merge
  const mergeRecord: MergeRecord = {
    id: `merge-${randomUUID().slice(0, 8)}`,
    prId: pr.id,
    commitSha: pr.headSha,
    mergeCommitSha: mergeResult.mergeCommitSha!,
    policyEvaluation: evaluation,
    initiatedBy,
    mergedAt: new Date().toISOString(),
    reason: generateMergeReason(evaluation),
  };

  await storeMergeRecord(mergeRecord);

  return {
    success: true,
    mergeRecord,
    policyEvaluation: evaluation,
  };
}

/**
 * Generate a human-readable reason for why merge was allowed.
 */
function generateMergeReason(evaluation: PolicyEvaluation): string {
  const reasons: string[] = [];

  // Gate evidence
  const verifiedGates = evaluation.evidence.gates.filter((g) => g.verified && g.status === "passed");
  if (verifiedGates.length > 0) {
    reasons.push(`${verifiedGates.length} gate(s) passed and verified`);
  }

  // Review evidence
  const approvals = evaluation.evidence.reviews.filter((r) => r.approved);
  if (approvals.length > 0) {
    reasons.push(`${approvals.length} approval(s) received`);
  }

  // Tier
  reasons.push(`risk tier: ${evaluation.tier}`);

  return reasons.join("; ");
}

/**
 * Create a failed evaluation for error cases.
 */
function createFailedEvaluation(message: string): PolicyEvaluation {
  return {
    passed: false,
    tier: "red", // Assume worst case
    violations: [
      {
        rule: "system-error",
        message,
        severity: "error",
      },
    ],
    warnings: [],
    evidence: {
      gates: [],
      reviews: [],
      changedFiles: [],
    },
    evaluatedAt: new Date().toISOString(),
  };
}

/** Options for automatic revert */
export interface AutoRevertOptions {
  /** Original merge record */
  mergeRecord: MergeRecord;
  /** Gate result that triggered the revert */
  triggeringGateResult: SignedGateResult;
  /** Git host adapter */
  gitHost: GitHostAdapter;
  /** Store revert record */
  storeRevertRecord: (record: RevertRecord) => Promise<void>;
}

/** Result of automatic revert */
export interface AutoRevertResult {
  success: boolean;
  revertRecord?: RevertRecord;
  error?: string;
}

/**
 * Automatically revert a merge when post-merge gate fails.
 */
export async function automaticRevert(options: AutoRevertOptions): Promise<AutoRevertResult> {
  const { mergeRecord, triggeringGateResult, gitHost, storeRevertRecord } = options;

  const reason = `Post-merge gate ${triggeringGateResult.result.id} failed: ${
    triggeringGateResult.result.steps
      .filter((s) => s.status === "failed")
      .map((s) => s.name)
      .join(", ")
  }`;

  try {
    const revertResult = await gitHost.createRevert(
      mergeRecord.mergeCommitSha,
      `Revert "${mergeRecord.prId}": ${reason}`
    );

    if (!revertResult.success) {
      return {
        success: false,
        error: `Revert failed: ${revertResult.error}`,
      };
    }

    const revertRecord: RevertRecord = {
      id: `revert-${randomUUID().slice(0, 8)}`,
      originalMergeId: mergeRecord.id,
      revertCommitSha: revertResult.revertCommitSha!,
      reason,
      triggeringGateId: triggeringGateResult.result.id,
      revertedAt: new Date().toISOString(),
      automatic: true,
    };

    await storeRevertRecord(revertRecord);

    return {
      success: true,
      revertRecord,
    };
  } catch (error) {
    return {
      success: false,
      error: `Revert failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Mock git host adapter for testing.
 */
export function createMockGitHost(
  pr: PullRequest,
  diffContent: string
): GitHostAdapter {
  let merged = false;
  let mergeCommitSha: string | undefined;

  return {
    async getPullRequest() {
      return pr;
    },
    async getDiffContent() {
      return diffContent;
    },
    async mergePullRequest(prNumber, options) {
      if (options.expectedHeadSha !== pr.headSha) {
        return { success: false, error: "Head SHA mismatch" };
      }
      if (merged) {
        return { success: false, error: "Already merged" };
      }
      merged = true;
      mergeCommitSha = `merge-${randomUUID().slice(0, 8)}`;
      return { success: true, mergeCommitSha };
    },
    async createRevert(_commitSha, _message) {
      return {
        success: true,
        revertCommitSha: `revert-${randomUUID().slice(0, 8)}`,
      };
    },
    async postStatusCheck() {
      // No-op in mock
    },
  };
}
