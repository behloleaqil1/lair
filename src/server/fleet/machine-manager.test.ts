/**
 * Tests for machine manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MachineManager, stopMachineManager } from "./machine-manager.js";

// Mock the event bus
vi.mock("../core/event-bus.js", () => ({
  getEventBus: () => ({
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }),
}));

describe("MachineManager", () => {
  let manager: MachineManager;

  beforeEach(() => {
    stopMachineManager();
    manager = new MachineManager();
  });

  afterEach(() => {
    manager.stop();
    stopMachineManager();
  });

  describe("local machines", () => {
    it("should add a local machine", async () => {
      const machine = await manager.addMachine({
        name: "Local Mac",
        type: "local",
      });

      expect(machine.id).toBe("machine-local-mac");
      expect(machine.name).toBe("Local Mac");
      expect(machine.type).toBe("local");
      expect(machine.status).toBe("online");
    });

    it("should list machines", async () => {
      await manager.addMachine({ name: "Mac1", type: "local" });
      await manager.addMachine({ name: "Mac2", type: "local" });

      const machines = manager.listMachines();
      expect(machines).toHaveLength(2);
    });

    it("should get machine by ID", async () => {
      await manager.addMachine({ name: "Test Machine", type: "local" });

      const machine = manager.getMachine("machine-test-machine");
      expect(machine).toBeDefined();
      expect(machine?.name).toBe("Test Machine");
    });

    it("should remove machine", async () => {
      await manager.addMachine({ name: "ToRemove", type: "local" });
      expect(manager.listMachines()).toHaveLength(1);

      const removed = await manager.removeMachine("machine-toremove");
      expect(removed).toBe(true);
      expect(manager.listMachines()).toHaveLength(0);
    });

    it("should not add duplicate machine", async () => {
      await manager.addMachine({ name: "Duplicate", type: "local" });

      await expect(
        manager.addMachine({ name: "Duplicate", type: "local" })
      ).rejects.toThrow("already exists");
    });
  });

  describe("ssh machines", () => {
    it("should add an SSH machine with config", async () => {
      // Mock SSH check to fail (no actual connection)
      vi.spyOn(manager, "checkSSHConnectivity").mockResolvedValue(false);

      const machine = await manager.addMachine({
        name: "Build Server",
        type: "ssh",
        ssh: {
          host: "198.51.100.10",
          user: "deploy",
          key: "~/.ssh/example_key",
        },
      });

      expect(machine.id).toBe("machine-build-server");
      expect(machine.type).toBe("ssh");
      expect(machine.ssh).toBeDefined();
      expect(machine.ssh?.host).toBe("198.51.100.10");
      // Should be error because connectivity check failed
      expect(machine.status).toBe("error");
    });

    it("should require SSH config for ssh type", async () => {
      await expect(
        manager.addMachine({
          name: "Missing SSH",
          type: "ssh",
          // Missing ssh config
        })
      ).rejects.toThrow(); // Will fail when trying to check SSH
    });
  });

  describe("online machines", () => {
    it("should filter online machines", async () => {
      await manager.addMachine({ name: "Online1", type: "local" });
      await manager.addMachine({ name: "Online2", type: "local" });

      const online = manager.getOnlineMachines();
      expect(online).toHaveLength(2);
    });

    it("should update machine status", async () => {
      await manager.addMachine({ name: "StatusTest", type: "local" });

      manager.updateMachineStatus("machine-statustest", "offline");

      const machine = manager.getMachine("machine-statustest");
      expect(machine?.status).toBe("offline");
    });
  });

  describe("configuration", () => {
    it("should use default runners", async () => {
      const machine = await manager.addMachine({
        name: "DefaultRunners",
        type: "local",
      });

      expect(machine.runners).toEqual(["heavy"]);
    });

    it("should use custom runners", async () => {
      const machine = await manager.addMachine({
        name: "CustomRunners",
        type: "local",
        runners: ["light", "remote"],
      });

      expect(machine.runners).toEqual(["light", "remote"]);
    });

    it("should use default maxAgents", async () => {
      const machine = await manager.addMachine({
        name: "DefaultAgents",
        type: "local",
      });

      expect(machine.maxAgents).toBe(4);
    });

    it("should use custom maxAgents", async () => {
      const machine = await manager.addMachine({
        name: "CustomAgents",
        type: "local",
        maxAgents: 8,
      });

      expect(machine.maxAgents).toBe(8);
    });
  });

  describe("lifecycle", () => {
    it("should stop without error", () => {
      expect(() => manager.stop()).not.toThrow();
    });

    it("should stop health check interval", () => {
      manager.stop();
      // No error means success
    });
  });
});
