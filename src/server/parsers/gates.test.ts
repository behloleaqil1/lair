/**
 * Gates parser unit tests
 */
import { describe, it, expect } from "vitest";
import {
  parseGateFilename,
  parseGateTimestamp,
  parseGateRc,
  parseGateLog,
  parseGateFiles,
  groupByLane,
  findDuplicates,
  isStaleRun,
  parseGateSteps,
} from "./gates.js";
import { readFileSync } from "fs";
import { join } from "path";

describe("parseGateTimestamp", () => {
  it("converts gate timestamp to ISO format", () => {
    expect(parseGateTimestamp("20261024T143500Z")).toBe("2026-10-24T14:35:00Z");
  });

  it("returns input if format does not match", () => {
    expect(parseGateTimestamp("invalid")).toBe("invalid");
  });
});

describe("parseGateFilename", () => {
  it("parses queued gate request", () => {
    const filename = "heavy.1.20261024T143500Z-fix-login-abc1234d-12345.req";
    const result = parseGateFilename(filename);

    expect(result).not.toBeNull();
    expect(result!.lane).toBe("heavy");
    expect(result!.priority).toBe(1);
    expect(result!.status).toBe("queued");
    expect(result!.track).toBe("fix-login");
    expect(result!.headSha).toBe("abc1234d");
    expect(result!.id).toBe("20261024T143500Z-fix-login-abc1234d-12345");
    expect(result!.startTime).toBe("2026-10-24T14:35:00Z");
  });

  it("parses running gate request", () => {
    const filename =
      "heavy.1.20261024T143500Z-search-panel-def5678e-23456.req.run";
    const result = parseGateFilename(filename);

    expect(result!.status).toBe("running");
  });

  it("parses superseded gate request", () => {
    const filename =
      "light.5.20261024T143500Z-old-task-abc9101a-34567.req.superseded";
    const result = parseGateFilename(filename);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("superseded");
    expect(result!.lane).toBe("light");
    expect(result!.priority).toBe(5);
  });

  it("parses remote lane", () => {
    const filename =
      "remote.1.20260101T000100Z-example-track-abcdef12-17874.req.run";
    const result = parseGateFilename(filename);

    expect(result!.lane).toBe("remote");
    expect(result!.status).toBe("running");
  });

  it("returns null for invalid format", () => {
    expect(parseGateFilename("not-a-gate.txt")).toBeNull();
    expect(parseGateFilename("random.log")).toBeNull();
  });

  it("takes the lane from the file name: quick and actions lanes too, not a fixed list", () => {
    expect(parseGateFilename("quick.1.20261027T100000Z-lint-fix-beef0001-201.req.run")).toMatchObject({
      lane: "quick",
      priority: 1,
      status: "running",
      track: "lint-fix",
      headSha: "beef0001",
      id: "20261027T100000Z-lint-fix-beef0001-201",
    });
    expect(parseGateFilename("actions.2.20261027T101000Z-e2e-cafe0001-301.req")).toMatchObject({
      lane: "actions",
      status: "queued",
      track: "e2e",
    });
    expect(parseGateFilename("nightly_2.0.20261027T101000Z-e2e-cafe0001-301.req")?.lane).toBe("nightly_2");
  });

  it("shows another suffix as the status it names, and skips files that are not requests", () => {
    const status = (name: string) => parseGateFilename(name)?.status;
    expect(status("actions.2.20261027T101100Z-e2e-cafe0002-302.req.stuck")).toBe("stuck");
    expect(status("light.4.20261027T081000Z-stacked-dead0002-402.req.deferred-stacked")).toBe("deferred-stacked");
    expect(status("light.5.20261027T080000Z-old-work-dead0001-401.req.superseded")).toBe("superseded");
    for (const name of [
      "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.log",
      "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.lock",
      "quick.1.20261027T100000Z-lint-fix-beef0001-201.log",
      "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.Run",
      "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.run.log",
    ]) {
      expect(parseGateFilename(name), name).toBeNull();
    }
  });

  it("refuses unsafe lane names and ids, and over-long names", () => {
    for (const name of [
      "9lane.1.20261027T100000Z-t-abcd0001-1.req",
      "-x.1.20261027T100000Z-t-abcd0001-1.req",
      "a b.1.20261027T100000Z-t-abcd0001-1.req",
      `${"l".repeat(33)}.1.20261027T100000Z-t-abcd0001-1.req`,
      "quick.x.20261027T100000Z-t-abcd0001-1.req",
      "quick.1..hidden.req",
      "quick.1.-rf.req",
      `quick.1.${"a".repeat(300)}.req`,
    ]) {
      expect(parseGateFilename(name), name).toBeNull();
    }
  });

  it("keeps a request whose id has another form, without track or sha", () => {
    expect(parseGateFilename("quick.3.manual-check-7.req")).toEqual({
      id: "manual-check-7",
      lane: "quick",
      priority: 3,
      status: "queued",
    });
  });

  it("handles full path", () => {
    const filename =
      "/path/to/queue/heavy.1.20261024T143500Z-fix-login-abc1234d-12345.req";
    const result = parseGateFilename(filename);

    expect(result).not.toBeNull();
    expect(result!.track).toBe("fix-login");
  });
});

describe("parseGateRc", () => {
  it("parses rc value", () => {
    expect(parseGateRc("0")).toBe(0);
    expect(parseGateRc("1")).toBe(1);
    expect(parseGateRc("  0\n")).toBe(0);
  });

  it("returns null for invalid rc", () => {
    expect(parseGateRc("")).toBeNull();
    expect(parseGateRc("not a number")).toBeNull();
  });
});

describe("parseGateLog", () => {
  it("extracts passed steps", () => {
    const content = `STEP commitlint: PASS (2s)
STEP gitleaks: PASS (15s)
STEP semgrep: PASS (90s)`;

    const result = parseGateLog(content);

    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toEqual({ name: "commitlint", status: "PASS" });
    expect(result.steps[1]).toEqual({ name: "gitleaks", status: "PASS" });
    expect(result.failedSteps).toHaveLength(0);
  });

  it("extracts failed steps", () => {
    const content = `STEP commitlint: PASS (2s)
STEP verify-backend: FAIL (240s)
== FAILED STEPS: verify-backend(rc=1)`;

    const result = parseGateLog(content);

    expect(result.failedSteps).toContain("verify-backend");
    expect(result.steps.find((s) => s.name === "verify-backend")?.status).toBe(
      "FAIL",
    );
  });

  it("extracts current running step", () => {
    const content = `STEP commitlint: PASS (2s)
STEP verify-backend: running`;

    const result = parseGateLog(content);
    expect(result.currentStep).toBe("verify-backend");
  });

  it("handles skipped steps", () => {
    const content =
      "STEP commitlint: SKIPPED (passed in the runner's preflight on this tree)";
    const result = parseGateLog(content);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("SKIPPED");
  });
});

describe("parseGateFiles", () => {
  it("parses and sorts gate files by priority", () => {
    const files = [
      "heavy.5.20261024T143500Z-task-c-abc12345-11111.req",
      "heavy.1.20261024T143500Z-task-b-def67890-22222.req",
      "heavy.3.20261024T143500Z-task-d-abc11111-33333.req",
    ];

    const gates = parseGateFiles(files);

    expect(gates).toHaveLength(3);
    expect(gates[0].priority).toBe(1);
    expect(gates[1].priority).toBe(3);
    expect(gates[2].priority).toBe(5);
  });

  it("skips invalid filenames", () => {
    const files = [
      "heavy.1.20261024T143500Z-task-abc12345-11111.req",
      "not-a-gate.txt",
      "README.md",
    ];

    const gates = parseGateFiles(files);
    expect(gates).toHaveLength(1);
  });
});

describe("groupByLane", () => {
  it("groups gates by lane", () => {
    const gates = [
      { lane: "heavy", id: "1" },
      { lane: "light", id: "2" },
      { lane: "heavy", id: "3" },
      { lane: "remote", id: "4" },
    ] as any;

    const grouped = groupByLane(gates);

    expect(grouped.heavy).toHaveLength(2);
    expect(grouped.light).toHaveLength(1);
    expect(grouped.remote).toHaveLength(1);
  });

  it("has one group per lane the gates name: heavy, light, remote first, then the others by name", () => {
    const gates = [
      { lane: "quick", id: "1" },
      { lane: "heavy", id: "2" },
      { lane: "actions", id: "3" },
      { lane: "quick", id: "4" },
    ] as any;

    const grouped = groupByLane(gates);

    expect(Object.keys(grouped)).toEqual(["heavy", "actions", "quick"]);
    expect(grouped.quick.map((g) => g.id)).toEqual(["1", "4"]);
    expect(grouped.light).toBeUndefined();
  });
});

describe("findDuplicates", () => {
  it("finds gates with same track", () => {
    const gates = [
      { track: "fix-login", status: "queued", id: "1" },
      { track: "fix-login", status: "queued", id: "2" },
      { track: "other-task", status: "queued", id: "3" },
    ] as any;

    const duplicates = findDuplicates(gates);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveLength(2);
  });

  it("ignores non-queued gates", () => {
    const gates = [
      { track: "fix-login", status: "queued", id: "1" },
      { track: "fix-login", status: "running", id: "2" },
    ] as any;

    const duplicates = findDuplicates(gates);
    expect(duplicates).toHaveLength(0);
  });
});

describe("isStaleRun", () => {
  it("returns false for non-running gates", () => {
    expect(isStaleRun({ status: "queued" } as any)).toBe(false);
    expect(isStaleRun({ status: "completed" } as any)).toBe(false);
  });

  it("returns false for recent running gates", () => {
    const recentTime = new Date().toISOString();
    expect(
      isStaleRun({ status: "running", startTime: recentTime } as any),
    ).toBe(false);
  });

  it("returns true for old running gates", () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    expect(isStaleRun({ status: "running", startTime: oldTime } as any)).toBe(
      true,
    );
  });

  it("uses custom max age", () => {
    const oldTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    expect(
      isStaleRun({ status: "running", startTime: oldTime } as any, 1800),
    ).toBe(false); // 30 min = 1800s, so not stale yet
    expect(
      isStaleRun({ status: "running", startTime: oldTime } as any, 1700),
    ).toBe(true); // 1700s threshold, 30 min > that
  });
});

describe("parseGateSteps", () => {
  const fixture = (name: string) => readFileSync(join(process.cwd(), "fixtures", name), "utf-8");

  it("reads each step's result and duration, the running step, and the commit the gate tested", () => {
    const log = parseGateSteps(fixture("gate-log.txt"));
    expect(log.steps.map((s) => [s.name, s.state, s.durationSeconds])).toEqual([
      ["security-guard", "passed", 24],
      ["pre-commit", "passed", 120],
      ["commitlint", "passed", 2],
      ["backend-lint", "passed", 9],
      ["backend-typecheck", "passed", 45],
      ["gitleaks", "passed", 15],
      ["semgrep", "passed", 90],
      ["verify-backend", "running", null],
    ]);
    expect(log.currentStep).toBe("verify-backend");
    expect(log.failedSteps).toEqual([]);
    expect(log).toMatchObject({ sha: "abc1234d", base: "def5678e", startedAt: "2026-10-24T14:35:00Z" });
  });

  it("marks failed steps with their exit code, and reads the lane and track", () => {
    const log = parseGateSteps(fixture("gate-log-failed.txt"));
    expect(log.failedSteps).toEqual(["verify-backend"]);
    expect(log.steps.find((s) => s.name === "verify-backend")).toEqual({
      name: "verify-backend",
      state: "failed",
      durationSeconds: 240,
      exitCode: 1,
    });
    // The fixture's commit is not hexadecimal, so it is not taken for a sha
    expect(log).toMatchObject({ lane: "heavy", track: "api-tests", sha: null });
    expect(log.currentStep).toBeNull();
  });

  it("reads table rows and other units, and stays bounded on hostile input", () => {
    const log = parseGateSteps(["  unit-tests      90ms  PASS", "  e2e   2min  FAIL", "STEP slow: TIMED OUT (5m)"].join("\n"));
    expect(log.steps).toEqual([
      { name: "unit-tests", state: "passed", durationSeconds: 0.09 },
      { name: "e2e", state: "failed", durationSeconds: 120 },
      { name: "slow", state: "timed_out", durationSeconds: 300 },
    ]);
    const hostile = parseGateSteps(
      [`STEP ${"a".repeat(5000)}: PASS (1s)`, ...Array.from({ length: 500 }, (_, i) => `STEP s${i}: PASS (1s)`)].join("\n"),
    );
    expect(hostile.steps.length).toBe(200);
    expect(hostile.steps.every((s) => s.name.length <= 100)).toBe(true);
  });
});
