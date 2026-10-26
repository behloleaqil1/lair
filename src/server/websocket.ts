/**
 * WebSocket server for real-time Lair updates.
 * Replaces REST polling with push-based updates.
 */
import { WebSocketServer, WebSocket, RawData } from "ws";
import type { Server } from "http";
import { randomUUID } from "crypto";
import { URL } from "url";
import { isAllowedOrigin } from "./origin.js";
import { registerUpgradeRoute } from "./ws-upgrade.js";

// Channel types supported by the WebSocket server
export type Channel =
  | "dragons" // All dragon status changes
  | "gates" // All gate updates (queue + results)
  | "machines" // Machine health changes
  | "orchestrator" // Orchestrator tick events
  | `logs:${string}`; // Live log streaming for a specific dragon (logs:kiro-A)

// Client → Server message types
export interface WSClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channels?: string[];
}

// Server → Client message types
export interface WSServerMessage {
  type:
    | "connected"
    | "subscribed"
    | "unsubscribed"
    | "update"
    | "error"
    | "pong";
  sessionId?: string;
  channel?: string;
  channels?: string[];
  data?: unknown;
  error?: string;
  timestamp: string;
}

// Dragon update event data
export interface DragonUpdateData {
  id: string;
  event: "status_change" | "log_line" | "task_change";
  running?: boolean;
  task?: string;
  lastLogLine?: string;
  lastLogTime?: string;
}

// Gate update event data
export interface GateUpdateData {
  id: string;
  event: "queued" | "started" | "completed" | "step_change";
  lane?: string;
  rc?: number;
  currentStep?: string;
  duration?: number;
}

// Machine update event data
export interface MachineUpdateData {
  name: string;
  event: "health_change" | "runner_change";
  up?: boolean;
  runners?: Array<{ lane: string; running: boolean }>;
}

// Log line event data
export interface LogLineData {
  dragonId: string;
  line: string;
  timestamp: string;
}

// Connected client state
interface Client {
  ws: WebSocket;
  sessionId: string;
  project: string;
  subscriptions: Set<string>;
  lastPing: number;
}

/**
 * Lair WebSocket server.
 * Manages client connections and broadcasts updates to subscribed channels.
 */
export class LairWebSocketServer {
  private clients = new Map<string, Client>();
  private wss: WebSocketServer;
  private pingInterval: NodeJS.Timeout | null = null;
  private unregisterUpgrade: () => void;

  constructor(server: Server) {
    this.wss = new WebSocketServer({
      noServer: true,
      // Any web page can open a WebSocket to localhost; only the dashboard's
      // own origins may subscribe (non-browser clients send no Origin)
      verifyClient: (info: { origin?: string }) => isAllowedOrigin(info.origin),
    });
    this.unregisterUpgrade = registerUpgradeRoute(server, "/ws", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", this.handleConnection.bind(this));
    this.wss.on("error", (error) => {
      console.error("[WebSocket] Server error:", error);
    });

    // Ping clients every 30 seconds to detect disconnects
    this.pingInterval = setInterval(() => {
      this.pingClients();
    }, 30000);

    console.log("[WebSocket] Server initialized on /ws");
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(ws: WebSocket, req: { url?: string }): void {
    const sessionId = randomUUID();
    const url = new URL(req.url || "/", "http://localhost");
    const project = url.searchParams.get("project") || "default";

    const client: Client = {
      ws,
      sessionId,
      project,
      subscriptions: new Set(),
      lastPing: Date.now(),
    };

    this.clients.set(sessionId, client);

    console.log(
      `[WebSocket] Client connected: ${sessionId} (project: ${project})`,
    );

    // Send connected message
    this.send(ws, {
      type: "connected",
      sessionId,
      timestamp: new Date().toISOString(),
    });

    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", () => this.handleClose(client));
    ws.on("error", (error) => {
      console.error(`[WebSocket] Client error (${sessionId}):`, error);
    });
    ws.on("pong", () => {
      client.lastPing = Date.now();
    });
  }

  /**
   * Handle a message from a client.
   */
  private handleMessage(client: Client, data: RawData): void {
    try {
      const message = JSON.parse(data.toString()) as WSClientMessage;

      switch (message.type) {
        case "subscribe":
          this.handleSubscribe(client, message.channels || []);
          break;
        case "unsubscribe":
          this.handleUnsubscribe(client, message.channels || []);
          break;
        case "ping":
          this.send(client.ws, {
            type: "pong",
            timestamp: new Date().toISOString(),
          });
          break;
        default:
          this.send(client.ws, {
            type: "error",
            error: `Unknown message type: ${(message as { type: string }).type}`,
            timestamp: new Date().toISOString(),
          });
      }
    } catch {
      this.send(client.ws, {
        type: "error",
        error: "Invalid JSON message",
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Handle subscribe request from client.
   */
  private handleSubscribe(client: Client, channels: string[]): void {
    const validChannels: string[] = [];

    for (const channel of channels) {
      if (this.isValidChannel(channel)) {
        client.subscriptions.add(channel);
        validChannels.push(channel);
      }
    }

    if (validChannels.length > 0) {
      console.log(
        `[WebSocket] ${client.sessionId} subscribed to: ${validChannels.join(", ")}`,
      );
    }

    this.send(client.ws, {
      type: "subscribed",
      channels: validChannels,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle unsubscribe request from client.
   */
  private handleUnsubscribe(client: Client, channels: string[]): void {
    for (const channel of channels) {
      client.subscriptions.delete(channel);
    }

    console.log(
      `[WebSocket] ${client.sessionId} unsubscribed from: ${channels.join(", ")}`,
    );

    this.send(client.ws, {
      type: "unsubscribed",
      channels,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle client disconnect.
   */
  private handleClose(client: Client): void {
    console.log(`[WebSocket] Client disconnected: ${client.sessionId}`);
    this.clients.delete(client.sessionId);
  }

  /**
   * Validate channel name.
   */
  private isValidChannel(channel: string): boolean {
    const validPrefixes = [
      "dragons",
      "gates",
      "machines",
      "orchestrator",
      "logs:",
    ];
    return validPrefixes.some(
      (prefix) => channel === prefix || channel.startsWith(prefix),
    );
  }

  /**
   * Check if a client's subscription matches a broadcast channel.
   * Supports prefix matching: subscription to "dragons" matches "dragons" broadcast.
   * Also supports specific dragon ID: subscription to "logs:kiro-A" matches only that dragon.
   */
  private matchesSubscription(
    subscriptions: Set<string>,
    channel: string,
  ): boolean {
    // Direct match
    if (subscriptions.has(channel)) {
      return true;
    }

    // For log channels, check if subscribed to the specific dragon
    if (channel.startsWith("logs:")) {
      return subscriptions.has(channel);
    }

    return false;
  }

  /**
   * Send a message to a single WebSocket client.
   */
  private send(ws: WebSocket, message: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast an update to all clients subscribed to a channel.
   * Optionally filter by project.
   */
  broadcast(
    channel: string,
    data: unknown,
    options?: { project?: string },
  ): void {
    const message: WSServerMessage = {
      type: "update",
      channel,
      data,
      timestamp: new Date().toISOString(),
    };

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    for (const client of this.clients.values()) {
      // Filter by project if specified
      if (options?.project && client.project !== options.project) {
        continue;
      }

      if (this.matchesSubscription(client.subscriptions, channel)) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(messageStr);
          sentCount++;
        }
      }
    }

    if (sentCount > 0) {
      console.log(
        `[WebSocket] Broadcast to ${channel}: ${sentCount} client(s)`,
      );
    }
  }

  /**
   * Broadcast a dragon status update.
   */
  broadcastDragonUpdate(data: DragonUpdateData, project?: string): void {
    this.broadcast("dragons", data, { project });
  }

  /**
   * Broadcast a gate update.
   */
  broadcastGateUpdate(data: GateUpdateData, project?: string): void {
    this.broadcast("gates", data, { project });
  }

  /**
   * Broadcast a machine health update.
   */
  broadcastMachineUpdate(data: MachineUpdateData, project?: string): void {
    this.broadcast("machines", data, { project });
  }

  /**
   * Broadcast a log line to subscribers of logs:<dragonId>.
   */
  broadcastLogLine(dragonId: string, line: string, project?: string): void {
    const data: LogLineData = {
      dragonId,
      line,
      timestamp: new Date().toISOString(),
    };
    this.broadcast(`logs:${dragonId}`, data, { project });
  }

  /**
   * Broadcast an orchestrator tick event.
   */
  broadcastOrchestratorTick(data: unknown, project?: string): void {
    this.broadcast("orchestrator", data, { project });
  }

  /**
   * Ping all clients to detect dead connections.
   */
  private pingClients(): void {
    const now = Date.now();
    const timeout = 60000; // 60 seconds without pong = dead

    for (const [sessionId, client] of this.clients) {
      if (now - client.lastPing > timeout) {
        console.log(
          `[WebSocket] Client ${sessionId} timed out, terminating`,
        );
        client.ws.terminate();
        this.clients.delete(sessionId);
      } else if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }

  /**
   * Get the number of connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of clients subscribed to a channel.
   */
  getSubscriberCount(channel: string): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (this.matchesSubscription(client.subscriptions, channel)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Gracefully close all connections and stop the server.
   */
  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();

    this.unregisterUpgrade();
    this.wss.close();
    console.log("[WebSocket] Server closed");
  }
}
