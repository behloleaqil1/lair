/**
 * Tracker module: Lair keeps GitHub issues, Projects boards and milestones in
 * step with its tasks, runs and pull requests. Off unless a project sets
 * `tracker.enabled: true`; observe mode (records only) unless `mode: act`.
 *
 * See docs/design/tracker.md and docs/configuration.md#tracker.
 */
export { TrackerManager, type TrackerManagerOptions } from "./manager.js";
export { TrackerService, closingRefs, explicitIssue, type TrackerServiceOptions } from "./service.js";
export { TrackerStore, TrackerStoreError, TRACKER_SCHEMA_VERSION } from "./store.js";
export { registerTrackerRoutes } from "./routes.js";
export { TrackerSchema, parseTrackerConfig, statusToOption, optionToStatus, type TrackerSettings, type RepoSettings } from "./config.js";
export { GitHubTrackerClient, GitHubError, type FetchLike, type Board, type BoardItem, type Issue, type Milestone, type Pull } from "./github-projects.js";
export { makeRedactor } from "./redact.js";
export { fileTaskSource, type TaskSource, type TaskInfo, type TasksSnapshot } from "./tasks.js";
