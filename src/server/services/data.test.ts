/**
 * DataService security tests: untrusted file content and request values must
 * never reach a shell or escape gates_dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { DataService, isSafeGateId, parsePidFile } from "./data.js";
import type { ProjectConfig } from "../../shared/types.js";

const TMP = join(process.cwd(), "data", "test-data-service");
const GATES = join(TMP, "gates");
const MARKER = join(TMP, "pwned");

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    repo: TMP,
    github: "",
    queue_file: join(TMP, "queue.md"),
    agents_dir: TMP,
    gates_dir: GATES,
    machines: { local: { name: "Local", type: "local" } },
    ...overrides,
  } as ProjectConfig;
}

beforeEach(() => {
  mkdirSync(join(GATES, "results"), { recursive: true });
  mkdirSync(join(GATES, "queue"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("runner pid files", () => {
  it("never runs shell syntax from a pid file", () => {
    writeFileSync(join(GATES, "runner-heavy.pid"), `1; touch '${MARKER}'\n`);
    const [status] = new DataService(makeConfig()).getMachineStatuses();
    expect(existsSync(MARKER)).toBe(false);
    expect(status.runners).toContainEqual({ lane: "heavy", running: false });
  });

  it("reports a live pid as running", () => {
    writeFileSync(join(GATES, "runner-light.pid"), `${process.pid}\n`);
    const [status] = new DataService(makeConfig()).getMachineStatuses();
    expect(status.runners).toContainEqual({ lane: "light", running: true });
  });

  it("parsePidFile accepts digits only", () => {
    expect(parsePidFile(" 1234\n")).toBe("1234");
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("-1")).toBeNull();
    expect(parsePidFile("12 34")).toBeNull();
    expect(parsePidFile("$(id)")).toBeNull();
    expect(parsePidFile(null)).toBeNull();
  });
});

describe("gate log ids", () => {
  it("refuses ids that would leave gates_dir", () => {
    writeFileSync(join(TMP, "secret.log"), "secret");
    const service = new DataService(makeConfig());
    expect(() => service.getGateLog("../../secret")).toThrow("Invalid gate id");
    expect(() => service.getGateLog("../secret")).toThrow("Invalid gate id");
    expect(() => service.getGateLog("/etc/passwd")).toThrow("Invalid gate id");
  });

  it("still reads a normal gate log", () => {
    writeFileSync(join(GATES, "results", "bt-20261024-001.log"), "ok");
    const service = new DataService(makeConfig());
    expect(service.getGateLog("bt-20261024-001")).toBe("ok");
  });

  it("isSafeGateId", () => {
    expect(isSafeGateId("heavy.1.bt-abc-123")).toBe(true);
    expect(isSafeGateId("..")).toBe(false);
    expect(isSafeGateId("a/b")).toBe(false);
    expect(isSafeGateId("")).toBe(false);
  });
});

describe("config values are passed as argv, not shell strings", () => {
  // The trailing # would comment out the rest of a shell command line
  const injected = `x; touch '${MARKER}' #`;

  it("orchestrator launchd_label", () => {
    new DataService(
      makeConfig({ orchestrator: { launchd_label: injected } }),
    ).getOrchestratorStatus();
    expect(existsSync(MARKER)).toBe(false);
  });

  it("repo path and github slug", () => {
    new DataService(
      makeConfig({ repo: `/nonexistent; touch '${MARKER}' #`, github: injected }),
    ).getOverview();
    expect(existsSync(MARKER)).toBe(false);
  });

  it("github slug for open PRs", () => {
    new DataService(makeConfig({ github: injected })).getPullRequests();
    expect(existsSync(MARKER)).toBe(false);
  });
});
