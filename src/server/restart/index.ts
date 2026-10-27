/**
 * The owner's Restart and "Update and restart" (restart.ts), configured by
 * data/server.yaml (server-config.ts). src/server/index.ts gives the
 * controller its graceful shutdown and process.exit.
 */
export { RestartController, runStep, updateEnvironment } from "./restart.js";
export type { RestartControllerOptions, RestartRequestResult, StepResult } from "./restart.js";
export { registerRestartRoutes } from "./routes.js";
export {
  DEFAULT_SERVER_SETTINGS,
  loadServerConfig,
  parseServerConfig,
  serviceManagerOf,
} from "./server-config.js";
export type { ServerConfigResult, ServerSettings, ServiceManagerName } from "./server-config.js";
