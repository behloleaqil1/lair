/**
 * The dragons a project has: the YAML `dragons:` map plus the dragons listed
 * in `<agents_dir>/dragons.txt`. Start/stop requests are validated against
 * this registry, and the dashboard's start dialog lists it (via
 * GET /api/controls/dragon/config), so the two always agree.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { DragonConfig, ProjectConfig } from "../../shared/types.js";
import { dragonDefaults, isValidDragonId, parseDragonRegistry } from "../parsers/dragon-config.js";
import { parseDragonsFile } from "../parsers/dragons.js";

/** Content of `<agents_dir>/dragons.txt`, or "" if it can't be read. */
export function readDragonsFile(config: ProjectConfig): string {
  try {
    return readFileSync(join(config.agents_dir, "dragons.txt"), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Merge the YAML registry with dragons.txt content (pure).
 *
 * - A YAML dragon keeps its fields, with the usual defaults filled in
 *   (parseDragonRegistry), also when dragons.txt lists it too.
 * - A dragon only in dragons.txt gets its dragons.txt name and the
 *   project's dragon_defaults model and adapter (without them: no model, and
 *   the default adapter applies), and no machine or instructions, which is
 *   how the dragons table shows it.
 * - IDs that fail isValidDragonId are dropped from either source.
 */
export function mergeDragonRegistry(
  config: ProjectConfig,
  dragonsFileContent: string,
): Map<string, DragonConfig> {
  const dragons = parseDragonRegistry(config);
  const defaults = dragonDefaults(config);
  for (const { id, name } of parseDragonsFile(dragonsFileContent)) {
    if (!isValidDragonId(id) || dragons.has(id)) {
      continue;
    }
    dragons.set(id, {
      id,
      name: name || id,
      model: defaults.model ?? "",
      machine: "",
      instructions: "",
      ...(defaults.adapter ? { adapter: defaults.adapter } : {}),
    });
  }
  return dragons;
}

/** The project's dragons, read from its config and dragons.txt now. */
export function loadKnownDragons(config: ProjectConfig): Map<string, DragonConfig> {
  return mergeDragonRegistry(config, readDragonsFile(config));
}

/** IDs of the project's dragons (see loadKnownDragons). */
export function knownDragonIds(config: ProjectConfig): Set<string> {
  return new Set(loadKnownDragons(config).keys());
}
