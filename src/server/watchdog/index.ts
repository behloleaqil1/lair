/**
 * Progress watchdog and playbook engine (docs/design/autonomy.md §2).
 * Started and stopped by src/server/index.ts; off unless a project sets
 * `watchdog.enabled: true`.
 */
export { WatchdogManager, Watchdog, createWatchdog } from "./service.js";
export type { WatchdogProjectStatus, ProjectEntry, TickSummary } from "./service.js";
export { registerWatchdogRoutes } from "./routes.js";
export { parseWatchdogConfig } from "./config.js";
export type { WatchdogSettings } from "./config.js";
export { WatchdogStore } from "./store.js";
export { systemProbes } from "./probes.js";
export type { Probes, ProcessTable, FileSystem, CommandRunner, Clock, ProcessInfo } from "./probes.js";
export * from "./types.js";
