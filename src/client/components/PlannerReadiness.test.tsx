/**
 * The Planner view's readiness panel (docs/design/planner-act.md §4.4): one row per part with its verdict, the
 * criteria that failed with their counts, the failed samples, and the changes behind a switch-back recommendation.
 * The report is the shape GET /api/planner/readiness returns (src/server/planner/readiness.ts).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ReadinessPanel } from "./PlannerReadiness";
import type { PlannerReadinessView } from "../../shared/planner-types";

const REPORT: PlannerReadinessView = {
  at: "2026-03-12T12:00:00.000Z",
  since: "2026-03-05T12:00:00.000Z",
  days: 7,
  minSamples: 20,
  minAgreement: 0.9,
  rows: [
    {
      part: "planner.mode",
      mode: "act",
      verdict: "switch_back",
      criteria: [
        { id: "verified", label: "(1) verified samples", ok: true, detail: "25 verified proposals in auto-applied ops (add); 20 needed" },
        { id: "recheck_history", label: "(5) recheck_on_change history", ok: false, detail: "recheck_on_change was off until 2026-03-06" },
      ],
      failed: [],
      undone: [{ change: "c1", op: "add", task: "t3", at: "2026-03-12T10:00:00.000Z", how: "undone" }],
    },
    {
      part: "backlog.mode",
      mode: "off",
      verdict: "not_yet",
      criteria: [{ id: "no_skipped", label: "none for a closed or skipped task", ok: false, detail: "1 for a closed or skipped task" }],
      failed: ["a20"],
      undone: [],
    },
    { part: "backlog.assign", mode: "off", verdict: "ready", criteria: [], failed: [], undone: [] },
  ],
};

describe("ReadinessPanel", () => {
  it("shows each part's verdict, the failed criteria and samples, and the changes behind switch back", () => {
    const html = renderToStaticMarkup(createElement(ReadinessPanel, { report: REPORT }));
    expect(html).toContain("Ready for act? (last 7 days)");
    expect(html).toContain("switch back recommended");
    expect(html).toContain("not yet");
    expect(html).toContain(">ready<");
    expect(html).toContain("(5) recheck_on_change history: recheck_on_change was off until 2026-03-06");
    // A criterion that holds is not listed as a problem
    expect(html).not.toContain("(1) verified samples:");
    expect(html).toContain("a20");
    expect(html).toContain("add t3 (undone)");
  });
});
