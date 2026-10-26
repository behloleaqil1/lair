/**
 * Adapter Config Parser
 *
 * Parses agent adapter and terminology configuration from project YAML.
 */
import type {
  AgentAdapter,
  ProjectTerminology,
  AdapterValidationResult,
} from "../../shared/types.js";
import {
  BUILTIN_ADAPTERS,
  DEFAULT_TERMINOLOGY,
  validateAdapter,
} from "../services/adapters.js";

/**
 * Raw adapter config from YAML (before validation).
 */
interface RawAdapterConfig {
  id?: string;
  name?: string;
  start_cmd?: string;
  stop_cmd?: string;
  status_method?: string;
  queue_file?: string;
  log_dir?: string;
  status_pattern?: string;
  mcp_endpoint?: string;
  session_id_env?: string;
  resume_flag?: string;
}

/**
 * Raw terminology config from YAML.
 */
interface RawTerminologyConfig {
  agent_singular?: string;
  agent_plural?: string;
  orchestrator?: string;
}

/**
 * Parse adapters from raw config object.
 * Returns validated adapters with errors collected.
 */
export function parseAdaptersConfig(
  rawConfig: Record<string, RawAdapterConfig> | undefined,
): { adapters: AgentAdapter[]; errors: string[] } {
  const adapters: AgentAdapter[] = [];
  const errors: string[] = [];

  if (!rawConfig || typeof rawConfig !== "object") {
    return { adapters, errors };
  }

  for (const [id, raw] of Object.entries(rawConfig)) {
    // Ensure id is set
    const adapter: AgentAdapter = {
      id: raw.id || id,
      name: raw.name || id,
      start_cmd: raw.start_cmd || "",
      stop_cmd: raw.stop_cmd || "",
      status_method: (raw.status_method as "file" | "stdout" | "mcp") || "file",
      queue_file: raw.queue_file,
      log_dir: raw.log_dir,
      status_pattern: raw.status_pattern,
      mcp_endpoint: raw.mcp_endpoint,
      session_id_env: raw.session_id_env,
      resume_flag: raw.resume_flag,
    };

    // Validate
    const result = validateAdapter(adapter);
    if (!result.valid) {
      for (const err of result.errors) {
        errors.push(`Adapter '${id}': ${err}`);
      }
    } else {
      adapters.push(adapter);
    }
  }

  return { adapters, errors };
}

/**
 * Parse terminology from raw config object.
 */
export function parseTerminologyConfig(
  rawConfig: RawTerminologyConfig | undefined,
): ProjectTerminology {
  if (!rawConfig || typeof rawConfig !== "object") {
    return DEFAULT_TERMINOLOGY;
  }

  return {
    agent_singular:
      typeof rawConfig.agent_singular === "string"
        ? rawConfig.agent_singular
        : DEFAULT_TERMINOLOGY.agent_singular,
    agent_plural:
      typeof rawConfig.agent_plural === "string"
        ? rawConfig.agent_plural
        : DEFAULT_TERMINOLOGY.agent_plural,
    orchestrator:
      typeof rawConfig.orchestrator === "string"
        ? rawConfig.orchestrator
        : DEFAULT_TERMINOLOGY.orchestrator,
  };
}

/**
 * Merge custom adapters with built-in adapters.
 * Custom adapters with the same ID override built-ins.
 */
export function mergeAdaptersWithBuiltins(
  customAdapters: AgentAdapter[],
): Record<string, AgentAdapter> {
  const result = { ...BUILTIN_ADAPTERS };

  for (const adapter of customAdapters) {
    result[adapter.id] = adapter;
  }

  return result;
}

/**
 * Get all available adapters (built-ins merged with custom).
 */
export function getAllAdapters(
  customAdapters: AgentAdapter[],
): AgentAdapter[] {
  const merged = mergeAdaptersWithBuiltins(customAdapters);
  return Object.values(merged);
}

/**
 * Validate all adapters in a list.
 */
export function validateAllAdapters(
  adapters: AgentAdapter[],
): AdapterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const adapter of adapters) {
    const result = validateAdapter(adapter);
    errors.push(...result.errors.map((e) => `${adapter.id}: ${e}`));
    warnings.push(...result.warnings.map((w) => `${adapter.id}: ${w}`));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
