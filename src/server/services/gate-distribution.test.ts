/**
 * Gate distribution tests
 *
 * Tests machine selection logic with round-robin and LRU strategies
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GateDistributor, createGateDistributor } from "./gate-distribution.js";
import type { MachineConfig, MachineHealthResult } from "../../shared/types.js";

describe("GateDistributor", () => {
  let distributor: GateDistributor;

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
      runners: ["heavy"],
    },
  };

  const allOnline: Map<string, MachineHealthResult> = new Map([
    ["mac", { machineId: "mac", up: true, checkedAt: "" }],
    ["mini", { machineId: "mini", up: true, checkedAt: "" }],
    ["build-server", { machineId: "build-server", up: true, checkedAt: "" }],
    ["server", { machineId: "server", up: true, checkedAt: "" }],
  ]);

  beforeEach(() => {
    distributor = new GateDistributor("round-robin");
  });

  describe("selectMachineForLane", () => {
    it("returns null for lane with no machines", () => {
      const result = distributor.selectMachineForLane("heavy", {}, allOnline);
      expect(result).toBeNull();
    });

    it("returns the only machine for a single-machine lane", () => {
      const result = distributor.selectMachineForLane(
        "remote",
        machines,
        allOnline,
      );
      expect(result).toBe("build-server");
    });

    it("returns a machine for multi-machine lane", () => {
      const result = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOnline,
      );
      expect(["mac", "server"]).toContain(result);
    });

    it("returns null when all machines for lane are offline", () => {
      const allOffline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: false, checkedAt: "", error: "down" }],
        [
          "server",
          { machineId: "server", up: false, checkedAt: "", error: "down" },
        ],
      ]);

      const result = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOffline,
      );
      expect(result).toBeNull();
    });

    it("uses round-robin for multiple machines", () => {
      const results: string[] = [];

      for (let i = 0; i < 4; i++) {
        const result = distributor.selectMachineForLane(
          "heavy",
          machines,
          allOnline,
        );
        if (result) results.push(result);
      }

      expect(results.length).toBe(4);
      // Should alternate between mac and server
      expect(results[0]).not.toBe(results[1]);
      expect(results[0]).toBe(results[2]);
      expect(results[1]).toBe(results[3]);
    });

    it("skips offline machines in round-robin", () => {
      const partialOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        [
          "server",
          { machineId: "server", up: false, checkedAt: "", error: "down" },
        ],
      ]);

      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = distributor.selectMachineForLane(
          "heavy",
          machines,
          partialOnline,
        );
        if (result) results.push(result);
      }

      // Only mac is available
      expect(results).toEqual(["mac", "mac", "mac"]);
    });
  });

  describe("LRU selection strategy", () => {
    beforeEach(() => {
      distributor = new GateDistributor("lru");
    });

    it("selects least recently used machine", () => {
      // Record some history
      distributor.recordGateStart("server", "heavy");
      distributor.recordGateEnd("server", "heavy");

      // Next selection should prefer mac (never used)
      const result = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOnline,
      );
      expect(result).toBe("mac");
    });

    it("tracks usage per lane", () => {
      // Use mac for heavy
      distributor.recordGateStart("mac", "heavy");
      distributor.recordGateEnd("mac", "heavy");

      // Heavy should now prefer server (mac was just used)
      const heavyResult = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOnline,
      );
      expect(heavyResult).toBe("server");

      // Light lane is independent, should use any available (mac or mini)
      const lightResult = distributor.selectMachineForLane(
        "light",
        machines,
        allOnline,
      );
      expect(["mac", "mini"]).toContain(lightResult);
    });

    it("handles all candidates with same last-use time", () => {
      // Never used any, should still return something
      const result = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOnline,
      );
      expect(["mac", "server"]).toContain(result);
    });

    it("selects oldest-used machine when all have history", () => {
      // Use mac first (older)
      distributor.recordGateStart("mac", "heavy");
      distributor.recordGateEnd("mac", "heavy");

      // Then use server (newer)
      distributor.recordGateStart("server", "heavy");
      distributor.recordGateEnd("server", "heavy");

      // LRU should prefer mac (least recently used = oldest usage)
      const result = distributor.selectMachineForLane(
        "heavy",
        machines,
        allOnline,
      );
      expect(result).toBe("mac");
    });
  });

  describe("recordGateStart and recordGateEnd", () => {
    it("tracks running gate count", () => {
      expect(distributor.getRunningGateCount("mac")).toBe(0);

      distributor.recordGateStart("mac", "heavy");
      expect(distributor.getRunningGateCount("mac")).toBe(1);

      distributor.recordGateStart("mac", "light");
      expect(distributor.getRunningGateCount("mac")).toBe(2);

      distributor.recordGateEnd("mac", "heavy");
      expect(distributor.getRunningGateCount("mac")).toBe(1);

      distributor.recordGateEnd("mac", "light");
      expect(distributor.getRunningGateCount("mac")).toBe(0);
    });
  });

  describe("getMachinesForLane", () => {
    it("returns all online machines for a lane", () => {
      const result = distributor.getMachinesForLane(
        "light",
        machines,
        allOnline,
      );

      expect(result).toContain("mac");
      expect(result).toContain("mini");
      expect(result).not.toContain("build-server");
      expect(result).not.toContain("server");
    });

    it("excludes offline machines", () => {
      const partialOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        [
          "mini",
          { machineId: "mini", up: false, checkedAt: "", error: "down" },
        ],
      ]);

      const result = distributor.getMachinesForLane(
        "light",
        machines,
        partialOnline,
      );

      expect(result).toContain("mac");
      expect(result).not.toContain("mini");
    });
  });

  describe("getUncoveredLanes", () => {
    it("returns empty when all lanes have online machines", () => {
      const result = distributor.getUncoveredLanes(machines, allOnline);
      expect(result).toEqual([]);
    });

    it("returns lanes with no online machines", () => {
      const onlyLocalOnline: Map<string, MachineHealthResult> = new Map([
        ["mac", { machineId: "mac", up: true, checkedAt: "" }],
        ["mini", { machineId: "mini", up: true, checkedAt: "" }],
        [
          "build-server",
          { machineId: "build-server", up: false, checkedAt: "", error: "down" },
        ],
        ["server", { machineId: "server", up: true, checkedAt: "" }],
      ]);

      const result = distributor.getUncoveredLanes(machines, onlyLocalOnline);
      expect(result).toContain("remote");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      distributor.recordGateStart("mac", "heavy");
      distributor.selectMachineForLane("heavy", machines, allOnline);

      distributor.reset();

      expect(distributor.getRunningGateCount("mac")).toBe(0);
    });
  });

  describe("setStrategy and getStrategy", () => {
    it("changes selection strategy", () => {
      expect(distributor.getStrategy()).toBe("round-robin");

      distributor.setStrategy("lru");
      expect(distributor.getStrategy()).toBe("lru");
    });
  });
});

describe("createGateDistributor", () => {
  it("creates distributor with default strategy", () => {
    const distributor = createGateDistributor();
    expect(distributor.getStrategy()).toBe("round-robin");
  });

  it("creates distributor with specified strategy", () => {
    const distributor = createGateDistributor("lru");
    expect(distributor.getStrategy()).toBe("lru");
  });
});
