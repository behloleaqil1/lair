/**
 * Cleanup module: retention and removal for worktrees and watched folders.
 */
export { CleanupSchema, parseCleanupConfig, getConfiguredRoots } from "./config.js";
export type { CleanupSettings, RetentionEntry, WorktreesSettings } from "./config.js";

export { CleanupStore } from "./store.js";
export type { CleanupRemoval, CleanupCycle } from "./store.js";

export { CleanupService } from "./service.js";
export type { CleanupPending, CleanupCycleResult, CleanupEvent, EventEmitter, AuditLogger } from "./service.js";

export { cleanupRoutes } from "./routes.js";
export type { CleanupRoutesDeps } from "./routes.js";

export { checkPathSafety, isInsidePath, isGitRepoRoot } from "./safety.js";
export type { SafetyResult, SafetyViolation } from "./safety.js";

export { realClock, realFs, realCommandRunner, parseWorktreeList } from "./probes.js";
export type { Clock, FileSystem, CommandRunner, GitHost, WorktreeInfo } from "./probes.js";

export type { AgentClaims, WorktreeCandidate } from "./worktree.js";
export type { RetentionCandidate } from "./retention.js";
