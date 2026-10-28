// @vitest-environment jsdom
/**
 * Settings v2, S2-1 (docs/design/settings-v2.md): the shell, its search, the
 * sticky save bar and the Overview checklist, rendered in a DOM and driven
 * as the owner would, against the real Settings, AI tools and notification
 * routes (testing/settings-server.ts): real files, the real parsers, the
 * real history. Only the tools' command runner is fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { writeFileSync } from "fs";
import { join } from "path";
import { parseRoute } from "./router";
import { fieldIndex, searchSettings } from "./settings-search";
import { setupChecklist, type ChecklistInput } from "./setup-checklist";
import { settingsSections } from "../server/settings/index.js";
import { answer, settingsServer, type SettingsServer, type SettingsServerOptions } from "./testing/settings-server";
import {
  button,
  click,
  drawer,
  goTo,
  key,
  mountSettings,
  saveBar,
  setValue,
  settle,
  unmountSettings,
  until,
} from "./testing/settings-dom";

let server: SettingsServer | null = null;

// Each test starts a server and runs git: more than the default five seconds on a slow runner
vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  unmountSettings();
  vi.unstubAllGlobals();
  await server?.close();
  server = null;
});

/** The project of these tests: comments and flow lists that a save must keep. */
function shopYaml(dir: string, extra = ""): string {
  const q = JSON.stringify;
  return [
    "# Shop: the example project of the Settings tests",
    "name: Shop",
    `repo: ${q(join(dir, "repo"))}`,
    "github: example/shop",
    `queue_file: ${q(join(dir, "queue.md"))}`,
    `agents_dir: ${q(join(dir, "agents"))}`,
    `gates_dir: ${q(join(dir, "gates"))}`,
    "watchdog:",
    "  enabled: true",
    "  interval_seconds: 60 # once a minute",
    "  mode: observe",
    "delivery:",
    "  enabled: false",
    "  interval_seconds: 30",
    extra,
  ].join("\n");
}

async function open(options: Partial<SettingsServerOptions> & { hash?: string; owner?: boolean } = {}): Promise<HTMLElement> {
  server = await settingsServer({ yaml: (dir) => shopYaml(dir), ...options });
  vi.stubGlobal("fetch", server.fetch);
  if (options.owner !== false) await server.signIn();
  return mountSettings(options.hash ?? "#/settings");
}

describe("Settings is the owner's", () => {
  it("signed out, shows the sign-in hint and reads nothing of the project, the tools or the notifications", async () => {
    const el = await open({ owner: false });
    await until("the sign-in hint", () => el.querySelector('[data-owner-hint="signed-out"]') !== null);
    expect(el.textContent).toContain("Reading and changing settings needs this browser to be signed in as the owner");
    expect(server!.requests.filter((r) => /\/api\/(settings|ai|owner\/notifications)/.test(r))).toEqual([]);
    expect(el.querySelector("[data-settings-view]")).toBeNull();
  });
});

describe("the search", () => {
  it("finds a field by its YAML key and by its help text, through the registry", () => {
    const index = fieldIndex(settingsSections());
    const byKey = searchSettings(index, "interval_seconds", 50).map((h) => h.entry.key);
    expect(byKey).toEqual(expect.arrayContaining(["watchdog.interval_seconds", "delivery.interval_seconds"]));
    expect(searchSettings(index, "watchdog.interval_seconds")[0]).toMatchObject({ matched: "key", entry: { key: "watchdog.interval_seconds" } });
    const byHelp = searchSettings(index, "observe reports only; act runs the playbooks");
    expect(byHelp[0]).toMatchObject({ matched: "help", entry: { key: "watchdog.mode", sectionTitle: "Watchdog" } });
    // By label, and at every level: an advanced field is found too
    expect(searchSettings(index, "reviewer for amber")[0].entry).toMatchObject({ key: "ai.roles.review.amber", label: "Reviewer for AMBER" });
    expect(searchSettings(index, "command_timeout_seconds").map((h) => h.entry.level)).toContain("advanced");
    // A record's entries are found by their pattern
    expect(searchSettings(index, "dragons.*.profile")[0].entry).toMatchObject({ key: "dragons.*.profile", label: "AI profile" });
  });

  it("in the page: ⌘K focuses the box, typing lists the matches, Enter opens the field on its page, focused", async () => {
    const el = await open();
    await until("the project", () => el.querySelector('[data-settings-page="overview"]') !== null);
    const box = el.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(box);

    setValue(box, "act runs the playbooks");
    const list = document.getElementById(box.getAttribute("aria-controls")!)!;
    expect(box.getAttribute("aria-expanded")).toBe("true");
    const first = list.querySelector('[role="option"]')!;
    expect(first.getAttribute("data-key")).toBe("watchdog.mode");
    // A match in the help shows the help
    expect(first.textContent).toContain("observe reports only");

    setValue(box, "interval_seconds");
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("data-key"))).toEqual(
      expect.arrayContaining(["watchdog.interval_seconds", "delivery.interval_seconds"]),
    );
    key(box, "ArrowDown");
    expect(box.getAttribute("aria-activedescendant")).toBe(list.querySelector('[role="option"]')!.id);
    const picked = list.querySelector('[role="option"]')!.getAttribute("data-key")!;
    key(box, "Enter");
    await settle();
    expect(parseRoute(window.location.hash)).toMatchObject({ section: "settings", tab: "classic", detail: picked });
    const field = el.querySelector(`[data-field="${picked}"]`)!;
    expect(field, el.textContent?.slice(0, 1500)).not.toBeNull();
    expect(field.hasAttribute("data-focused")).toBe(true);
    expect(field.contains(document.activeElement)).toBe(true);
  });
});

describe("the save bar: one draft for every page, saved through the phase-1 path", () => {
  it("counts the changes, then the drawer runs the dry run and shows the diff, and Save writes exactly them", async () => {
    const el = await open({ hash: "#/settings/watchdog.interval_seconds?tab=classic" });
    await until("the watchdog field", () => el.querySelector('[data-field="watchdog.interval_seconds"] input') !== null);
    const before = server!.read();
    expect(saveBar()).toBeNull();

    setValue(el.querySelector<HTMLInputElement>('[data-field="watchdog.interval_seconds"] input')!, "120");
    expect(saveBar()?.textContent).toContain("1 unsaved change");
    await goTo("#/settings/delivery.interval_seconds?tab=classic");
    await until("the delivery field", () => el.querySelector('[data-field="delivery.interval_seconds"] input') !== null);
    setValue(el.querySelector<HTMLInputElement>('[data-field="delivery.interval_seconds"] input')!, "45");
    expect(saveBar()?.textContent).toContain("2 unsaved changes");
    // Another page keeps the draft
    await goTo("#/settings");
    expect(saveBar()?.textContent).toContain("2 unsaved changes");

    click(button(saveBar()!, "Review and save"));
    await until("the dry run", () => drawer()?.querySelector("[data-settings-review]") !== null);
    expect(server!.requests).toContain("POST /api/settings/validate");
    const panel = drawer()!;
    expect(panel.getAttribute("aria-labelledby")).toBeTruthy();
    expect([...panel.querySelectorAll("[data-settings-changed-keys] code")].map((c) => c.textContent)).toEqual([
      "watchdog.interval_seconds",
      "delivery.interval_seconds",
    ]);
    const diff = panel.querySelector("[data-diff]")!.textContent!;
    expect(diff).toContain("+  interval_seconds: 120 # once a minute");
    expect(diff).toContain("-  interval_seconds: 60 # once a minute");
    expect(diff).toContain("+  interval_seconds: 45");
    // A dry run writes nothing
    expect(server!.read()).toBe(before);

    click(button(panel, "Save"));
    await until("the save", () => drawer() === null && saveBar() === null);
    expect(server!.read()).toBe(
      before.replace("interval_seconds: 60 # once a minute", "interval_seconds: 120 # once a minute").replace("interval_seconds: 30", "interval_seconds: 45"),
    );
    expect(el.querySelector("[data-settings-message]")?.textContent).toContain("Saved (version");
  });

  it("on a file changed meanwhile (409), offers to review the same change again on top of the current file", async () => {
    const el = await open({ hash: "#/settings/watchdog.interval_seconds?tab=classic" });
    await until("the watchdog field", () => el.querySelector('[data-field="watchdog.interval_seconds"] input') !== null);
    setValue(el.querySelector<HTMLInputElement>('[data-field="watchdog.interval_seconds"] input')!, "90");
    // A hand edit after the page loaded the file
    const handEdited = server!.read().replace("interval_seconds: 30", "interval_seconds: 35");
    writeFileSync(server!.file, handEdited);

    click(button(saveBar()!, "Review and save"));
    await until("the dry run", () => drawer()?.querySelector("[data-settings-review]") !== null);
    expect(drawer()!.textContent).toContain("The file changed on disk since you loaded it");
    expect(button(drawer()!, "Save")!.disabled).toBe(true);

    click(button(drawer()!, "Review again on top of the current file"));
    await until(
      "the dry run on the current file",
      () => drawer()?.querySelector("[data-settings-review]") != null && !drawer()!.textContent!.includes("The file changed on disk"),
    );
    expect(drawer()!.textContent).toContain("made your changes again on top of it");
    const diff = drawer()!.querySelector("[data-diff]")!.textContent!;
    expect(diff).toContain("+  interval_seconds: 90 # once a minute");
    expect(diff).not.toContain("interval_seconds: 35");
    click(button(drawer()!, "Save"));
    await until("the save", () => drawer() === null);
    expect(server!.read()).toBe(handEdited.replace("interval_seconds: 60 # once a minute", "interval_seconds: 90 # once a minute"));
  });

  it("the YAML page saves through the same bar, and a command needs its confirmation in the drawer", async () => {
    const el = await open({ hash: "#/settings?tab=yaml" });
    await until("the YAML", () => el.querySelector<HTMLTextAreaElement>("[data-settings-yaml]")?.value.includes("Shop") === true);
    const text = el.querySelector<HTMLTextAreaElement>("[data-settings-yaml]")!;
    const edited = `${server!.read()}\ndragon_start_cmd: ["./bin/start", "{dragon}"]\n`;
    setValue(text, edited);
    expect(saveBar()?.textContent).toContain("The YAML is edited");

    click(button(saveBar()!, "Review and save"));
    await until("the dry run", () => drawer()?.querySelector("[data-settings-commands]") !== null);
    expect(drawer()!.querySelector("[data-settings-commands]")!.textContent).toContain('["./bin/start","{dragon}"]');
    const save = button(drawer()!, "Save")!;
    expect(save.disabled).toBe(true);
    click(drawer()!.querySelector('[data-settings-commands] input[type="checkbox"]'));
    expect(button(drawer()!, "Save")!.disabled).toBe(false);
    click(button(drawer()!, "Save"));
    await until("the save", () => drawer() === null);
    expect(server!.read()).toBe(edited);
  });
});

describe("Overview: the setup checklist", () => {
  const status = (el: HTMLElement, part: string) => el.querySelector(`[data-part="${part}"]`)?.getAttribute("data-status");
  const detail = (el: HTMLElement, part: string) => el.querySelector(`[data-part="${part}"] .checklist-detail`)?.textContent;

  it("shows each part's state from the real routes, with a link to its fix, and nothing of the tools' output", async () => {
    const el = await open({
      origin: "https://github.com/example/shop.git",
      programs: ["kiro-cli"],
      tools: (argv) => {
        const command = argv.join(" ");
        if (command === "kiro-cli whoami") return answer("Not logged in. Sign in at https://example-org.awsapps.com/start/\n", 1);
        if (command === "kiro-cli --version") return answer("kiro-cli 1.2.3\n");
        return undefined;
      },
      yaml: (dir) =>
        shopYaml(
          dir,
          [
            "ai:",
            "  profiles:",
            "    kiro-opus: { tool: kiro, model: claude-opus-4.5 }",
            "dragons:",
            "  builder: { name: Builder, profile: kiro-opus }",
            "  helper: { name: Helper }",
          ].join("\n"),
        ),
    });
    await until("the checks", () => el.querySelectorAll('[data-status="waiting"]').length === 0 && el.querySelector("[data-part]") !== null);
    expect(status(el, "repository")).toBe("ok");
    expect(detail(el, "repository")).toContain("on GitHub as example/shop");
    expect(status(el, "ai")).toBe("attention");
    expect(detail(el, "ai")).toBe("Kiro CLI is not signed in on this machine: run kiro-cli login in a terminal there");
    expect(status(el, "agents")).toBe("ok");
    expect(detail(el, "agents")).toBe("2 agents, 1 on an AI profile");
    expect(status(el, "gates")).toBe("off");
    expect(status(el, "machines")).toBe("ok");
    expect(detail(el, "machines")).toBe("This machine only");
    expect(status(el, "notifications")).toBe("off");
    expect(status(el, "reviews")).toBe("off");
    // Each part links to where it is set
    expect(el.querySelector('[data-part="reviews"] a')?.getAttribute("href")).toBe("#/settings/review?tab=classic");
    // The sign-in check's output (an organisation's portal) is never shown
    expect(el.textContent).not.toContain("awsapps");
    expect(server!.runner.calls).toContain("kiro-cli whoami");
    expect(el.textContent).toContain("3 of 7 parts ok; 1 needs you");
  });

  it("the rules of each part", () => {
    const base: ChecklistInput = {
      project: null,
      values: {},
      errors: [],
      repo: { state: "loading" },
      tools: { state: "loading" },
      machines: { state: "loading" },
      notifications: { state: "loading" },
    };
    const part = (input: Partial<ChecklistInput>, id: string) => setupChecklist({ ...base, ...input }).find((i) => i.part === id)!;
    const repo = { path: "/r", exists: true, gitRepo: true, github: "a/b", remotes: [{ name: "origin", url: "x", github: "a/b" }], suggested: { queue_file: "", agents_dir: "", gates_dir: "" } };

    expect(part({ values: { repo: "/r" } }, "repository").status).toBe("waiting");
    expect(part({ values: { repo: "/r", github: "a/c" }, repo: { state: "ok", data: repo } }, "repository")).toMatchObject({
      status: "attention",
      detail: expect.stringContaining("github is a/c, but no remote of /r is that repository"),
    });
    expect(part({ values: { repo: "/r" }, errors: [{ path: "github", message: "use owner/name" }] }, "repository").status).toBe("attention");

    const signedIn = {
      project: "p",
      notes: [],
      tools: [
        {
          id: "kiro",
          name: "Kiro CLI",
          experimental: false,
          program: "kiro-cli",
          signInCheck: true,
          modelsCmd: true,
          knownModels: 0,
          inUse: true,
          machines: [
            {
              machine: "local",
              installed: true,
              path: "/bin/kiro-cli",
              version: null,
              signIn: { state: "signed_in" as const, as: null, detail: "signed in", fix: null },
              checkedAt: "",
            },
          ],
        },
      ],
    };
    expect(part({ tools: { state: "ok", data: signedIn } }, "ai")).toMatchObject({ status: "ok", detail: "Kiro CLI: signed in" });
    expect(part({ tools: { state: "ok", data: { ...signedIn, tools: [] } } }, "ai").status).toBe("off");
    expect(part({ tools: { state: "error", error: "HTTP 500" } }, "ai").status).toBe("attention");

    const machines = { "build-2": { type: "ssh", host: "build-2.lan" } };
    expect(part({ values: { machines }, machines: { state: "ok", data: [{ name: "build-2", type: "ssh", up: false }] } }, "machines")).toMatchObject({
      status: "attention",
      detail: "build-2 doesn't answer",
    });
    expect(part({ values: { machines }, machines: { state: "ok", data: [{ name: "build-2", type: "ssh", up: true }] } }, "machines").status).toBe("ok");
    expect(part({ values: { dragons: { a: { machine: "gpu-1" } } } }, "machines").detail).toBe("a runs on gpu-1, which is not one of the project's machines");

    const review = { enabled: true, prompt_file: "review.md" };
    expect(part({ values: { review } }, "reviews").status).toBe("attention");
    expect(part({ values: { review, ai: { roles: { review: { amber: ["kiro-opus"] } } } } }, "reviews")).toMatchObject({
      status: "ok",
      detail: "RED: a human (default); AMBER: kiro-opus; GREEN: a self-check (default)",
    });

    const notifications = {
      settings: { desktop: false, ntfyUrl: "https://ntfy.sh/t", ntfyTokenFile: false, reminderHours: 4, enabled: true },
      errors: [],
      desktopAvailable: { ok: false, detail: "no notify-send" },
      last: null,
      lastReminderAt: null,
    };
    expect(part({ notifications: { state: "ok", data: notifications } }, "notifications")).toMatchObject({ status: "ok", detail: "On: phone (ntfy)" });
    expect(part({ notifications: { state: "ok", data: { ...notifications, errors: ["data/server.yaml is writable by others"] } } }, "notifications").status).toBe(
      "attention",
    );
    expect(part({ values: { pipelines: { ci: {} } } }, "gates")).toMatchObject({ status: "ok", detail: "1 pipeline: ci" });
  });
});
