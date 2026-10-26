/**
 * Machine health checker tests
 *
 * Tests caching logic and result handling (no actual SSH connections)
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MachineHealthChecker,
  checkAllMachines,
  getOnlineMachinesForLane,
} from "./health.js";
import type { MachineConfig, MachineHealthResult } from "../../shared/types.js";

describe("MachineHealthChecker", () => {
  let checker: MachineHealthChecker;

  beforeEach(() => {
    checker = new MachineHealthChecker(1000); // 1 second cache for testing
  });

  describe("local machines", () => {
    it("always returns up for local machines", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      const result = await checker.check("mac", machine);

      expect(result.machineId).toBe("mac");
      expect(result.up).toBe(true);
      expect(result.checkedAt).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("returns cached result for local machines", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      const result1 = await checker.check("mac", machine);
      const result2 = await checker.check("mac", machine);

      // Same timestamp = cached result
      expect(result2.checkedAt).toBe(result1.checkedAt);
    });
  });

  describe("SSH machines with invalid config", () => {
    it("returns error for SSH machine missing host", async () => {
      const machine: MachineConfig = {
        name: "Build Server",
        type: "ssh",
        user: "deploy",
        key: "~/.ssh/example_key",
        runners: ["remote"],
      };

      const result = await checker.check("build-server", machine);

      expect(result.up).toBe(false);
      expect(result.error).toContain("Invalid SSH configuration");
    });

    it("returns error for SSH machine missing user", async () => {
      const machine: MachineConfig = {
        name: "Build Server",
        type: "ssh",
        host: "198.51.100.10",
        key: "~/.ssh/example_key",
        runners: ["remote"],
      };

      const result = await checker.check("build-server", machine);

      expect(result.up).toBe(false);
      expect(result.error).toContain("Invalid SSH configuration");
    });

    it("returns error for SSH machine missing key", async () => {
      const machine: MachineConfig = {
        name: "Build Server",
        type: "ssh",
        host: "198.51.100.10",
        user: "deploy",
        runners: ["remote"],
      };

      const result = await checker.check("build-server", machine);

      expect(result.up).toBe(false);
      expect(result.error).toContain("Invalid SSH configuration");
    });
  });

  describe("caching", () => {
    it("caches results", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      await checker.check("mac", machine);
      const cached = checker.getCached("mac");

      expect(cached).toBeDefined();
      expect(cached?.up).toBe(true);
    });

    it("returns undefined for non-cached machine", () => {
      const cached = checker.getCached("nonexistent");
      expect(cached).toBeUndefined();
    });

    it("invalidates single machine cache", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      await checker.check("mac", machine);
      checker.invalidate("mac");

      const cached = checker.getCached("mac");
      expect(cached).toBeUndefined();
    });

    it("invalidates all caches", async () => {
      const mac: MachineConfig = { name: "Mac", type: "local", runners: ["heavy"] };
      const mini: MachineConfig = { name: "Mini", type: "local", runners: ["light"] };

      await checker.check("mac", mac);
      await checker.check("mini", mini);

      checker.invalidateAll();

      expect(checker.getCached("mac")).toBeUndefined();
      expect(checker.getCached("mini")).toBeUndefined();
    });

    it("expires cache after TTL", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      // Use a very short TTL
      const shortChecker = new MachineHealthChecker(10); // 10ms

      await shortChecker.check("mac", machine);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 20));

      const cached = shortChecker.getCached("mac");
      expect(cached).toBeUndefined();
    });

    it("force refresh bypasses cache", async () => {
      const machine: MachineConfig = {
        name: "Mac",
        type: "local",
        runners: ["heavy"],
      };

      const result1 = await checker.check("mac", machine);

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result2 = await checker.check("mac", machine, true); // force refresh

      // Different timestamps = not cached
      expect(result2.checkedAt).not.toBe(result1.checkedAt);
    });
  });
});

describe("checkAllMachines", () => {
  it("checks all machines in parallel", async () => {
    const machines: Record<string, MachineConfig> = {
      mac: { name: "Mac", type: "local", runners: ["heavy"] },
      mini: { name: "Mini", type: "local", runners: ["light"] },
    };

    const checker = new MachineHealthChecker();
    const results = await checkAllMachines(machines, checker);

    expect(results.size).toBe(2);
    expect(results.get("mac")?.up).toBe(true);
    expect(results.get("mini")?.up).toBe(true);
  });

  it("handles empty machines config", async () => {
    const checker = new MachineHealthChecker();
    const results = await checkAllMachines({}, checker);

    expect(results.size).toBe(0);
  });
});

describe("getOnlineMachinesForLane", () => {
  const machines: Record<string, MachineConfig> = {
    mac: { name: "Mac", type: "local", runners: ["heavy", "light"] },
    mini: { name: "Mini", type: "local", runners: ["light"] },
    "build-server": { name: "Build Server", type: "ssh", host: "198.51.100.10", user: "deploy", key: "~/.ssh/example_key", runners: ["remote"] },
  };

  it("returns machines that handle the lane and are online", () => {
    const healthResults = new Map<string, MachineHealthResult>([
      ["mac", { machineId: "mac", up: true, checkedAt: "" }],
      ["mini", { machineId: "mini", up: true, checkedAt: "" }],
      ["build-server", { machineId: "build-server", up: true, checkedAt: "" }],
    ]);

    const result = getOnlineMachinesForLane(machines, healthResults, "light");

    expect(result).toContain("mac");
    expect(result).toContain("mini");
    expect(result).not.toContain("build-server");
  });

  it("excludes offline machines", () => {
    const healthResults = new Map<string, MachineHealthResult>([
      ["mac", { machineId: "mac", up: true, checkedAt: "" }],
      ["mini", { machineId: "mini", up: false, checkedAt: "", error: "offline" }],
      ["build-server", { machineId: "build-server", up: true, checkedAt: "" }],
    ]);

    const result = getOnlineMachinesForLane(machines, healthResults, "light");

    expect(result).toContain("mac");
    expect(result).not.toContain("mini"); // offline
  });

  it("returns empty array if no machines handle the lane", () => {
    const healthResults = new Map<string, MachineHealthResult>([
      ["mac", { machineId: "mac", up: true, checkedAt: "" }],
    ]);

    const result = getOnlineMachinesForLane(machines, healthResults, "remote");

    // mac doesn't handle 'remote', build-server is not in results
    expect(result).toEqual([]);
  });

  it("returns empty array if all machines for lane are offline", () => {
    const healthResults = new Map<string, MachineHealthResult>([
      ["mac", { machineId: "mac", up: false, checkedAt: "", error: "down" }],
      ["mini", { machineId: "mini", up: false, checkedAt: "", error: "down" }],
    ]);

    const result = getOnlineMachinesForLane(machines, healthResults, "light");

    expect(result).toEqual([]);
  });
});
