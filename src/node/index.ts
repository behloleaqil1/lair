/**
 * lair-node daemon
 *
 * The node daemon runs on every machine in the fleet.
 * It connects to lair-server via WebSocket, registers itself,
 * reports capacity, receives job assignments, and streams results back.
 */
import { WebSocket, RawData } from "ws";
import {
  loadConfig,
  saveConfig,
  writePidFile,
  removePidFile,
} from "./registration.js";
import { getSystemInfo, measureCapacity } from "./capacity.js";
import { JobRunner } from "./job-runner.js";
import type { NodeConfig } from "../shared/node-types.js";
import type {
  NodeRegistration,
  NodeHeartbeat,
  NodeCapacity,
  ServerToNodeMessage,
  NodeToServerMessage,
  JobAssignment,
  JobResult,
} from "../shared/server-types.js";
import { LAIR_VERSION } from "../shared/version.js";

const VERSION = LAIR_VERSION;
const HEARTBEAT_INTERVAL = 10000; // 10 seconds
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute

/**
 * Node daemon state.
 */
interface DaemonState {
  config: NodeConfig;
  ws: WebSocket | null;
  connected: boolean;
  registered: boolean;
  draining: boolean;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectDelay: number;
  jobRunner: JobRunner;
  shuttingDown: boolean;
  activeJobs: number;
}

let state: DaemonState | null = null;

/**
 * Start the node daemon.
 */
export async function startDaemon(serverUrl: string): Promise<void> {
  // Load or create config
  const config = loadConfig();
  if (!config) {
    throw new Error("Node not configured. Run 'lair node join <token>' first.");
  }

  // Update server URL if provided
  if (serverUrl && config.serverUrl !== serverUrl) {
    config.serverUrl = serverUrl;
    saveConfig(config);
  }

  // Write PID file
  writePidFile(process.pid);

  // Initialize state
  state = {
    config,
    ws: null,
    connected: false,
    registered: false,
    draining: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectDelay: RECONNECT_DELAY,
    jobRunner: new JobRunner(config.nodeId, config.privateKey),
    shuttingDown: false,
    activeJobs: 0,
  };

  // Set up job runner event handlers
  setupJobRunnerEvents(state);

  // Connect to server
  connect(state);

  // Handle shutdown signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`[lair-node] Daemon started (PID: ${process.pid})`);
  console.log(`[lair-node] Node ID: ${config.nodeId}`);
  console.log(`[lair-node] Server: ${config.serverUrl}`);
}

/**
 * Connect to the lair-server.
 */
function connect(state: DaemonState): void {
  if (state.shuttingDown) {
    return;
  }

  // Server expects WebSocket at /ws/node
  const wsUrl = state.config.serverUrl.replace(/^http/, "ws") + "/ws/node";
  console.log(`[lair-node] Connecting to ${wsUrl}...`);

  // A server reached over the network (not loopback) only accepts nodes
  // that present its LAIR_NODE_TOKEN
  const token = process.env.LAIR_NODE_TOKEN;
  state.ws = new WebSocket(
    wsUrl,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  );

  state.ws.on("open", () => {
    console.log("[lair-node] Connected to server");
    state.connected = true;
    state.reconnectDelay = RECONNECT_DELAY; // Reset reconnect delay

    // Register with server
    sendRegistration(state);
  });

  state.ws.on("message", (data: RawData) => {
    handleMessage(state, data.toString());
  });

  state.ws.on("close", (code: number, reason: Buffer) => {
    console.log(`[lair-node] Disconnected: ${code} ${reason.toString()}`);
    state.connected = false;
    state.registered = false;
    stopHeartbeat(state);
    scheduleReconnect(state);
  });

  state.ws.on("error", (error: Error) => {
    console.error("[lair-node] WebSocket error:", error.message);
  });
}

/**
 * Send registration message to server.
 * Uses server-types.ts NodeRegistration format.
 */
function sendRegistration(state: DaemonState): void {
  const systemInfo = getSystemInfo();
  const capacity = measureCapacity(state.config.nodeId);

  // Build capacity in server-types format
  const nodeCapacity: NodeCapacity = {
    cores: capacity.cores,
    ramMb: capacity.ramMb,
    diskGb: capacity.diskGb,
    gpuCount: 0, // TODO: detect GPUs
    containerRuntime: capacity.containerRuntime,
  };

  const registration: NodeRegistration = {
    name: systemInfo.hostname,
    capacity: nodeCapacity,
    version: VERSION,
    os: systemInfo.os,
    arch: process.arch,
  };

  const message: NodeToServerMessage = {
    type: "register",
    payload: registration,
  };

  send(state, message);
  state.registered = true;
  console.log(`[lair-node] Registered as ${systemInfo.hostname}`);

  // Start heartbeat immediately after registration
  startHeartbeat(state);
}

/**
 * Send a message to the server.
 */
function send(state: DaemonState, message: NodeToServerMessage): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  }
}

/**
 * Handle a message from the server.
 */
function handleMessage(state: DaemonState, data: string): void {
  try {
    const message = JSON.parse(data) as ServerToNodeMessage;

    switch (message.type) {
      case "job.assign":
        handleJobAssign(state, message.payload as JobAssignment);
        break;
      case "job.cancel":
        handleJobCancel(state, message.payload as { jobId: string });
        break;
      case "ping":
        handlePing(state);
        break;
      case "shutdown":
        console.log("[lair-node] Server requested shutdown");
        shutdown("server");
        break;
      default:
        console.warn(`[lair-node] Unknown message type: ${(message as { type: string }).type}`);
    }
  } catch (error) {
    console.error("[lair-node] Failed to parse message:", error);
  }
}

/**
 * Handle ping from server.
 */
function handlePing(state: DaemonState): void {
  const message: NodeToServerMessage = {
    type: "pong",
  };
  send(state, message);
}

/**
 * Handle job assignment from server.
 */
function handleJobAssign(state: DaemonState, assignment: JobAssignment): void {
  console.log(`[lair-node] Received job: ${assignment.jobId} (task: ${assignment.task.title})`);

  if (state.draining) {
    console.log(`[lair-node] Rejecting job ${assignment.jobId}: node is draining`);
    return;
  }

  state.activeJobs++;

  // Start the job
  state.jobRunner.startJob({
    id: assignment.jobId,
    type: assignment.task.type as "agent" | "gate" | "dev-check",
    command: ["echo", "Job executed"], // TODO: get command from task
    cwd: process.cwd(),
    env: {},
    timeout: 300000, // 5 minutes default
    sandbox: false,
  });
}

/**
 * Handle job cancellation from server.
 */
function handleJobCancel(state: DaemonState, payload: { jobId: string }): void {
  console.log(`[lair-node] Cancelling job ${payload.jobId}`);
  state.jobRunner.cancelJob(payload.jobId, "Cancelled by server");
}

/**
 * Set up job runner event handlers.
 */
function setupJobRunnerEvents(state: DaemonState): void {
  state.jobRunner.on("job_started", (jobId: string, _pid: number) => {
    // Cast needed: server accepts { jobId } but type is more restrictive
    const message: NodeToServerMessage = {
      type: "job.started",
      payload: { jobId, progress: "started" } as { jobId: string; progress: string },
    };
    send(state, message);
    console.log(`[lair-node] Job started: ${jobId}`);
  });

  state.jobRunner.on("job_completed", (result: { jobId: string; exitCode: number; durationMs: number }) => {
    state.activeJobs = Math.max(0, state.activeJobs - 1);

    const jobResult: JobResult = {
      jobId: result.jobId,
      nodeId: state.config.nodeId,
      status: "completed",
      exitCode: result.exitCode,
      duration: result.durationMs,
    };

    const message: NodeToServerMessage = {
      type: "job.completed",
      payload: jobResult,
    };
    send(state, message);
    console.log(`[lair-node] Job completed: ${result.jobId} (exit ${result.exitCode})`);
  });

  state.jobRunner.on("job_failed", (jobId: string, error: string, exitCode?: number) => {
    state.activeJobs = Math.max(0, state.activeJobs - 1);

    const jobResult: JobResult = {
      jobId,
      nodeId: state.config.nodeId,
      status: "failed",
      exitCode,
      error,
    };

    const message: NodeToServerMessage = {
      type: "job.failed",
      payload: jobResult,
    };
    send(state, message);
    console.log(`[lair-node] Job failed: ${jobId} - ${error}`);
  });
}

/**
 * Start the heartbeat timer.
 */
function startHeartbeat(state: DaemonState): void {
  stopHeartbeat(state);

  state.heartbeatTimer = setInterval(() => {
    sendHeartbeat(state);
  }, HEARTBEAT_INTERVAL);

  // Send initial heartbeat
  sendHeartbeat(state);
}

/**
 * Stop the heartbeat timer.
 */
function stopHeartbeat(state: DaemonState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

/**
 * Send a heartbeat to the server.
 * Uses server-types.ts NodeHeartbeat format.
 */
function sendHeartbeat(state: DaemonState): void {
  // Calculate used capacity based on active jobs
  // Rough estimate: each job uses 1 core and 512MB RAM
  const usedCores = state.activeJobs;
  const usedRamMb = state.activeJobs * 512;

  const heartbeat: NodeHeartbeat = {
    nodeId: state.config.nodeId,
    usedCapacity: {
      cores: usedCores,
      ramMb: usedRamMb,
    },
    activeJobs: state.activeJobs,
    timestamp: new Date().toISOString(),
  };

  const message: NodeToServerMessage = {
    type: "heartbeat",
    payload: heartbeat,
  };

  send(state, message);
}

/**
 * Schedule a reconnection attempt.
 */
function scheduleReconnect(state: DaemonState): void {
  if (state.shuttingDown) {
    return;
  }

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  console.log(`[lair-node] Reconnecting in ${state.reconnectDelay / 1000}s...`);

  state.reconnectTimer = setTimeout(() => {
    connect(state);
  }, state.reconnectDelay);

  // Exponential backoff
  state.reconnectDelay = Math.min(
    state.reconnectDelay * 1.5,
    MAX_RECONNECT_DELAY,
  );
}

/**
 * Gracefully shutdown the daemon.
 */
async function shutdown(signal: string): Promise<void> {
  if (!state || state.shuttingDown) {
    return;
  }

  console.log(`[lair-node] Received ${signal}, shutting down...`);
  state.shuttingDown = true;

  // Stop accepting new jobs
  state.draining = true;

  // Stop timers
  stopHeartbeat(state);
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  // Stop running jobs
  await state.jobRunner.stopAll();

  // Close WebSocket
  if (state.ws) {
    state.ws.close(1000, "Daemon shutting down");
  }

  // Remove PID file
  removePidFile();

  console.log("[lair-node] Shutdown complete");
  process.exit(0);
}

/**
 * Get the current daemon state (for status reporting).
 */
export function getDaemonState(): {
  connected: boolean;
  registered: boolean;
  draining: boolean;
  runningJobs: number;
} | null {
  if (!state) {
    return null;
  }

  return {
    connected: state.connected,
    registered: state.registered,
    draining: state.draining,
    runningJobs: state.activeJobs,
  };
}
