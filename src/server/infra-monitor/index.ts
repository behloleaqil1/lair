/**
 * Infrastructure monitor module (docs/configuration.md#infra-monitor).
 *
 * Watches running jobs' machines and raises notices when:
 * - A machine goes down while a job runs on it
 * - Two runners claim the same slot
 * - A runner is down while its lane has queued jobs
 *
 * Started and stopped by src/server/index.ts; off unless a project sets
 * `infra_monitor.enabled: true`, and observe-only unless it sets `mode: act`.
 */
export { InfraMonitor, InfraMonitorManager, type InfraMonitorOptions, type ProjectEntry } from "./service.js";
export { parseInfraMonitorConfig, actBlockedReason, buildArgv } from "./config.js";
export { InfraMonitorStore } from "./store.js";
export { registerInfraMonitorRoutes } from "./routes.js";
export type {
  InfraFinding,
  InfraMonitorSettings,
  InfraMonitorStatus,
  InfraMonitorTick,
  InfraNotice,
  MachineState,
  MonitoredJob,
} from "./types.js";
export {
  readGateQueue,
  findDuplicateSlots,
  getRunnerPid,
  parseGateRequest,
  parsePid,
  NodeFileSystem,
  systemInfraProbes,
  type CommandOutput,
  type CommandRunner,
  type Clock,
  type FileEntry,
  type FileSystem,
  type InfraMonitorProbes,
  type QueuedGate,
} from "./probes.js";
export { detectJobMachineDown, detectDuplicateSlot, detectDeadRunner, type DetectorContext } from "./detectors.js";
