/**
 * The dashboard's hash routes (router.ts): a URL per section, tab and open
 * detail, and the old views' ids redirecting to where each went.
 */
import { describe, expect, it } from "vitest";
import { HOME, LEGACY_VIEWS, linkTo, parseRoute, redirectFor, routeHash } from "./router";

describe("routes", () => {
  it("reads a section, its open detail, its tab and the project", () => {
    expect(parseRoute("")).toEqual(HOME);
    expect(parseRoute("#/")).toEqual(HOME);
    expect(parseRoute("#/work/kiro-A")).toEqual({ section: "work", tab: null, detail: "kiro-A", project: null });
    expect(parseRoute("#/gates/20261024T170000Z-api-abc123-1?tab=triage")).toEqual({
      section: "gates",
      tab: "triage",
      detail: "20261024T170000Z-api-abc123-1",
      project: null,
    });
    expect(parseRoute("#/prs/42?project=shop")).toEqual({ section: "prs", tab: null, detail: "42", project: "shop" });
    expect(parseRoute("#/decisions/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b").detail).toBe("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b");
  });

  it("writes the URL each route reads back", () => {
    for (const hash of ["#/", "#/work/kiro-A", "#/gates/run-0123456789ab?tab=pipelines", "#/prs/42?project=shop", "#/home?tab=health"]) {
      expect(routeHash(parseRoute(hash))).toBe(hash);
    }
    expect(linkTo("gates", "a b/c", "results")).toBe("#/gates/a%20b%2Fc?tab=results");
    expect(parseRoute(linkTo("gates", "a b/c")).detail).toBe("a b/c");
  });

  it("drops a tab its section doesn't have, and anything it can't read", () => {
    expect(parseRoute("#/gates?tab=nope")).toMatchObject({ section: "gates", tab: null });
    expect(parseRoute("#/nowhere/x")).toEqual(HOME);
    expect(parseRoute("#/work/%E0%A4%A")).toMatchObject({ section: "work", detail: null });
    expect(parseRoute(`#/work/${"a".repeat(500)}`).detail).toBeNull();
  });
});

describe("old view ids redirect to the section that replaced them", () => {
  it("maps every old view", () => {
    const where = (id: string) => routeHash(parseRoute(`#/${id}`));
    expect(where("overview")).toBe("#/");
    expect(where("dragons")).toBe("#/work");
    expect(where("agents")).toBe("#/work");
    expect(where("reviews")).toBe("#/prs");
    expect(where("nodes")).toBe("#/machines?tab=nodes");
    expect(where("health")).toBe("#/home?tab=health");
    expect(where("activity")).toBe("#/home?tab=activity");
    expect(where("orchestrator")).toBe("#/home?tab=activity");
    expect(where("triage")).toBe("#/gates?tab=triage");
    expect(where("inbox")).toBe("#/decisions?tab=messages");
    expect(where("planner")).toBe("#/work?tab=planner");
    // The sections that kept their name
    for (const id of ["gates", "prs", "machines", "decisions", "delivery", "processes", "settings"]) {
      expect(where(id)).toBe(`#/${id}`);
    }
    expect(Object.keys(LEGACY_VIEWS).sort()).toEqual(
      ["activity", "agents", "dragons", "health", "inbox", "nodes", "orchestrator", "overview", "planner", "reviews", "triage"],
    );
  });

  it("keeps the detail an old link names", () => {
    expect(redirectFor("#/dragons/kiro-A")).toBe("#/work/kiro-A");
    expect(redirectFor("#/agents/kiro-A")).toBe("#/work/kiro-A");
    expect(redirectFor("#/reviews/42")).toBe("#/prs/42");
    expect(redirectFor("#dragons")).toBe("#/work");
    expect(redirectFor("#/home")).toBe("#/");
  });

  it("leaves canonical URLs, an empty hash and the owner's setup link alone", () => {
    expect(redirectFor("#/work/kiro-A")).toBeNull();
    expect(redirectFor("#/")).toBeNull();
    expect(redirectFor("")).toBeNull();
    const setup = `#owner-token=${"x".repeat(43)}`;
    expect(redirectFor(setup)).toBeNull();
    expect(parseRoute(setup)).toEqual(HOME);
    // An inherited property name is not an old view
    expect(parseRoute("#/constructor")).toEqual(HOME);
    expect(redirectFor("#toString")).toBeNull();
  });
});
