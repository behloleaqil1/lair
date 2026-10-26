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

/**
 * Parse dragon registry from project config.
 * Returns full DragonConfig objects with all fields populated.
 */
export function parseDragonRegistry(
  config: ProjectConfig,
): Map<string, DragonConfig> {
  const dragons = new Map<string, DragonConfig>();
  const rawDragons = config.dragons || {};

  for (const [id, rawConfig] of Object.entries(rawDragons)) {
    if (!isValidDragonId(id)) {
      continue; // Skip invalid IDs
    }

    const dragon: DragonConfig = {
      id,
      name: rawConfig.name || id,
      model: rawConfig.model || DEFAULT_MODEL_ID,
      machine: rawConfig.machine || DEFAULT_MACHINE,
      instructions: rawConfig.instructions || "",
      adapter: rawConfig.adapter, // optional, defaults to 'kiro' at runtime
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
