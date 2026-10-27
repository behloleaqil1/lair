/**
 * Reviews and policy merge (docs/design/autonomy.md §5). Started by
 * src/server/index.ts; off unless a project sets `review.enabled: true`.
 */
export { ReviewManager, ReviewService, ReviewError, INTEGRITY_REVIEWER, systemClock } from "./service.js";
export type { Clock, ReviewInput, RequestOutcome, ProjectEntry, ReviewManagerOptions } from "./service.js";
export { registerReviewRoutes } from "./routes.js";
export {
  parseReviewConfig,
  compileBranchTemplate,
  agentFromBranch,
  DEFAULT_REVIEWERS,
  DEFAULT_CHECK_APP,
  NOREPLY_EMAILS,
} from "./config.js";
export type { ReviewSettings, MergeSettings, GateSettings, IntegritySettings, RequiredCheck } from "./config.js";
export { ReviewStore } from "./store.js";
export { checkTestIntegrity, classifyAssertion, isTestFile } from "./integrity.js";
export type { IntegrityFile, IntegrityFinding, IntegrityOptions, IntegrityRule } from "./integrity.js";
export { GitHubHost, tokenFrom } from "./github.js";
export type { FetchLike, FetchResponseLike, TokenSource } from "./github.js";
export { HostError } from "./host.js";
export type { GitHost, HostPullRequest, HostFile, HostCommit, HostCheck, HostRepo } from "./host.js";
export { systemGit } from "./git.js";
export type { GitRunner, GitResult } from "./git.js";
export {
  LocalMerger,
  mergeOnHost,
  planMerge,
  checkCommitEmails,
  emailAllowed,
  maskEmail,
} from "./executor.js";
export type { MergeExecution, PublishedCommit, EmailViolation } from "./executor.js";
export { hostChecksGate, signedGate, checkVerdict, trustedCheck } from "./gate-source.js";
export type { GateSource } from "./gate-source.js";
export {
  eventBusDecisionSink,
  eventBusAssigner,
  unwiredDecisionSink,
  unwiredAssigner,
} from "./ports.js";
export type {
  DecisionSink,
  DecisionRequest,
  DecisionKind,
  ReviewAssigner,
  ReviewAssignment,
  ReviewerRuns,
} from "./ports.js";
export { AgentReviewAssigner, reviewTaskId, AGENTS_CHANNEL } from "./agent-assigner.js";
export { buildReviewPrompt, fillTemplate, FINDINGS_FORMAT } from "./prompt.js";
export { mapAuthor, compileBranchGlob, globMatches, branchesFromTasks } from "./authors.js";
