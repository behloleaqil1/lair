/**
 * The AI spend panel's rules (spend-view.ts) on the edges the DOM test (components/SpendPanel.test.tsx, against the
 * real server) doesn't reach: no reported cost at all, cost reported by only some runs, runs not classified yet, each
 * guard mode with and without counts, a group with no cost of its own, an agent with no runs, and ids a newer server
 * may send.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpendGroupView, SpendGuardView, SpendReportView, SpendTotalsView } from "../shared/agents-types";
import {
  agentSpendLine,
  formatCost,
  formatCount,
  formatMinutes,
  groupRow,
  guardLines,
  partlyReportedNote,
  reasonLabel,
  spendBars,
  topWasteReasons,
  wasteSentence,
} from "./spend-view";
import { SpendPanelView } from "./components/SpendPanel";

/** Totals as the server sums them; reportedRuns defaults to every run when reported, else none */
const totals = (over: Partial<SpendTotalsView> = {}): SpendTotalsView => {
  const t: SpendTotalsView = { runs: 0, minutes: 0, requests: null, turns: null, tokens: null, cost: null, reported: false, reportedRuns: 0, ...over };
  return { ...t, reportedRuns: over.reportedRuns ?? (t.reported ? t.runs : 0) };
};

const share = (over: Partial<SpendGroupView["waste"]> = {}): SpendGroupView["waste"] => ({ cost: null, tokens: null, requests: null, turns: null, minutes: null, runs: null, ...over });

/** A report of runs whose adapters report no tokens (requests and minutes only), one not classified yet */
function requestsOnly(): SpendReportView {
  const productive = totals({ runs: 2, minutes: 10, requests: 40 });
  const idle = totals({ runs: 1, minutes: 5, requests: 20 });
  const noResult = totals({ runs: 1, minutes: 45, requests: 0 });
  const unclassified = totals({ runs: 1, minutes: 2, requests: 4 });
  const all = totals({ runs: 5, minutes: 62, requests: 64 });
  return {
    project: "demo",
    window: "today",
    by: "agent",
    from: "2026-03-02T00:00:00.000Z",
    to: "2026-03-02T12:00:00.001Z",
    source: "runs",
    unit: "requests",
    totals: all,
    productive,
    idle,
    noResult,
    unclassified,
    waste: share({ requests: 0.3333, minutes: 0.8333, runs: 0.5 }),
    wasteShare: 0.3333,
    groups: [{ key: "builder-k", totals: all, productive, idle, noResult, unclassified, waste: share({ requests: 0.3333, minutes: 0.8333, runs: 0.5 }), reloads: 1, lairRestarts: 0 }],
    reasons: [
      { class: "no_result", reason: "hung", totals: noResult },
      { class: "idle", reason: "waiting_unnamed", totals: idle },
      { class: "productive", reason: "done", totals: productive },
      { class: "unclassified", reason: "pending", totals: unclassified },
    ],
    reloads: 1,
    lairRestarts: 0,
    topTasks: [],
    reviewsPerHead: [],
    planner: null,
    guards: [],
  };
}

/**
 * A day of a mixed fleet: a Claude Code run that finished (cost reported, no request lines), two idle runs of which
 * only one reported its cost (the other on the kiro CLI: request lines only), and a kiro CLI run that ended on its
 * provider's quota line (no result, requests only)
 */
function mixed(): SpendReportView {
  const productive = totals({ runs: 1, minutes: 2, turns: 10, tokens: 60_000, cost: 0.5, reported: true });
  const idle = totals({ runs: 2, minutes: 3, requests: 12, turns: 8, tokens: 40_000, cost: 0.25, reported: true, reportedRuns: 1 });
  const noResult = totals({ runs: 1, minutes: 1.5, requests: 30 });
  const unclassified = totals();
  const all = totals({ runs: 4, minutes: 6.5, requests: 42, turns: 18, tokens: 100_000, cost: 0.75, reported: true, reportedRuns: 2 });
  const waste = share({ cost: 0.3333, tokens: 0.4, requests: 1, turns: 0.4444, minutes: 0.6923, runs: 0.75 });
  return {
    ...requestsOnly(),
    by: "project",
    unit: "cost",
    totals: all,
    productive,
    idle,
    noResult,
    unclassified,
    waste,
    wasteShare: 0.3333,
    groups: [{ key: "demo", totals: all, productive, idle, noResult, unclassified, waste, reloads: 0, lairRestarts: 0 }],
    reasons: [
      { class: "no_result", reason: "rate_limit", totals: noResult },
      { class: "idle", reason: "no_line", totals: idle },
      { class: "productive", reason: "done", totals: productive },
    ],
    reloads: 0,
  };
}

describe("AI spend panel rules", () => {
  it("no adapter reported cost: cost and tokens say 'not reported', the waste share is in requests, and not-classified runs are their own segment", () => {
    const report = requestsOnly();
    const bars = spendBars(report);
    expect(bars.map((b) => [b.unit, b.notReported, b.totalText])).toEqual([
      ["cost", true, "not reported"],
      ["tokens", true, "not reported"],
      ["requests", false, "64 requests"],
      ["minutes", false, "1.0 h"],
      ["runs", false, "5 runs"],
    ]);
    const requests = bars.find((b) => b.unit === "requests")!;
    expect(requests.segments.map((s) => [s.class, s.value, s.text])).toEqual([
      ["productive", 40, "40 requests"],
      ["idle", 20, "20 requests"],
      ["noResult", 0, "0 requests"],
      ["unclassified", 4, "4 requests"],
    ]);
    expect(requests.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo((40 + 20 + 4) / 64);
    expect(wasteSentence(report)).toBe("33% of the model requests went to idle runs or runs with no result");
    // The reasons that cost the most requests first; productive and unclassified ones are no waste
    expect(topWasteReasons(report).map((r) => [r.label, r.runs, r.amount])).toEqual([
      ["waited on nothing Lair can watch", 1, "20 requests"],
      ["hung", 1, "0 requests"],
    ]);
  });

  it("the panel renders 'not reported' in place of cost and tokens, and says so in the table", () => {
    const html = renderToStaticMarkup(
      createElement(SpendPanelView, { report: { data: requestsOnly(), loading: false, error: null }, signedIn: true, range: "today", by: "agent", onRange: () => undefined, onBy: () => undefined }),
    );
    expect(html).toContain("not reported: the adapters of these runs don&#x27;t report it");
    expect(html).toContain("1 context reload (a restart that re-sent a failed run&#x27;s context)");
    expect(html).toContain('aria-pressed="true" data-spend-window="today"');
    // Nothing was reported, so nothing is partly reported
    expect(partlyReportedNote(requestsOnly())).toBeNull();
    expect(html).not.toContain('data-spend="partly-reported"');
  });

  it("cost reported by some runs only: a class or reason whose runs reported none says 'not reported' (never $0.00 or 0 tokens), a class with no runs is a true 0, and the waste share says it is of the reported cost", () => {
    const report = mixed();
    const bars = spendBars(report);
    const segments = (unit: string) => bars.find((b) => b.unit === unit)!.segments.map((s) => [s.class, s.value, s.text]);
    expect(segments("cost")).toEqual([
      ["productive", 0.5, "$0.50"],
      ["idle", 0.25, "$0.25"],
      ["noResult", null, "not reported"],
    ]);
    expect(segments("tokens")).toEqual([
      ["productive", 60_000, "60k tokens"],
      ["idle", 40_000, "40k tokens"],
      ["noResult", null, "not reported"],
    ]);
    // The productive Claude Code run counted no request lines: unknown, not 0
    expect(segments("requests")).toEqual([
      ["productive", null, "not reported"],
      ["idle", 12, "12 requests"],
      ["noResult", 30, "30 requests"],
    ]);
    expect(bars.find((b) => b.unit === "cost")!.segments.find((s) => s.class === "noResult")!.share).toBe(0);
    // A class with no runs at all is a true 0
    expect(spendBars({ ...report, noResult: totals() }).find((b) => b.unit === "cost")!.segments.at(-1)).toMatchObject({ class: "noResult", value: 0, text: "$0.00" });

    expect(topWasteReasons(report).map((r) => [r.label, r.runs, r.amount])).toEqual([
      ["wrote no queue line", 2, "$0.25 (reported for 1 of them)"],
      ["hit a rate limit or quota", 1, "not reported"],
    ]);
    expect(wasteSentence(report)).toBe("33% of the reported cost (2 of 4 runs) went to idle runs or runs with no result");
    expect(partlyReportedNote(report)).toBe("Tokens and cost cover only the 2 of 4 runs whose adapter reported them; the others' are not reported, never estimated.");
    // Every run reported: the plain sentence, no caveat
    const all = { ...report, totals: { ...report.totals, reportedRuns: 4 } };
    expect(wasteSentence(all)).toBe("33% of the cost went to idle runs or runs with no result");
    expect(partlyReportedNote(all)).toBeNull();

    const html = renderToStaticMarkup(
      createElement(SpendPanelView, { report: { data: report, loading: false, error: null }, signedIn: true, range: "today", by: "project", onRange: () => undefined, onBy: () => undefined }),
    );
    expect(html).toContain('data-spend="partly-reported"');
    expect(html).not.toContain("$0.00");
  });

  it("a group without the report's unit shows its waste in the next unit it has; one with nothing classified shows a dash", () => {
    const group = (waste: SpendGroupView["waste"], t: SpendTotalsView): SpendGroupView => ({
      key: "builder-k",
      totals: t,
      productive: totals(),
      idle: totals(),
      noResult: totals(),
      unclassified: totals(),
      waste,
      reloads: 0,
      lairRestarts: 0,
    });
    expect(groupRow(group(share({ requests: 1 }), totals({ runs: 1, requests: 30 })), { by: "agent", unit: "cost" }).waste).toBe("100% of requests");
    expect(groupRow(group(share({ minutes: 0.25 }), totals({ runs: 1, minutes: 4 })), { by: "agent", unit: "cost" }).waste).toBe("25% of time");
    expect(groupRow(group(share({ cost: 0.5 }), totals({ runs: 2, cost: 1, reported: true })), { by: "agent", unit: "cost" }).waste).toBe("50%");
    expect(groupRow(group(share(), totals({ runs: 1 })), { by: "agent", unit: "cost" }).waste).toBe("—");
    // Origins in words; agent and task ids as code
    const fill = { ...group(share(), totals({ runs: 1 })), key: "fill" };
    expect([groupRow(fill, { by: "origin", unit: "runs" }).name, groupRow(fill, { by: "origin", unit: "runs" }).code]).toEqual(["Fill (the tasks file)", false]);
    expect(groupRow(group(share(), totals({ runs: 1 })), { by: "task", unit: "runs" }).code).toBe(true);
  });

  it("each guard mode: off, watching (would have) and on (did), with and without counts; a guard a newer server sends still gets its line", () => {
    const g = (guard: string, mode: SpendGuardView["mode"], would: number, did: number) => ({ guard, key: `agents.x.${guard}`, mode, would, did }) as SpendGuardView;
    const lines = guardLines(
      [
        g("quota", "off", 0, 0),
        g("hung_repeat", "off", 1, 1),
        g("task_no_result_cap", "observe", 0, 0),
        g("task_no_result_cap", "observe", 3, 0),
        g("budget", "act", 0, 0),
        g("budget", "act", 1, 2),
        g("wake_events", "observe", 1, 1),
        g("a_new_guard", "act", 0, 4),
      ],
      "7d",
    );
    expect(lines.map((l) => [l.modeLabel, l.text])).toEqual([
      ["off", "Off"],
      ["off", "Off (before that, parked tasks 2 times in the last 7 days while it was watching or on)"],
      ["watching", "Nothing it would have done in the last 7 days"],
      ["watching", "Would have parked tasks 3 times in the last 7 days; it changed nothing"],
      ["on", "Nothing to do in the last 7 days"],
      ["on", "It held new runs 2 times in the last 7 days (and would have held new runs once while it was watching)"],
      ["watching", "Would have started a waiting agent on its event once in the last 7 days; it changed nothing (it started a waiting agent on its event once while it was on)"],
      ["on", "It acted 4 times in the last 7 days"],
    ]);
    expect(lines[7].name).toBe("a new guard");
  });

  it("an agent's line: none today, cost when reported, else requests or time with 'not reported'", () => {
    const report = requestsOnly();
    expect(agentSpendLine(report, "worker-z")).toBe("No runs ended today (UTC).");
    expect(agentSpendLine(report, "builder-k")).toBe(
      "Today (UTC): 5 runs: 2 productive, 1 idle, 1 with no result, 1 not classified yet · 64 requests, 1.0 h (tokens and cost not reported)",
    );
    const timed = { ...report, groups: [{ ...report.groups[0], totals: totals({ runs: 1, minutes: 3 }) }] };
    expect(agentSpendLine(timed, "builder-k")).toContain("· 3 min (tokens and cost not reported)");
    // Its adapter changed during the day: 4 runs on the kiro CLI, 1 on Claude Code at $0.30. The cost is partly reported
    const changed = { ...report, groups: [{ ...report.groups[0], totals: totals({ runs: 5, minutes: 62, requests: 40, cost: 0.3, tokens: 9_000, reported: true, reportedRuns: 1 }) }] };
    expect(agentSpendLine(changed, "builder-k")).toBe(
      "Today (UTC): 5 runs: 2 productive, 1 idle, 1 with no result, 1 not classified yet · cost $0.30 for 1 of 5 runs (partly reported; the others' not reported), 40 requests",
    );
    // Every run reported: the cost alone
    const reported = { ...report, groups: [{ ...report.groups[0], totals: totals({ runs: 5, minutes: 62, cost: 1.2, tokens: 9_000, reported: true }) }] };
    expect(agentSpendLine(reported, "builder-k")).toContain("· cost $1.20");
    expect(agentSpendLine(reported, "builder-k")).not.toContain("partly");
  });

  it("numbers in words, and a reason a newer server sends", () => {
    expect([formatCost(0), formatCost(0.004), formatCost(1234.5)]).toEqual(["$0.00", "under $0.01", "$1,234.50"]);
    expect([formatCount(999), formatCount(69_007), formatCount(1_634_873)]).toEqual(["999", "69k", "1.6M"]);
    expect([formatMinutes(1.5), formatMinutes(90)]).toEqual(["1.5 min", "1.5 h"]);
    expect(reasonLabel("rate_limit")).toBe("hit a rate limit or quota");
    expect(reasonLabel("some_new_reason")).toBe("some new reason");
  });
});
