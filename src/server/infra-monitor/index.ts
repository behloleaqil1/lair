/**
 * Infrastructure monitor module (docs/configuration.md#infrastructure-monitor).
 *
 * Watches the machines of a project's gate lanes and the jobs on them, and
 * finds a machine down under work, a job whose process is gone, a lane with
 * more running jobs than slots, and a lane whose runners are all dead while
 * jobs wait.
 *
 * Started and stopped by src/server/index.ts; off unless a project sets
 * `infra_monitor.enabled: true`, and observe-only (writes nothing) unless it
 * sets `mode: act`.
 */
export { InfraMonitor, InfraMonitorManager, MAX_REQUEUES_PER_TICK, type InfraMonitorOptions, type InfraMonitorManagerOptions, type ProjectEntry } from "./service.js";
export { parseInfraMonitorConfig, actBlockedReason, buildRequeueArgv, type InfraMonitorSettings } from "./config.js";
export { RequeueLedger } from "./ledger.js";
export { registerInfraMonitorRoutes } from "./routes.js";
export { SpawnRunner, systemInfraProbes, type CommandOutput, type CommandRunner, type Clock, type InfraProbes } from "./probes.js";
export type {
  FindingType,
  FindingView,
  InfraFinding,
  InfraMonitorStatus,
  InfraMonitorTick,
  JobView,
  MachineView,
  PlannedRequeue,
  RequeueRecord,
} from "./types.js";
