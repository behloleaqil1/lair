/**
 * Which modules a project's YAML turns on, for the dashboard's nav: a
 * section whose module is off is hidden (and, opened by its URL, says how to
 * turn it on). Read from the config as written, so the nav follows a live
 * reload; a module that is on but failed to start shows its own errors in
 * its section.
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { ModuleFlags } from "../../shared/dashboard-types.js";

function block(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function enabled(value: unknown): boolean {
  return block(value)?.enabled === true;
}

function hasEntries(value: unknown): boolean {
  const map = block(value);
  return map !== null && Object.keys(map).length > 0;
}

export function moduleFlags(config: ProjectConfig, nodeCount: number): ModuleFlags {
  return {
    agents: enabled(config.agents),
    fill: enabled(config.agents) && enabled(block(config.agents)?.fill),
    planner: enabled(config.planner),
    review: enabled(config.review),
    triage: enabled(config.triage),
    placement: enabled(config.placement),
    hostServices: enabled(config.host_services),
    cloud: enabled(config.cloud),
    pipelines: hasEntries(config.pipelines),
    delivery: enabled(config.delivery),
    watchdog: enabled(config.watchdog),
    processes: hasEntries(config.processes),
    github: typeof config.github === "string" && config.github.trim() !== "",
    machines: hasEntries(config.machines),
    nodes: nodeCount > 0,
    lessons: enabled(config.lessons),
  };
}

/** Every module off: the project's config could not be read. */
export const NO_MODULES: ModuleFlags = {
  agents: false,
  fill: false,
  planner: false,
  review: false,
  triage: false,
  placement: false,
  hostServices: false,
  cloud: false,
  pipelines: false,
  delivery: false,
  watchdog: false,
  processes: false,
  github: false,
  machines: false,
  nodes: false,
  lessons: false,
};
