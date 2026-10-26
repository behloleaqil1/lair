/**
 * Policy evaluator.
 * Evaluates whether a PR meets all policy requirements for merge.
 */
import type {
  PolicyConfig,
  PolicyEvaluation,
  PolicyViolation,
  PullRequest,
  RiskTier,
  SignedGateResult,
} from "../../shared/policy-types.js";
import {
  computeRiskTier,
  getReviewRequirement,
  isWithinMergeWindow,
  checkProtectedTests,
  checkBlockedPatterns,
} from "./policy-config.js";
import {
  verifySignedGateResult,
  detectTampering,
  isShellError,
} from "../gates/signature.js";

/** Options for policy evaluation */
export interface EvaluatePolicyOptions {
  /** The pull request to evaluate */
  pr: PullRequest;
  /** The policy config to evaluate against */
  policy: PolicyConfig;
  /** The diff content (for protected test checks) */
  diffContent: string;
  /** Map of nodeId -> publicKey for signature verification */
  nodePublicKeys: Map<string, string>;
  /**
   * Map of pipelineId -> expected pipeline version (computePipelineVersion()
   * of the pipeline config in force). A gate result run with any other
   * version, or for a required gate with no entry here, is rejected.
   */
  expectedPipelineVersions: Map<string, string>;
  /** Current time (for merge window checks) */
  now?: Date;
}

/**
 * Evaluate a PR against a policy.
 * Returns whether the PR can be merged and any violations.
 */
export function evaluatePolicy(options: EvaluatePolicyOptions): PolicyEvaluation {
  const {
    pr,
    policy,
    diffContent,
    nodePublicKeys,
    expectedPipelineVersions,
    now = new Date(),
  } = options;

  const violations: PolicyViolation[] = [];
  const warnings: PolicyViolation[] = [];
  const gateEvidence: PolicyEvaluation["evidence"]["gates"] = [];
  const reviewEvidence: PolicyEvaluation["evidence"]["reviews"] = [];

  // 1. Compute risk tier
  const tier = computeRiskTier(pr.changedFiles, policy.riskTiers);

  // 2. Check blocked patterns
  const blockedFiles = checkBlockedPatterns(policy.blockedPatterns, pr.changedFiles);
  if (blockedFiles.length > 0) {
    violations.push({
      rule: "blocked-patterns",
      message: `PR touches blocked files: ${blockedFiles.join(", ")}`,
      severity: "error",
      details: { blockedFiles },
    });
  }

  // 3. Check PR size
  if (policy.maxPrSize) {
    const totalLines = pr.linesAdded + pr.linesDeleted;
    if (totalLines > policy.maxPrSize) {
      violations.push({
        rule: "max-pr-size",
        message: `PR size (${totalLines} lines) exceeds limit (${policy.maxPrSize})`,
        severity: "error",
        details: { totalLines, limit: policy.maxPrSize },
      });
    }
  }

  // 4. Check merge window
  if (!isWithinMergeWindow(policy.mergeWindows, now)) {
    violations.push({
      rule: "merge-window",
      message: "Current time is outside allowed merge windows",
      severity: "error",
      details: { currentTime: now.toISOString() },
    });
  }

  // 5. Check protected tests
  const { violations: testViolations } = checkProtectedTests(policy, pr.changedFiles, diffContent);
  for (const v of testViolations) {
    violations.push({
      rule: "protected-tests",
      message: v,
      severity: "error",
    });
  }

  // 6. Verify gate results
  const verifiedGates = verifyGateResults(
    pr,
    policy,
    nodePublicKeys,
    expectedPipelineVersions,
  );
  gateEvidence.push(...verifiedGates.evidence);
  violations.push(...verifiedGates.violations);

  // 7. Check review requirements
  const reviewResult = checkReviews(pr, policy, tier);
  reviewEvidence.push(...reviewResult.evidence);
  violations.push(...reviewResult.violations);
  warnings.push(...reviewResult.warnings);

  return {
    passed: violations.length === 0,
    tier,
    violations,
    warnings,
    evidence: {
      gates: gateEvidence,
      reviews: reviewEvidence,
      changedFiles: pr.changedFiles,
    },
    evaluatedAt: now.toISOString(),
  };
}

/** Why one gate result can't be trusted, as a violation plus its evidence row. */
interface GateRejection {
  violation: PolicyViolation;
  evidence: PolicyEvaluation["evidence"]["gates"][number];
}

/** Sort key for "newest": completion time, then start time. */
function gateTime(signed: SignedGateResult): number {
  const completed = Date.parse(signed.result.completedAt);
  if (!Number.isNaN(completed)) return completed;
  const started = Date.parse(signed.result.startedAt);
  return Number.isNaN(started) ? 0 : started;
}

/**
 * Check that a gate result can be trusted: known node, valid signature, this
 * project, the expected pipeline version, no tampering, a real run.
 * Returns null if it can, otherwise the reason it can't.
 */
function checkGateResult(
  signed: SignedGateResult,
  pr: PullRequest,
  policy: PolicyConfig,
  nodePublicKeys: Map<string, string>,
  expectedVersion: string | undefined,
): GateRejection | null {
  const result = signed.result;
  const reject = (
    rule: string,
    status: string,
    message: string,
    details: Record<string, unknown>,
  ): GateRejection => ({
    violation: { rule, message, severity: "error", details },
    evidence: { id: result.id, status, commitSha: result.commitSha, verified: false },
  });

  // Verify signature
  const nodeKey = nodePublicKeys.get(result.nodeId);
  if (!nodeKey) {
    return reject(
      "gate-signature",
      "invalid-node",
      `Unknown node for gate ${result.id}: ${result.nodeId}`,
      { gateId: result.id, nodeId: result.nodeId },
    );
  }

  const sigResult = verifySignedGateResult(signed, nodeKey);
  if (!sigResult.valid) {
    return reject(
      "gate-signature",
      "invalid-signature",
      `Invalid signature for gate ${result.id}: ${sigResult.errors.join(", ")}`,
      { gateId: result.id, errors: sigResult.errors },
    );
  }

  // The (signed) result must be for this project and the pipeline in force
  if (result.projectId !== policy.projectId || result.projectId !== pr.projectId) {
    return reject(
      "gate-project",
      "wrong-project",
      `Gate ${result.id} is for project ${result.projectId}, not ${policy.projectId}`,
      { gateId: result.id, gateProject: result.projectId, project: policy.projectId },
    );
  }

  if (expectedVersion === undefined || result.pipelineVersion !== expectedVersion) {
    return reject(
      "gate-pipeline-version",
      "wrong-pipeline-version",
      expectedVersion === undefined
        ? `No expected pipeline version configured for ${result.pipelineId}`
        : `Gate ${result.id} ran pipeline version ${result.pipelineVersion}, expected ${expectedVersion}`,
      {
        gateId: result.id,
        pipelineId: result.pipelineId,
        gateVersion: result.pipelineVersion,
        expectedVersion,
      },
    );
  }

  // Check for tampering
  const tamperIssues = detectTampering(result);
  if (tamperIssues.length > 0) {
    return reject(
      "gate-tampering",
      "tampered",
      `Gate ${result.id} shows signs of tampering: ${tamperIssues.join(", ")}`,
      { gateId: result.id, issues: tamperIssues },
    );
  }

  // Check for shell errors (not a real run)
  if (isShellError(result)) {
    return reject(
      "gate-shell-error",
      "shell-error",
      `Gate ${result.id} is a shell error, not a real run`,
      { gateId: result.id },
    );
  }

  // Check commit SHA matches
  if (result.commitSha !== pr.headSha) {
    return reject(
      "gate-commit",
      "wrong-commit",
      `Gate ${result.id} is for wrong commit: ${result.commitSha} != ${pr.headSha}`,
      { gateId: result.id, gateCommit: result.commitSha, prCommit: pr.headSha },
    );
  }

  return null;
}

/**
 * Verify all gate results for a PR.
 *
 * For each required gate, the NEWEST trustworthy result at the head commit
 * decides: an older pass can't hide a newer failure, and an untrustworthy
 * result (bad signature, other project, old pipeline version, tampered) is
 * ignored. If no candidate can be trusted, every rejection is reported.
 */
export function verifyGateResults(
  pr: PullRequest,
  policy: PolicyConfig,
  nodePublicKeys: Map<string, string>,
  expectedPipelineVersions: Map<string, string>,
): {
  evidence: PolicyEvaluation["evidence"]["gates"];
  violations: PolicyViolation[];
} {
  const evidence: PolicyEvaluation["evidence"]["gates"] = [];
  const violations: PolicyViolation[] = [];

  // Check each required gate has a valid result
  for (const requiredGateId of policy.requiredGates) {
    // Candidate results for this gate at the head commit, newest first
    const candidates = pr.gateResults
      .filter(
        (g) => g.result.pipelineId === requiredGateId && g.result.commitSha === pr.headSha,
      )
      .sort((a, b) => gateTime(b) - gateTime(a));

    if (candidates.length === 0) {
      violations.push({
        rule: "required-gate",
        message: `Missing required gate: ${requiredGateId} at commit ${pr.headSha}`,
        severity: "error",
        details: { requiredGateId, commitSha: pr.headSha },
      });
      evidence.push({
        id: requiredGateId,
        status: "missing",
        commitSha: pr.headSha,
        verified: false,
      });
      continue;
    }

    const expectedVersion = expectedPipelineVersions.get(requiredGateId);
    const rejections: GateRejection[] = [];
    let chosen: SignedGateResult | undefined;
    for (const candidate of candidates) {
      const rejection = checkGateResult(
        candidate,
        pr,
        policy,
        nodePublicKeys,
        expectedVersion,
      );
      if (!rejection) {
        chosen = candidate;
        break;
      }
      rejections.push(rejection);
    }

    if (!chosen) {
      for (const rejection of rejections) {
        violations.push(rejection.violation);
        evidence.push(rejection.evidence);
      }
      continue;
    }

    // Check gate passed
    if (chosen.result.status !== "passed") {
      violations.push({
        rule: "gate-failed",
        message: `Gate ${chosen.result.id} failed with status: ${chosen.result.status}`,
        severity: "error",
        details: {
          gateId: chosen.result.id,
          status: chosen.result.status,
          failedSteps: chosen.result.steps
            .filter((s) => s.status === "failed")
            .map((s) => s.name),
        },
      });
      evidence.push({
        id: chosen.result.id,
        status: chosen.result.status,
        commitSha: chosen.result.commitSha,
        verified: true, // Signature is valid, just status is failed
      });
      continue;
    }

    // Gate is valid!
    evidence.push({
      id: chosen.result.id,
      status: "passed",
      commitSha: chosen.result.commitSha,
      verified: true,
    });
  }

  return { evidence, violations };
}

/**
 * Check review requirements.
 */
function checkReviews(
  pr: PullRequest,
  policy: PolicyConfig,
  tier: RiskTier
): {
  evidence: PolicyEvaluation["evidence"]["reviews"];
  violations: PolicyViolation[];
  warnings: PolicyViolation[];
} {
  const evidence: PolicyEvaluation["evidence"]["reviews"] = [];
  const violations: PolicyViolation[] = [];
  const warnings: PolicyViolation[] = [];

  const requirement = getReviewRequirement(policy, tier);

  // Add all reviews to evidence
  for (const review of pr.reviews) {
    evidence.push({
      agent: review.reviewerId,
      model: review.model,
      approved: review.state === "approved",
    });
  }

  if (!requirement || requirement.count === 0) {
    return { evidence, violations, warnings };
  }

  // Filter to approving reviews at the current head
  const approvingReviews = pr.reviews.filter(
    (r) => r.state === "approved" && r.commitSha === pr.headSha
  );

  // Count reviews
  if (approvingReviews.length < requirement.count) {
    violations.push({
      rule: "review-count",
      message: `Insufficient reviews: ${approvingReviews.length}/${requirement.count} required for ${tier} tier`,
      severity: "error",
      details: {
        required: requirement.count,
        actual: approvingReviews.length,
        tier,
      },
    });
  }

  // Check distinct agents
  if (requirement.distinctAgents) {
    const uniqueAgents = new Set(approvingReviews.map((r) => r.reviewerId));
    if (uniqueAgents.size < requirement.count) {
      violations.push({
        rule: "review-distinct-agents",
        message: `Reviews must be from ${requirement.count} distinct agents, got ${uniqueAgents.size}`,
        severity: "error",
        details: {
          required: requirement.count,
          actual: uniqueAgents.size,
          agents: Array.from(uniqueAgents),
        },
      });
    }
  }

  // Check distinct models (for red tier)
  if (requirement.distinctModels) {
    const agentReviews = approvingReviews.filter((r) => r.isAgent && r.model);
    const uniqueModels = new Set(agentReviews.map((r) => r.model));
    if (agentReviews.length >= 2 && uniqueModels.size < 2) {
      violations.push({
        rule: "review-distinct-models",
        message: "Red tier requires reviews from distinct AI models",
        severity: "error",
        details: {
          models: Array.from(uniqueModels),
        },
      });
    }
  }

  // Check human required
  if (requirement.humanRequired) {
    const humanReviews = approvingReviews.filter((r) => !r.isAgent);
    if (humanReviews.length === 0) {
      violations.push({
        rule: "review-human-required",
        message: `${tier} tier requires at least one human review`,
        severity: "error",
      });
    }
  }

  // Warn about stale reviews
  const staleReviews = pr.reviews.filter(
    (r) => r.state === "approved" && r.commitSha !== pr.headSha
  );
  if (staleReviews.length > 0) {
    warnings.push({
      rule: "review-stale",
      message: `${staleReviews.length} review(s) are from previous commits`,
      severity: "warning",
      details: {
        staleReviews: staleReviews.map((r) => ({
          reviewer: r.reviewerId,
          commitSha: r.commitSha,
        })),
      },
    });
  }

  return { evidence, violations, warnings };
}

/**
 * Quick check if a PR can be merged (without full evaluation).
 * Useful for UI status indicators.
 */
export function canMerge(options: EvaluatePolicyOptions): boolean {
  const evaluation = evaluatePolicy(options);
  return evaluation.passed;
}
