/**
 * useBusEvents - React hook for SSE subscription to bus events
 *
 * Connects to /api/bus/events SSE endpoint and provides:
 * - Live reports, messages, and claims
 * - Auto-reconnect on disconnect
 * - Typed event parsing
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  SSEEvent,
  BusReport,
  BusMessage,
  BusClaim,
} from "../../shared/bus-types";

export interface UseBusEventsState {
  connected: boolean;
  reports: BusReport[];
  messages: BusMessage[];
  claims: BusClaim[];
  lastEventTime: string | null;
  error: string | null;
}

export interface UseBusEventsActions {
  reconnect: () => void;
}

const RECONNECT_DELAY = 3000; // 3 seconds
const MAX_REPORTS = 100;
const MAX_MESSAGES = 100;

/**
 * Parse SSE data into typed event
 */
function parseSSEEvent(data: string): SSEEvent | null {
  try {
    return JSON.parse(data) as SSEEvent;
  } catch {
    console.error("Failed to parse SSE event:", data);
    return null;
  }
}

/**
 * Hook for subscribing to bus events via SSE
 */
export function useBusEvents(
  project: string,
  enabled = true
): [UseBusEventsState, UseBusEventsActions] {
  const [state, setState] = useState<UseBusEventsState>({
    connected: false,
    reports: [],
    messages: [],
    claims: [],
    lastEventTime: null,
    error: null,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Clean up function
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Connect to SSE endpoint
  const connect = useCallback(() => {
    if (!project || !enabled || !mountedRef.current) return;

    cleanup();

    const url = `/api/bus/events?project=${encodeURIComponent(project)}`;

    try {
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!mountedRef.current) return;
        setState((prev) => ({
          ...prev,
          connected: true,
          error: null,
        }));
      };

      eventSource.onmessage = (event) => {
        if (!mountedRef.current) return;

        const sseEvent = parseSSEEvent(event.data);
        if (!sseEvent) return;

        setState((prev) => {
          const newState = { ...prev, lastEventTime: sseEvent.timestamp };

          switch (sseEvent.type) {
            case "init":
              // Connection initialized
              break;

            case "heartbeat":
              // Keep-alive, no state change needed
              break;

            case "report":
              if (Array.isArray(sseEvent.data)) {
                // Batch of reports (initial load)
                const reports = sseEvent.data as BusReport[];
                newState.reports = mergeReports(prev.reports, reports);
              }
              break;

            case "message":
              if (Array.isArray(sseEvent.data)) {
                // Batch of messages (initial load or updates)
                const messages = sseEvent.data as BusMessage[];
                newState.messages = mergeMessages(prev.messages, messages);
              }
              break;

            case "claim":
              if (Array.isArray(sseEvent.data)) {
                // Claims snapshot
                newState.claims = sseEvent.data as BusClaim[];
              }
              break;

            case "ack":
              // Message acknowledgment - update message state
              // This will be handled via message updates
              break;
          }

          return newState;
        });
      };

      eventSource.onerror = () => {
        if (!mountedRef.current) return;

        setState((prev) => ({
          ...prev,
          connected: false,
          error: "Connection lost",
        }));

        cleanup();

        // Schedule reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, RECONNECT_DELAY);
      };
    } catch (err) {
      setState((prev) => ({
        ...prev,
        connected: false,
        error: err instanceof Error ? err.message : "Connection failed",
      }));
    }
  }, [project, enabled, cleanup]);

  // Reconnect action
  const reconnect = useCallback(() => {
    connect();
  }, [connect]);

  // Effect to manage connection lifecycle
  useEffect(() => {
    mountedRef.current = true;

    if (enabled && project) {
      connect();
    }

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [project, enabled, connect, cleanup]);

  return [state, { reconnect }];
}

/**
 * Merge new reports with existing ones, keeping most recent
 */
function mergeReports(existing: BusReport[], incoming: BusReport[]): BusReport[] {
  const byId = new Map<number, BusReport>();

  // Add existing
  for (const report of existing) {
    byId.set(report.id, report);
  }

  // Add/update with incoming
  for (const report of incoming) {
    byId.set(report.id, report);
  }

  // Sort by timestamp descending and limit
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_REPORTS);
}

/**
 * Merge new messages with existing ones, updating delivery state
 */
function mergeMessages(existing: BusMessage[], incoming: BusMessage[]): BusMessage[] {
  const byId = new Map<number, BusMessage>();

  // Add existing
  for (const message of existing) {
    byId.set(message.id, message);
  }

  // Add/update with incoming (incoming has newer state)
  for (const message of incoming) {
    byId.set(message.id, message);
  }

  // Sort by timestamp descending and limit
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_MESSAGES);
}

/**
 * Helper to get message delivery state display
 */
export function getDeliveryStateDisplay(state: BusMessage["state"]): {
  icon: string;
  label: string;
  className: string;
} {
  switch (state) {
    case "sent":
      return { icon: "📤", label: "Sent", className: "state-sent" };
    case "read":
      return { icon: "👁", label: "Read", className: "state-read" };
    case "ack":
      return { icon: "✓", label: "Acknowledged", className: "state-ack" };
  }
}

/**
 * Helper to get report kind display
 */
export function getReportKindDisplay(kind: BusReport["kind"]): {
  icon: string;
  label: string;
  className: string;
} {
  switch (kind) {
    case "WAITING":
      return { icon: "⏳", label: "Waiting", className: "kind-waiting" };
    case "DONE":
      return { icon: "✅", label: "Done", className: "kind-done" };
    case "BLOCKED":
      return { icon: "🚫", label: "Blocked", className: "kind-blocked" };
    case "PROGRESS":
      return { icon: "🔄", label: "Progress", className: "kind-progress" };
    case "TICK":
      return { icon: "🕐", label: "Tick", className: "kind-tick" };
  }
}
