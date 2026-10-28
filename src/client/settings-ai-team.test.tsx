// @vitest-environment jsdom
/**
 * Settings v2, S2-1 (docs/design/settings-v2.md): the AI and Team pages,
 * rendered in a DOM and driven as the owner would, against the real
 * Settings and AI tools routes (testing/settings-server.ts): real files,
 * the real parsers (the AI block's validation among them), the real model
 * lists and sign-in checks. Only the tools' command runner is fake: what
 * `kiro-cli` and a custom `agent-cli` answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { answer, settingsServer, type SettingsServer } from "./testing/settings-server";
import { button, choose, click, drawer, mountSettings, saveBar, setValue, unmountSettings, until } from "./testing/settings-dom";
import type { ToolRunOutput } from "../server/ai/index.js";

let server: SettingsServer | null = null;

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  unmountSettings();
  vi.unstubAllGlobals();
  await server?.close();
  server = null;
});

const AMBER_LINE = "      amber: [kiro-opus] # the default tier";

/**
 * A project with two profiles, its roles, three agents and a custom tool
 * with its own model list. Flow maps are written as Settings prints them
 * (no padding inside the braces), so a save changes only what it changes.
 */
function teamYaml(dir: string): string {
  const q = JSON.stringify;
  return [
    "# Shop: the example project of the AI and Team tests",
    "name: Shop",
    `repo: ${q(join(dir, "repo"))}`,
    "github: example/shop",
    `queue_file: ${q(join(dir, "queue.md"))}`,
    `agents_dir: ${q(join(dir, "agents"))}`,
    `gates_dir: ${q(join(dir, "gates"))}`,
    "agent_adapters:",
    "  test-cli:",
    "    id: test-cli",
    "    name: Test CLI",
    '    start_cmd: "agent-cli run --agent {agent_id} --model {model} --prompt {prompt_file}"',
    '    stop_cmd: "kill -TERM {pid}"',
    "    status_method: file",
    "    log_dir: logs",
    '    models_cmd: ["agent-cli", "models"]',
    "    models_parser: lines",
    "ai:",
    "  profiles:",
    "    kiro-opus: {tool: kiro, model: claude-opus-4.5}",
    "    kiro-cheap: {tool: kiro, model: claude-haiku-4.5}",
    "  roles:",
    "    build: [kiro-opus, kiro-cheap]",
    "    review:",
    AMBER_LINE,
    "dragons:",
    "  worker-a: {name: Worker A, profile: kiro-opus}",
    "  worker-b: {name: Worker B, adapter: kiro, model: claude-haiku-4.5}",
    "  worker-c: {name: Worker C}",
    "",
  ].join("\n");
}

const KIRO_MODELS = [
  "* auto  1.00x credits  Models chosen by task",
  "  claude-opus-4.5  2.20x credits  Claude Opus 4.5",
  "  claude-haiku-4.5  0.40x credits  Claude Haiku 4.5",
].join("\n");

let signedIn = false;

/** What the tools' own commands answer: their model lists, and Kiro's sign-in check. */
function tools(argv: string[]): ToolRunOutput | undefined {
  switch (argv.join(" ")) {
    case "kiro-cli chat --list-models":
      return answer(`${KIRO_MODELS}\n`);
    case "agent-cli models":
      return answer("model-x  Model X\n* model-y  Model Y\n");
    case "kiro-cli whoami":
      return signedIn ? answer("Logged in with Builder ID\n") : answer("Not logged in\n", 1);
    default:
      return undefined;
  }
}

async function open(hash: string, owner = true): Promise<HTMLElement> {
  signedIn = false;
  server = await settingsServer({ yaml: teamYaml, tools, programs: ["kiro-cli"] });
  vi.stubGlobal("fetch", server.fetch);
  if (owner) await server.signIn();
  return mountSettings(hash);
}

const options = (select: HTMLSelectElement | null | undefined) => [...(select?.options ?? [])].map((o) => o.textContent ?? "");
const values = (select: HTMLSelectElement | null | undefined) => [...(select?.options ?? [])].map((o) => o.value);
const filed = () => parseYaml(server!.read()) as Record<string, any>;

/** Review and save from the bar, then Save in the drawer; returns the drawer's diff text as it was shown. */
async function reviewAndSave(): Promise<{ keys: string[]; added: string[]; removed: string[] }> {
  click(button(saveBar()!, "Review and save"));
  await until("the dry run", () => drawer()?.querySelector("[data-settings-review]") != null);
  const panel = drawer()!;
  const shown = {
    keys: [...panel.querySelectorAll("[data-settings-changed-keys] code")].map((c) => c.textContent ?? ""),
    added: [...panel.querySelectorAll(".diff-line.text-success")].map((l) => l.textContent ?? ""),
    removed: [...panel.querySelectorAll(".diff-line.text-danger")].map((l) => l.textContent ?? ""),
  };
  expect(panel.querySelector("[data-settings-errors]"), panel.textContent ?? "").toBeNull();
  click(button(panel, "Save"));
  await until("the save", () => drawer() === null && saveBar() === null);
  return shown;
}

describe("acceptance (settings-v2.md, S2-1)", () => {
  it("a new user sets the reviewer for AMBER from a dropdown and saves, with no YAML seen; the diff shows exactly that key", async () => {
    const el = await open("#/settings?tab=ai");
    await until("the roles", () => el.querySelector('[data-role="review.amber"] select') !== null);
    const before = server!.read();
    const amber = el.querySelector<HTMLSelectElement>('[data-role="review.amber"] select[data-role-slot="0"]');
    expect(amber?.getAttribute("aria-label")).toBe("Reviewer for AMBER: primary");
    expect(amber?.value).toBe("kiro-opus");

    choose(amber, "kiro-cheap");
    expect(saveBar()?.textContent).toContain("1 unsaved change");
    const shown = await reviewAndSave();

    expect(shown.keys).toEqual(["ai.roles.review.amber"]);
    expect(shown.removed).toEqual([`-${AMBER_LINE}`]);
    expect(shown.added).toEqual(["+      amber: [kiro-cheap] # the default tier"]);
    expect(server!.read()).toBe(before.replace(AMBER_LINE, "      amber: [kiro-cheap] # the default tier"));
    // No YAML was seen: the YAML page was never opened, and no page showed the file as text
    expect(window.location.hash).toBe("#/settings?tab=ai");
    expect(server!.requests.some((r) => r.includes("tab=yaml"))).toBe(false);
    expect(document.querySelector("[data-settings-yaml]")).toBeNull();
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(el.querySelector("[data-settings-message]")?.textContent).toContain("Saved (version");
  });
});

describe("Settings → AI", () => {
  it("is the owner's: signed out, it asks the AI tools API nothing", async () => {
    const el = await open("#/settings?tab=ai", false);
    await until("the sign-in hint", () => el.querySelector('[data-owner-hint="signed-out"]') !== null);
    expect(server!.requests.filter((r) => r.includes("/api/ai") || r.includes("/api/settings"))).toEqual([]);
    expect(server!.runner.calls).toEqual([]);
  });

  it("Tools: per machine, installed, the version and the sign-in state with the exact fix; Refresh checks again", async () => {
    const el = await open("#/settings?tab=ai");
    await until("the tools", () => el.querySelector('[data-ai-tools] [data-sign-in]') !== null);
    const tools = el.querySelector("[data-ai-tools]")!;
    const kiro = [...tools.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes("Kiro CLI"))!;
    expect(kiro.textContent).toContain("local");
    expect(kiro.textContent).toContain("installed");
    expect(kiro.querySelector("[data-sign-in]")?.getAttribute("data-sign-in")).toBe("signed_out");
    expect(kiro.textContent).toContain("Run kiro-cli login in a terminal on this machine");
    // A tool no profile or agent names is listed apart
    expect(tools.querySelector("details")?.textContent).toContain("Test CLI");

    signedIn = true;
    click(button(tools, "Refresh"));
    await until("the check again", () => tools.querySelector('[data-sign-in="signed_in"]') !== null);
    expect(server!.requests).toContain("POST /api/ai/tools/refresh");
    expect(server!.runner.calls.filter((c) => c === "kiro-cli whoami")).toHaveLength(2);
  });

  it("Profiles: the model dropdown is the chosen tool's own list, refilled when the tool changes", async () => {
    const el = await open("#/settings?tab=ai");
    await until("the profiles", () => el.querySelector("[data-ai-profiles] tbody tr") !== null);
    click(button(el.querySelector("[data-ai-profiles]")!, "Add a profile"));
    const panel = drawer()!;
    expect(panel.querySelector("[data-model-select]")!.hasAttribute("disabled")).toBe(true);
    const tool = panel.querySelector<HTMLSelectElement>("[data-tool-select]")!;
    // The presets, then the project's own adapters
    expect([...tool.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Presets", "This project's adapters"]);

    choose(tool, "test-cli");
    const model = () => drawer()!.querySelector<HTMLSelectElement>("[data-model-select]");
    await until("test-cli's models", () => values(model()).includes("model-x"));
    expect(options(model())).toEqual(expect.arrayContaining(["model-x: Model X", "model-y: Model Y · default", "Other…"]));
    expect(server!.runner.calls).toContain("agent-cli models");

    choose(tool, "kiro");
    await until("kiro's models", () => values(model()).includes("claude-opus-4.5"));
    expect(values(model())).not.toContain("model-x");
    expect(options(model())).toEqual(
      expect.arrayContaining(["auto: Models chosen by task · default · 1.00x credits", "claude-opus-4.5: Claude Opus 4.5 · 2.20x credits"]),
    );
    expect(server!.runner.calls).toContain("kiro-cli chat --list-models");
  });

  it("Profiles: Other… takes a typed model with a warning, and saves it", async () => {
    const el = await open("#/settings?tab=ai");
    await until("the profiles", () => el.querySelector("[data-ai-profiles] tbody tr") !== null);
    click(button(el.querySelector("[data-ai-profiles]")!, "Add a profile"));
    setValue(drawer()!.querySelector<HTMLInputElement>("[data-profile-name]")!, "custom");
    choose(drawer()!.querySelector("[data-tool-select]"), "test-cli");
    const model = () => drawer()!.querySelector<HTMLSelectElement>("[data-model-select]");
    await until("test-cli's models", () => values(model()).includes("model-x"));
    expect(drawer()!.querySelector("[data-model-warning]")).toBeNull();

    choose(model(), "\u0000other");
    setValue(drawer()!.querySelector<HTMLInputElement>("[data-model-other]")!, "model-z");
    expect(drawer()!.querySelector("[data-model-warning]")?.textContent).toContain("test-cli doesn't list model-z");
    click(button(drawer()!, "Add"));
    expect(drawer()).toBeNull();
    expect(el.querySelector("[data-ai-profiles]")!.textContent).toContain("model-z");

    const shown = await reviewAndSave();
    expect(shown.keys).toEqual(["ai.profiles.custom"]);
    // Saved as typed: a warning, never a refusal
    expect(filed().ai.profiles.custom).toEqual({ tool: "test-cli", model: "model-z" });
  });

  it("Roles: an ordered list per role; the editor saves the new order", async () => {
    const el = await open("#/settings?tab=ai");
    await until("the roles", () => el.querySelector('[data-role="build"] [data-role-entry]') !== null);
    const before = server!.read();
    const build = el.querySelector('[data-role="build"]')!;
    expect([...build.querySelectorAll<HTMLSelectElement>("select[data-role-slot]")].map((s) => s.value)).toEqual(["kiro-opus", "kiro-cheap"]);
    click(build.querySelector('[data-role-entry="kiro-cheap"] [data-move="up"]'));
    expect([...build.querySelectorAll<HTMLSelectElement>("select[data-role-slot]")].map((s) => s.value)).toEqual(["kiro-cheap", "kiro-opus"]);
    expect(build.querySelector('[data-role-entry="kiro-cheap"]')?.textContent).toContain("primary");

    const shown = await reviewAndSave();
    expect(shown.keys).toEqual(["ai.roles.build"]);
    expect(server!.read()).toBe(before.replace("build: [kiro-opus, kiro-cheap]", "build: [kiro-cheap, kiro-opus]"));
  });
});

describe("Settings → Team", () => {
  it("lists the agents with their role, profile or tool + model, and machine", async () => {
    const el = await open("#/settings?tab=team");
    await until("the agents", () => el.querySelectorAll("[data-team-agents] tbody tr").length === 3);
    const runs = (id: string) => el.querySelector(`[data-runs="${id}"]`)?.textContent;
    expect(runs("worker-a")).toBe("kiro-opus (kiro + claude-opus-4.5)");
    expect(runs("worker-b")).toBe("kiro + claude-haiku-4.5");
    expect(runs("worker-c")).toBe("kiro-opus, its role's first profile");
    expect(el.querySelector("[data-team-agents] tbody")!.textContent).toContain("build");
  });

  it("bulk: select rows, then move them to a profile", async () => {
    const el = await open("#/settings?tab=team");
    await until("the agents", () => el.querySelectorAll("[data-team-agents] tbody tr").length === 3);
    click(el.querySelector('[data-select-agent="worker-b"]'));
    click(el.querySelector('[data-select-agent="worker-c"]'));
    // Selecting is not opening
    expect(drawer()).toBeNull();
    const bulk = el.querySelector<HTMLElement>("[data-bulk]")!;
    expect(bulk.textContent).toContain("2 selected");
    choose(bulk.querySelector("select"), "kiro-cheap");
    click(button(bulk, "Move"));
    expect(el.querySelector("[data-bulk]")).toBeNull();
    expect(el.querySelector('[data-runs="worker-b"]')?.textContent).toBe("kiro-cheap (kiro + claude-haiku-4.5)");

    const shown = await reviewAndSave();
    expect(shown.keys).toEqual(expect.arrayContaining(["dragons.worker-b.profile", "dragons.worker-b.adapter", "dragons.worker-c.profile"]));
    const dragons = filed().dragons;
    expect(dragons["worker-b"]).toEqual({ name: "Worker B", profile: "kiro-cheap" });
    expect(dragons["worker-c"]).toEqual({ name: "Worker C", profile: "kiro-cheap" });
    expect(dragons["worker-a"]).toEqual({ name: "Worker A", profile: "kiro-opus" });
  });

  it("adds an agent in a drawer, on a tool and a model from that tool's own list", async () => {
    const el = await open("#/settings?tab=team");
    await until("the agents", () => el.querySelectorAll("[data-team-agents] tbody tr").length === 3);
    click(button(el.querySelector("[data-team-agents]")!, "Add an agent"));
    setValue(drawer()!.querySelector<HTMLInputElement>("[data-agent-id]")!, "worker-d");
    click(drawer()!.querySelector('[data-runs-on="own"]'));
    choose(drawer()!.querySelector("[data-tool-select]"), "test-cli");
    const model = () => drawer()!.querySelector<HTMLSelectElement>("[data-model-select]");
    await until("test-cli's models", () => values(model()).includes("model-y"));
    choose(model(), "model-y");
    click(button(drawer()!, "Add"));
    expect(el.querySelector('[data-runs="worker-d"]')?.textContent).toBe("test-cli + model-y");

    await reviewAndSave();
    expect(filed().dragons["worker-d"]).toEqual({ adapter: "test-cli", model: "model-y" });
  });
});
