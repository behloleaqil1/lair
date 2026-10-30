/**
 * Types for the infrastructure monitor module.
 *
 * The monitor watches running jobs' machines and detects:
 * - A machine that goes down while a job runs on it
 * - Duplicate runner slots (two runners claiming one slot)
 * - A dead runner while its lane has queued jobs
 */

/** A job being monitored */
export interface MonitoredJob {
  /** Gate id (e.g. "20260302T113000Z-login-fix-abc1234-101") */
  id: string;
  /** Lane the job runs on */
  lane: string;
  /** Machine the lane is assigned to */
  machine: string;
  /** When the job was first seen running (ISO string) */
  startedAt: string;
  /** When the job was last seen running (epoch ms) */
  lastSeenAt: number;
  /** Runner pid if known */
  runnerPid: number | null;
}

/** Machine state for monitoring */
export interface MachineState {
  /** Machine id from config */
  id: string;
  /** Whether the machine is reachable */
  reachable: boolean;
  /** Last time the machine was probed (epoch ms) */
  lastProbeAt: number | null;
  /** Error message if probe failed */
  lastError: string | null;
  /** When the machine became unreachable (epoch ms), null if up */
  downSince: number | null;
}

/** A finding from the monitor */
export interface InfraFinding {
  /** Unique key for deduplication */
  key: string;
  /** Category of finding */
  type: "job_machine_down" | "duplicate_slot" | "dead_runner";
  /** Human-readable summary */
  summary: string;
  /** Detailed evidence lines */
  evidence: string[];
  /** Variables for act-mode commands */
  vars: Record<string, string>;
}

/** A notice raised to the decision inbox */
export interface InfraNotice {
  id: string;
  finding: InfraFinding;
  /** When the notice was raised (ISO string) */
  raisedAt: string;
  /** Decision id if linked to the inbox */
  decisionId: string | null;
  /** Whether re-queue was attempted */
  requeued: boolean;
  /** Result of re-queue attempt */
  requeueResult: "moved" | "failed" | "skipped" | null;
}

/** Configuration for the infra monitor */
export interface InfraMonitorSettings {
  /** Whether the monitor is enabled */
  enabled: boolean;
  /** Mode: observe or act */
  mode: "observe" | "act";
  /** Interval between checks in seconds */
  intervalSeconds: number;
  /** How long a machine must be down before noticing (seconds) */
  downThresholdSeconds: number;
  /** Command to probe a machine: argv with {machine} placeholder */
  probeCmd: string[] | null;
  /** Timeout for probe commands in seconds */
  probeTimeoutSeconds: number;
  /** Command to re-queue a job: argv with {gate}, {from_lane}, {to_lane} placeholders */
  requeueCmd: string[] | null;
  /** Timeout for re-queue commands in seconds */
  requeueTimeoutSeconds: number;
}

/** Tick summary */
export interface InfraMonitorTick {
  at: string;
  jobsMonitored: number;
  machinesProbed: number;
  findingsDetected: number;
  noticesRaised: number;
  requeuesAttempted: number;
}

/** Status for API */
export interface InfraMonitorStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  intervalSeconds: number | null;
  lastTick: InfraMonitorTick | null;
  lastError: string | null;
  monitoredJobs: MonitoredJob[];
  machineStates: MachineState[];
  activeNotices: InfraNotice[];
}
