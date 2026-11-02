// @vitest-environment jsdom
/**
 * AI spend on the dashboard (docs/design/ai-spend.md §4.4, AT-35): Home's AI spend panel and an agent's Spend line,
 * against the real agents routes (testing/spend-server.ts): the real AgentsService wrote the spend rows of runs whose
 * logs are real CLI output (a Claude Code stream-json run that reports its cost, a kiro CLI run that reports only
 * requests), with G1, G2 and G4 in observe. Home is mounted in a DOM and driven as the owner would: the today / 7 days
 * switch and the table's grouping refetch, and with spend off there is no panel and nothing is asked for.
 * Home's other cards read the dashboard's fixture answers (a11y-fixtures.ts).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import axe from "axe-core";
import { Home } from "./Home";
import { AgentDetailView } from "./AgentDetail";
import { parseRoute } from "../router";
import { FIXTURE_MODULES, fixtureFetch } from "../a11y-fixtures";
import { spendServer, type SpendServer } from "../testing/spend-server";
import { ownerHeaders } from "../owner-session";
import type { AgentsStatusView, SpendReportView } from "../../shared/agents-types";

vi.setConfig({ testTimeout: 30_000 });

class InertEventSource {
  readyState = 0;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

class InertWebSocket extends InertEventSource {
  send() {}
}

let server: SpendServer | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  await server?.close();
  server = null;
});

async function start(spend: boolean, signedIn = true): Promise<SpendServer> {
  server = await spendServer({ spend, fallback: fixtureFetch() });
  vi.stubGlobal("fetch", server.fetch);
  vi.stubGlobal("EventSource", InertEventSource);
  vi.stubGlobal("WebSocket", InertWebSocket);
  if (signedIn) await server.signIn();
  return server;
}

/** Let the requests answer and the effects run, until `done` holds. */
async function until(what: string, done: () => boolean, rounds = 300): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (!done()) throw new Error(`timed out waiting for ${what}\n${document.body.textContent?.slice(0, 2000)}`);
}

/** Home's overview, as App.tsx mounts it, with the agents module on */
function mountHome(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(Home, {
        project: "demo",
        refreshKey: 0,
        route: parseRoute("#/"),
        modules: { ...FIXTURE_MODULES, agents: true },
        readOnly: false,
        open: () => undefined,
      }),
    ),
  );
  return host;
}

const panel = () => document.querySelector<HTMLElement>('[data-card="ai-spend"]');
const part = (name: string) => panel()?.querySelector<HTMLElement>(`[data-spend="${name}"]`)?.textContent ?? "";
const bar = (unit: string) => panel()?.querySelector<HTMLElement>(`[data-spend-bar="${unit}"]`)?.textContent ?? "";
const row = (key: string) => [...(panel()?.querySelectorAll<HTMLElement>(`[data-spend-row="${key}"] td`) ?? [])].map((td) => td.textContent);
const guard = (id: string) => panel()?.querySelector<HTMLElement>(`[data-guard="${id}"]`)?.textContent ?? "";
const spendAsks = () => (server?.requests ?? []).filter((r) => r.startsWith("GET /api/agents/spend"));

describe("AT-35: Home's AI spend panel", () => {
  it("shows the stacked bars, the waste share, the top reasons and tasks, one line per guard with its count, and 'not reported' for the adapter that reports no tokens", async () => {
    await start(true);
    mountHome();
    await until("the panel's bars", () => bar("runs").length > 0);
    expect(spendAsks()).toEqual(["GET /api/agents/spend?window=today&by=agent&project=demo"]);

    // Today: worker-c finished t-docs and ended t-notes with nothing (each run's cost reported), builder-k hit its quota
    // on the kiro CLI (requests only). The waste share is of the cost the two Claude Code runs reported, and says so
    const partly = "Tokens and cost cover only the 2 of 3 runs whose adapter reported them; the others' are not reported, never estimated.";
    const waste = "50% of the reported cost (2 of 3 runs) went to idle runs or runs with no result";
    expect(part("waste")).toBe(waste);
    // The kiro run's cost and tokens are unknown, not 0: "not reported" in its class's place, never "$0.00"
    expect(bar("cost")).toContain("$1.04: productive $0.52 · idle $0.52 · no result not reported");
    expect(bar("cost")).not.toContain("$0.00");
    expect(bar("tokens")).toContain("138k tokens");
    expect(bar("tokens")).toContain("no result not reported");
    expect(bar("tokens")).not.toContain(" 0 tokens");
    // and the Claude Code runs count no request lines: theirs are not reported either, never "0 requests"
    expect(bar("requests")).toContain("30 requests: productive not reported · idle not reported · no result 30 requests");
    expect(bar("runs")).toContain("3 runs: productive 1 run · idle 1 run · no result 1 run");
    expect(panel()!.querySelectorAll('[data-spend-bar="cost"] .spend-segment')).toHaveLength(2); // productive and idle: no-result cost is unknown
    expect(part("reasons")).toContain("hit a rate limit or quota: 1 run, not reported");
    expect(part("reasons")).not.toContain("$0.00");
    expect(part("reasons")).toContain("wrote no queue line: 1 run, $0.52");
    expect(part("partly-reported")).toBe(partly);
    expect(part("tasks")).toContain("t-api");
    expect(part("tasks")).toContain("t-notes");
    expect(part("tasks")).not.toContain("t-docs");

    // The kiro CLI reports requests, not tokens or cost: "not reported", never an estimate
    expect(row("builder-k")).toEqual(["builder-k", "1", "0", "0", "1", "100% of requests", "30", "1.5 min", "not reported", "not reported"]);
    expect(row("worker-c")).toEqual(["worker-c", "2", "1", "1", "0", "50%", "—", "3 min", "138k", "$1.04"]);
    expect(part("losses")).toBe("0 context reloads (a restart that re-sent a failed run's context) · 0 runs ended by a Lair restart");

    // One line per guard: G1 watched the quota line once; the others in observe had nothing; the rest are off
    expect(panel()!.querySelectorAll("[data-guard]")).toHaveLength(9);
    expect(guard("quota")).toBe("watching Provider quota cooldown: Would have cooled a provider once today (UTC); it changed nothing");
    expect(guard("task_no_result_cap")).toContain("watching");
    expect(guard("task_no_result_cap")).toContain("Nothing it would have done today (UTC)");
    expect(guard("hung_repeat")).toContain("watching");
    expect(guard("budget")).toContain("watching");
    expect(guard("wake_events")).toBe("off Wake waiting agents on their event: Off");
    expect(guard("planner_skip_unchanged")).toContain("Off");

    // Axe on the panel: no serious or critical violations (colour contrast is tokens.test.ts's)
    const result = await axe.run(panel()!, { resultTypes: ["violations"], rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

    // The caveat comes from the report's totals, not the table: by project (one row, whose cost 2 of its 3 runs
    // reported) the caveat and the waste sentence stay as they were
    const select = panel()!.querySelector<HTMLSelectElement>('select[aria-label="Group the AI spend table by"]')!;
    act(() => {
      select.value = "project";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until("the table by project", () => row("demo").length > 0);
    expect(spendAsks().at(-1)).toBe("GET /api/agents/spend?window=today&by=project&project=demo");
    expect(row("demo").slice(0, 5)).toEqual(["demo", "3", "1", "1", "1"]);
    expect(part("partly-reported")).toBe(partly);
    expect(part("waste")).toBe(waste);
  });

  it("the 7 days switch refetches with window=7d (the crash two days ago counts then); the table's grouping refetches with by=", async () => {
    await start(true);
    mountHome();
    await until("today's bars", () => bar("runs").includes("3 runs"));
    const sevenDays = panel()!.querySelector<HTMLButtonElement>('[data-spend-window="7d"]')!;
    expect(sevenDays.getAttribute("aria-pressed")).toBe("false");

    act(() => sevenDays.click());
    await until("7 days' bars", () => bar("runs").includes("4 runs"));
    expect(spendAsks().at(-1)).toBe("GET /api/agents/spend?window=7d&by=agent&project=demo");
    expect(sevenDays.getAttribute("aria-pressed")).toBe("true");
    expect(bar("runs")).toContain("4 runs: productive 1 run · idle 1 run · no result 2 runs");
    expect(part("reasons")).toContain("crashed: 1 run");
    expect(row("worker-c")[1]).toBe("3");

    const select = panel()!.querySelector<HTMLSelectElement>('select[aria-label="Group the AI spend table by"]')!;
    act(() => {
      select.value = "task";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until("the table by task", () => row("t-old").length > 0);
    expect(spendAsks().at(-1)).toBe("GET /api/agents/spend?window=7d&by=task&project=demo");
    expect(row("t-api")).toEqual(["t-api", "1", "0", "0", "1", "100% of requests", "30", "1.5 min", "not reported", "not reported"]);
    expect(row("t-old").slice(0, 5)).toEqual(["t-old", "1", "0", "0", "1"]);
  });

  it("with agents.spend off there is no panel, and the spend route is never asked", async () => {
    const s = await start(false);
    mountHome();
    await until("the agents status", () => s.requests.some((r) => r.startsWith("GET /api/agents/status")));
    await until("Home's tiles", () => (host?.textContent ?? "").includes("Agents working"));
    expect(panel()).toBeNull();
    expect(spendAsks()).toEqual([]);
    // The status says spend is off, and the route agrees (asked as the owner)
    const status = (await (await s.fetch("/api/agents/status?project=demo")).json()) as { data: AgentsStatusView };
    expect(status.data).toMatchObject({ enabled: true, spendEnabled: false });
    const off = await s.fetch("/api/agents/spend?window=today&by=agent&project=demo", { headers: ownerHeaders() });
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: string }).error).toContain("agents.spend.enabled is off");
  });

  it("signed out, the panel says it is the owner's and asks for nothing", async () => {
    await start(true, false);
    mountHome();
    await until("the panel", () => panel() !== null && (panel()!.textContent ?? "").includes("owner only"));
    expect(panel()!.querySelector('[data-owner-only="signed-out"]')).not.toBeNull();
    expect(panel()!.querySelector("[data-spend-window]")).toBeNull();
    expect(spendAsks()).toEqual([]);
  });
});

describe("an agent's Spend line (next to its Budget)", () => {
  async function ownerRead<T>(s: SpendServer, url: string): Promise<T> {
    const res = await s.fetch(url, { headers: ownerHeaders() });
    return ((await res.json()) as { data: T }).data;
  }

  const detail = (id: string, status: AgentsStatusView, spend: SpendReportView | null, signedIn = true) =>
    renderToStaticMarkup(
      createElement(AgentDetailView, {
        id,
        project: "demo",
        refreshKey: 0,
        dragons: [],
        status,
        readOnly: false,
        dragonConfig: null,
        onChanged: () => undefined,
        onClose: () => undefined,
        data: {
          signedIn,
          runs: { data: [], loading: false, error: null },
          queue: { data: [], loading: false, error: null },
          log: { data: null, loading: false, error: null },
          spend: { data: spend, loading: false, error: null },
        },
      }),
    );

  it("today's runs per class with their cost, or their requests when the adapter reports no cost; none while spend is off", async () => {
    const s = await start(true);
    const status = await ownerRead<AgentsStatusView>(s, "/api/agents/status?project=demo");
    expect(status.spendEnabled).toBe(true);
    const today = await ownerRead<SpendReportView>(s, "/api/agents/spend?window=today&by=agent&project=demo");

    const claude = detail("worker-c", status, today);
    expect(claude).toContain(">Spend<");
    expect(claude).toContain("Today (UTC): 2 runs: 1 productive, 1 idle, 0 with no result · cost $1.04");
    const kiro = detail("builder-k", status, today);
    expect(kiro).toContain("Today (UTC): 1 run: 0 productive, 0 idle, 1 with no result · 30 requests, 1.5 min (tokens and cost not reported)");
    // Signed out: the owner's, so a notice
    expect(detail("builder-k", status, null, false)).toContain("shown to the owner only");
    // Off: no Spend section at all
    expect(detail("builder-k", { ...status, spendEnabled: false }, today)).not.toContain(">Spend<");
  });
});
