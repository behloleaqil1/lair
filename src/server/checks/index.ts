/**
 * Checks module exports.
 */
export { parseChecksConfig, validateSelector, validateBranchName, buildCommand, matchesWithin } from "./config.js";
export type { ChecksConfig, CheckKindConfig, ParsedChecksConfig, CommandPlaceholders } from "./config.js";

export { ChecksStore } from "./store.js";
export type { CheckRequest, CheckStatus, CheckAuditEntry } from "./store.js";

export { ChecksService, DEFAULT_RETENTION } from "./service.js";
export type {
  CheckResult,
  ChecksServiceOptions,
  CheckSpawner,
  SpawnResult,
  GuardRunner,
  Clock,
  ChecksFs,
  CheckError,
  CheckServiceResult,
  RetentionSettings,
} from "./service.js";

export { shaOnPushedBranch } from "./git.js";
export type { GitRunner, GitResult, ShaCheck } from "./git.js";

export { registerChecksRoutes } from "./routes.js";
export type { ChecksRoutesOptions } from "./routes.js";

export {
  ChecksManager,
  ChecksProcessSpawner,
  ChecksGuardRunner,
  NodeChecksFs,
  RepoGit,
  agentRunIsActive,
  checkEnvironment,
} from "./manager.js";
export type { ChecksManagerOptions, ProjectEntry } from "./manager.js";

export { parseJUnitFailures, isJUnitXml } from "./junit.js";
