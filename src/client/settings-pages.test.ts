/**
 * Settings pages: routing from YAML keys to their page, and the page definitions.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS_PAGES, pageForKey, pageOf, tabOf, unsavedText } from "./settings-pages";

describe("SETTINGS_PAGES", () => {
  it("has all expected pages in order", () => {
    const ids = SETTINGS_PAGES.map((p) => p.id);
    expect(ids).toEqual(["overview", "ai", "team", "work", "gates", "classic", "yaml", "history"]);
  });

  it("every page has an about text", () => {
    for (const page of SETTINGS_PAGES) {
      expect(page.about.length, page.id).toBeGreaterThan(10);
    }
  });
});

describe("pageForKey", () => {
  it("routes AI keys to the ai page", () => {
    expect(pageForKey("ai")).toBe("ai");
    expect(pageForKey("ai.profiles")).toBe("ai");
    expect(pageForKey("ai.profiles.fast")).toBe("ai");
    expect(pageForKey("ai.roles")).toBe("ai");
    expect(pageForKey("ai.roles.build")).toBe("ai");
    expect(pageForKey("ai.roles.review.red")).toBe("ai");
  });

  it("routes dragons keys to the team page", () => {
    expect(pageForKey("dragons")).toBe("team");
    expect(pageForKey("dragons.kiro-A")).toBe("team");
    expect(pageForKey("dragons.kiro-A.model")).toBe("team");
  });

  it("routes agents keys to the work page", () => {
    expect(pageForKey("agents")).toBe("work");
    expect(pageForKey("agents.enabled")).toBe("work");
    expect(pageForKey("agents.fill")).toBe("work");
    expect(pageForKey("agents.fill.enabled")).toBe("work");
    expect(pageForKey("agents.fill.tasks_file")).toBe("work");
    expect(pageForKey("agents.recovery")).toBe("work");
    expect(pageForKey("agents.budgets")).toBe("work");
    expect(pageForKey("agents.failover")).toBe("work");
  });

  it("routes pipelines keys to the gates page", () => {
    expect(pageForKey("pipelines")).toBe("gates");
    expect(pageForKey("pipelines.ci")).toBe("gates");
    expect(pageForKey("pipelines.ci.steps")).toBe("gates");
  });

  it("routes executors keys to the gates page", () => {
    expect(pageForKey("executors")).toBe("gates");
    expect(pageForKey("executors.github")).toBe("gates");
    expect(pageForKey("executors.local")).toBe("gates");
    expect(pageForKey("executors.order")).toBe("gates");
  });

  it("routes triage keys to the gates page", () => {
    expect(pageForKey("triage")).toBe("gates");
    expect(pageForKey("triage.enabled")).toBe("gates");
    expect(pageForKey("triage.mode")).toBe("gates");
    expect(pageForKey("triage.infra_patterns")).toBe("gates");
    expect(pageForKey("triage.recheck")).toBe("gates");
    expect(pageForKey("triage.flaky")).toBe("gates");
    expect(pageForKey("triage.bisect")).toBe("gates");
  });

  it("routes placement keys to the gates page", () => {
    expect(pageForKey("placement")).toBe("gates");
    expect(pageForKey("placement.enabled")).toBe("gates");
    expect(pageForKey("placement.mode")).toBe("gates");
    expect(pageForKey("placement.machines")).toBe("gates");
    expect(pageForKey("placement.lanes")).toBe("gates");
  });

  it("routes other keys to classic", () => {
    expect(pageForKey("watchdog")).toBe("classic");
    expect(pageForKey("delivery")).toBe("classic");
    expect(pageForKey("review")).toBe("classic");
    expect(pageForKey("machines")).toBe("classic");
    expect(pageForKey("name")).toBe("classic");
    expect(pageForKey("repo")).toBe("classic");
  });

  it("returns overview for empty key", () => {
    expect(pageForKey("")).toBe("overview");
  });
});

describe("pageOf", () => {
  it("returns overview for null or unknown tab", () => {
    expect(pageOf(null)).toBe("overview");
    expect(pageOf("unknown")).toBe("overview");
  });

  it("returns the page for known tabs", () => {
    expect(pageOf("ai")).toBe("ai");
    expect(pageOf("team")).toBe("team");
    expect(pageOf("work")).toBe("work");
    expect(pageOf("gates")).toBe("gates");
    expect(pageOf("classic")).toBe("classic");
    expect(pageOf("yaml")).toBe("yaml");
    expect(pageOf("history")).toBe("history");
  });
});

describe("tabOf", () => {
  it("returns null for overview", () => {
    expect(tabOf("overview")).toBeNull();
  });

  it("returns the page id for other pages", () => {
    expect(tabOf("ai")).toBe("ai");
    expect(tabOf("team")).toBe("team");
    expect(tabOf("work")).toBe("work");
    expect(tabOf("gates")).toBe("gates");
    expect(tabOf("classic")).toBe("classic");
  });
});

describe("unsavedText", () => {
  it("singularizes for 1 change", () => {
    expect(unsavedText(1)).toBe("1 unsaved change");
  });

  it("pluralizes for other counts", () => {
    expect(unsavedText(0)).toBe("0 unsaved changes");
    expect(unsavedText(2)).toBe("2 unsaved changes");
    expect(unsavedText(10)).toBe("10 unsaved changes");
  });
});
