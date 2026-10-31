/**
 * Tests for infra monitor configuration parsing.
 */
import { describe, expect, it } from "vitest";
import { parseInfraMonitorConfig, buildArgv, actBlockedReason } from "./config.js";
import type { ProjectConfig } from "../../shared/types.js";

describe("parseInfraMonitorConfig", () => {
  it("returns defaults when config is undefined", () => {
    const result = parseInfraMonitorConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toMatchObject({
        enabled: false,
        mode: "observe",
        intervalSeconds: 60,
        downThresholdSeconds: 120,
        probeCmd: null,
        probeTimeoutSeconds: 10,
        requeueCmd: null,
        requeueTimeoutSeconds: 30,
      });
    }
  });

  it("returns defaults when config is null", () => {
    const result = parseInfraMonitorConfig(null);
    expect(result.ok).toBe(true);
  });

  it("parses enabled: true", () => {
    const result = parseInfraMonitorConfig({ enabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.enabled).toBe(true);
    }
  });

  it("parses mode: act", () => {
    const result = parseInfraMonitorConfig({ mode: "act" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.mode).toBe("act");
    }
  });

  it("rejects invalid mode", () => {
    const result = parseInfraMonitorConfig({ mode: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("infra_monitor.mode must be 'observe' or 'act'");
    }
  });

  it("parses interval_seconds", () => {
    const result = parseInfraMonitorConfig({ interval_seconds: 120 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.intervalSeconds).toBe(120);
    }
  });

  it("rejects interval_seconds out of range", () => {
    const tooLow = parseInfraMonitorConfig({ interval_seconds: 5 });
    expect(tooLow.ok).toBe(false);

    const tooHigh = parseInfraMonitorConfig({ interval_seconds: 5000 });
    expect(tooHigh.ok).toBe(false);
  });

  it("parses probe_cmd", () => {
    const result = parseInfraMonitorConfig({
      probe_cmd: ["ssh", "-o", "ConnectTimeout=5", "{machine}", "echo", "ok"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.probeCmd).toEqual(["ssh", "-o", "ConnectTimeout=5", "{machine}", "echo", "ok"]);
    }
  });

  it("rejects probe_cmd with dangerous characters", () => {
    const result = parseInfraMonitorConfig({
      probe_cmd: ["sh", "-c", "echo $HOME"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("forbidden shell metacharacters");
    }
  });

  it("rejects non-array probe_cmd", () => {
    const result = parseInfraMonitorConfig({ probe_cmd: "ping {machine}" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("infra_monitor.probe_cmd must be an array");
    }
  });

  it("rejects empty probe_cmd array", () => {
    const result = parseInfraMonitorConfig({ probe_cmd: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("infra_monitor.probe_cmd must have at least one element");
    }
  });

  it("parses requeue_cmd", () => {
    const result = parseInfraMonitorConfig({
      requeue_cmd: ["./bin/requeue", "{gate}", "{from_lane}", "{to_lane}"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.requeueCmd).toEqual(["./bin/requeue", "{gate}", "{from_lane}", "{to_lane}"]);
    }
  });

  it("rejects non-object config", () => {
    const result = parseInfraMonitorConfig("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("infra_monitor must be an object");
    }
  });

  it("collects multiple errors", () => {
    const result = parseInfraMonitorConfig({
      enabled: "yes",
      mode: "maybe",
      interval_seconds: "fast",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});

describe("buildArgv", () => {
  it("replaces placeholders", () => {
    const result = buildArgv(["ssh", "{machine}", "echo", "ok"], { machine: "build-server" });
    expect(result).toEqual({ argv: ["ssh", "build-server", "echo", "ok"] });
  });

  it("replaces multiple placeholders", () => {
    const result = buildArgv(
      ["./bin/requeue", "{gate}", "{from_lane}", "{to_lane}"],
      { gate: "20260302T110000Z-fix-abc-101", from_lane: "heavy", to_lane: "light" }
    );
    expect(result).toEqual({
      argv: ["./bin/requeue", "20260302T110000Z-fix-abc-101", "heavy", "light"],
    });
  });

  it("fails on unreplaced placeholder", () => {
    const result = buildArgv(["ssh", "{machine}", "{unknown}"], { machine: "host" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("{unknown}");
    }
  });

  it("fails when command starts with option", () => {
    const result = buildArgv(["-option", "value"], {});
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("must not start with an option");
    }
  });
});

describe("actBlockedReason", () => {
  const baseConfig: ProjectConfig = {
    name: "Test",
    repo: "/tmp/test",
    github: "example/test",
    queue_file: "/tmp/queue.md",
    agents_dir: "/tmp/agents",
    gates_dir: "/tmp/gates",
    machines: {},
  };

  it("returns null when act is allowed", () => {
    const result = actBlockedReason(baseConfig, {
      enabled: true,
      mode: "act",
      intervalSeconds: 60,
      downThresholdSeconds: 120,
      probeCmd: null,
      probeTimeoutSeconds: 10,
      requeueCmd: ["./bin/requeue"],
      requeueTimeoutSeconds: 30,
    });
    expect(result).toBeNull();
  });

  it("blocks when project is read_only", () => {
    const result = actBlockedReason(
      { ...baseConfig, read_only: true },
      {
        enabled: true,
        mode: "act",
        intervalSeconds: 60,
        downThresholdSeconds: 120,
        probeCmd: null,
        probeTimeoutSeconds: 10,
        requeueCmd: ["./bin/requeue"],
        requeueTimeoutSeconds: 30,
      }
    );
    expect(result).toContain("read_only");
  });

  it("blocks when mode is observe", () => {
    const result = actBlockedReason(baseConfig, {
      enabled: true,
      mode: "observe",
      intervalSeconds: 60,
      downThresholdSeconds: 120,
      probeCmd: null,
      probeTimeoutSeconds: 10,
      requeueCmd: ["./bin/requeue"],
      requeueTimeoutSeconds: 30,
    });
    expect(result).toContain("observe");
  });

  it("blocks when requeue_cmd is not configured", () => {
    const result = actBlockedReason(baseConfig, {
      enabled: true,
      mode: "act",
      intervalSeconds: 60,
      downThresholdSeconds: 120,
      probeCmd: null,
      probeTimeoutSeconds: 10,
      requeueCmd: null,
      requeueTimeoutSeconds: 30,
    });
    expect(result).toContain("requeue_cmd");
  });
});
