/**
 * Lane-to-machine mapper tests
 */
import { describe, it, expect, beforeEach } from "vitest";
import { LaneMachineMapper, validateLaneConfig } from "./mapper.js";
import type { MachineConfig, MachineHealthResult } from "../../shared/types.js";

describe("LaneMachineMapper", () => {
  let mapper: LaneMachineMapper;

  const machines: Record<string, MachineConfig> = {
    mac: { name: "Mac", type: "local", runners: ["heavy", "light"] },
    mini: { name: "Mini", type: "local", runners: ["light"] },
    "build-server": {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    },
    server: {
      name: "Server",
      type: "ssh",
      host: "198.51.100.20",
      user: "admin",
      key: "~/.ssh/example_key",
      runners: ["heavy"], // Another heavy runner
    },
  };

  const allOnline: Map<string, MachineHealthResult> = new Map([
    ["mac", { machineId: "mac", up: true, checkedAt: "" }],
    ["mini", { machineId: "mini", up: true, checkedAt: "" }],
    ["build-server", { machineId: "build-server", up: true, checkedAt: "" }],
    ["server", { machineId: "server", up: true, checkedAt: "" }],
  ]);

  beforeEach(() => {
    mapper = new LaneMachineMapper();
  });

  describe("selectMachine", () => {
    it("returns undefined for lane with no machines", () => {
      const result = mapper.selectMachine("heavy", {}, allOnline);
      expect(result).toBeUndefined();
    });

    it("returns the only machine for a single-machine lane", () => {
      const result = mapper.selectMachine("remote", machines, allOnline);
      expect(result).toBe("build-server");
    });

    it("returns a machine for multi-machine lane", () => {
      const result = mapper.selectMachine("heavy", machines, allOnline);
      // Should return either mac or server
      expect(["mac", "server"]).toContain(result);
    });

    it("uses round-robin for multiple calls", () => {
      const results: string[] = [];

      // Call multiple times
      for (let i = 0; i < 4; i++) {
        const result = mapper.selectMachine("heavy", machines, allOnline);
        if (result) results.push(result);
      }

      // Should alternate between mac and server
      expect(results.length).toBe(4);
      expect(results[0]).not.toBe(results[1]); // Different machines
      expect(results[0]).toBe(results[2]); // Same pattern repeats
      expect(results[1]).toBe(results[3]);
    });

    it("round-robin skips offline machines", () => {
      const partialOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        ["mini", { machineId: "mini", up: true, checkedAt: "" }],
        ["build-server", { machineId: "build-server", up: true, checkedAt: "" }],
        ["server", { machineId: "server", up: false, checkedAt: "", error: "down" }],
      ]);

      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = mapper.selectMachine("heavy", machines, partialOnline);
        if (result) results.push(result);
      }

      // Only mac is available for heavy (server is offline)
      expect(results).toEqual(["mac", "mac", "mac"]);
    });

    it("returns undefined when all machines for lane are offline", () => {
      const allOffline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: false, checkedAt: "", error: "down" }],
        ["server", { machineId: "server", up: false, checkedAt: "", error: "down" }],
      ]);

      const result = mapper.selectMachine("heavy", machines, allOffline);
      expect(result).toBeUndefined();
    });
  });

  describe("getMachinesForLane", () => {
    it("returns all online machines for a lane", () => {
      const result = mapper.getMachinesForLane("light", machines, allOnline);

      expect(result).toContain("mac");
      expect(result).toContain("mini");
      expect(result).not.toContain("build-server"); // build-server doesn't handle light
      expect(result).not.toContain("server"); // server doesn't handle light
    });

    it("excludes offline machines", () => {
      const partialOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        ["mini", { machineId: "mini", up: false, checkedAt: "", error: "down" }],
      ]);

      const result = mapper.getMachinesForLane("light", machines, partialOnline);

      expect(result).toContain("mac");
      expect(result).not.toContain("mini");
    });

    it("returns empty array for unconfigured lane", () => {
      const result = mapper.getMachinesForLane(
        "nonexistent" as any,
        machines,
        allOnline
      );
      expect(result).toEqual([]);
    });
  });

  describe("getUncoveredLanes", () => {
    it("returns empty array when all lanes have online machines", () => {
      const result = mapper.getUncoveredLanes(machines, allOnline);
      expect(result).toEqual([]);
    });

    it("returns lanes with no online machines", () => {
      const onlyLocalOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        ["mini", { machineId: "mini", up: true, checkedAt: "" }],
        ["build-server", { machineId: "build-server", up: false, checkedAt: "", error: "down" }],
        ["server", { machineId: "server", up: true, checkedAt: "" }],
      ]);

      const result = mapper.getUncoveredLanes(machines, onlyLocalOnline);

      // 'remote' is only handled by build-server, which is offline
      expect(result).toContain("remote");
    });

    it("handles machines with no runners", () => {
      const machinesNoRunners: Record<string, MachineConfig> = {
        mac: { name: "Mac", type: "local", runners: [] },
      };

      const result = mapper.getUncoveredLanes(machinesNoRunners, allOnline);

      // No lanes declared, so no uncovered lanes
      expect(result).toEqual([]);
    });
  });

  describe("reset", () => {
    it("resets round-robin state", () => {
      // Advance round-robin
      mapper.selectMachine("heavy", machines, allOnline);
      mapper.selectMachine("heavy", machines, allOnline);

      // Reset
      mapper.reset();

      // Should start from beginning again
      const first = mapper.selectMachine("heavy", machines, allOnline);
      mapper.reset();
      const afterReset = mapper.selectMachine("heavy", machines, allOnline);

      expect(first).toBe(afterReset);
    });
  });
});

describe("validateLaneConfig", () => {
  it("returns valid for well-configured machines", () => {
    const machines: Record<string, MachineConfig> = {
      mac: { name: "Mac", type: "local", runners: ["heavy"] },
      "build-server": {
        name: "Build Server",
        type: "ssh",
        host: "h",
        user: "u",
        key: "k",
        runners: ["remote"],
      },
    };

    const result = validateLaneConfig(machines);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("warns about machines with no runners", () => {
    const machines: Record<string, MachineConfig> = {
      mac: { name: "Mac", type: "local", runners: [] },
    };

    const result = validateLaneConfig(machines);

    expect(result.valid).toBe(true); // Still valid, just a warning
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("no runners");
  });

  it("handles empty machines config", () => {
    const result = validateLaneConfig({});

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("allows duplicate lanes (multiple machines handling same lane)", () => {
    const machines: Record<string, MachineConfig> = {
      mac: { name: "Mac", type: "local", runners: ["heavy"] },
      server: {
        name: "Server",
        type: "ssh",
        host: "h",
        user: "u",
        key: "k",
        runners: ["heavy"],
      },
    };

    const result = validateLaneConfig(machines);

    // Duplicate lanes are allowed and often desirable
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
