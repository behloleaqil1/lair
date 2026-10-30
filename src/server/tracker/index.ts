/**
 * Tracker module: Lair keeps GitHub issues, Projects boards and milestones
 * in sync with its tasks, runs and PRs. Off unless a project sets
 * `tracker.enabled: true`.
 *
 * See docs/design/tracker.md and docs/configuration.md#tracker.
 */
export { TrackerService, TrackerError, type TrackerServiceOptions } from "./service.js";
export { TrackerStore } from "./store.js";
export {
  parseTrackerConfig,
  statusToOption,
  optionToStatus,
  type TrackerSettings,
  type StatusMapping,
  type TierLabels,
  type MilestoneSettings,
  type TrackerParseResult,
} from "./config.js";
export {
  GitHubProjectsClient,
  ProjectsApiError,
  type ProjectBoard,
  type ProjectField,
  type ProjectTextField,
  type ProjectItem,
  type TrackerIssue,
  type TrackerMilestone,
  type GitHubProjectsOptions,
} from "./github-projects.js";
