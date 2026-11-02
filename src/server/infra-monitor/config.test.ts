/**
 * The `infra_monitor:` block: defaults, refusals and the re-queue argv.
 */
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../shared/types.js";
import { actBlockedReason, buildRequeueArgv, parseInfraMonitorConfig, type InfraMonitorSettings } from "./config.js";

const valid = {
  enabled: true,
  mode: "act",
  machines: {
    local: { probes: [["/usr/local/bin/docker", "info", "--format", "{{.ServerVersion}}"]] },
    laptop: { probes: [{ argv: ["/usr/bin/ssh", "-o", "ConnectTimeout=5", "dev@host", "echo", "ok"], expect: "ok" }] },
  },
  lanes: {
    heavy: { machine: "local" },
    remote: { machine: "laptop", slots: 2, runner_pid_files: ["runner-remote.pid", "runner-remote2.pid"], requeue_to: ["heavy"] },
  },
  requeue_cmd: ["/opt/gates/requeue.sh", "{id}", "{from}", "{to}"],
};

function settings(raw: unknown): InfraMonitorSettings {
  const parsed = parseInfraMonitorConfig(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.settings;
}

function errors(raw: unknown): string[] {
  const parsed = parseInfraMonitorConfig(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseInfraMonitorConfig", () => {
  it("is off and in observe mode by default", () => {
    expect(settings(undefined)).toMatchObject({ enabled: false, mode: "observe", intervalSeconds: 60, downThresholdSeconds: 120, requeueCmd: null });
    expect(settings({})).toMatchObject({ enabled: false, mode: "observe" });
  });

  it("parses machines (probe argv, or argv with expect) and lanes", () => {
    const s = settings(valid);
    expect(s.machines).toEqual([
      { id: "local", probes: [{ argv: ["/usr/local/bin/docker", "info", "--format", "{{.ServerVersion}}"], expect: null }], startGraceSeconds: 120 },
      { id: "laptop", probes: [{ argv: ["/usr/bin/ssh", "-o", "ConnectTimeout=5", "dev@host", "echo", "ok"], expect: "ok" }], startGraceSeconds: 120 },
    ]);
    expect(s.lanes).toEqual([
      { name: "heavy", machine: "local", slots: 1, runnerPidFiles: [], requeueTo: [] },
      { name: "remote", machine: "laptop", slots: 2, runnerPidFiles: ["runner-remote.pid", "runner-remote2.pid"], requeueTo: ["heavy"] },
    ]);
  });

  it("refuses an enabled block that watches nothing", () => {
    expect(errors({ enabled: true })).toEqual(["infra_monitor.lanes: name at least one lane and its machine, or the monitor watches nothing"]);
  });

  it("refuses a machine with no probe: it would count as up", () => {
    expect(errors({ ...valid, machines: { ...valid.machines, local: { probes: [] } } })[0]).toContain("infra_monitor.machines.local.probes");
  });

  it("refuses a lane on an unknown machine and a requeue_to that is unknown or itself", () => {
    const out = errors({
      ...valid,
      lanes: { heavy: { machine: "cloud" }, remote: { machine: "laptop", requeue_to: ["remote", "quick"] } },
    });
    expect(out).toEqual([
      'infra_monitor.lanes.heavy.machine: no machine "cloud" under infra_monitor.machines',
      "infra_monitor.lanes.remote.requeue_to: a lane can't re-queue to itself",
      'infra_monitor.lanes.remote.requeue_to: no lane "quick" under infra_monitor.lanes',
    ]);
  });

  it("refuses unknown keys, out-of-range numbers and a program starting with '-'", () => {
    expect(errors({ ...valid, probe_cmd: ["ssh"] })[0]).toContain("Unrecognized key");
    expect(errors({ ...valid, interval_seconds: 5 })[0]).toContain("infra_monitor.interval_seconds");
    expect(errors({ ...valid, probe_timeout_seconds: 0 })[0]).toContain("infra_monitor.probe_timeout_seconds");
    expect(errors({ ...valid, machines: { local: { probes: [["-rf"]] } }, lanes: { heavy: { machine: "local" } } })[0]).toContain("must not start with '-'");
    expect(errors({ ...valid, lanes: { heavy: { machine: "local", runner_pid_files: ["../x.pid"] } } })[0]).toContain("runner_pid_files");
  });

  it("checks requeue_cmd's placeholders", () => {
    expect(errors({ ...valid, requeue_cmd: ["/x", "{id}", "{to}", "{host}"] })).toEqual([
      "infra_monitor.requeue_cmd: unknown placeholder {host} (allowed: {id}, {from}, {to})",
    ]);
    expect(errors({ ...valid, requeue_cmd: ["{to}", "{id}"] })).toContain("infra_monitor.requeue_cmd: the program can't be a placeholder");
    expect(errors({ ...valid, requeue_cmd: ["/x", "{id}"] })).toEqual(["infra_monitor.requeue_cmd: must pass {id} and {to}"]);
  });
});

describe("buildRequeueArgv", () => {
  it("fills each placeholder once, as one argument, never interpreting the value", () => {
    expect(buildRequeueArgv(["/x", "--id={id}", "{from}", "{to}"], { id: "g$&{to}", from: "remote", to: "heavy" })).toEqual({
      argv: ["/x", "--id=g$&{to}", "remote", "heavy"],
    });
  });

  it("refuses a value that would become an option", () => {
    expect(buildRequeueArgv(["/x", "{id}", "{to}"], { id: "-rf", from: "a", to: "b" })).toEqual({
      error: 'requeue_cmd: the value in "{id}" starts with "-" and would be read as an option',
    });
  });
});

describe("actBlockedReason", () => {
  const config = { read_only: false } as ProjectConfig;
  it("acts only in act mode on a project that is not read_only", () => {
    expect(actBlockedReason(config, settings(valid))).toBeNull();
    expect(actBlockedReason(config, settings({ ...valid, mode: "observe" }))).toContain("observe");
    expect(actBlockedReason({ read_only: true } as ProjectConfig, settings(valid))).toBe("the project is read_only");
  });
});
