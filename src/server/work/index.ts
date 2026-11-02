/**
 * The work store (docs/design/work-store.md): tasks and their events in Lair's database, per project, behind
 * `work_store.mode: off | observe` (off by default) and `work_store.files: follow`.
 */
export { parseWorkStoreConfig, WORK_MODES } from "./config.js";
export type { WorkMode, WorkSettings } from "./config.js";
export { WorkStoreManager } from "./manager.js";
export type { ImportReport, WorkResult, WorkStatus, WorkStoreManagerOptions, WorkTaskView } from "./manager.js";
export { registerWorkRoutes } from "./routes.js";
export { SqliteWorkStore, WorkStoreError, WORK_SCHEMA_VERSION } from "./store.js";
export type { StoredTaskState, TaskState, WorkActor, WorkEvent, WorkStore, WorkTask } from "./store.js";
