/**
 * Home → Health's self-checks panel: the failing and warning checks first,
 * each with its fix, the empty and off states, and the MCP config a minted
 * token goes in. Rendered to markup with the real component.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckResult, DiagnosticsView } from "../shared/supervisor-types";
import { attentionRows, healthSummary, mcpConfig } from "./health-checks-view";
import { SelfChecksCard } from "./components/SelfChecks";

const check = (over: Partial<CheckResult>): CheckResult => ({
  id: "disk_free",
  scope: "server",
  title: "Free disk",
  status: "ok",
  values: {},
  thresholds: {},
  explanation: "Plenty free.",
  fix: null,
  measuredAt: "2026-10-28T09:00:00Z",
  durationMs: 2,
  failingSince: null,
  noticeId: null,
  ...over,
});

const view = (server: CheckResult[], demo: CheckResult[], over: Partial<DiagnosticsView> = {}): DiagnosticsView => ({
  enabled: true,
  intervalSeconds: 60,
  lastRunAt: "2026-10-28T09:00:00Z",
  server,
  projects: [
    { project: "demo", enabled: true, errors: [], lastRunAt: "2026-10-28T09:00:05Z", checks: demo },
    { project: "other", enabled: true, errors: [], lastRunAt: null, checks: [check({ id: "retention", scope: "other", status: "failing" })] },
  ],
  counts: { ok: 0, warning: 0, failing: 0, unknown: 0 },
  ...over,
});

describe("the self-checks panel", () => {
  const diagnostics = view(
    [
      check({ id: "open_files", title: "Open files", status: "warning", explanation: "75% of the limit.", fix: "Restart Lair." }),
      check({ id: "event_loop_lag", title: "Event-loop lag", status: "ok" }),
    ],
    [
      check({
        id: "gate_queue_age",
        scope: "demo",
        title: "Gate queue age",
        status: "failing",
        explanation: "The oldest has waited 240 min.",
        fix: "Check the runner of lane heavy.",
        failingSince: "2026-10-28T08:50:00Z",
        noticeId: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
      }),
      check({ id: "retention", scope: "demo", status: "unknown" }),
    ],
  );

  it("lists the failing checks first, then the warnings, of the server and this project only", () => {
    expect(attentionRows(diagnostics, "demo").map((r) => [r.key, r.status, r.where])).toEqual([
      ["demo:gate_queue_age", "failing", "demo"],
      ["server:open_files", "warning", "Lair"],
    ]);
    expect(healthSummary(diagnostics, "demo")).toEqual({ total: 4, failing: 1, warning: 1, unknown: 1, lastRunAt: "2026-10-28T09:00:05Z" });
  });

  it("shows each with its fix and a link to its notice", () => {
    const html = renderToStaticMarkup(createElement(SelfChecksCard, { view: diagnostics, project: "demo" }));
    expect(html).toContain('data-check="demo:gate_queue_age"');
    expect(html).toContain("Fix: Check the runner of lane heavy.");
    expect(html).toContain("Fix: Restart Lair.");
    expect(html).toContain("#/decisions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b");
    expect(html.indexOf("Gate queue age")).toBeLessThan(html.indexOf("Open files"));
    expect(html).not.toContain("Event-loop lag");
  });

  it("says so when everything passes, when nothing ran yet, and when the checks are off", () => {
    const passing = renderToStaticMarkup(createElement(SelfChecksCard, { view: view([check({})], []), project: "demo" }));
    expect(passing).toContain('data-empty="self-checks"');
    expect(passing).toContain("All 1 measured checks pass");
    const none = renderToStaticMarkup(createElement(SelfChecksCard, { view: view([], [], { lastRunAt: null }), project: "nope" }));
    expect(none).toContain("No check has run yet");
    const off = renderToStaticMarkup(createElement(SelfChecksCard, { view: view([], [], { enabled: false }), project: "nope" }));
    expect(off).toContain("supervisor.checks.enabled: false");
  });

  it("gives an MCP client the bridge with the token in its environment", () => {
    const config = JSON.parse(mcpConfig("lairops_x", "http://127.0.0.1:4777"));
    expect(config).toEqual({
      mcpServers: { lair: { command: "lair", args: ["ops-mcp"], env: { LAIR_OPS_TOKEN: "lairops_x", LAIR_URL: "http://127.0.0.1:4777" } } },
    });
  });
});
