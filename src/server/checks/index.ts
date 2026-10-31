/**
 * Checks module exports.
 */
export { parseChecksConfig, validateSelector, buildCommand } from "./config.js";
export type { ChecksConfig, CheckKindConfig, ParsedChecksConfig, CommandPlaceholders } from "./config.js";

export { ChecksStore, getChecksStore, closeChecksStores } from "./store.js";
export type { CheckRequest, CheckStatus, CheckAuditEntry } from "./store.js";

export { ChecksService } from "./service.js";
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
} from "./service.js";

export { registerChecksRoutes } from "./routes.js";
export type { ChecksRoutesOptions } from "./routes.js";

export { ChecksManager } from "./manager.js";
export type { ChecksManagerOptions, ProjectEntry } from "./manager.js";

export { parseJUnitFailures, isJUnitXml } from "./junit.js";
