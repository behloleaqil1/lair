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

// Pipelines from the project config and the executors that run them
// (docs/design/runners.md). Started and stopped by src/server/index.ts.
export {
  PipelineManager,
  PipelineRequestError,
  budgetProvider,
  type PipelineManagerOptions,
  type PipelineProjectEntry,
} from "./pipeline-service.js";
export { registerPipelineRoutes } from "./routes.js";
export { parsePipelineConfig, type ProjectPipelineSettings } from "./project-pipelines.js";
export { EventBusDecisionHook, type DecisionHook, type DecisionRequest } from "./decision-hook.js";
