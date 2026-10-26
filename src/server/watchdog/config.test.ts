import { describe, expect, it } from "vitest";
import { actBlockedReason, agentMatcher, parseWatchdogConfig, placeholdersIn } from "./config.js";
import { buildArgv } from "./executors.js";
import { failureSignature, normaliseFailure } from "./detectors.js";
import type { ProjectConfig } from "../../shared/types.js";

function errorsOf(raw: unknown): string[] {
  const parsed = parseWatchdogConfig(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseWatchdogConfig", () => {
  it("is off and in observe mode by default", () => {
    const parsed = parseWatchdogConfig(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toMatchObject({
      enabled: false,
      mode: "observe",
      intervalSeconds: 60,
      hungMinutes: 45,
      idleMinutes: 10,
      stallHours: 4,
      infraMinTracks: 3,
      reescalateMinutes: 60,
      dockerCmd: ["docker"],
      locks: [],
      containers: [],
      actions: {},
    });
    expect(Object.values(parsed.settings.playbooks).every((p) => p.act === false)).toBe(true);
    expect(parsed.settings.playbooks.agent_stuck).toEqual({
      act: false,
      maxAttempts: 2,
      cooldownMinutes: 10,
      verifyDelaySeconds: 30,
    });
  });

  it("applies per-playbook settings and lock/container defaults", () => {
    const parsed = parseWatchdogConfig({
      enabled: true,
      mode: "act",
      locks: [{ name: "gate-lock", path: "/tmp/x.lock" }],
      containers: [{ name: "api" }],
      actions: { restart_agent: ["./restart", "{agent}"] },
      playbooks: { agent_stuck: { act: true, max_attempts: 3, cooldown_minutes: 1 } },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.locks).toEqual([
      { name: "gate-lock", path: "/tmp/x.lock", pidFile: "pid", leaseMinutes: 30 },
    ]);
    expect(parsed.settings.containers).toEqual([{ name: "api", maxRestarts: 3, windowMinutes: 10 }]);
    expect(parsed.settings.playbooks.agent_stuck).toEqual({
      act: true,
      maxAttempts: 3,
      cooldownMinutes: 1,
      verifyDelaySeconds: 30,
    });
  });

  it("rejects unknown keys, bad modes and bad types", () => {
    expect(errorsOf({ enabeld: true })[0]).toContain("enabeld");
    expect(errorsOf({ mode: "fix-everything" })[0]).toContain("watchdog.mode");
    expect(errorsOf({ actions: { kill_all: ["kill"] } })[0]).toContain("kill_all");
    expect(errorsOf({ actions: { break_lock: "rm -rf {lock}" } })[0]).toContain("watchdog.actions.break_lock");
    expect(errorsOf({ disabled_detectors: ["nope"] })[0]).toContain("disabled_detectors");
  });

  it("requires the action of every playbook opted in to act", () => {
    expect(errorsOf({ playbooks: { stale_lock: { act: true } } })).toEqual([
      "watchdog.playbooks.stale_lock.act is true but watchdog.actions.break_lock is not set",
    ]);
  });

  it("rejects placeholders an action does not provide", () => {
    expect(errorsOf({ actions: { break_lock: ["./break", "{agent}"] } })[0]).toContain(
      "watchdog.actions.break_lock: unknown placeholder {agent}",
    );
    expect(errorsOf({ actions: { break_lock: ["./break", "{lock}", "{project}"] } })).toEqual([]);
  });

  it("checks agent_command", () => {
    expect(errorsOf({ agent_command: "agent-cli run" })).toEqual([
      "watchdog.agent_command: must contain {agent}",
    ]);
    expect(errorsOf({ agent_command: "agent-cli (--agent {agent}" })[0]).toContain(
      "not a valid regular expression",
    );
  });

  it("rejects duplicate lock names", () => {
    expect(
      errorsOf({
        locks: [
          { name: "a", path: "/tmp/1" },
          { name: "a", path: "/tmp/2" },
        ],
      }),
    ).toEqual(["watchdog.locks: duplicate lock name a"]);
  });
});

describe("actBlockedReason", () => {
  const config = (readOnly?: boolean) => ({ read_only: readOnly }) as unknown as ProjectConfig;
  it("acts only in act mode on a project that is not read_only", () => {
    const settings = (mode: "observe" | "act") => {
      const parsed = parseWatchdogConfig({ mode });
      if (!parsed.ok) throw new Error(parsed.errors.join());
      return parsed.settings;
    };
    expect(actBlockedReason(config(false), settings("observe"))).toBe("watchdog.mode is observe");
    expect(actBlockedReason(config(true), settings("act"))).toBe("the project is read_only");
    expect(actBlockedReason(config(undefined), settings("act"))).toBeNull();
    expect(actBlockedReason(config(false), settings("act"))).toBeNull();
  });
});

describe("agentMatcher", () => {
  const matcher = agentMatcher("agent-cli .*--agent {agent}", "worker-a");
  it("matches the agent id as a whole word", () => {
    expect(matcher.test("agent-cli chat --agent worker-a")).toBe(true);
    expect(matcher.test("agent-cli chat --agent worker-a --resume")).toBe(true);
    expect(matcher.test("agent-cli chat --agent worker-ab")).toBe(false);
    expect(matcher.test("agent-cli chat --agent xworker-a")).toBe(false);
    expect(matcher.test("other-cli --agent worker-a")).toBe(false);
  });
  it("escapes regex characters in the id", () => {
    expect(agentMatcher("run {agent}", "a.b").test("run aXb")).toBe(false);
  });
});

describe("argv templates", () => {
  it("lists placeholders", () => {
    expect(placeholdersIn(["./x", "{agent}", "--pid={pid}", "{agent}"])).toEqual(["agent", "pid"]);
  });

  it("fills each argument without a shell, and refuses missing values", () => {
    expect(
      buildArgv("restart_agent", ["./restart", "{agent}", "--pid={pid}"], {
        agent: "worker-a",
        pid: "42",
      }),
    ).toEqual({ argv: ["./restart", "worker-a", "--pid=42"] });
    expect(buildArgv("restart_agent", ["./restart", "{log}"], { agent: "worker-a" })).toEqual({
      error: "watchdog.actions.restart_agent: no value for {log}",
    });
    expect(buildArgv("restart_agent", ["./restart", "{gate}"], { gate: "x" })).toEqual({
      error: "watchdog.actions.restart_agent: placeholder {gate} is not allowed",
    });
  });

  it("refuses a value that would turn an argument into an option", () => {
    expect(buildArgv("mark_lane_broken", ["./mark", "{lane}", "{signature}"], { lane: "heavy", signature: "-rf /" })).toEqual({
      error: 'watchdog.actions.mark_lane_broken: the value of {signature} starts with "-" and would be read as an option',
    });
    expect(buildArgv("restart_agent", ["./restart", "{log}"], { log: "--help" })).toMatchObject({
      error: expect.stringContaining("{log}"),
    });
    // A value inside an argument, or after the template's own dash, is data
    expect(
      buildArgv("mark_lane_broken", ["./mark", "--signature={signature}", "x{signature}"], { signature: "-rf" }),
    ).toEqual({ argv: ["./mark", "--signature=-rf", "x-rf"] });
  });
});

describe("failure signatures", () => {
  it("normalises times, hashes, numbers and the gate's own ids", () => {
    expect(
      normaliseFailure("ERROR at 2026-03-02T11:13:05Z in gate 20260302T111000Z-login-fix-abc1234-1 (pid 77, sha 9f8e7d6c)", [
        "20260302T111000Z-login-fix-abc1234-1",
      ]),
    ).toBe("error at <time> in gate <id> (pid <n>, sha <hex>)");
  });

  it("takes the first error line, skipping step summaries and test totals", () => {
    const log = [
      "[gate-run] heavy lane, track: x",
      "STEP build: FAIL (3s)",
      "Tests: 3 failed, 10 passed",
      "BUILD FAILED in 2m",
      "fatal: unable to access remote: Could not resolve host",
      "error: later line",
    ].join("\n");
    expect(failureSignature(log)).toBe("fatal: unable to access remote: could not resolve host");
  });

  it("drops leading dashes, so the text never reads as an option", () => {
    expect(normaliseFailure("--- FAIL: error in TestLogin")).toBe("fail: error in testlogin");
    expect(failureSignature("-- error: --force-reset storage\n")).toBe("error: --force-reset storage");
  });

  it("prefers the result JSON's error, and returns null without an error line", () => {
    expect(failureSignature("ok\n", "No space left on device")).toBe("no space left on device");
    expect(failureSignature("STEP build: FAIL (3s)\n== FAILED STEPS: build(rc=1)\n")).toBeNull();
  });
});
