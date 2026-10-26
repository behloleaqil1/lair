/**
 * Machine management module
 *
 * Provides:
 * - SSH command building for remote operations
 * - Health checking with caching
 * - Lane-to-machine mapping with round-robin selection
 */

export {
  isSSHMachine,
  resolveKeyPath,
  buildSSHBaseArgs,
  buildSSHCommand,
  buildHealthCheckCommand,
  buildGateCommand,
  validateSSHConfig,
} from "./ssh.js";

export {
  MachineHealthChecker,
  checkAllMachines,
  getOnlineMachinesForLane,
} from "./health.js";

export {
  LaneMachineMapper,
  validateLaneConfig,
  type LaneValidationResult,
} from "./mapper.js";
