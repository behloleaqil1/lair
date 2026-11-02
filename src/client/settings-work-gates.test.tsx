// @vitest-environment jsdom
/**
 * Settings → Work and Gates (docs/design/settings-v2.md, S2-2), rendered in a
 * DOM with the real registry's sections: an edit inside a list item keeps the
 * list a list, a search pick focuses the field itself, and the pipelines empty
 * state adds the first pipeline. The draft goes back through `onDraft`, as the
 * shell's draft does.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsGates } from "./components/SettingsGates";
import { SettingsWork } from "./components/SettingsWork";
import type { PageFocus } from "./components/SettingsAi";
import { settingsSections } from "../server/settings/index.js";
import type { KnownValues } from "../shared/settings-types";
import { button, click, setValue } from "./testing/settings-dom";

const KNOWN: KnownValues = { agents: [], adapters: [], models: [], lanes: [], machines: [], profiles: [] };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount a page on `start`; returns the latest draft the page handed back */
function mount(page: "work" | "gates", start: Record<string, unknown>, focus: PageFocus | null = null): () => Record<string, unknown> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let latest = start;
  function Host() {
    const [draft, setDraft] = useState(start);
    const props = {
      project: "shop",
      draft,
      sections: settingsSections(),
      known: KNOWN,
      errors: [],
      disabled: false,
      focus,
      onDraft: (next: Record<string, unknown>) => {
        latest = next;
        setDraft(next);
      },
    };
    return page === "work" ? <SettingsWork {...props} /> : <SettingsGates {...props} />;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Host />));
  return () => latest;
}

const input = (path: string) => document.querySelector<HTMLInputElement>(`[data-field="${path}"] input`);

const STEPS = [
  { name: "lint", run: ["npm", "run", "lint"] },
  { name: "test", run: ["npm", "test"] },
];

describe("Settings → Gates", () => {
  it("editing a field of a list item (pipelines.*.steps[i].name) keeps steps a list", () => {
    const draft = mount("gates", { pipelines: { ci: { steps: STEPS } } }, { key: "pipelines.ci.steps.0.name", nonce: 1 });
    const field = input("pipelines.ci.steps.0.name");
    expect(field, "the step name control").toBeTruthy();
    setValue(field!, "lint-all");
    const steps = (draft().pipelines as { ci: { steps: unknown } }).ci.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toEqual([{ ...STEPS[0], name: "lint-all" }, STEPS[1]]);
  });

  it("clearing a field of a list item keeps the list and drops only that key", () => {
    const draft = mount("gates", { pipelines: { ci: { steps: STEPS } } }, { key: "pipelines.ci.steps.1.name", nonce: 1 });
    setValue(input("pipelines.ci.steps.1.name")!, "");
    expect((draft().pipelines as { ci: { steps: unknown } }).ci.steps).toEqual([STEPS[0], { run: ["npm", "test"] }]);
  });

  it("editing a triage.trusted_nodes item keeps trusted_nodes a list", () => {
    const nodes = [{ id: "a", public_key_file: "a.pem" }];
    const draft = mount("gates", { triage: { trusted_nodes: nodes } }, { key: "triage.trusted_nodes.0.id", nonce: 1 });
    setValue(input("triage.trusted_nodes.0.id")!, "b");
    expect((draft().triage as { trusted_nodes: unknown }).trusted_nodes).toEqual([{ id: "b", public_key_file: "a.pem" }]);
  });

  it("a search pick focuses the field itself, not the summary card", () => {
    mount("gates", { triage: { enabled: true, recheck: { max_retries: 2 } } }, { key: "triage.recheck.max_retries", nonce: 1 });
    const field = input("triage.recheck.max_retries");
    expect(field).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  it("with no pipelines, the empty state adds the first one by name and opens its steps", () => {
    const draft = mount("gates", {});
    const add = button(document.body, "Add pipeline");
    expect(add, "the empty state's add button").toBeTruthy();
    expect(add!.disabled).toBe(true);
    setValue(document.querySelector<HTMLInputElement>('[aria-label="New pipeline name"]')!, "ci");
    click(button(document.body, "Add pipeline"));
    expect(draft().pipelines).toEqual({ ci: { steps: [] } });
    expect(document.querySelector('[data-field="pipelines.ci.steps"]')).toBeTruthy();
    expect(button(document.body, "Add pipeline")).toBeUndefined();
  });

  it("refuses a pipeline name the schema refuses", () => {
    mount("gates", {});
    setValue(document.querySelector<HTMLInputElement>('[aria-label="New pipeline name"]')!, "-bad");
    expect(button(document.body, "Add pipeline")!.disabled).toBe(true);
  });

  it("shows on and off with the kit's status badges", () => {
    mount("gates", { triage: { enabled: true }, placement: { enabled: false } });
    const card = (attr: string) => document.querySelector(`[${attr}]`)!;
    expect(card("data-gates-triage").querySelector('[data-status="ok"]')?.textContent).toContain("enabled");
    expect(card("data-gates-placement").querySelector('[data-status="off"]')?.textContent).toContain("disabled");
  });
});

describe("Settings → Work", () => {
  it("editing a field of an agents.locks item keeps locks a list", () => {
    const locks = [{ name: "build", path: "/tmp/build.lock" }];
    const draft = mount("work", { agents: { locks } }, { key: "agents.locks.0.path", nonce: 1 });
    const field = input("agents.locks.0.path");
    expect(field, "the lock path control").toBeTruthy();
    setValue(field!, "/tmp/other.lock");
    expect((draft().agents as { locks: unknown }).locks).toEqual([{ name: "build", path: "/tmp/other.lock" }]);
  });

  it("a search pick focuses the field itself, not the Task source card", () => {
    mount("work", { agents: { fill: { max_active: 2 } } }, { key: "agents.fill.max_active", nonce: 1 });
    const field = input("agents.fill.max_active");
    expect(field).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });
});
