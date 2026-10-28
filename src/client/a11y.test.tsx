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
import { fixtureFetch } from "./a11y-fixtures";
import { signIn } from "./owner-session";
import { applyPreferences } from "./ui/preferences";

/** Each top-level view: its URL, and a text that says it rendered with its data */
const VIEWS: { name: string; hash: string; shows: string }[] = [
  { name: "Home", hash: "#/", shows: "worker-a is paused" },
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
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
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
      expect(el.textContent).toContain(view.shows);
      expect(await seriousViolations()).toEqual([]);
    });

    it(`${view.name}, signed in as the owner, dark and compact: no serious or critical violations`, async () => {
      await signIn("owner-token");
      applyPreferences({ theme: "dark", density: "compact" });
      const el = await renderAt(view.hash);
      expect(el.textContent).toContain(view.shows);
      // The owner's footer controls are there, so the signed-in markup is the one checked
      expect(el.querySelector('[data-server-controls="owner"]')).not.toBeNull();
      expect(await seriousViolations()).toEqual([]);
      applyPreferences({ theme: "system", density: "comfortable" });
    });
  }

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
