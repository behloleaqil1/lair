/**
 * The token variables the projects name: the update command must not get
 * them (restart.ts updateEnvironment), as local gate steps don't.
 */
import type { ProjectConfig } from "../../shared/types.js";
import { parseAgentsConfig } from "../agents/config.js";
import { parsePipelineConfig } from "../gates/project-pipelines.js";
import { parseReviewConfig } from "../review/config.js";
import { parseTrackerConfig } from "../tracker/config.js";

/**
 * review.token_env (reviews on), executors.github.token_env (pipelines
 * configured), agents.env_passthrough (agents on: the provider keys the
 * agents get) and the tracker's token variable (tracker on), over all
 * `configs`.
 */
export function configuredTokenEnvs(configs: ProjectConfig[]): string[] {
  const names = new Set<string>();
  for (const config of configs) {
    const review = parseReviewConfig(config.review, config);
    if (review.ok && review.settings.enabled) names.add(review.settings.tokenEnv);
    if (config.pipelines !== undefined || config.executors !== undefined) {
      const pipelines = parsePipelineConfig(config.pipelines, config.executors, config.github);
      if (pipelines.ok) names.add(pipelines.settings.executors.github.tokenEnv);
    }
    const agents = parseAgentsConfig(config.agents, config);
    if (agents.ok && agents.settings.enabled) for (const name of agents.settings.envPassthrough) names.add(name);
    const tracker = parseTrackerConfig(config.tracker, config);
    if (tracker.ok && tracker.settings.enabled) names.add(tracker.settings.token.env);
  }
  return [...names].sort();
}
