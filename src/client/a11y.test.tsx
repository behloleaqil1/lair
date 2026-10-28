// @vitest-environment jsdom
/**
 * Accessibility in CI: the whole dashboard, rendered in a DOM with fixture
 * data (a11y-fixtures.ts), checked by axe for serious and critical
 * violations, on each view the list below names, signed in as the owner and
 * signed out, in each theme and density. Colour contrast is left to
 * tokens.test.ts: jsdom has no layout, so axe can't compute it here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { App } from "./App";
import { FIXTURE_MODULES, FIXTURE_NOW, fixtureFetch } from "./a11y-fixtures";
import { signIn } from "./owner-session";
import { applyPreferences } from "./ui/preferences";
import { settingsSections } from "../server/settings/index.js";
import type { ModuleFlags } from "../shared/dashboard-types";

/** Each top-level view and detail: its URL, and a text that says it rendered with its data */
const VIEWS: { name: string; hash: string; shows: string }[] = [
  { name: "Home", hash: "#/", shows: "worker-a is paused" },
  { name: "Home, Activity", hash: "#/?tab=activity", shows: "Live Feed" },
  { name: "Home, Health", hash: "#/?tab=health", shows: "self-checks" },
  { name: "Work", hash: "#/work", shows: "worker-a" },
  { name: "Work, an agent's detail", hash: "#/work/worker-a", shows: "worker-a" },
  { name: "Gates", hash: "#/gates", shows: "feat-y" },
  { name: "Gates, Results", hash: "#/gates?tab=results", shows: "g-1" },
  { name: "Gates, a gate's detail", hash: "#/gates/g-1", shows: "g-1" },
  { name: "PRs", hash: "#/prs", shows: "the export button" },
  { name: "PRs, a PR's detail", hash: "#/prs/7", shows: "the export button" },
  { name: "Machines", hash: "#/machines", shows: "build-2" },
  { name: "Machines, Nodes", hash: "#/machines?tab=nodes", shows: "Nodes" },
  { name: "Decisions", hash: "#/decisions", shows: "worker-a is paused" },
  { name: "Decisions, a decision's detail", hash: "#/decisions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b", shows: "Start it again" },
  { name: "Decisions, Owner messages", hash: "#/decisions?tab=messages", shows: "Pause the heavy lane tonight" },
  { name: "Delivery", hash: "#/delivery", shows: "demo-staging" },
  { name: "Processes", hash: "#/processes", shows: "Docs server" },
  { name: "Settings", hash: "#/settings", shows: "Settings" },
];

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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // As index.html has them
  document.documentElement.lang = "en";
  document.title = "Lair";
});

beforeEach(() => {
  vi.stubGlobal("fetch", fixtureFetch());
  vi.stubGlobal("EventSource", InertEventSource);
  vi.stubGlobal("WebSocket", InertWebSocket);
  // Mock Date.now to use the fixture time, so time-based filters (e.g., results in the last 24 hours) work
  vi.useFakeTimers({ now: Date.parse(FIXTURE_NOW) });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let the fetches answer and the effects settle */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderAt(hash: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/${hash}`);
  host = document.createElement("div");
  host.id = "root";
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<App />));
  await settle();
  return host;
}

async function seriousViolations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")}: ${n.failureSummary ?? ""}`).join("\n")}`);
}

describe("accessibility: axe on every view", () => {
  for (const view of VIEWS) {
    it(`${view.name}, signed out: no serious or critical violations`, async () => {
      const el = await renderAt(view.hash);
      expect(el.textContent, el.textContent?.slice(0, 1500)).toContain(view.shows);
      expect(await seriousViolations()).toEqual([]);
    });

    it(`${view.name}, signed in as the owner, dark and compact: no serious or critical violations`, async () => {
      await signIn("owner-token");
      applyPreferences({ theme: "dark", density: "compact" });
      const el = await renderAt(view.hash);
      expect(el.textContent, el.textContent?.slice(0, 1500)).toContain(view.shows);
      // The owner's footer controls are there, so the signed-in markup is the one checked
      expect(el.querySelector('[data-server-controls="owner"]')).not.toBeNull();
      expect(await seriousViolations()).toEqual([]);
      applyPreferences({ theme: "system", density: "comfortable" });
    });
  }

  it("the supervisor's chat panel, opened from Home's Ask Lair card: no serious or critical violations", async () => {
    await signIn("owner-token");
    const el = await renderAt("#/");
    const input = el.querySelector<HTMLInputElement>('input[aria-label="A question for Lair"]');
    expect(input, el.textContent?.slice(0, 1500)).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Why is nothing merging?");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input!.form!.requestSubmit();
    });
    await settle();
    const panel = el.querySelector('[data-panel="chat"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Why is nothing merging?");
    expect(await seriousViolations()).toEqual([]);
  });

  it("the shell: a labelled nav with the current section, the project's status and the look toggles", async () => {
    const el = await renderAt("#/");
    const nav = el.querySelector('nav[aria-label="Sections"]')!;
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain("Home");
    expect(el.querySelector('[aria-label="Lair status"]')?.textContent).toContain("Control");
    expect(el.textContent).toContain("Paused");
    expect(el.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect([...el.querySelectorAll("label")].map((l) => l.textContent)).toContain("Theme");
    expect(el.querySelector('button[aria-controls="lair-sidebar"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("the theme toggle and the density switch set the attributes the tokens read", async () => {
    const el = await renderAt("#/");
    const theme = [...el.querySelectorAll("label")].find((l) => l.textContent === "Theme")!;
    const select = document.getElementById(theme.htmlFor) as HTMLSelectElement;
    act(() => {
      select.value = "dark";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => (el.querySelector('[role="switch"]') as HTMLElement).click());
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    act(() => {
      select.value = "system";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => (el.querySelector('[role="switch"]') as HTMLElement).click());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.hasAttribute("data-density")).toBe(false);
  });
});

/** Every module on: the Settings pages draw everything they have */
const ALL_ON = Object.fromEntries(Object.keys(FIXTURE_MODULES).map((k) => [k, true])) as unknown as ModuleFlags;

/** Settings' own pages (settings-pages.ts), with the real registry's sections and the fixture project's settings */
const SETTINGS_PAGES: { name: string; hash: string; shows: string }[] = [
  { name: "Overview", hash: "#/settings", shows: "build-2 doesn't answer" },
  { name: "AI: tools, profiles and roles", hash: "#/settings?tab=ai", shows: "Reviewer for AMBER" },
  { name: "Team: the agents", hash: "#/settings?tab=team", shows: "kiro-opus (kiro + claude-opus-4.5)" },
  { name: "All settings (classic), a field shown by the search", hash: "#/settings/watchdog.interval_seconds?tab=classic", shows: "Secrets" },
  { name: "YAML", hash: "#/settings?tab=yaml", shows: "The project's file" },
  { name: "History", hash: "#/settings?tab=history", shows: "saved from Settings" },
];

describe("accessibility: the Settings pages, signed in, with the modules on", () => {
  const settingsFetch = () =>
    fixtureFetch({
      "/api/settings/modules": { sections: settingsSections() },
      "/api/dashboard/modules": { project: "demo", readOnly: false, error: null, modules: ALL_ON },
    });

  function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  for (const page of SETTINGS_PAGES) {
    for (const theme of ["light", "dark"] as const) {
      it(`${page.name}, ${theme}: no serious or critical violations`, async () => {
        vi.stubGlobal("fetch", settingsFetch());
        await signIn("owner-token");
        applyPreferences({ theme, density: theme === "dark" ? "compact" : "comfortable" });
        const el = await renderAt(page.hash);
        expect(el.textContent, el.textContent?.slice(0, 1500)).toContain(page.shows);
        expect(el.querySelector('nav[aria-label="Settings pages"] [aria-current="page"]')).not.toBeNull();
        expect(await seriousViolations()).toEqual([]);
        applyPreferences({ theme: "system", density: "comfortable" });
      });
    }
  }

  it("the search's open list of matches: no serious or critical violations", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    await signIn("owner-token");
    const el = await renderAt("#/settings");
    const box = el.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
    act(() => box.focus());
    type(box, "reviewer");
    expect(document.getElementById(box.getAttribute("aria-controls")!)!.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(await seriousViolations()).toEqual([]);
  });

  it("the save bar and the review drawer, with a command to confirm: no serious or critical violations", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    await signIn("owner-token");
    const el = await renderAt("#/settings?tab=yaml");
    const text = el.querySelector<HTMLTextAreaElement>("[data-settings-yaml]")!;
    type(text, `${text.value}dragon_start_cmd: ["./bin/start", "{dragon}"]\n`);
    const bar = el.querySelector("[data-settings-savebar]")!;
    expect(bar.textContent).toContain("The YAML is edited");
    act(() => [...bar.querySelectorAll("button")].find((b) => b.textContent === "Review and save")!.click());
    await settle();
    const drawer = el.querySelector('[role="dialog"]')!;
    expect(drawer.querySelector("[data-settings-commands]")).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });

  it("a profile's drawer, its model dropdown filled, then Other… with its warning: no serious or critical violations", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    await signIn("owner-token");
    const el = await renderAt("#/settings?tab=ai");
    const row = [...el.querySelectorAll<HTMLElement>("[data-ai-profiles] tbody tr")].find((r) => r.textContent?.includes("kiro-opus"))!;
    act(() => row.click());
    await settle();
    const drawer = el.querySelector('[role="dialog"]')!;
    const model = drawer.querySelector<HTMLSelectElement>("[data-model-select]")!;
    expect([...model.options].map((o) => o.value)).toContain("claude-opus-4.5");
    expect(await seriousViolations()).toEqual([]);
    act(() => {
      model.value = "\u0000other";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    type(drawer.querySelector<HTMLInputElement>("[data-model-other]")!, "a-new-model");
    expect(drawer.querySelector("[data-model-warning]")).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });

  it("Team: rows selected for a bulk move, and an agent's drawer: no serious or critical violations", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    await signIn("owner-token");
    const el = await renderAt("#/settings?tab=team");
    act(() => el.querySelector<HTMLInputElement>('[data-select-agent="worker-a"]')!.click());
    expect(el.querySelector("[data-bulk]")).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
    const row = [...el.querySelectorAll<HTMLElement>("[data-team-agents] tbody tr")].find((r) => r.textContent?.includes("worker-b"))!;
    act(() => row.click());
    await settle();
    expect(el.querySelector('[role="dialog"]')?.querySelector("[data-model-select]")).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });
});
