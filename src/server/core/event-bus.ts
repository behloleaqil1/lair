/**
 * Internal event bus for lair-server.
 * Decouples components and enables real-time updates.
 */
import type { EventType, Event } from "../../shared/server-types.js";

type EventHandler = (event: Event) => void | Promise<void>;

/**
 * Simple pub/sub event bus.
 * Components publish events, subscribers react to them.
 */
export class EventBus {
  private handlers = new Map<EventType | "*", Set<EventHandler>>();
  private recentEvents: Event[] = [];
  private maxRecentEvents = 1000;

  /**
   * Subscribe to events of a specific type, or "*" for all events.
   */
  on(type: EventType | "*", handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe to events once.
   */
  once(type: EventType | "*", handler: EventHandler): () => void {
    const wrappedHandler: EventHandler = (event) => {
      this.handlers.get(type)?.delete(wrappedHandler);
      return handler(event);
    };
    return this.on(type, wrappedHandler);
  }

  /**
   * Emit an event.
   */
  async emit(type: EventType, data: Record<string, unknown>): Promise<void> {
    const event: Event = {
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    // Store in recent events
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    // Notify type-specific handlers
    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`[EventBus] Handler error for ${type}:`, error);
        }
      }
    }

    // Notify wildcard handlers
    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`[EventBus] Wildcard handler error for ${type}:`, error);
        }
      }
    }
  }

  /**
   * Get recent events, optionally filtered by type.
   */
  getRecentEvents(type?: EventType, limit = 100): Event[] {
    let events = this.recentEvents;
    if (type) {
      events = events.filter((e) => e.type === type);
    }
    return events.slice(-limit);
  }

  /**
   * Clear all handlers.
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Global singleton instance
let globalEventBus: EventBus | null = null;

/**
 * Get the global event bus instance.
 */
export function getEventBus(): EventBus {
  if (!globalEventBus) {
    globalEventBus = new EventBus();
  }
  return globalEventBus;
}

/**
 * Reset the global event bus (for testing).
 */
export function resetEventBus(): void {
  globalEventBus?.clear();
  globalEventBus = null;
}
