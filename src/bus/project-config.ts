/**
 * Project config lookup for the lair-bus CLI.
 *
 * Same rules as the server (src/server/config.ts getConfigPath): a private
 * config in projects/local/ wins over a public one of the same name, and
 * both `.yaml` and `.yml` are accepted, `.yaml` first.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { BusProjectConfig } from "./types.js";

interface ProjectYaml {
  name: string;
  queue_file: string;
  inbox_file?: string;
  mail_dir?: string;
  wake_file?: string;
}

/**
 * Candidate config paths for `projectName`, in lookup order. For each root
 * (in the order given): projects/local/<name>.yaml, projects/local/<name>.yml,
 * projects/<name>.yaml, projects/<name>.yml.
 */
export function busConfigCandidates(projectName: string, roots: string[]): string[] {
  const paths: string[] = [];
  for (const root of roots) {
    for (const dir of [join(root, "projects", "local"), join(root, "projects")]) {
      for (const ext of [".yaml", ".yml"]) {
        paths.push(join(dir, `${projectName}${ext}`));
      }
    }
  }
  return paths;
}

/** The first existing candidate path, or undefined. */
export function findBusConfigPath(projectName: string, roots: string[]): string | undefined {
  return busConfigCandidates(projectName, roots).find((p) => existsSync(p));
}

/**
 * Load the bus's view of a project config. Throws if no candidate exists.
 */
export function loadBusProjectConfig(projectName: string, roots: string[]): BusProjectConfig {
  const configPath = findBusConfigPath(projectName, roots);
  if (!configPath) {
    const searched = busConfigCandidates(projectName, roots);
    throw new Error(
      `Project config not found: ${projectName}\nSearched: ${searched.join(", ")}`,
    );
  }

  const yaml = parseYaml(readFileSync(configPath, "utf-8")) as ProjectYaml;
  return {
    name: yaml.name,
    queue_file: yaml.queue_file,
    inbox_file: yaml.inbox_file,
    mail_dir: yaml.mail_dir,
    wake_file: yaml.wake_file,
  };
}
