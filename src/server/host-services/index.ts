/**
 * Host services module: per-machine services with probe and start.
 *
 * - Probes every service each interval (argv, no shell, timed; a timeout is never up)
 * - Act mode: starts a down service, with a grace window and a doubling backoff
 *   that survive restarts and reloads
 * - Act mode: holds the pipeline lanes that need a service while it is not up
 *   (the pipeline manager asks holdFor before it dispatches a job)
 * - One decision per outage it cannot fix, withdrawn on a stable recovery
 *
 * See docs/configuration.md#host-services for configuration reference.
 */

export {
  HostServices,
  HostServicesManager,
  createHostServices,
  DECISION_CLASS,
  decisionInput,
  programName,
  type HostServicesOptions,
  type HostServicesProjectStatus,
  type ProjectEntry,
} from "./service.js";

export { registerHostServicesRoutes, OWNER_PREFIX } from "./routes.js";

export { parseHostServicesConfig, actBlockedReason, HostServicesSchema } from "./config.js";
export type { ParseResult } from "./config.js";

export { HostServicesStore, STORE_VERSION, freshState } from "./store.js";

export { systemHostServicesProbes, ExecFileRunner, systemClock } from "./probes.js";
export type { HostServicesProbes, CommandRunner, CommandOutput, RunOptions, Clock } from "./probes.js";

export type {
  EscalationCode,
  ServiceConfig,
  ServiceState,
  ServiceStatus,
  ProbeResult,
  StartResult,
  TickSummary,
  StoredServiceState,
  HostServicesSettings,
  LaneHold,
} from "./types.js";
export { DECISION_MODULE } from "./types.js";
