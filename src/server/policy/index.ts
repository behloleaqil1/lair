/**
 * Policy engine module.
 * Provides policy configuration, evaluation, and control-plane merge.
 */

export {
  parsePolicyConfig,
  computeRiskTier,
  getReviewRequirement,
  isWithinMergeWindow,
  checkProtectedTests,
  checkBlockedPatterns,
  createExamplePolicy,
} from "./policy-config.js";

export {
  evaluatePolicy,
  canMerge,
  type EvaluatePolicyOptions,
} from "./policy-evaluator.js";

export {
  attemptMerge,
  automaticRevert,
  createMockGitHost,
  type GitHostAdapter,
  type MergeOptions,
  type MergeResult,
  type RevertResult,
  type StatusCheck,
  type MergeAttemptOptions,
  type MergeAttemptResult,
  type AutoRevertOptions,
  type AutoRevertResult,
} from "./merge-controller.js";
