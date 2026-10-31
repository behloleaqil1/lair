/**
 * LivePublisher unit tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LivePublisher } from "./index.js";
import type { LairWebSocketServer } from "../websocket.js";
import { EventBus } from "../core/event-bus.js";

describe("LivePublisher", () => {
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

  describe("publish", () => {
    it("broadcasts after coalesce delay", () => {
      publisher.publish("dragons", "kiro-A", "update", { running: true }, "test-project");

      // Not broadcast immediately
      expect(mockWs.broadcast).not.toHaveBeenCalled();

      // Broadcast after 250ms
      vi.advanceTimersByTime(250);
      expect(mockWs.broadcast).toHaveBeenCalledTimes(1);
      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "dragons",
        expect.objectContaining({
          topic: "dragons",
          id: "kiro-A",
          change: "update",
          data: { running: true },
        }),
        { project: "test-project" },
      );
    });

    it("coalesces rapid updates to the same row", () => {
      publisher.publish("dragons", "kiro-A", "update", { running: true });
      publisher.publish("dragons", "kiro-A", "update", { running: false });
      publisher.publish("dragons", "kiro-A", "update", { task: "new-task" });

      vi.advanceTimersByTime(250);

      // Only one broadcast with the last data
      expect(mockWs.broadcast).toHaveBeenCalledTimes(1);
      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "dragons",
        expect.objectContaining({
          id: "kiro-A",
          data: { task: "new-task" },
        }),
        expect.anything(),
      );
    });

    it("broadcasts different rows independently", () => {
      publisher.publish("dragons", "kiro-A", "update", { running: true });
      publisher.publish("dragons", "kiro-B", "update", { running: false });

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledTimes(2);
    });

    it("drops data larger than 8KB", () => {
      const largeData = { content: "x".repeat(8500) }; // Just over 8KB threshold
      publisher.publish("dragons", "kiro-A", "update", largeData);

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "dragons",
        expect.objectContaining({
          id: "kiro-A",
          data: undefined, // Data dropped
        }),
        expect.anything(),
      );
    });
  });

  describe("event subscriptions", () => {
    it("publishes on decision.raised", async () => {
      await eventBus.emit("decision.raised", {
        project: "test-project",
        decision: { id: "dec-1", status: "open" },
      });

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "decisions",
        expect.objectContaining({
          topic: "decisions",
          id: "dec-1",
          change: "insert",
        }),
        { project: "test-project" },
      );
    });

    it("publishes on decision.answered", async () => {
      await eventBus.emit("decision.answered", {
        project: "test-project",
        decision: { id: "dec-1", status: "answered", answeredBy: "owner" },
      });

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "decisions",
        expect.objectContaining({
          id: "dec-1",
          change: "update",
        }),
        { project: "test-project" },
      );
    });

    it("publishes on bus.report", async () => {
      await eventBus.emit("bus.report", {
        project: "test-project",
        report: {
          id: 42,
          agent: "kiro-A",
          kind: "DONE",
          summary: "Task completed",
        },
      });

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "bus",
        expect.objectContaining({
          topic: "bus",
          id: "report:42",
          change: "insert",
        }),
        { project: "test-project" },
      );
    });

    it("publishes on gate.completed", async () => {
      await eventBus.emit("gate.completed", {
        project: "test-project",
        result: { id: "gate-123", rc: 0 },
      });

      vi.advanceTimersByTime(250);

      expect(mockWs.broadcast).toHaveBeenCalledWith(
        "gates",
        expect.objectContaining({
          topic: "gates",
          id: "gate-123",
          change: "update",
          data: expect.objectContaining({ rc: 0, status: "completed" }),
        }),
        { project: "test-project" },
      );
    });
  });

  describe("close", () => {
    it("clears pending timers", () => {
      publisher.publish("dragons", "kiro-A", "update", { running: true });
      publisher.close();

      vi.advanceTimersByTime(250);

      // No broadcast because timer was cleared
      expect(mockWs.broadcast).not.toHaveBeenCalled();
    });

    it("unsubscribes from events", async () => {
      publisher.close();

      await eventBus.emit("decision.raised", {
        decision: { id: "dec-1" },
      });

      vi.advanceTimersByTime(250);

      // No broadcast because unsubscribed
      expect(mockWs.broadcast).not.toHaveBeenCalled();
    });
  });
});
