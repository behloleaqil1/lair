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
} from "./gates.js";

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
