/**
 * DataService security tests: untrusted file content and request values must
 * never reach a shell or escape gates_dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { DataService, isSafeGateId, parsePidFile } from "./data.js";
import { groupByLane } from "../parsers/gates.js";
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

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Set a file's mtime to `ms` before now. */
function aged(path: string, ms: number, now = Date.now()): void {
  const t = new Date(now - ms);
  utimesSync(path, t, t);
}

describe("recent gate results", () => {
  /** A result written `ms` ago, with its log */
  function result(id: string, rc: number, ms: number, log = ""): void {
    const rc_ = join(GATES, "results", `${id}.rc`);
    writeFileSync(rc_, `${rc}\n`);
    if (log) writeFileSync(join(GATES, "results", `${id}.log`), log);
    aged(rc_, ms);
  }

  it("lists only results written in the last 24 h, newest first, with their finish time", () => {
    // Ids sort oldest first by name: the order on disk is not the order shown
    result("20261026T080000Z-old-track-aaaa1111-1", 0, 26 * HOUR);
    result("20261026T120000Z-yesterday-bbbb2222-2", 1, 23 * HOUR, "STEP test: FAIL (3s)\n== FAILED STEPS: test(rc=1)\n");
    result("20261027T060000Z-morning-cccc3333-3", 0, 5 * HOUR);
    result("20261027T104500Z-latest-dddd4444-4", 0, 10 * MINUTE);
    result("20261020T000000Z-last-week-eeee5555-5", 0, 7 * 24 * HOUR);
    // A clock far ahead, or a copied file: not "recent"
    result("20261028T000000Z-future-ffff6666-6", 0, -3 * HOUR);
    // Not a result
    writeFileSync(join(GATES, "results", "notes.txt"), "x");

    const now = Date.now();
    const results = new DataService(makeConfig()).getRecentGateResults(24, 100, now);
    expect(results.map((r) => r.id)).toEqual([
      "20261027T104500Z-latest-dddd4444-4",
      "20261027T060000Z-morning-cccc3333-3",
      "20261026T120000Z-yesterday-bbbb2222-2",
    ]);
    expect(results[2]).toMatchObject({ rc: 1, failedSteps: ["test"] });
    const finished = results.map((r) => Date.parse(r.finishedAt ?? ""));
    expect(finished[0]).toBeGreaterThan(finished[1]);
    expect(finished[1]).toBeGreaterThan(finished[2]);
    expect(now - finished[2]).toBeLessThan(24 * HOUR);
  });

  it("caps the list and treats a bad window as 24 h", () => {
    for (let i = 0; i < 5; i++) result(`20261027T00000${i}Z-t-abcd000${i}-${i}`, 0, (i + 1) * MINUTE);
    result("20261025T000000Z-two-days-abcd0009-9", 0, 48 * HOUR);
    const service = new DataService(makeConfig());
    expect(service.getRecentGateResults(24, 2).map((r) => r.id)).toEqual([
      "20261027T000000Z-t-abcd0000-0",
      "20261027T000001Z-t-abcd0001-1",
    ]);
    expect(service.getRecentGateResults(Number.NaN)).toHaveLength(5);
    expect(service.getRecentGateResults(72)).toHaveLength(6);
  });
});

describe("gate queue lanes come from the file names", () => {
  // A queue directory as a project's runners leave it: the usual lanes and others
  const QUEUE_FIXTURE = [
    "heavy.1.20261027T090000Z-api-tests-abcd1234-101.req.run",
    "heavy.2.20261027T091000Z-api-tests-abcd1235-102.req",
    "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.run",
    "quick.3.20261027T100500Z-docs-beef0002-202.req",
    "actions.2.20261027T101000Z-e2e-cafe0001-301.req",
    "actions.2.20261027T101100Z-e2e-cafe0002-302.req.stuck",
    "light.5.20261027T080000Z-old-work-dead0001-401.req.superseded",
    "light.4.20261027T081000Z-stacked-dead0002-402.req.deferred-stacked",
    // Files beside the requests that are not requests
    "quick.1.20261027T100000Z-lint-fix-beef0001-201.log",
    "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.log",
    "README.md",
    "9lane.1.20261027T100000Z-bad-lane-beef0003-203.req",
  ];

  it("shows every lane's running and queued requests, and other suffixes as their status", () => {
    for (const name of QUEUE_FIXTURE) writeFileSync(join(GATES, "queue", name), "");
    const queue = new DataService(makeConfig()).getGateQueue();

    const byStatus = (status: string) =>
      queue
        .filter((g) => g.status === status)
        .map((g) => `${g.lane}:${g.track}`)
        .sort();
    expect(byStatus("running")).toEqual(["heavy:api-tests", "quick:lint-fix"]);
    expect(byStatus("queued")).toEqual(["actions:e2e", "heavy:api-tests", "quick:docs"]);
    expect(byStatus("stuck")).toEqual(["actions:e2e"]);
    expect(byStatus("superseded")).toEqual(["light:old-work"]);
    expect(byStatus("deferred-stacked")).toEqual(["light:stacked"]);
    expect(queue).toHaveLength(8);

    const grouped = groupByLane(queue);
    expect(Object.keys(grouped)).toEqual(["heavy", "light", "actions", "quick"]);
    expect(grouped.quick.map((g) => g.status).sort()).toEqual(["queued", "running"]);
    expect(grouped.actions).toHaveLength(2);
  });
});

describe("dragons: last log time, default model and runs of the agents module", () => {
  /** A dragon's log written `ms` ago */
  function log(name: string, text: string, ms: number): string {
    const path = join(TMP, name);
    writeFileSync(path, text);
    aged(path, ms);
    return path;
  }

  it("takes lastLogTime from the newest log's mtime, the same file the last line is read from", () => {
    writeFileSync(join(TMP, "dragons.txt"), "kiro-A\tSmaug\tfix-login\nkiro-B\tSaphira\tsearch-panel\n");
    log("kiro-A-20261026T200000Z.log", "an older session\n", 9 * HOUR);
    const newest = log("kiro-A-20261027T041041Z.log", "[INFO] boot\nreading the login form\n[tool] edit\n", 7 * MINUTE);
    log("kiro-B-20261027T030000Z.log", "waiting on the gate\n", 2 * HOUR);

    const dragons = new DataService(makeConfig()).getDragons();
    const a = dragons.find((d) => d.id === "kiro-A");
    expect(a?.lastLogTime).toBe(statSync(newest).mtime.toISOString());
    expect(a?.lastLogLine).toBe("reading the login form");
    expect(dragons.find((d) => d.id === "kiro-B")?.lastLogTime).toBeDefined();
  });

  it("flags a running dragon silent only when its log time is known, and says when it is unknown", () => {
    writeFileSync(
      join(TMP, "dragons.txt"),
      "kiro-A\tSmaug\tfix-login\nkiro-B\tSaphira\tsearch-panel\nkiro-C\tFafnir\tdocs\n",
    );
    for (const id of ["kiro-A", "kiro-B", "kiro-C"]) mkdirSync(join(TMP, `${id}.running`));
    log("kiro-A-20261027T041041Z.log", "working\n", 7 * MINUTE);
    log("kiro-B-20261027T010000Z.log", "stuck on something\n", 2 * HOUR);
    // kiro-C has no log at all

    const { problems } = new DataService(makeConfig()).getOverview();
    const about = (id: string) => problems.filter((p) => p.message.includes(`(${id})`));
    expect(about("kiro-A")).toEqual([]);
    expect(about("kiro-B")).toEqual([expect.objectContaining({ type: "silent_agent" })]);
    expect(about("kiro-C")).toEqual([
      expect.objectContaining({ type: "log_time_unknown", message: "Fafnir (kiro-C): log time unknown" }),
    ]);
    expect(problems.some((p) => p.message.includes("silent") && p.message.includes("kiro-C"))).toBe(false);
  });

  it("gives dragons.txt dragons dragon_defaults' model and adapter, marked as the default; a YAML entry's own model wins", () => {
    writeFileSync(join(TMP, "dragons.txt"), "kiro-A\tSmaug\tt\nkiro-B\tSaphira\tt\nkiro-C\tFafnir\tt\n");
    const config = makeConfig({
      dragon_defaults: { model: "model-default", adapter: "aider" },
      dragons: {
        "kiro-B": { name: "Saphira", model: "model-own", machine: "local", instructions: "" },
        "kiro-C": { name: "Fafnir", adapter: "kiro" } as never,
      },
    });
    const dragons = new DataService(config).getDragons();
    const byId = (id: string) => dragons.find((d) => d.id === id);
    expect(byId("kiro-A")).toMatchObject({ model: "model-default", modelFromDefault: true, adapter: "aider" });
    expect(byId("kiro-B")).toMatchObject({ model: "model-own", modelFromDefault: false, adapter: "aider" });
    expect(byId("kiro-C")).toMatchObject({ model: "model-default", modelFromDefault: true, adapter: "kiro" });

    // Without dragon_defaults a dragons.txt dragon still has no model
    const plain = new DataService(makeConfig()).getDragons();
    expect(plain.find((d) => d.id === "kiro-A")).toMatchObject({ model: undefined, modelFromDefault: false });
  });

  it("shows a dragon with a run of the agents module as running, with the run's state", () => {
    writeFileSync(join(TMP, "dragons.txt"), "kiro-A\tSmaug\tunassigned\nkiro-B\tSaphira\tunassigned\n");
    const run = { runId: "1a2b3c4d-0000-4000-8000-000000000000", task: "feat-login", state: "hung", detail: "no output for 50 min" };
    const service = new DataService(makeConfig(), { managedRuns: () => new Map([["kiro-A", run]]) });
    const dragons = service.getDragons();
    expect(dragons.find((d) => d.id === "kiro-A")).toMatchObject({ running: true, managedRun: run });
    expect(dragons.find((d) => d.id === "kiro-B")).toMatchObject({ running: false });
    expect(dragons.find((d) => d.id === "kiro-B")?.managedRun).toBeUndefined();
    // A failing source of runs leaves the list as the files say
    const failing = new DataService(makeConfig(), {
      managedRuns: () => {
        throw new Error("store closed");
      },
    });
    expect(failing.getDragons().map((d) => d.running)).toEqual([false, false]);
  });
});
