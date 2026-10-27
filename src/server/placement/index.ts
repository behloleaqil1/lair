/**
 * Placement: which machine runs each queued job of a project's own gate
 * queue, and moves that make jobs finish sooner (docs/configuration.md#placement).
 * Started and stopped by src/server/index.ts; off unless a project sets
 * `placement.enabled: true`, and observe-only unless it sets `mode: act`.
 */
export { Placement, PlacementManager, createPlacement, formatSpan, parseLoad } from "./service.js";
export type { PlacementOptions, ProjectEntry } from "./service.js";
export { registerPlacementRoutes } from "./routes.js";
export { parsePlacementConfig, compilePattern } from "./config.js";
export type { PlacementSettings } from "./config.js";
export { PlacementStore } from "./store.js";
export { NodeQueueFiles, systemPlacementProbes } from "./probes.js";
export type { PlacementProbes, QueueFiles } from "./probes.js";
