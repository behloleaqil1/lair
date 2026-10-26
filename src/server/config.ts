/**
 * Configuration loader - reads project YAML files
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig, DragonConfig, AIModel } from "../shared/types.js";
import {
  parseDragonRegistry,
  parseAvailableModels,
  validateAllDragons,
} from "./parsers/dragon-config.js";

const PROJECTS_DIR = join(process.cwd(), "projects");

/**
 * Project names come from file names in projects/ (and projects/local/).
 * Before a name from a request is joined into any path it must match this
 * pattern (no path separators, no leading dot) AND be one of the names that
 * listProjects() returns.
 */
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Thrown when a project name is malformed or unknown. Routes map it to HTTP 400.
 */
export class InvalidProjectError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

/**
 * Return an error message if `name` is not a safe, known project name, else null.
 */
export function projectNameError(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "Missing project parameter";
  }
  if (!SAFE_PROJECT_NAME.test(name)) {
    return "Invalid project name";
  }
  if (!listProjects().includes(name)) {
    return `Unknown project: ${name}`;
  }
  return null;
}

/**
 * Validate a project name (safe pattern AND membership in listProjects()).
 * Throws InvalidProjectError when it is not valid.
 */
export function assertValidProject(name: unknown): string {
  const error = projectNameError(name);
  if (error) {
    throw new InvalidProjectError(error);
  }
  return name as string;
}

/**
 * Load a project configuration from YAML
 */
export function loadProjectConfig(name: string): ProjectConfig {
  const configPath = getConfigPath(name);

  if (!existsSync(configPath)) {
    throw new Error(`Project config not found: ${configPath}`);
  }

  const content = readFileSync(configPath, "utf-8");
  const config = parseYaml(content) as ProjectConfig;

  // Validate required fields
  if (
    !config.name ||
    !config.repo ||
    !config.queue_file ||
    !config.agents_dir ||
    !config.gates_dir
  ) {
    throw new Error(
      `Invalid project config: missing required fields in ${configPath}`,
    );
  }

  return config;
}

/**
 * Get parsed dragon registry from project config.
 */
export function getDragons(config: ProjectConfig): Map<string, DragonConfig> {
  return parseDragonRegistry(config);
}

/**
 * Get available AI models from project config.
 */
export function getModels(config: ProjectConfig): AIModel[] {
  return parseAvailableModels(config);
}

/**
 * Validate dragon config references (machines, models).
 * Returns validation errors or empty array if valid.
 */
export function validateDragonsConfig(config: ProjectConfig): string[] {
  return validateAllDragons(config);
}

/**
 * List all available project configs
 */
export function listProjects(): string[] {
  if (!existsSync(PROJECTS_DIR)) {
    return [];
  }

  const localDir = join(PROJECTS_DIR, "local");
  const files = [
    ...readdirSync(PROJECTS_DIR),
    ...(existsSync(localDir) ? readdirSync(localDir) : []),
  ];

  const names = files
    .filter((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f: string) => f.replace(/\.ya?ml$/, ""));
  return [...new Set(names)];
}

/**
 * Get the default project (first one, or 'example' if it exists)
 */
export function getDefaultProject(): string {
  const projects = listProjects();

  if (projects.includes("example")) {
    return "example";
  }

  if (projects.length > 0) {
    return projects[0];
  }

  throw new Error("No project configurations found in projects/");
}

/**
 * Get the config file path for a project.
 * Returns the local path if it exists, otherwise the public path.
 */
export function getConfigPath(name: string): string {
  assertValidProject(name);
  // A private config in projects/local/ (gitignored) wins over the public example of the same name
  const candidates = [
    join(PROJECTS_DIR, "local", `${name}.yaml`),
    join(PROJECTS_DIR, "local", `${name}.yml`),
    join(PROJECTS_DIR, `${name}.yaml`),
    join(PROJECTS_DIR, `${name}.yml`),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[2];
}
