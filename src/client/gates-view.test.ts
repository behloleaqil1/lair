/**
 * The Gates view's lanes and recent results (gates-view.ts), on what the
 * server's parser makes of a queue directory with quick and actions lanes.
 */
import { describe, expect, it } from "vitest";
import { parseGateFiles } from "../server/parsers/gates";
import type { GateResult } from "../shared/types";
import { laneGates, queueLanes, recentResults, statusBadge } from "./gates-view";

const QUEUE = parseGateFiles([
  "heavy.1.20261027T090000Z-api-tests-abcd1234-101.req.run",
  "quick.1.20261027T100000Z-lint-fix-beef0001-201.req.run",
  "quick.3.20261027T100500Z-docs-beef0002-202.req",
  "actions.2.20261027T101100Z-e2e-cafe0002-302.req.stuck",
  "actions.2.20261027T101000Z-e2e-cafe0001-301.req",
]);

describe("gates view: lanes from the queue", () => {
  it("shows every lane a request names, the usual ones first", () => {
    expect(queueLanes(QUEUE)).toEqual(["heavy", "actions", "quick"]);
  });

  it("lists a lane's running request first, then the queued, then the others", () => {
    expect(laneGates(QUEUE, "quick").map((g) => g.status)).toEqual(["running", "queued"]);
    expect(laneGates(QUEUE, "actions").map((g) => g.status)).toEqual(["queued", "stuck"]);
    expect(laneGates(QUEUE, "light")).toEqual([]);
  });

  it("puts the quick lane's running job under Running", () => {
    const running = QUEUE.filter((g) => g.status === "running").map((g) => g.lane);
    expect(running.sort()).toEqual(["heavy", "quick"]);
  });

  it("gives each status a badge", () => {
    expect(statusBadge("running")).toBe("badge-success");
    expect(statusBadge("queued")).toBe("badge-neutral");
    expect(statusBadge("stuck")).toBe("badge-warning");
  });
});

describe("gates view: recent results", () => {
  const NOW = Date.parse("2026-10-27T12:00:00.000Z");
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

  it("keeps the last 24 hours only, newest first", () => {
    const results: GateResult[] = [
      { id: "a-oldest", rc: 0, finishedAt: at(30) },
      { id: "b-yesterday", rc: 1, finishedAt: at(23.5) },
      { id: "c-morning", rc: 0, finishedAt: at(5) },
      { id: "d-no-time", rc: 0 },
      { id: "e-latest", rc: 0, finishedAt: at(0.1) },
    ];
    expect(recentResults(results, NOW).map((r) => r.id)).toEqual(["e-latest", "c-morning", "b-yesterday"]);
  });

});
