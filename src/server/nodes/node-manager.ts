/**
 * Node manager for lair-server.
 * Manages connected lair-node instances via WebSocket.
 */
import { WebSocket, WebSocketServer, RawData } from "ws";
import type { IncomingMessage, Server } from "http";
import { randomUUID } from "crypto";
import { isAllowedNodePeer, isAllowedOrigin } from "../origin.js";
import { registerUpgradeRoute } from "../ws-upgrade.js";
import { getStore } from "../store/store.js";
import { getEventBus } from "../core/event-bus.js";
import type {
  NodeRegistration,
  NodeHeartbeat,
  JobAssignment,
  JobResult,
  ServerToNodeMessage,
  NodeToServerMessage,
} from "../../shared/server-types.js";

/** Connected node session */
interface NodeSession {
  ws: WebSocket;
  nodeId: string;
  lastPing: number;
}

/**
 * Node manager.
 * Handles node connections, heartbeats, and job dispatch.
 */
export class NodeManager {
  private wss: WebSocketServer;
  private sessions = new Map<string, NodeSession>();
  private nodeToSession = new Map<string, string>(); // nodeId -> sessionId
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private nodeTimeoutMs: number;
  private unregisterUpgrade: () => void;

  constructor(server: Server, options?: { path?: string; nodeTimeoutMs?: number }) {
    const path = options?.path ?? "/ws/node";
    this.nodeTimeoutMs = options?.nodeTimeoutMs ?? 30000;

    this.wss = new WebSocketServer({
      noServer: true,
      // Nodes are not browsers: refuse foreign browser origins, and refuse
      // non-loopback peers unless LAIR_NODE_TOKEN is set and presented
      verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
        isAllowedOrigin(info.origin) && isAllowedNodePeer(info.req),
    });
    this.unregisterUpgrade = registerUpgradeRoute(server, path, (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", this.handleConnection.bind(this));
    this.wss.on("error", (error) => {
      console.error("[NodeManager] WebSocket error:", error);
    });

    // Check for offline nodes every 10 seconds
    this.heartbeatInterval = setInterval(() => {
      this.checkHeartbeats();
    }, 10000);

    console.log(`[NodeManager] WebSocket server initialized on ${path}`);
  }

  /**
   * Handle a new node connection.
   */
  private handleConnection(ws: WebSocket, _req: { url?: string }): void {
    const sessionId = randomUUID();

    const session: NodeSession = {
      ws,
      nodeId: "", // Set when node registers
      lastPing: Date.now(),
    };

    this.sessions.set(sessionId, session);

    console.log(`[NodeManager] New connection: ${sessionId}`);

    ws.on("message", (data) => this.handleMessage(sessionId, data));
    ws.on("close", () => this.handleClose(sessionId));
    ws.on("error", (error) => {
      console.error(`[NodeManager] Connection error (${sessionId}):`, error);
    });
    ws.on("pong", () => {
      session.lastPing = Date.now();
    });
  }

  /**
   * Handle a message from a node.
   */
  private async handleMessage(sessionId: string, data: RawData): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const message = JSON.parse(data.toString()) as NodeToServerMessage;

      switch (message.type) {
        case "register":
          await this.handleRegister(sessionId, message.payload as NodeRegistration);
          break;
        case "heartbeat":
          await this.handleHeartbeat(sessionId, message.payload as NodeHeartbeat);
          break;
        case "job.started":
          await this.handleJobStarted(sessionId, message.payload as { jobId: string });
          break;
        case "job.completed":
          await this.handleJobCompleted(sessionId, message.payload as JobResult);
          break;
        case "job.failed":
          await this.handleJobFailed(sessionId, message.payload as JobResult);
          break;
        case "job.progress":
          await this.handleJobProgress(sessionId, message.payload as { jobId: string; progress: string });
          break;
        case "pong":
          session.lastPing = Date.now();
          break;
        default:
          console.warn(`[NodeManager] Unknown message type from ${sessionId}:`, (message as { type: string }).type);
      }
    } catch (error) {
      console.error(`[NodeManager] Error handling message from ${sessionId}:`, error);
    }
  }

  /**
   * Handle node registration.
   */
  private async handleRegister(sessionId: string, registration: NodeRegistration): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const store = getStore();
    const eventBus = getEventBus();

    // Generate or derive node ID from name
    const nodeId = `node-${registration.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

    // Register in store
    const node = store.registerNode(nodeId, registration.name, registration.capacity, {
      version: registration.version,
      os: registration.os,
      arch: registration.arch,
    });

    // Update session
    session.nodeId = nodeId;
    this.nodeToSession.set(nodeId, sessionId);

    console.log(`[NodeManager] Node registered: ${node.name} (${nodeId}) - ${node.capacity.cores} cores, ${node.capacity.ramMb}MB RAM`);

    // Emit event
    await eventBus.emit("node.registered", { nodeId, name: node.name, capacity: node.capacity });
  }

  /**
   * Handle node heartbeat.
   */
  private async handleHeartbeat(sessionId: string, heartbeat: NodeHeartbeat): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.nodeId) return;

    const store = getStore();
    const eventBus = getEventBus();

    session.lastPing = Date.now();

    // Update store
    store.updateNodeHeartbeat(session.nodeId, heartbeat.usedCapacity, heartbeat.activeJobs);

    // Emit event
    await eventBus.emit("node.heartbeat", {
      nodeId: session.nodeId,
      usedCapacity: heartbeat.usedCapacity,
      activeJobs: heartbeat.activeJobs,
    });
  }

  /**
   * Handle job started notification.
   */
  private async handleJobStarted(sessionId: string, payload: { jobId: string }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.nodeId) return;

    const store = getStore();
    const eventBus = getEventBus();

    const now = new Date().toISOString();
    store.updateJobStatus(payload.jobId, "running", { startedAt: now });

    // Also update the task
    const job = store.getJob(payload.jobId);
    if (job) {
      store.updateTaskStatus(job.taskId, "running", { startedAt: now });
    }

    await eventBus.emit("job.started", { jobId: payload.jobId, nodeId: session.nodeId });

    console.log(`[NodeManager] Job started: ${payload.jobId} on ${session.nodeId}`);
  }

  /**
   * Handle job completed notification.
   */
  private async handleJobCompleted(sessionId: string, result: JobResult): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.nodeId) return;

    const store = getStore();
    const eventBus = getEventBus();

    const now = new Date().toISOString();
    store.updateJobStatus(result.jobId, "completed", {
      completedAt: now,
      exitCode: result.exitCode,
      output: result.output,
    });

    // Also update the task
    const job = store.getJob(result.jobId);
    if (job) {
      store.updateTaskStatus(job.taskId, "completed", {
        completedAt: now,
        result: {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          output: result.output,
          duration: result.duration,
        },
      });
    }

    await eventBus.emit("job.completed", {
      jobId: result.jobId,
      nodeId: session.nodeId,
      exitCode: result.exitCode,
    });

    console.log(`[NodeManager] Job completed: ${result.jobId} (exit ${result.exitCode})`);
  }

  /**
   * Handle job failed notification.
   */
  private async handleJobFailed(sessionId: string, result: JobResult): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.nodeId) return;

    const store = getStore();
    const eventBus = getEventBus();

    const now = new Date().toISOString();
    store.updateJobStatus(result.jobId, "failed", {
      completedAt: now,
      exitCode: result.exitCode,
      error: result.error,
      output: result.output,
    });

    // Also update the task
    const job = store.getJob(result.jobId);
    if (job) {
      store.updateTaskStatus(job.taskId, "failed", {
        completedAt: now,
        result: {
          success: false,
          exitCode: result.exitCode,
          error: result.error,
          output: result.output,
          duration: result.duration,
        },
      });
    }

    await eventBus.emit("job.failed", {
      jobId: result.jobId,
      nodeId: session.nodeId,
      error: result.error,
    });

    console.log(`[NodeManager] Job failed: ${result.jobId} - ${result.error}`);
  }

  /**
   * Handle job progress update.
   */
  private async handleJobProgress(sessionId: string, payload: { jobId: string; progress: string }): Promise<void> {
    // Just log for now; could emit to UI WebSocket
    console.log(`[NodeManager] Job progress: ${payload.jobId} - ${payload.progress}`);
  }

  /**
   * Handle node disconnect.
   */
  private handleClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.nodeId) {
      this.nodeToSession.delete(session.nodeId);

      // Mark node as offline
      const store = getStore();
      store.markNodeOffline(session.nodeId);

      console.log(`[NodeManager] Node disconnected: ${session.nodeId}`);

      // Emit event
      const eventBus = getEventBus();
      eventBus.emit("node.offline", { nodeId: session.nodeId });
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Check for timed out nodes.
   */
  private checkHeartbeats(): void {
    const now = Date.now();
    const store = getStore();
    const eventBus = getEventBus();

    for (const [sessionId, session] of this.sessions) {
      if (session.nodeId && now - session.lastPing > this.nodeTimeoutMs) {
        console.log(`[NodeManager] Node ${session.nodeId} timed out`);
        store.markNodeOffline(session.nodeId);
        eventBus.emit("node.offline", { nodeId: session.nodeId });
        session.ws.terminate();
        this.sessions.delete(sessionId);
        this.nodeToSession.delete(session.nodeId);
      } else if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.ping();
      }
    }
  }

  /**
   * Send a job assignment to a node.
   */
  assignJob(nodeId: string, assignment: JobAssignment): boolean {
    const sessionId = this.nodeToSession.get(nodeId);
    if (!sessionId) {
      console.warn(`[NodeManager] Cannot assign job to ${nodeId}: not connected`);
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[NodeManager] Cannot assign job to ${nodeId}: connection not ready`);
      return false;
    }

    const message: ServerToNodeMessage = {
      type: "job.assign",
      payload: assignment,
    };

    session.ws.send(JSON.stringify(message));
    console.log(`[NodeManager] Job assigned: ${assignment.jobId} -> ${nodeId}`);
    return true;
  }

  /**
   * Cancel a job on a node.
   */
  cancelJob(nodeId: string, jobId: string): boolean {
    const sessionId = this.nodeToSession.get(nodeId);
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;

    const message: ServerToNodeMessage = {
      type: "job.cancel",
      payload: { jobId },
    };

    session.ws.send(JSON.stringify(message));
    console.log(`[NodeManager] Job cancel sent: ${jobId} -> ${nodeId}`);
    return true;
  }

  /**
   * Check if a node is connected.
   */
  isNodeConnected(nodeId: string): boolean {
    const sessionId = this.nodeToSession.get(nodeId);
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    return session?.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connected node IDs.
   */
  getConnectedNodeIds(): string[] {
    return Array.from(this.nodeToSession.keys());
  }

  /**
   * Get node count.
   */
  getNodeCount(): number {
    return this.nodeToSession.size;
  }

  /**
   * Close the node manager.
   */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const session of this.sessions.values()) {
      const message: ServerToNodeMessage = { type: "shutdown" };
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(message));
        session.ws.close(1001, "Server shutting down");
      }
    }

    this.sessions.clear();
    this.nodeToSession.clear();
    this.unregisterUpgrade();
    this.wss.close();
    console.log("[NodeManager] Closed");
  }
}

// Global singleton
let globalNodeManager: NodeManager | null = null;

/**
 * Initialize the global node manager.
 */
export function initNodeManager(server: Server, options?: { path?: string; nodeTimeoutMs?: number }): NodeManager {
  if (globalNodeManager) {
    throw new Error("NodeManager already initialized");
  }
  globalNodeManager = new NodeManager(server, options);
  return globalNodeManager;
}

/**
 * Get the global node manager.
 */
export function getNodeManager(): NodeManager {
  if (!globalNodeManager) {
    throw new Error("NodeManager not initialized");
  }
  return globalNodeManager;
}

/**
 * Close the global node manager.
 */
export function closeNodeManager(): void {
  globalNodeManager?.close();
  globalNodeManager = null;
}
