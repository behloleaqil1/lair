/**
 * useLiveUpdates - React hook for topic-based live updates.
 *
 * Subscribes to one or more topics via the WebSocket connection and calls
 * onUpdate when a change arrives. The view uses this to patch its state
 * instead of re-fetching everything.
 *
 * Falls back to polling every 60s while the connection is down.
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { LiveSocket, type LiveSocketState } from "./live-socket";
import type { LiveTopic, LiveUpdate, ChangeKind } from "../../shared/live-types";
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, type ConnectionStatus } from "./reconnect";

const FALLBACK_POLL_MS = 60_000;

export interface LiveUpdateHandler<T = unknown> {
  /** Called when a row changes */
  onUpdate: (id: string, change: ChangeKind, data?: T) => void;
  /** Called to refetch after fallback poll or reconnect */
  onRefresh?: () => void;
}

export interface UseLiveUpdatesOptions<T = unknown> {
  project: string;
  topics: readonly LiveTopic[];
  handler: LiveUpdateHandler<T>;
  /** Skip connecting (e.g., module off) */
  skip?: boolean;
}

export interface UseLiveUpdatesState {
  status: ConnectionStatus;
  /** True when connected and receiving live updates */
  live: boolean;
  /** True when using the 60s fallback poll */
  polling: boolean;
}

/**
 * Hook for receiving live updates on specific topics.
 */
export function useLiveUpdates<T = unknown>(options: UseLiveUpdatesOptions<T>): UseLiveUpdatesState {
  const { project, topics, handler, skip } = options;
  const topicsKey = topics.join("\n");
  const [state, setState] = useState<UseLiveUpdatesState>({
    status: "connecting",
    live: false,
    polling: false,
  });
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (skip || topics.length === 0) {
      setState({ status: "closed", live: false, polling: false });
      return;
    }

    let active = true;
    let wasConnected = false;

    const socket = new LiveSocket({
      url: `ws://${window.location.hostname}:4777/ws?project=${encodeURIComponent(project)}`,
      channels: [...topics],
      autoReconnect: true,
      initialDelayMs: RECONNECT_INITIAL_MS,
      maxDelayMs: RECONNECT_MAX_MS,
      onState: (s: LiveSocketState) => {
        if (!active) return;
        const connected = s.status === "connected";
        setState({
          status: s.status,
          live: connected,
          polling: !connected,
        });

        // Start/stop fallback poll
        if (!connected && !pollRef.current) {
          pollRef.current = setInterval(() => {
            handlerRef.current.onRefresh?.();
          }, FALLBACK_POLL_MS);
        } else if (connected && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Refresh once on reconnect to catch missed updates
          if (wasConnected) {
            handlerRef.current.onRefresh?.();
          }
        }
        wasConnected = connected || wasConnected;
      },
      onMessage: (message: unknown) => {
        if (!active) return;
        const msg = message as { type?: string; channel?: string; data?: LiveUpdate };
        if (msg.type !== "update" || !msg.data) return;
        const update = msg.data;
        if (!topics.includes(update.topic)) return;
        handlerRef.current.onUpdate(update.id, update.change, update.data as T);
      },
    });

    socket.start();

    return () => {
      active = false;
      socket.stop();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [project, topicsKey, skip, topics]);

  return state;
}

/**
 * Hook for managing a list with live updates.
 * Handles insert/update/delete operations on an array.
 */
export function useLiveList<T extends { id: string | number }>(
  initial: T[],
  options: Omit<UseLiveUpdatesOptions<T>, "handler"> & { onRefresh?: () => void },
): [T[], UseLiveUpdatesState] {
  const [items, setItems] = useState(initial);

  // Sync with initial when it changes from REST
  useEffect(() => {
    setItems(initial);
  }, [initial]);

  const handler: LiveUpdateHandler<T> = {
    onUpdate: useCallback((id: string, change: ChangeKind, data?: T) => {
      setItems((prev) => {
        switch (change) {
          case "insert":
            if (data && !prev.some((item) => String(item.id) === id)) {
              return [data, ...prev];
            }
            return prev;
          case "update":
            return prev.map((item) =>
              String(item.id) === id && data ? { ...item, ...data } : item,
            );
          case "delete":
            return prev.filter((item) => String(item.id) !== id);
          default:
            return prev;
        }
      });
    }, []),
    onRefresh: options.onRefresh,
  };

  const state = useLiveUpdates({ ...options, handler });
  return [items, state];
}

/**
 * Hook for managing a map with live updates.
 * Handles insert/update/delete operations on a Map<string, T>.
 */
export function useLiveMap<T>(
  initial: Map<string, T>,
  options: Omit<UseLiveUpdatesOptions<T>, "handler"> & { onRefresh?: () => void },
): [Map<string, T>, UseLiveUpdatesState] {
  const [items, setItems] = useState(initial);

  useEffect(() => {
    setItems(initial);
  }, [initial]);

  const handler: LiveUpdateHandler<T> = {
    onUpdate: useCallback((id: string, change: ChangeKind, data?: T) => {
      setItems((prev) => {
        const next = new Map(prev);
        switch (change) {
          case "insert":
          case "update":
            if (data) next.set(id, data);
            break;
          case "delete":
            next.delete(id);
            break;
        }
        return next;
      });
    }, []),
    onRefresh: options.onRefresh,
  };

  const state = useLiveUpdates({ ...options, handler });
  return [items, state];
}
