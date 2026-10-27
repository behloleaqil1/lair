/**
 * useWebSocket - React hook for WebSocket connection to Lair server.
 *
 * Provides real-time updates for dragons, gates, machines, and orchestrator,
 * replacing REST polling with push-based updates.
 *
 * The connection itself is a LiveSocket (live-socket.ts): when the server
 * goes away (a restart) it reconnects with backoff (1 s, doubling, at most
 * 30 s) and subscribes again, and `status` / `connectionState` say
 * "reconnecting" meanwhile. Unmounting, or a new project or channel list,
 * closes it on purpose: no reconnect follows.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { Dragon, Gate } from "../../shared/types";
import { LiveSocket } from "./live-socket";
import { RECONNECT_INITIAL_MS, type ConnectionStatus } from "./reconnect";

// WebSocket message types (mirrors server types)
interface WSServerMessage {
  type:
    "connected" | "subscribed" | "unsubscribed" | "update" | "error" | "pong";
  sessionId?: string;
  channel?: string;
  channels?: string[];
  data?: unknown;
  error?: string;
  timestamp: string;
}

// Dragon update data from WebSocket
interface DragonUpdateData {
  id: string;
  event: "status_change" | "log_line" | "task_change";
  running?: boolean;
  task?: string;
  lastLogLine?: string;
  lastLogTime?: string;
}

// Gate update data from WebSocket
interface GateUpdateData {
  id: string;
  event: "queued" | "started" | "completed" | "step_change";
  lane?: string;
  rc?: number;
  currentStep?: string;
  duration?: number;
}

// Machine update data from WebSocket
interface MachineUpdateData {
  name: string;
  event: "health_change" | "runner_change";
  up?: boolean;
  runners?: Array<{ lane: string; running: boolean }>;
}

// Log line data from WebSocket
interface LogLineData {
  dragonId: string;
  line: string;
  timestamp: string;
}

export type WSChannel =
  "dragons" | "gates" | "machines" | "orchestrator" | `logs:${string}`;

export interface UseWebSocketState {
  connected: boolean;
  /** connecting (first try), connected, reconnecting (lost: retrying with backoff), closed */
  status: ConnectionStatus;
  /** True while the connection is lost and a retry is scheduled or under way */
  reconnecting: boolean;
  /** The wait before the scheduled retry, while reconnecting */
  retryInMs: number | null;
  sessionId: string | null;
  subscribedChannels: Set<string>;
  error: string | null;
}

export interface UseWebSocketOptions {
  /** Project name for the WebSocket connection */
  project: string;
  /** Channels to subscribe to on connect */
  channels?: WSChannel[];
  /** Callback for dragon updates */
  onDragonUpdate?: (data: DragonUpdateData) => void;
  /** Callback for gate updates */
  onGateUpdate?: (data: GateUpdateData) => void;
  /** Callback for machine updates */
  onMachineUpdate?: (data: MachineUpdateData) => void;
  /** Callback for orchestrator updates */
  onOrchestratorUpdate?: (data: unknown) => void;
  /** Callback for log lines (requires logs:<dragonId> subscription) */
  onLogLine?: (data: LogLineData) => void;
  /** Callback when connection state changes */
  onConnectionChange?: (connected: boolean) => void;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** The first reconnect's delay in ms (default: 1000); it doubles per failed try, up to 30 s */
  reconnectDelay?: number;
}

// Alternative options format (used by Nodes.tsx)
export interface UseWebSocketLegacyOptions {
  channels?: string[];
  onConnectionChange?: (connected: boolean) => void;
}

const DEFAULT_RECONNECT_DELAY = RECONNECT_INITIAL_MS;

/** The hook's connectionState for a connection status. */
export function toConnectionState(
  status: ConnectionStatus,
): "connecting" | "connected" | "reconnecting" | "disconnected" {
  return status === "closed" ? "disconnected" : status;
}

function isServerMessage(value: unknown): value is WSServerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** The WebSocket URL of the Lair server for a project. */
export function socketUrl(hostname: string, project: string): string {
  return `ws://${hostname}:4777/ws?project=${encodeURIComponent(project)}`;
}

/**
 * Hook for WebSocket connection to Lair server.
 * Supports two signatures:
 * 1. useWebSocket(options: UseWebSocketOptions) - modern
 * 2. useWebSocket(project: string, options?: UseWebSocketLegacyOptions) - legacy
 */
export function useWebSocket(
  optionsOrProject: UseWebSocketOptions | string,
  legacyOptions?: UseWebSocketLegacyOptions,
) {
  // Normalize options
  const isLegacy = typeof optionsOrProject === "string";
  const options: UseWebSocketOptions = isLegacy
    ? {
        project: optionsOrProject,
        channels: legacyOptions?.channels as WSChannel[],
        onConnectionChange: legacyOptions?.onConnectionChange,
      }
    : optionsOrProject;

  const {
    project,
    channels = [],
    autoReconnect = true,
    reconnectDelay = DEFAULT_RECONNECT_DELAY,
  } = options;
  // Callers pass a new array each render: key the connection on its content
  const channelsKey = channels.join("\n");

  const [state, setState] = useState<UseWebSocketState>({
    connected: false,
    status: "connecting",
    reconnecting: false,
    retryInMs: null,
    sessionId: null,
    subscribedChannels: new Set(),
    error: null,
  });

  // The latest callbacks: a new function each render must not reopen the socket
  const handlersRef = useRef(options);
  handlersRef.current = options;
  const socketRef = useRef<LiveSocket | null>(null);

  useEffect(() => {
    let active = true;
    let connected = false;

    const handleMessage = (message: unknown) => {
      if (!active || !isServerMessage(message)) return;
      const handlers = handlersRef.current;
      switch (message.type) {
        case "connected":
          setState((prev) => ({ ...prev, sessionId: message.sessionId || null }));
          break;
        case "subscribed":
          setState((prev) => {
            const next = new Set(prev.subscribedChannels);
            for (const ch of message.channels || []) next.add(ch);
            return { ...prev, subscribedChannels: next };
          });
          break;
        case "unsubscribed":
          setState((prev) => {
            const next = new Set(prev.subscribedChannels);
            for (const ch of message.channels || []) next.delete(ch);
            return { ...prev, subscribedChannels: next };
          });
          break;
        case "update": {
          const channel = message.channel || "";
          if (channel === "dragons") handlers.onDragonUpdate?.(message.data as DragonUpdateData);
          else if (channel === "gates") handlers.onGateUpdate?.(message.data as GateUpdateData);
          else if (channel === "machines") handlers.onMachineUpdate?.(message.data as MachineUpdateData);
          else if (channel === "orchestrator") handlers.onOrchestratorUpdate?.(message.data);
          else if (channel.startsWith("logs:")) handlers.onLogLine?.(message.data as LogLineData);
          break;
        }
        case "error":
          console.error("[useWebSocket] Server error:", message.error);
          setState((prev) => ({ ...prev, error: message.error || null }));
          break;
        case "pong":
          break;
      }
    };

    const socket = new LiveSocket({
      url: socketUrl(window.location.hostname, project),
      channels: channelsKey ? channelsKey.split("\n") : [],
      autoReconnect,
      initialDelayMs: reconnectDelay,
      onMessage: handleMessage,
      onState: (s) => {
        if (!active) return;
        const isConnected = s.status === "connected";
        setState((prev) => ({
          ...prev,
          connected: isConnected,
          status: s.status,
          reconnecting: s.status === "reconnecting",
          retryInMs: s.retryInMs,
          error: s.error,
          // A new connection (to a restarted server) has a new session and no subscriptions yet
          ...(isConnected ? {} : { sessionId: null, subscribedChannels: new Set<string>() }),
        }));
        if (isConnected !== connected) {
          connected = isConnected;
          handlersRef.current.onConnectionChange?.(isConnected);
        }
      },
    });
    socketRef.current = socket;
    socket.start();

    return () => {
      active = false;
      socket.stop();
      if (socketRef.current === socket) socketRef.current = null;
      if (connected) handlersRef.current.onConnectionChange?.(false);
    };
  }, [project, channelsKey, autoReconnect, reconnectDelay]);

  // Subscribe to channels (kept across reconnects)
  const subscribe = useCallback((channelsToSubscribe: WSChannel[]) => {
    socketRef.current?.subscribe(channelsToSubscribe);
  }, []);

  // Unsubscribe from channels
  const unsubscribe = useCallback((channelsToUnsubscribe: WSChannel[]) => {
    socketRef.current?.unsubscribe(channelsToUnsubscribe);
  }, []);

  // Try now instead of waiting for the scheduled retry
  const reconnect = useCallback(() => {
    socketRef.current?.reconnectNow();
  }, []);

  return {
    ...state,
    connectionState: toConnectionState(state.status),
    subscribe,
    unsubscribe,
    reconnect,
  };
}

/**
 * Hook for subscribing to dragon updates with automatic state management.
 * Returns dragons with real-time updates and connection state.
 */
export function useDragonsWebSocket(
  project: string,
  initialDragons: Dragon[],
): {
  dragons: Dragon[];
  connectionState: "connecting" | "connected" | "disconnected";
  isUsingWebSocket: boolean;
  error: string | null;
} {
  const [dragons, setDragons] = useState<Dragon[]>(initialDragons);

  // Update initial dragons when they change from REST
  useEffect(() => {
    setDragons(initialDragons);
  }, [initialDragons]);

  const handleDragonUpdate = useCallback((data: DragonUpdateData) => {
    setDragons((prev) => {
      // If "all" dragons changed, don't update individual - client should refetch
      if (data.id === "all") {
        return prev;
      }

      return prev.map((dragon) => {
        if (dragon.id !== data.id) return dragon;

        switch (data.event) {
          case "status_change":
            return {
              ...dragon,
              running: data.running ?? dragon.running,
              task: data.task ?? dragon.task,
            };
          case "log_line":
            return {
              ...dragon,
              lastLogLine: data.lastLogLine ?? dragon.lastLogLine,
              lastLogTime: data.lastLogTime ?? dragon.lastLogTime,
            };
          case "task_change":
            return {
              ...dragon,
              task: data.task ?? dragon.task,
            };
          default:
            return dragon;
        }
      });
    });
  }, []);

  const { connected, error } = useWebSocket({
    project,
    channels: ["dragons"],
    onDragonUpdate: handleDragonUpdate,
  });

  return {
    dragons,
    connectionState: connected ? "connected" : "connecting",
    isUsingWebSocket: connected,
    error,
  };
}

/**
 * Hook for subscribing to gate updates with automatic state management.
 */
export function useGatesWebSocket(
  project: string,
  initialGates: Gate[],
): {
  gates: Gate[];
  connected: boolean;
  error: string | null;
} {
  const [gates, setGates] = useState<Gate[]>(initialGates);

  // Update initial gates when they change from REST
  useEffect(() => {
    setGates(initialGates);
  }, [initialGates]);

  const handleGateUpdate = useCallback((data: GateUpdateData) => {
    setGates((prev) => {
      // Check if gate exists
      const existingIndex = prev.findIndex((g) => g.id === data.id);

      if (existingIndex >= 0) {
        // Update existing gate
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          rc: data.rc ?? updated[existingIndex].rc,
          currentStep: data.currentStep ?? updated[existingIndex].currentStep,
          status:
            data.event === "completed"
              ? "completed"
              : data.event === "started"
                ? "running"
                : updated[existingIndex].status,
        };
        return updated;
      } else if (data.event === "queued") {
        // Add new gate
        const newGate: Gate = {
          id: data.id,
          lane: (data.lane as Gate["lane"]) || "heavy",
          priority: 0,
          status: "queued",
        };
        return [...prev, newGate];
      }

      return prev;
    });
  }, []);

  const { connected, error } = useWebSocket({
    project,
    channels: ["gates"],
    onGateUpdate: handleGateUpdate,
  });

  return { gates, connected, error };
}

/**
 * Hook for subscribing to live log streaming for a specific dragon.
 */
export function useDragonLogs(
  project: string,
  dragonId: string,
  enabled = true,
): {
  logs: string[];
  connected: boolean;
  clearLogs: () => void;
} {
  const [logs, setLogs] = useState<string[]>([]);

  const handleLogLine = useCallback(
    (data: LogLineData) => {
      if (data.dragonId === dragonId) {
        setLogs((prev) => [...prev.slice(-999), data.line]); // Keep last 1000 lines
      }
    },
    [dragonId],
  );

  const { connected } = useWebSocket({
    project,
    channels: enabled ? [`logs:${dragonId}`] : [],
    onLogLine: handleLogLine,
  });

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return { logs, connected, clearLogs };
}

// Machine update data types
interface MachineStatus {
  name: string;
  type: string;
  up: boolean;
  lastCheck?: string;
  lastGateTime?: string;
  runners?: Array<{ lane: string; running: boolean }>;
}

/**
 * Hook for subscribing to machine updates with automatic state management.
 */
export function useMachinesWebSocket(
  project: string,
  initialMachines: MachineStatus[],
): {
  machines: MachineStatus[];
  connected: boolean;
  error: string | null;
} {
  const [machines, setMachines] = useState<MachineStatus[]>(initialMachines);

  // Update initial machines when they change from REST
  useEffect(() => {
    setMachines(initialMachines);
  }, [initialMachines]);

  const handleMachineUpdate = useCallback((data: MachineUpdateData) => {
    setMachines((prev) => {
      const existingIndex = prev.findIndex((m) => m.name === data.name);

      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          up: data.up ?? updated[existingIndex].up,
          runners: data.runners ?? updated[existingIndex].runners,
          lastCheck: new Date().toISOString(),
        };
        return updated;
      }

      return prev;
    });
  }, []);

  const { connected, error } = useWebSocket({
    project,
    channels: ["machines"],
    onMachineUpdate: handleMachineUpdate,
  });

  return { machines, connected, error };
}

// Orchestrator update data types
interface OrchestratorStatus {
  launchdLoaded: boolean;
  stopFileExists: boolean;
  tickLines: Array<{ timestamp?: string; message: string }>;
}

interface OrchestratorUpdateData {
  event: "tick" | "launchd_change" | "stop_file_change";
  launchdLoaded?: boolean;
  stopFileExists?: boolean;
  tickLine?: { timestamp?: string; message: string };
}

/**
 * Hook for subscribing to orchestrator updates with automatic state management.
 */
export function useOrchestratorWebSocket(
  project: string,
  initialStatus: OrchestratorStatus | null,
): {
  status: OrchestratorStatus | null;
  connected: boolean;
  error: string | null;
} {
  const [status, setStatus] = useState<OrchestratorStatus | null>(
    initialStatus,
  );

  // Update initial status when it changes from REST
  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const handleOrchestratorUpdate = useCallback((data: unknown) => {
    const update = data as OrchestratorUpdateData;

    setStatus((prev) => {
      if (!prev) return prev;

      switch (update.event) {
        case "tick":
          if (update.tickLine) {
            return {
              ...prev,
              tickLines: [...prev.tickLines, update.tickLine].slice(-100),
            };
          }
          return prev;

        case "launchd_change":
          return {
            ...prev,
            launchdLoaded: update.launchdLoaded ?? prev.launchdLoaded,
          };

        case "stop_file_change":
          return {
            ...prev,
            stopFileExists: update.stopFileExists ?? prev.stopFileExists,
          };

        default:
          return prev;
      }
    });
  }, []);

  const { connected, error } = useWebSocket({
    project,
    channels: ["orchestrator"],
    onOrchestratorUpdate: handleOrchestratorUpdate,
  });

  return { status, connected, error };
}
