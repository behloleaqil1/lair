/**
 * Dragon configuration parser
 *
 * Parses dragon registry and model config from project YAML.
 * Validates and normalizes dragon configs with safe defaults.
 */
import type {
  ProjectConfig,
  DragonConfig,
  AIModel,
} from "../../shared/types.js";
import { getAdapter } from "../services/adapters.js";
import { dragonAi, namesOwnProfile } from "../ai/profiles.js";

// Default models if none configured
const DEFAULT_MODELS: AIModel[] = [
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    description: "Most capable, higher cost",
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    description: "Fast and capable, lower cost",
  },
  {
    id: "claude-haiku",
    name: "Claude Haiku",
    description: "Fastest, lowest cost",
  },
];

// Default model to use when not specified
const DEFAULT_MODEL_ID = "claude-sonnet-4";

// Default machine when not specified
const DEFAULT_MACHINE = "local";

/** Model ids such as "vendor/model-1.5:latest"; never starting with "-" (as the agents module's MODEL_ID) */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/** Adapter ids such as "kiro", "claude-code", or one of the project's agent_adapters */
const ADAPTER_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** `dragon_defaults:` in the project YAML, for dragons that don't name their own */
export interface DragonDefaults {
  model?: string;
  adapter?: string;
}

/**
 * The project's `dragon_defaults`, for a dragon with no model or adapter of
 * its own: a dragons.txt dragon (it never has one), or a YAML `dragons:`
 * entry that leaves the key out. A dragon's own value always wins. Only
 * well-formed values are returned (validateDragonDefaults reports the
 * others), so a config that was never validated can't pass a bad one on.
 */
export function dragonDefaults(config: ProjectConfig): DragonDefaults {
  const raw: unknown = config.dragon_defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { model, adapter } = raw as Record<string, unknown>;
  const defaults: DragonDefaults = {};
  if (typeof model === "string" && MODEL_ID.test(model)) defaults.model = model;
  if (typeof adapter === "string" && ADAPTER_ID.test(adapter)) defaults.adapter = adapter;
  return defaults;
}

/**
 * What is wrong with `dragon_defaults` (nothing when it is absent): it must
 * be a mapping with only `model` (a model id) and `adapter` (a built-in
 * adapter or one of agent_adapters).
 */
export function validateDragonDefaults(config: ProjectConfig): string[] {
  const raw: unknown = config.dragon_defaults;
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return ["dragon_defaults: must be a mapping, e.g. { model: <model id>, adapter: <adapter id> }"];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "model") {
      if (typeof value !== "string" || !MODEL_ID.test(value)) {
        errors.push(
          "dragon_defaults.model: must be a model id (letters, digits, '.', '_', ':', '/', '@' or '-', not starting with '-')",
        );
      }
    } else if (key === "adapter") {
      if (typeof value !== "string" || !ADAPTER_ID.test(value)) {
        errors.push("dragon_defaults.adapter: must be an adapter id (a letter, then letters, digits, '_' or '-')");
      } else if (!getAdapter(value, config)) {
        errors.push(`dragon_defaults.adapter: unknown adapter ${value} (neither built in nor in agent_adapters)`);
      }
    } else {
      errors.push(`dragon_defaults.${key.slice(0, 40)}: unknown key (only model and adapter)`);
    }
  }
  return errors;
}

/** True when the YAML `dragons:` entry for `id` names its own model, or its own profile (ai.profiles). */
export function hasOwnModel(config: ProjectConfig, id: string): boolean {
  const own: unknown = config.dragons?.[id]?.model;
  return (typeof own === "string" && own.length > 0) || namesOwnProfile(config, config.dragons?.[id]);
}

/**
 * Parse dragon registry from project config.
 * Returns full DragonConfig objects with all fields populated (dragonAi): an
 * entry's own profile, else its own model and adapter (each else
 * dragon_defaults'), else its role's first profile (ai.roles), else
 * dragon_defaults', else the built-in default model (and no adapter: 'kiro'
 * at runtime).
 */
export function parseDragonRegistry(
  config: ProjectConfig,
): Map<string, DragonConfig> {
  const dragons = new Map<string, DragonConfig>();
  const rawDragons = config.dragons || {};
  const defaults = dragonDefaults(config);

  for (const [id, rawConfig] of Object.entries(rawDragons)) {
    if (!isValidDragonId(id)) {
      continue; // Skip invalid IDs
    }

    const ai = dragonAi(config, id, rawConfig, defaults);
    const dragon: DragonConfig = {
      id,
      name: rawConfig.name || id,
      model: ai.model || DEFAULT_MODEL_ID,
      machine: rawConfig.machine || DEFAULT_MACHINE,
      instructions: rawConfig.instructions || "",
      adapter: ai.adapter, // optional, defaults to 'kiro' at runtime
      ...(ai.profile ? { profile: ai.profile } : {}),
    };

    dragons.set(id, dragon);
  }

  return dragons;
}

/**
 * Parse available models from project config.
 * Falls back to defaults if none configured.
 */
export function parseAvailableModels(config: ProjectConfig): AIModel[] {
  if (config.available_models && config.available_models.length > 0) {
    return config.available_models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description,
    }));
  }
  return DEFAULT_MODELS;
}

/**
 * Get default instructions for a project.
 */
export function getDefaultInstructions(config: ProjectConfig): string {
  return config.default_instructions || "";
}

/**
 * Dragon IDs: a letter first, then letters, digits, "_" or "-", ending in a
 * letter or digit, at most 64 characters. Covers "kiro-A" as well as ids
 * for other agents ("aider-1", "worker_b"). IDs are matched against file
 * names, so no dots, slashes or spaces.
 */
const DRAGON_ID = /^[A-Za-z](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

/**
 * Validate a dragon ID (see DRAGON_ID).
 */
export function isValidDragonId(id: string): boolean {
  return DRAGON_ID.test(id);
}

/**
 * Validate dragon config references (machine, model).
 * Returns validation errors as an array of strings.
 */
export function validateDragonConfig(
  dragon: DragonConfig,
  config: ProjectConfig,
): string[] {
  const errors: string[] = [];
  const machines = config.machines || {};
  const models = parseAvailableModels(config);

  // Validate machine reference
  if (dragon.machine && !(dragon.machine in machines)) {
    errors.push(
      `Dragon ${dragon.id}: machine '${dragon.machine}' not found in config`,
    );
  }

  // Validate model reference
  const modelIds = models.map((m) => m.id);
  if (dragon.model && !modelIds.includes(dragon.model)) {
    errors.push(
      `Dragon ${dragon.id}: model '${dragon.model}' not in available_models`,
    );
  }

  return errors;
}

/**
 * Validate all dragon configs in a project.
 * Returns all validation errors.
 */
export function validateAllDragons(config: ProjectConfig): string[] {
  const dragons = parseDragonRegistry(config);
  const errors: string[] = [];

  for (const dragon of dragons.values()) {
    errors.push(...validateDragonConfig(dragon, config));
  }

  return errors;
}

/**
 * Get dragon config by ID, or undefined if not found.
 */
export function getDragonConfig(
  config: ProjectConfig,
  dragonId: string,
): DragonConfig | undefined {
  const dragons = parseDragonRegistry(config);
  return dragons.get(dragonId);
}

/**
 * Get model display name by ID.
 */
export function getModelName(config: ProjectConfig, modelId: string): string {
  const models = parseAvailableModels(config);
  const model = models.find((m) => m.id === modelId);
  return model?.name || modelId;
}

/**
 * Get machine display name by ID.
 */
export function getMachineName(
  config: ProjectConfig,
  machineId: string,
): string {
  const machines = config.machines || {};
  return machines[machineId]?.name || machineId;
}

/**
 * Combine instructions from all levels:
 * 1. Project default instructions
 * 2. Dragon-specific instructions
 * 3. Task-level instructions (passed separately)
 */
export function combineInstructions(
  config: ProjectConfig,
  dragonId: string,
  taskInstructions?: string,
): string {
  const parts: string[] = [];

  // Project-level
  const projectInstructions = getDefaultInstructions(config);
  if (projectInstructions) {
    parts.push(projectInstructions);
  }

  // Dragon-level
  const dragonConfig = getDragonConfig(config, dragonId);
  if (dragonConfig?.instructions) {
    parts.push(dragonConfig.instructions);
  }

  // Task-level
  if (taskInstructions) {
    parts.push(taskInstructions);
  }

  return parts.join("\n\n").trim();
}
