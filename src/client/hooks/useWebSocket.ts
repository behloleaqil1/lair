/**
 * useWebSocket - React hook for WebSocket connection to Lair server.
 *
 * Provides real-time updates for dragons, gates, machines, and orchestrator,
 * replacing REST polling with push-based updates.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { Dragon, Gate } from "../../shared/types";

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

interface WSClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channels?: string[];
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
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelay?: number;
}

// Alternative options format (used by Nodes.tsx)
export interface UseWebSocketLegacyOptions {
  channels?: string[];
  onConnectionChange?: (connected: boolean) => void;
}

const DEFAULT_RECONNECT_DELAY = 3000;
const PING_INTERVAL = 25000; // Send ping every 25 seconds

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
    onDragonUpdate,
    onGateUpdate,
    onMachineUpdate,
    onOrchestratorUpdate,
    onLogLine,
    onConnectionChange,
    autoReconnect = true,
    reconnectDelay = DEFAULT_RECONNECT_DELAY,
  } = options;

  const [state, setState] = useState<UseWebSocketState>({
    connected: false,
    sessionId: null,
    subscribedChannels: new Set(),
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Send message to WebSocket
  const sendMessage = useCallback((message: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Subscribe to channels
  const subscribe = useCallback(
    (channelsToSubscribe: WSChannel[]) => {
      sendMessage({ type: "subscribe", channels: channelsToSubscribe });
    },
    [sendMessage],
  );

  // Unsubscribe from channels
  const unsubscribe = useCallback(
    (channelsToUnsubscribe: WSChannel[]) => {
      sendMessage({ type: "unsubscribe", channels: channelsToUnsubscribe });
    },
    [sendMessage],
  );

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    cleanup();

    const wsUrl = `ws://${window.location.hostname}:4777/ws?project=${encodeURIComponent(project)}`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;

        console.log("[useWebSocket] Connected");
        setState((prev) => ({
          ...prev,
          connected: true,
          error: null,
        }));
        onConnectionChange?.(true);

        // Subscribe to initial channels
        if (channels.length > 0) {
          sendMessage({ type: "subscribe", channels });
        }

        // Start ping interval
        pingIntervalRef.current = setInterval(() => {
          sendMessage({ type: "ping" });
        }, PING_INTERVAL);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const message = JSON.parse(event.data) as WSServerMessage;

          switch (message.type) {
            case "connected":
              setState((prev) => ({
                ...prev,
                sessionId: message.sessionId || null,
              }));
              break;

            case "subscribed":
              setState((prev) => {
                const newChannels = new Set(prev.subscribedChannels);
                for (const ch of message.channels || []) {
                  newChannels.add(ch);
                }
                return { ...prev, subscribedChannels: newChannels };
              });
              break;

            case "unsubscribed":
              setState((prev) => {
                const newChannels = new Set(prev.subscribedChannels);
                for (const ch of message.channels || []) {
                  newChannels.delete(ch);
                }
                return { ...prev, subscribedChannels: newChannels };
              });
              break;

            case "update":
              handleUpdate(message.channel || "", message.data);
              break;

            case "error":
              console.error("[useWebSocket] Server error:", message.error);
              setState((prev) => ({ ...prev, error: message.error || null }));
              break;

            case "pong":
              // Pong received, connection is alive
              break;
          }
        } catch (err) {
          console.error("[useWebSocket] Failed to parse message:", err);
        }
      };

      ws.onerror = (error) => {
        console.error("[useWebSocket] WebSocket error:", error);
        setState((prev) => ({
          ...prev,
          error: "WebSocket connection error",
        }));
      };

      ws.onclose = (event) => {
        console.log("[useWebSocket] Disconnected:", event.code, event.reason);

        setState((prev) => ({
          ...prev,
          connected: false,
          sessionId: null,
          subscribedChannels: new Set(),
        }));
        onConnectionChange?.(false);

        // Clear ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Auto-reconnect if enabled and component is still mounted
        if (autoReconnect && mountedRef.current && event.code !== 1000) {
          console.log(`[useWebSocket] Reconnecting in ${reconnectDelay}ms...`);
          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, reconnectDelay);
        }
      };
    } catch (err) {
      console.error("[useWebSocket] Failed to connect:", err);
      setState((prev) => ({
        ...prev,
        error: "Failed to connect to WebSocket",
      }));
    }
  }, [project, channels, autoReconnect, reconnectDelay, cleanup, sendMessage]);

  // Handle update messages
  const handleUpdate = useCallback(
    (channel: string, data: unknown) => {
      if (channel === "dragons" && onDragonUpdate) {
        onDragonUpdate(data as DragonUpdateData);
      } else if (channel === "gates" && onGateUpdate) {
        onGateUpdate(data as GateUpdateData);
      } else if (channel === "machines" && onMachineUpdate) {
        onMachineUpdate(data as MachineUpdateData);
      } else if (channel === "orchestrator" && onOrchestratorUpdate) {
        onOrchestratorUpdate(data);
      } else if (channel.startsWith("logs:") && onLogLine) {
        onLogLine(data as LogLineData);
      }
    },
    [
      onDragonUpdate,
      onGateUpdate,
      onMachineUpdate,
      onOrchestratorUpdate,
      onLogLine,
    ],
  );

  // Effect to manage connection lifecycle
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);

  // Reconnect when project changes
  useEffect(() => {
    if (state.connected) {
      cleanup();
      connect();
    }
    // Only reconnect when project changes, not on connect/cleanup updates
  }, [project]);

  return {
    ...state,
    connectionState: state.connected
      ? ("connected" as const)
      : ("disconnected" as const),
    subscribe,
    unsubscribe,
    reconnect: connect,
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
