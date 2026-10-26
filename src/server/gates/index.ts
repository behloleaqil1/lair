/**
 * Gate pipeline module.
 * Provides gate configuration, execution, and cryptographic verification.
 */

export {
  parseGatePipeline,
  parseProjectGateConfig,
  parseGateStep,
  matchGlob,
  computeAffectedSteps,
  computePipelineVersion,
  createExamplePipeline,
} from "./pipeline-config.js";

export {
  runGate,
  validateGateResult,
  type RunGateOptions,
  type ExecuteOptions,
  type ExecuteResult,
} from "./gate-executor.js";

export {
  generateNodeKeyPair,
  signGateResult,
  verifySignedGateResult,
  verifyGateResultIntegrity,
  detectTampering,
  isShellError,
  type NodeKeyPair,
  type VerificationResult,
} from "./signature.js";
