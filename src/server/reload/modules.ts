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
import type { PlacementManager } from "../placement/service.js";
import { parsePlannerConfig } from "../planner/config.js";
import type { PlannerManager } from "../planner/manager.js";
import { parseWatchdogConfig } from "../watchdog/config.js";
import type { WatchdogManager } from "../watchdog/service.js";
import type { Supervisor } from "../supervisor/service.js";

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
  placements?: PlacementManager;
  planner?: PlannerManager;
  supervisor?: Supervisor;
}

function errorsOf(result: { ok: true } | { ok: false; errors: string[] }): string[] {
  return result.ok ? [] : result.errors;
}

/** The server's modules, as src/server/index.ts wires them. */
export function serverModules(m: ServerModules): ReloadableModule[] {
  const modules: ReloadableModule[] = [];
  const { delivery, watchdogs, pipelines, reviews, agents, triage, placements, planner, supervisor } = m;
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
  if (placements) {
    modules.push({
      name: "placement",
      blocks: ["placement"],
      validate: (config) => placements.validate(config),
      reload: (entry) => placements.reloadProject(entry),
    });
  }
  if (planner) {
    modules.push({
      name: "planner",
      blocks: ["planner"],
      // Its tasks file, allowlist and done pattern are agents.fill's
      reads: ["agents"],
      validate: (config) => errorsOf(parsePlannerConfig(config.planner, config)),
      reload: (entry) => planner.reloadProject(entry),
    });
  }
  if (supervisor) {
    modules.push({
      name: "supervisor",
      blocks: ["supervisor"],
      // Which agent supervisor runs start on comes from these blocks: a change there makes the chat read it again.
      // It is never a config error (the chat's problem instead), so a change there can't keep the file from loading
      reads: ["agents", "dragons", "ai", "planner"],
      validate: (config) => supervisor.validate(config),
      reload: (entry) => supervisor.reloadProject(entry),
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
 * Top-level keys none of these modules reads: the dashboard's controls and
 * commands, the merge bar, the process manager, the orchestrator, the model
 * list. A change to them reloads nothing. Any other key no module owns
 * (name, repo, read_only, dragons, machines, agents_dir, an undeclared key
 * such as agent_adapters...) may be read by any module, so a change to it
 * reloads them all. modules.test.ts checks this list against the modules'
 * code.
 */
export const UNREAD_KEYS: ReadonlySet<string> = new Set([
  "status_cmd",
  "orchestrator",
  "allow_direct_assign",
  "backlog_file",
  "ask_cmd",
  "tick_now_cmd",
  "pause_cmd",
  "resume_cmd",
  "agent_run_cmd",
  "agent_stop_cmd",
  "agent_release_cmd",
  "gate_submit_cmd",
  "gate_stuck_cmd",
  "merge_cmd",
  "merge_bar",
  "processes",
  "available_models",
  "gate_runner",
  "dragon_start_cmd",
  "dragon_stop_cmd",
  "dragon_release_cmd",
]);

/**
 * What `module` reads of `config`: its own blocks, the blocks it also
 * reads, and every top-level key no module owns (name, repo, read_only,
 * dragons, machines...) except UNREAD_KEYS. Two configs with the same
 * fingerprint run the module the same way.
 */
export function fingerprint(module: ReloadableModule, config: ProjectConfig, owned: ReadonlySet<string>): string {
  const mine = new Set([...module.blocks, ...(module.reads ?? [])]);
  const slice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (mine.has(key) || (!owned.has(key) && !UNREAD_KEYS.has(key))) slice[key] = value;
  }
  return stableJson(slice);
}
