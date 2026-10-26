/**
 * Lair Node Types - Types for the lair-node daemon
 *
 * These types define the interface between lair-node daemons and lair-server.
 */

// ============ Node Info ============

/** Operating system type */
export type NodeOS = "darwin" | "linux" | "windows";

/** Container runtime available on the node */
export type ContainerRuntime = "docker" | "podman" | "colima" | "none";

/** Node status in the fleet */
export type NodeStatus = "online" | "draining" | "offline";

/** Information about a node in the fleet */
export interface NodeInfo {
  /** Unique node identifier (generated on first registration) */
  id: string;
  /** Human-readable hostname */
  hostname: string;
  /** Operating system */
  os: NodeOS;
  /** Number of CPU cores */
  cores: number;
  /** Total RAM in megabytes */
  ramMb: number;
  /** Available RAM in megabytes */
  ramAvailableMb: number;
  /** Total disk space in gigabytes */
  diskGb: number;
  /** Available disk space in gigabytes */
  diskAvailableGb: number;
  /** Container runtime available */
  containerRuntime: ContainerRuntime;
  /** Current load average (1 minute) */
  load: number;
  /** Node status */
  status: NodeStatus;
  /** Version of lair-node */
  version: string;
  /** When the node was registered */
  registeredAt: string;
  /** Last heartbeat timestamp */
  lastHeartbeat: string;
}

/** Capacity measurement for a node */
export interface NodeCapacity {
  /** Node ID */
  nodeId: string;
  /** CPU cores */
  cores: number;
  /** Total RAM in MB */
  ramMb: number;
  /** Available RAM in MB */
  ramAvailableMb: number;
  /** Total disk in GB */
  diskGb: number;
  /** Available disk in GB */
  diskAvailableGb: number;
  /** Current load average (1 minute) */
  load1: number;
  /** Load average (5 minute) */
  load5: number;
  /** Load average (15 minute) */
  load15: number;
  /** Container runtime */
  containerRuntime: ContainerRuntime;
  /** Timestamp of measurement */
  measuredAt: string;
}

// ============ Jobs ============

/** Job type */
export type JobType = "agent" | "gate" | "dev-check";

/** Job status */
export type JobStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Job definition sent from server to node */
export interface Job {
  /** Unique job identifier */
  id: string;
  /** Type of job */
  type: JobType;
  /** Command to execute */
  command: string[];
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Timeout in milliseconds */
  timeout: number;
  /** Resource limits */
  limits?: JobLimits;
  /** Whether to use container sandbox */
  sandbox: boolean;
  /** Container image to use (if sandbox=true) */
  image?: string;
}

/** Resource limits for a job */
export interface JobLimits {
  /** Memory limit in MB */
  memoryMb?: number;
  /** CPU limit (cores, can be fractional) */
  cpuCores?: number;
  /** Disk space limit in GB */
  diskGb?: number;
}

/** Job result reported back to server */
export interface JobResult {
  /** Job ID */
  jobId: string;
  /** Node ID that ran the job */
  nodeId: string;
  /** Exit code of the command */
  exitCode: number;
  /** When the job started */
  startedAt: string;
  /** When the job completed */
  completedAt: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Cryptographic signature (stub for M1) */
  signature: string;
  /** Error message if failed */
  error?: string;
}

/** Log line from a running job */
export interface JobLogLine {
  /** Job ID */
  jobId: string;
  /** Node ID */
  nodeId: string;
  /** Timestamp */
  timestamp: string;
  /** Stream (stdout or stderr) */
  stream: "stdout" | "stderr";
  /** Log content */
  text: string;
}

// ============ WebSocket Messages ============

/** Message types from node to server */
export type NodeToServerMessageType =
  | "register"
  | "heartbeat"
  | "capacity"
  | "job_accepted"
  | "job_started"
  | "job_log"
  | "job_completed"
  | "job_failed";

/** Message types from server to node */
export type ServerToNodeMessageType =
  | "registered"
  | "heartbeat_ack"
  | "job_assign"
  | "job_cancel"
  | "drain"
  | "error";

/** Base message from node to server */
export interface NodeToServerMessage {
  type: NodeToServerMessageType;
  nodeId: string;
  timestamp: string;
}

/** Node registration message */
export interface RegisterMessage extends NodeToServerMessage {
  type: "register";
  hostname: string;
  os: NodeOS;
  cores: number;
  ramMb: number;
  diskGb: number;
  containerRuntime: ContainerRuntime;
  version: string;
  /** Public key for result signing (PEM format) */
  publicKey: string;
}

/** Heartbeat message */
export interface HeartbeatMessage extends NodeToServerMessage {
  type: "heartbeat";
  /** Number of currently running jobs */
  runningJobs: number;
  /** Current capacity snapshot */
  capacity: Omit<NodeCapacity, "nodeId" | "measuredAt">;
}

/** Capacity report message */
export interface CapacityMessage extends NodeToServerMessage {
  type: "capacity";
  capacity: Omit<NodeCapacity, "nodeId" | "measuredAt">;
}

/** Job accepted message */
export interface JobAcceptedMessage extends NodeToServerMessage {
  type: "job_accepted";
  jobId: string;
}

/** Job started message */
export interface JobStartedMessage extends NodeToServerMessage {
  type: "job_started";
  jobId: string;
  pid: number;
}

/** Job log message */
export interface JobLogMessage extends NodeToServerMessage {
  type: "job_log";
  jobId: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** Job completed message */
export interface JobCompletedMessage extends NodeToServerMessage {
  type: "job_completed";
  result: JobResult;
}

/** Job failed message */
export interface JobFailedMessage extends NodeToServerMessage {
  type: "job_failed";
  jobId: string;
  error: string;
  exitCode?: number;
}

/** Base message from server to node */
export interface ServerToNodeMessage {
  type: ServerToNodeMessageType;
  timestamp: string;
}

/** Registration confirmed message */
export interface RegisteredMessage extends ServerToNodeMessage {
  type: "registered";
  nodeId: string;
  /** Server-signed certificate (stub for M1) */
  certificate: string;
}

/** Heartbeat acknowledgment */
export interface HeartbeatAckMessage extends ServerToNodeMessage {
  type: "heartbeat_ack";
}

/** Job assignment message */
export interface JobAssignMessage extends ServerToNodeMessage {
  type: "job_assign";
  job: Job;
}

/** Job cancellation message */
export interface JobCancelMessage extends ServerToNodeMessage {
  type: "job_cancel";
  jobId: string;
  reason: string;
}

/** Drain request (stop accepting new jobs) */
export interface DrainMessage extends ServerToNodeMessage {
  type: "drain";
  reason: string;
}

/** Error message */
export interface ErrorMessage extends ServerToNodeMessage {
  type: "error";
  code: string;
  message: string;
}

// ============ Node Configuration ============

/** Node configuration stored locally */
export interface NodeConfig {
  /** Node ID (generated on first registration) */
  nodeId: string;
  /** Server URL to connect to */
  serverUrl: string;
  /** Private key for signing (PEM format) */
  privateKey: string;
  /** Public key (PEM format) */
  publicKey: string;
  /** Server-issued certificate (PEM format, stub for M1) */
  certificate?: string;
  /** When registered */
  registeredAt: string;
}

/** CLI status output */
export interface NodeStatusOutput {
  /** Whether the node daemon is running */
  daemonRunning: boolean;
  /** PID of the daemon (if running) */
  daemonPid?: number;
  /** Node ID (if registered) */
  nodeId?: string;
  /** Server URL (if configured) */
  serverUrl?: string;
  /** Connection status */
  connectionStatus: "connected" | "connecting" | "disconnected" | "not_configured";
  /** Current capacity */
  capacity?: NodeCapacity;
  /** Running jobs */
  runningJobs: Array<{ id: string; type: JobType; startedAt: string }>;
  /** Last heartbeat */
  lastHeartbeat?: string;
}
