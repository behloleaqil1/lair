/**
 * Host services module: per-machine services with probe and start.
 *
 * Provides:
 * - Service health probing at configurable intervals
 * - Automatic service restart in act mode (with backoff)
 * - Lane holds while services are down
 * - Decision escalation when services fail to recover
 *
 * See docs/configuration.md#host-services for configuration reference.
 */

export {
  HostServices,
  HostServicesManager,
  createHostServices,
  type HostServicesOptions,
  type HostServicesProjectStatus,
  type ProjectEntry,
} from "./service.js";

export { registerHostServicesRoutes } from "./routes.js";

export { parseHostServicesConfig, actBlockedReason, HostServicesSchema } from "./config.js";
export type { ParseResult } from "./config.js";

export { HostServicesStore } from "./store.js";

export { systemHostServicesProbes, ExecFileRunner, systemClock } from "./probes.js";
export type { HostServicesProbes, CommandRunner, CommandOutput, RunOptions, Clock } from "./probes.js";

export type {
  ServiceConfig,
  ServiceState,
  ServiceStatus,
  ProbeResult,
  TickSummary,
  StoredServiceState,
  HostServicesSettings,
  LaneHold,
} from "./types.js";
export { DECISION_MODULE } from "./types.js";
