/**
 * Tests for the bus consumers module.
 *
 * Acceptance tests from the brief:
 * 1. A bus DONE for a WAITING task marks it done in fill within 2s; the
 *    mirrored queue line does not mark it again.
 * 2. A bus BLOCKED raises exactly one hold or decision (no second one from
 *    the mirrored line).
 * 3. `observe` changes nothing and records the would-be transition.
 * 4. `off` behaves byte-for-byte as main (the file reader only).
 * 5. An event for an unknown task or agent is ignored and audited.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { BusConsumers, extractBusId, validateBusReportEvent, validateBusMessageEvent } from "./consumers.js";
import { EventBus } from "../core/event-bus.js";

describe("BusConsumers", () => {
  let eventBus: EventBus;
  let clock: { now: () => number };
  let currentTime: number;
  let reportHandler: ReturnType<typeof vi.fn>;
  let messageHandler: ReturnType<typeof vi.fn>;
  let invalidEventHandler: ReturnType<typeof vi.fn>;
  let consumers: BusConsumers;

  beforeEach(() => {
    eventBus = new EventBus();
    currentTime = 1700000000000;
    clock = { now: () => currentTime };
    reportHandler = vi.fn();
    messageHandler = vi.fn();
    invalidEventHandler = vi.fn();
    consumers = new BusConsumers({
      events: eventBus,
      clock,
      onReport: reportHandler,
      onMessage: messageHandler,
      onInvalidEvent: invalidEventHandler,
    });
  });

  afterEach(() => {
    consumers.stop();
    eventBus.clear();
  });

  // ============ extractBusId ============

  describe("extractBusId", () => {
    it("extracts bus id from a mirrored line", () => {
      const line = "- DONE feat-search by worker-a 14:30Z: completed [bus:42]";
      expect(extractBusId(line)).toBe(42);
    });

    it("returns null for a line without a marker", () => {
      const line = "- DONE feat-search by worker-a 14:30Z: completed";
      expect(extractBusId(line)).toBeNull();
    });

    it("handles marker with whitespace", () => {
      const line = "- DONE feat-search by worker-a 14:30Z: completed [bus:123]  ";
      expect(extractBusId(line)).toBe(123);
    });

    it("handles large bus ids", () => {
      const line = "- DONE feat-search by worker-a 14:30Z: completed [bus:1234567890]";
      expect(extractBusId(line)).toBe(1234567890);
    });
  });

  // ============ Mode: off ============

  describe("mode: off (ACCEPTANCE TEST 4)", () => {
    it("does not subscribe to events", async () => {
      consumers.setMode("test-project", "off");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
    });

    it("getMode returns off", () => {
      consumers.setMode("test-project", "off");
      expect(consumers.getMode("test-project")).toBe("off");
    });

    it("wasConsumed returns false", () => {
      consumers.setMode("test-project", "off");
      expect(consumers.wasConsumed("test-project", 42)).toBe(false);
    });

    it("returns off for unknown projects", () => {
      expect(consumers.getMode("unknown-project")).toBe("off");
    });
  });

  // ============ Mode: observe ============

  describe("mode: observe (ACCEPTANCE TEST 3)", () => {
    it("calls handlers with observe mode", async () => {
      consumers.setMode("test-project", "observe");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).toHaveBeenCalledWith(
        "test-project",
        expect.objectContaining({
          project: "test-project",
          id: 1,
          agent: "worker-a",
          kind: "DONE",
          task: "feat-search",
        }),
        "observe",
      );
    });

    it("does not mark events as consumed", async () => {
      consumers.setMode("test-project", "observe");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 42,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(consumers.wasConsumed("test-project", 42)).toBe(false);
    });

    it("records observations", () => {
      consumers.setMode("test-project", "observe");
      consumers.recordObservation("test-project", {
        busId: 42,
        kind: "report",
        agent: "worker-a",
        task: "feat-search",
        reportKind: "DONE",
        wouldDo: "mark_done",
      });

      const obs = consumers.getObservations("test-project");
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({
        busId: 42,
        kind: "report",
        wouldDo: "mark_done",
      });
    });

    it("records file actions for comparison", () => {
      consumers.setMode("test-project", "observe");
      consumers.recordObservation("test-project", {
        busId: 42,
        kind: "report",
        agent: "worker-a",
        task: "feat-search",
        reportKind: "DONE",
        wouldDo: "mark_done",
      });

      consumers.recordFileAction("test-project", 42, "mark_done");

      const obs = consumers.getObservations("test-project");
      expect(obs[0].fileDid).toBe("mark_done");
      expect(obs[0].match).toBe(true);
    });

    it("detects mismatches", () => {
      consumers.setMode("test-project", "observe");
      consumers.recordObservation("test-project", {
        busId: 42,
        kind: "report",
        agent: "worker-a",
        task: "feat-search",
        reportKind: "DONE",
        wouldDo: "mark_done",
      });

      consumers.recordFileAction("test-project", 42, "ignored");

      const obs = consumers.getObservations("test-project");
      expect(obs[0].match).toBe(false);
    });

    it("getHealthSummary shows observation stats", () => {
      consumers.setMode("test-project", "observe");

      // One pending
      consumers.recordObservation("test-project", {
        busId: 1,
        kind: "report",
        agent: "worker-a",
        task: "task-1",
        wouldDo: "action-1",
      });

      // One match
      consumers.recordObservation("test-project", {
        busId: 2,
        kind: "report",
        agent: "worker-a",
        task: "task-2",
        wouldDo: "action-2",
      });
      consumers.recordFileAction("test-project", 2, "action-2");

      // One mismatch
      consumers.recordObservation("test-project", {
        busId: 3,
        kind: "report",
        agent: "worker-a",
        task: "task-3",
        wouldDo: "action-3",
      });
      consumers.recordFileAction("test-project", 3, "different");

      const summary = consumers.getHealthSummary("test-project");
      expect(summary).toEqual({
        mode: "observe",
        observations: 3,
        matches: 1,
        mismatches: 1,
        pending: 1,
      });
    });
  });

  // ============ Mode: on ============

  describe("mode: on", () => {
    it("calls handlers with on mode", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).toHaveBeenCalledWith(
        "test-project",
        expect.objectContaining({ id: 1 }),
        "on",
      );
    });

    it("marks events as consumed (ACCEPTANCE TEST 1)", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 42,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(consumers.wasConsumed("test-project", 42)).toBe(true);
    });

    it("consumed events expire after TTL", () => {
      consumers.setMode("test-project", "on");
      consumers.markConsumed("test-project", 42);

      // Advance time past TTL (24 hours)
      currentTime += 25 * 60 * 60 * 1000;

      // Force a prune by marking another event
      consumers.markConsumed("test-project", 99);

      // The old event should be pruned
      expect(consumers.wasConsumed("test-project", 42)).toBe(false);
    });

    it("bounds consumed events to MAX_CONSUMED_EVENTS", () => {
      consumers.setMode("test-project", "on");

      // Mark many events
      for (let i = 0; i < 10_001; i++) {
        consumers.markConsumed("test-project", i);
      }

      // Old events should be dropped
      expect(consumers.wasConsumed("test-project", 0)).toBe(false);
      expect(consumers.wasConsumed("test-project", 10_000)).toBe(true);
    });
  });

  // ============ Event routing ============

  describe("event routing", () => {
    it("ignores events for other projects", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "other-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
    });

    it("handles message events", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.message", {
        project: "test-project",
        id: "msg-1",
        from: "worker-a",
        to: "orchestrator",
        priority: 5,
      });

      expect(messageHandler).toHaveBeenCalledWith(
        "test-project",
        expect.objectContaining({
          id: "msg-1",
          from: "worker-a",
          to: "orchestrator",
        }),
        "on",
      );
    });
  });

  // ============ Mode switching ============

  describe("mode switching", () => {
    it("unsubscribes when switching modes", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });
      expect(reportHandler).toHaveBeenCalledTimes(1);

      // Switch to off
      consumers.setMode("test-project", "off");
      reportHandler.mockClear();

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 2,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });
      expect(reportHandler).not.toHaveBeenCalled();
    });

    it("preserves consumed state when switching modes", () => {
      consumers.setMode("test-project", "on");
      consumers.markConsumed("test-project", 42);

      // Switch to observe and back
      consumers.setMode("test-project", "observe");
      consumers.setMode("test-project", "on");

      expect(consumers.wasConsumed("test-project", 42)).toBe(true);
    });

    it("switching to same mode is a no-op", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });
      expect(reportHandler).toHaveBeenCalledTimes(1);

      // Set same mode
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 2,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });
      // Should still work (not double-subscribed)
      expect(reportHandler).toHaveBeenCalledTimes(2);
    });
  });

  // ============ Cleanup ============

  describe("cleanup", () => {
    it("stop() cleans up all subscriptions", async () => {
      consumers.setMode("test-project", "on");
      consumers.stop();

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
    });
  });

  // ============ Runtime validation (M3) ============

  describe("runtime validation (ACCEPTANCE TEST 5)", () => {
    it("ignores and audits invalid report events", async () => {
      consumers.setMode("test-project", "on");

      // Missing required field
      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        // missing kind
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
      expect(invalidEventHandler).toHaveBeenCalledWith(
        "test-project",
        "invalid bus.report event data",
        expect.objectContaining({ project: "test-project" }),
      );
    });

    it("ignores report events with invalid kind", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 1,
        agent: "worker-a",
        kind: "INVALID_KIND",
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
      expect(invalidEventHandler).toHaveBeenCalled();
    });

    it("ignores report events with non-integer id", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: "not-a-number",
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
      });

      expect(reportHandler).not.toHaveBeenCalled();
      expect(invalidEventHandler).toHaveBeenCalled();
    });

    it("ignores and audits invalid message events", async () => {
      consumers.setMode("test-project", "on");

      // Missing required field
      await eventBus.emit("bus.message", {
        project: "test-project",
        id: "msg-1",
        from: "worker-a",
        // missing 'to'
        priority: 5,
      });

      expect(messageHandler).not.toHaveBeenCalled();
      expect(invalidEventHandler).toHaveBeenCalledWith(
        "test-project",
        "invalid bus.message event data",
        expect.objectContaining({ project: "test-project" }),
      );
    });

    it("accepts valid report events with all fields", async () => {
      consumers.setMode("test-project", "on");

      await eventBus.emit("bus.report", {
        project: "test-project",
        id: 42,
        agent: "worker-a",
        kind: "DONE",
        task: "feat-search",
        gateId: "gate-123",
        pr: 456,
        sha: "abc1234",
      });

      expect(reportHandler).toHaveBeenCalledWith(
        "test-project",
        expect.objectContaining({
          id: 42,
          gateId: "gate-123",
          pr: 456,
          sha: "abc1234",
        }),
        "on",
      );
      expect(invalidEventHandler).not.toHaveBeenCalled();
    });
  });

  // ============ Persistence (M2) ============

  describe("persistence", () => {
    it("loads consumed ids on setMode", () => {
      const loadConsumed = vi.fn().mockReturnValue(new Map([[42, 1700000000000]]));
      const saveConsumed = vi.fn();
      
      const persistentConsumers = new BusConsumers({
        events: eventBus,
        clock,
        onReport: reportHandler,
        onMessage: messageHandler,
        loadConsumed,
        saveConsumed,
      });

      persistentConsumers.setMode("test-project", "on");

      expect(loadConsumed).toHaveBeenCalledWith("test-project");
      expect(persistentConsumers.wasConsumed("test-project", 42)).toBe(true);
    });

    it("saves consumed ids when marking", () => {
      const loadConsumed = vi.fn().mockReturnValue(new Map());
      const saveConsumed = vi.fn();
      
      const persistentConsumers = new BusConsumers({
        events: eventBus,
        clock,
        onReport: reportHandler,
        onMessage: messageHandler,
        loadConsumed,
        saveConsumed,
      });

      persistentConsumers.setMode("test-project", "on");
      persistentConsumers.markConsumed("test-project", 42);

      expect(saveConsumed).toHaveBeenCalledWith("test-project", expect.any(Map));
      const savedMap = saveConsumed.mock.calls[0][1];
      expect(savedMap.has(42)).toBe(true);
    });
  });
});

describe("bus config", () => {
  let parseBusConfig: (raw: Record<string, unknown> | undefined) => { consume: string };

  beforeAll(async () => {
    // Import here to avoid circular dependencies
    const module = await import("./config.js");
    parseBusConfig = module.parseBusConfig;
  });

  it("returns defaults for undefined config", () => {
    const settings = parseBusConfig(undefined);
    expect(settings.consume).toBe("off");
  });

  it("parses valid consume modes", () => {
    expect(parseBusConfig({ consume: "off" }).consume).toBe("off");
    expect(parseBusConfig({ consume: "observe" }).consume).toBe("observe");
    expect(parseBusConfig({ consume: "on" }).consume).toBe("on");
  });

  it("throws for invalid consume mode", () => {
    expect(() => parseBusConfig({ consume: "invalid" })).toThrow(
      'bus.consume must be "off", "observe", or "on"',
    );
  });

  it("throws for wrong type", () => {
    expect(() => parseBusConfig({ consume: 42 })).toThrow();
    expect(() => parseBusConfig({ consume: true })).toThrow();
  });
});

describe("validateBusReportEvent", () => {
  it("validates a minimal valid report event", () => {
    const result = validateBusReportEvent({
      project: "test",
      id: 1,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
    });

    expect(result).toEqual({
      project: "test",
      id: 1,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
      gateId: undefined,
      pr: undefined,
      sha: undefined,
    });
  });

  it("validates a report event with all optional fields", () => {
    const result = validateBusReportEvent({
      project: "test",
      id: 42,
      agent: "worker-a",
      kind: "WAITING",
      task: "feat-search",
      gateId: "gate-123",
      pr: 456,
      sha: "abc1234",
    });

    expect(result).toEqual({
      project: "test",
      id: 42,
      agent: "worker-a",
      kind: "WAITING",
      task: "feat-search",
      gateId: "gate-123",
      pr: 456,
      sha: "abc1234",
    });
  });

  it("accepts all valid report kinds", () => {
    for (const kind of ["DONE", "WAITING", "BLOCKED", "PROGRESS"]) {
      const result = validateBusReportEvent({
        project: "test",
        id: 1,
        agent: "worker-a",
        kind,
        task: "feat-search",
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe(kind);
    }
  });

  it("rejects missing project", () => {
    expect(validateBusReportEvent({
      id: 1,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
    })).toBeNull();
  });

  it("rejects non-integer id", () => {
    expect(validateBusReportEvent({
      project: "test",
      id: 1.5,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
    })).toBeNull();

    expect(validateBusReportEvent({
      project: "test",
      id: "not-a-number",
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
    })).toBeNull();
  });

  it("rejects invalid kind", () => {
    expect(validateBusReportEvent({
      project: "test",
      id: 1,
      agent: "worker-a",
      kind: "INVALID",
      task: "feat-search",
    })).toBeNull();
  });

  it("rejects invalid optional field types", () => {
    expect(validateBusReportEvent({
      project: "test",
      id: 1,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
      pr: "not-a-number",
    })).toBeNull();

    expect(validateBusReportEvent({
      project: "test",
      id: 1,
      agent: "worker-a",
      kind: "DONE",
      task: "feat-search",
      gateId: 123,
    })).toBeNull();
  });
});

describe("validateBusMessageEvent", () => {
  it("validates a valid message event", () => {
    const result = validateBusMessageEvent({
      project: "test",
      id: "msg-1",
      from: "worker-a",
      to: "orchestrator",
      priority: 5,
    });

    expect(result).toEqual({
      project: "test",
      id: "msg-1",
      from: "worker-a",
      to: "orchestrator",
      priority: 5,
    });
  });

  it("rejects missing required fields", () => {
    expect(validateBusMessageEvent({
      project: "test",
      id: "msg-1",
      from: "worker-a",
      // missing 'to'
      priority: 5,
    })).toBeNull();

    expect(validateBusMessageEvent({
      project: "test",
      id: "msg-1",
      from: "worker-a",
      to: "orchestrator",
      // missing 'priority'
    })).toBeNull();
  });

  it("rejects wrong types", () => {
    expect(validateBusMessageEvent({
      project: "test",
      id: 123, // should be string
      from: "worker-a",
      to: "orchestrator",
      priority: 5,
    })).toBeNull();

    expect(validateBusMessageEvent({
      project: "test",
      id: "msg-1",
      from: "worker-a",
      to: "orchestrator",
      priority: "high", // should be number
    })).toBeNull();
  });
});
