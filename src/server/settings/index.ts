/**
 * Settings: every project setting from the dashboard, written to the
 * project's YAML (docs/design/settings-ui.md). src/server/index.ts wires it
 * to the live reload:
 *
 *   const settings = new SettingsService({
 *     dataDir, validate: (c) => reloader.validate(c), reload: (p) => reloader.apply(p),
 *     reloadProblem: (p) => reloader.problemOf(p),
 *   });
 *   await registerSettingsUiRoutes(fastify, { service: settings, auth: humanAuth });
 *
 * A module with a config block adds one entry to registry.ts.
 */
export { SettingsService, SettingsError, githubOf } from "./service.js";
export type { SettingsServiceOptions } from "./service.js";
export { registerSettingsUiRoutes, SETTINGS_BODY_LIMIT } from "./routes.js";
export { SETTINGS_SECTIONS, settingsSections, ownedKeys } from "./registry.js";
export type { SectionEntry } from "./registry.js";
export { toJsonSchema } from "./json-schema.js";
export { applyChanges, newConfigText } from "./yaml-doc.js";
