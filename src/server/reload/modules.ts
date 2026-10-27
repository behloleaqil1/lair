/**
 * The modules a project config change can reload, each with its own blocks
 * of the project config, its own parser, and its manager's reloadProject().
 */
import type { ProjectConfig } from "../../shared/types.js";
import { parseAgentsConfig } from "../agents/config.js";
import type { AgentsManager } from "../agents/service.js";
import { parseDeliveryConfig } from "../delivery/config.js";
import type { DeliveryManager } from "../delivery/service.js";
import { parsePipelineConfig } from "../gates/project-pipelines.js";
import type { PipelineManager } from "../gates/pipeline-service.js";
import { parseReviewConfig } from "../review/config.js";
import type { ReviewManager } from "../review/service.js";
import type { TriageManager } from "../triage/manager.js";
import { parseWatchdogConfig } from "../watchdog/config.js";
import type { WatchdogManager } from "../watchdog/service.js";

export interface ProjectEntry {
  name: string;
  config?: ProjectConfig;
  /** The config could not be loaded */
  error?: string;
}

/** One module, as the reloader sees it. */
export interface ReloadableModule {
  readonly name: string;
  /** The top-level keys of a project config that are this module's own */
  readonly blocks: readonly string[];
  /** Other modules' blocks this module reads too (a change there reloads it as well) */
  readonly reads?: readonly string[];
  /** The module's own parser: the errors that would keep it from starting ([] when valid) */
  validate(config: ProjectConfig): string[];
  /**
   * Stop the project's instance cleanly, then start it from `entry` (no
   * config: off). Resolves once it runs; on failure nothing of the new
   * instance is left running.
   */
  reload(entry: ProjectEntry): Promise<void>;
}

export interface ServerModules {
  delivery?: DeliveryManager;
  watchdogs?: WatchdogManager;
  pipelines?: PipelineManager;
  reviews?: ReviewManager;
  agents?: AgentsManager;
  triage?: TriageManager;
}

function errorsOf(result: { ok: true } | { ok: false; errors: string[] }): string[] {
  return result.ok ? [] : result.errors;
}

/** The server's modules, as src/server/index.ts wires them. */
export function serverModules(m: ServerModules): ReloadableModule[] {
  const modules: ReloadableModule[] = [];
  const { delivery, watchdogs, pipelines, reviews, agents, triage } = m;
  if (delivery) {
    modules.push({
      name: "delivery",
      blocks: ["delivery"],
      validate: (config) => errorsOf(parseDeliveryConfig(config.delivery)),
      reload: (entry) => delivery.reloadProject(entry),
    });
  }
  if (watchdogs) {
    modules.push({
      name: "watchdog",
      blocks: ["watchdog"],
      validate: (config) => errorsOf(parseWatchdogConfig(config.watchdog)),
      reload: (entry) => watchdogs.reloadProject(entry),
    });
  }
  if (pipelines) {
    modules.push({
      name: "pipelines",
      blocks: ["pipelines", "executors"],
      validate: (config) =>
        config.pipelines === undefined && config.executors === undefined
          ? []
          : errorsOf(parsePipelineConfig(config.pipelines, config.executors, config.github)),
      reload: (entry) => pipelines.reloadProject(entry),
    });
  }
  if (reviews) {
    modules.push({
      name: "review",
      blocks: ["review"],
      validate: (config) => errorsOf(parseReviewConfig(config.review, config)),
      reload: (entry) => reviews.reloadProject(entry),
    });
  }
  if (agents) {
    modules.push({
      name: "agents",
      blocks: ["agents"],
      // Its hung-agent rule comes from the project's watchdog settings
      reads: ["watchdog"],
      validate: (config) => errorsOf(parseAgentsConfig(config.agents, config)),
      reload: (entry) => agents.reloadProject(entry),
    });
  }
  if (triage) {
    modules.push({
      name: "triage",
      blocks: ["triage"],
      validate: (config) => triage.validate(config),
      reload: (entry) => triage.reloadProject(entry),
    });
  }
  return modules;
}

/** JSON with object keys sorted, so the same settings in another key order compare equal. */
export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) throw new Error("the config refers to itself");
    seen.add(v);
    const out = Array.isArray(v)
      ? v.map(sort)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
        );
    seen.delete(v);
    return out;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

/**
 * What `module` reads of `config`: its own blocks, the blocks it also
 * reads, and every top-level key no module owns (name, repo, read_only,
 * dragons, machines...), which any module may read. Two configs with the
 * same fingerprint run the module the same way.
 */
export function fingerprint(module: ReloadableModule, config: ProjectConfig, owned: ReadonlySet<string>): string {
  const mine = new Set([...module.blocks, ...(module.reads ?? [])]);
  const slice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (mine.has(key) || !owned.has(key)) slice[key] = value;
  }
  return stableJson(slice);
}
