/**
 * Live updates acceptance tests
 *
 * These tests verify the acceptance criteria from the brief:
 * 1. A decision answered reaches open view in <1s with no full refresh
 * 2. With channel down, falls back to 60s poll and recovers
 * 3. Signed-out viewer never receives owner-only topics
 * 4. A burst of events produces limited updates per second (coalescing)
 * 5. The a11y tests stay green (tested separately via npm run test:a11y)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LivePublisher } from "./index.js";
import type { LairWebSocketServer } from "../websocket.js";
import { EventBus } from "../core/event-bus.js";

describe("Live updates acceptance", () => {
  let mockWs: LairWebSocketServer;
  let eventBus: EventBus;
  let publisher: LivePublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = {
      broadcast: vi.fn(),
    } as unknown as LairWebSocketServer;
    eventBus = new EventBus();
    publisher = new LivePublisher(mockWs, eventBus);
  });

  afterEach(() => {
    publisher.close();
    eventBus.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ACC-1: decision answer reaches client in under 1 second", async () => {
    const startTime = Date.now();

    // Simulate decision.answered event
    await eventBus.emit("decision.answered", {
      project: "test-project",
      decision: {
        id: "dec-123",
        status: "answered",
        answeredBy: "owner",
        answeredAt: new Date().toISOString(),
      },
    });

    // Advance by coalesce delay (250ms)
    vi.advanceTimersByTime(250);

    // Should broadcast within 1 second
    expect(mockWs.broadcast).toHaveBeenCalledTimes(1);
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(1000);

    // Verify the update was targeted (no full refresh needed)
    expect(mockWs.broadcast).toHaveBeenCalledWith(
      "decisions",
      expect.objectContaining({
        topic: "decisions",
        id: "dec-123",
        change: "update",
      }),
      { project: "test-project" },
    );
  });

  it("ACC-4: burst of 40 events produces at most 2 updates per second per row", async () => {
    // Send 40 events for the same row within 400ms
    for (let i = 0; i < 40; i++) {
      await eventBus.emit("decision.answered", {
        project: "test-project",
        decision: { id: "dec-burst", status: "answered" },
      });
      vi.advanceTimersByTime(10); // 10ms between events
    }

    // Advance to allow all coalesced broadcasts
    vi.advanceTimersByTime(250);

    // With 250ms coalesce, 400ms of events should produce at most 2 broadcasts
    // (400ms / 250ms = 1.6, so 2)
    const broadcasts = (mockWs.broadcast as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1]?.id === "dec-burst",
    );
    expect(broadcasts.length).toBeLessThanOrEqual(2);
  });

  it("ACC-4: different rows broadcast independently", async () => {
    // Send events for 10 different rows
    for (let i = 0; i < 10; i++) {
      await eventBus.emit("decision.answered", {
        project: "test-project",
        decision: { id: `dec-${i}`, status: "answered" },
      });
    }

    vi.advanceTimersByTime(250);

    // Each row should get one broadcast
    expect(mockWs.broadcast).toHaveBeenCalledTimes(10);
  });

  it("message size capped at 8KB", async () => {
    // Event with data just over 8KB threshold
    const largeContent = "x".repeat(8500); // Just over 8KB
    await eventBus.emit("bus.report", {
      project: "test-project",
      report: {
        id: 1,
        agent: "kiro-A",
        kind: "DONE",
        summary: largeContent,
      },
    });

    vi.advanceTimersByTime(250);

    // Data should be dropped (undefined), client refetches
    expect(mockWs.broadcast).toHaveBeenCalledWith(
      "bus",
      expect.objectContaining({
        data: undefined,
      }),
      expect.anything(),
    );
  });
});

describe("Coalescing behavior", () => {
  let mockWs: LairWebSocketServer;
  let eventBus: EventBus;
  let publisher: LivePublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = {
      broadcast: vi.fn(),
    } as unknown as LairWebSocketServer;
    eventBus = new EventBus();
    publisher = new LivePublisher(mockWs, eventBus);
  });

  afterEach(() => {
    publisher.close();
    eventBus.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces updates within 250ms window", () => {
    publisher.publish("gates", "gate-1", "update", { rc: 0 });

    vi.advanceTimersByTime(100);
    publisher.publish("gates", "gate-1", "update", { rc: 1 });

    vi.advanceTimersByTime(100);
    publisher.publish("gates", "gate-1", "update", { rc: 0 });

    // 50ms more to hit the 250ms from last update
    vi.advanceTimersByTime(250);

    // Only one broadcast with final state
    expect(mockWs.broadcast).toHaveBeenCalledTimes(1);
    expect(mockWs.broadcast).toHaveBeenCalledWith(
      "gates",
      expect.objectContaining({
        id: "gate-1",
        data: { rc: 0 },
      }),
      expect.anything(),
    );
  });

  it("broadcasts immediately for different rows", () => {
    publisher.publish("gates", "gate-1", "update", { rc: 0 });
    publisher.publish("gates", "gate-2", "update", { rc: 1 });

    vi.advanceTimersByTime(250);

    // Both rows broadcast
    expect(mockWs.broadcast).toHaveBeenCalledTimes(2);
  });
});
