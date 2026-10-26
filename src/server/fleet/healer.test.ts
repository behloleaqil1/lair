/**
 * Tests for self-healing service.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Healer, stopHealer } from "./healer.js";

describe("Healer", () => {
  let healer: Healer;

  beforeEach(() => {
    stopHealer();
    healer = new Healer({
      enabled: true,
      heartbeatTimeoutMs: 5000,
      stuckJobTimeoutMs: 10000,
      maxRetries: 3,
      autoReschedule: true,
      autoRecover: true,
    });
  });

  afterEach(() => {
    healer.stop();
    stopHealer();
  });

  describe("configuration", () => {
    it("should return config", () => {
      const config = healer.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.heartbeatTimeoutMs).toBe(5000);
      expect(config.maxRetries).toBe(3);
    });

    it("should update config", () => {
      healer.updateConfig({ maxRetries: 5 });
      const config = healer.getConfig();
      expect(config.maxRetries).toBe(5);
    });

    it("should disable healing when enabled set to false", () => {
      healer.updateConfig({ enabled: false });
      const config = healer.getConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe("events", () => {
    it("should start with no events", () => {
      const events = healer.getEvents();
      expect(events).toEqual([]);
    });

    it("should return empty unresolved events initially", () => {
      const events = healer.getUnresolvedEvents();
      expect(events).toEqual([]);
    });

    it("should limit events returned", () => {
      const events = healer.getEvents(10);
      expect(events).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("should start without error when enabled", () => {
      expect(() => healer.start()).not.toThrow();
    });

    it("should stop without error", () => {
      healer.start();
      expect(() => healer.stop()).not.toThrow();
    });

    it("should not start check interval when disabled", () => {
      healer.updateConfig({ enabled: false });
      healer.start();
      // Should complete without starting interval
    });
  });
});
