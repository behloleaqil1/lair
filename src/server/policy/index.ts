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
  verifyGateResults,
  type EvaluatePolicyOptions,
} from "./policy-evaluator.js";

export {
  assessRisk,
  matchPath,
  fileKindsOf,
  higherTier,
  DEFAULT_FILE_KINDS,
  DEFAULT_RISK_RULES,
  type RiskRule,
  type ChangedFile,
  type ChangeFacts,
} from "./risk-rules.js";

export {
  matchSlots,
  slotMismatch,
  slotLabel,
  optionLabel,
  type SlotCandidate,
} from "./reviewer-slots.js";

export {
  evaluateMergePolicy,
  type MergePolicyInput,
  type MergePolicyResult,
} from "./merge-policy.js";

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
