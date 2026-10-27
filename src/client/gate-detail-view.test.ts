/**
 * What the gate detail shows (gate-detail-view.ts), from the shape GET
 * /api/dashboard/gates/:id returns, and the failures Home lists.
 */
import { describe, expect, it } from "vitest";
import type { GateDetailView, GateOutputView } from "../shared/dashboard-types";
import type { Gate, GateResult } from "../shared/types";
import { gateBadge, gateFacts, latestFailures, outputEndpoint, placementLine, testsHeading, trackOf } from "./gate-detail-view";

const NOW = Date.parse("2026-10-24T17:05:00.000Z");

function gate(over: Partial<GateDetailView> = {}): GateDetailView {
  return {
    id: "20261024T170000Z-api-tests-abcdef12-1",
    project: "demo",
    source: "queue",
    status: "failed",
    lane: "heavy",
    priority: 1,
    track: "api-tests",
    sha: "abcdef1234567890",
    base: "9999888877776666",
    branch: "feat/api",
    machine: "builder",
    pipeline: null,
    runId: null,
    startedAt: "2026-10-24T17:00:00Z",
    finishedAt: "2026-10-24T17:04:30Z",
    rc: 1,
    currentStep: null,
    steps: [],
    failedSteps: ["verify"],
    triage: null,
    placement: null,
    hasLog: true,
    ...over,
  };
}

describe("gate detail", () => {
  it("lists track, branch, commit, lane, machine, exit code and duration", () => {
    expect(gateFacts(gate())).toEqual([
      ["Source", "the project's gate queue"],
      ["Track", "api-tests"],
      ["Branch", "feat/api"],
      ["Commit", "abcdef123456 (base 999988887777)"],
      ["Lane", "heavy"],
      ["Priority", "1"],
      ["Machine", "builder"],
      ["Exit code", "1"],
      ["Duration", "4.5 min"],
    ]);
    const pipeline = gateFacts(gate({ source: "pipeline", pipeline: "gate", track: null, priority: null, rc: null, base: null, finishedAt: null }));
    expect(pipeline.map(([k]) => k)).toEqual(["Source", "Pipeline", "Branch", "Commit", "Lane", "Machine"]);
    expect(pipeline[0][1]).toBe("Lair pipeline");
  });

  it("gives each status a badge", () => {
    expect(gateBadge("passed")).toBe("badge-success");
    expect(gateBadge("failed")).toBe("badge-error");
    expect(gateBadge("running")).toBe("badge-warning");
    expect(gateBadge("superseded")).toBe("badge-neutral");
  });

  it("says what placement would do with a queued gate, and when it starts and finishes", () => {
    const queued = gate({
      status: "queued",
      placement: {
        mode: "observe",
        machine: "builder",
        job: {
          id: "x",
          lane: "heavy",
          priority: 1,
          status: "queued",
          class: null,
          expectedStart: "2026-10-24T17:15:00.000Z",
          expectedFinish: "2026-10-24T17:45:00.000Z",
          held: null,
          advice: { to: "remote", gainSeconds: 1200, explanation: "faster", quiet: false, stuck: false },
        },
      },
    });
    expect(placementLine(queued, NOW)).toBe("would move to remote: −20 min · starts in 10 min · finishes in 40 min");
    expect(placementLine(gate(), NOW)).toBeNull();
  });

  it("titles the failing tests with where they come from", () => {
    const out = (over: Partial<GateOutputView>): GateOutputView => ({
      id: "g",
      log: null,
      tests: [{ id: "a#b", suite: "a", name: "b", file: null, message: "m", class: "code", step: "test" }],
      testsTruncated: false,
      testsFrom: "triage",
      evidence: [],
      ...over,
    });
    expect(testsHeading(out({}))).toBe("1 failing test, as triage read them");
    expect(testsHeading(out({ testsTruncated: true, testsFrom: "log" }))).toBe("1+ failing test, from the log's test output");
    expect(outputEndpoint("a b", 50)).toBe("/dashboard/gates/a%20b/output?lines=50");
  });
});

describe("Home's failed gates", () => {
  it("lists each track's newest result when it failed and no re-run is queued", () => {
    const results: GateResult[] = [
      { id: "20261024T100000Z-web-aaaa1111-1", rc: 1, finishedAt: "2026-10-24T10:10:00Z", failedSteps: ["lint"] },
      { id: "20261024T110000Z-web-aaaa2222-2", rc: 0, finishedAt: "2026-10-24T11:10:00Z" },
      { id: "20261024T120000Z-api-bbbb1111-1", rc: 2, finishedAt: "2026-10-24T12:10:00Z", failedSteps: ["test"] },
      { id: "20261024T130000Z-docs-cccc1111-1", rc: 1, finishedAt: "2026-10-24T13:10:00Z" },
    ];
    const queue = [{ id: "20261024T140000Z-docs-cccc2222-2", lane: "light", priority: 1, status: "queued", track: "docs" }] as Gate[];
    expect(latestFailures(results, queue)).toEqual([
      { id: "20261024T120000Z-api-bbbb1111-1", track: "api", finishedAt: "2026-10-24T12:10:00Z", failedSteps: ["test"] },
    ]);
    expect(trackOf("not-structured")).toBe("not-structured");
  });
});
