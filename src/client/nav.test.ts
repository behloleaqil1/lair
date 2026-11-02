/**
 * The nav (nav.ts): about eight sections, only those whose module the
 * project turns on, and the tabs within them; the owner's message file is a
 * tab of Decisions, apart from the decisions themselves.
 */
import { describe, expect, it } from "vitest";
import type { ModuleFlags } from "../shared/dashboard-types";
import {
  OWNER_MESSAGES_LABEL,
  OWNER_MESSAGES_SUBTITLE,
  SECTIONS,
  sectionAvailable,
  tabAvailable,
  visibleSections,
  visibleTabs,
} from "./nav";

const OFF: ModuleFlags = {
  agents: false,
  fill: false,
  planner: false,
  review: false,
  triage: false,
  placement: false,
  hostServices: false,
  cloud: false,
  pipelines: false,
  delivery: false,
  watchdog: false,
  processes: false,
  github: false,
  machines: false,
  nodes: false,
  lessons: false,
};
const ALL: ModuleFlags = Object.fromEntries(Object.keys(OFF).map((k) => [k, true])) as unknown as ModuleFlags;
const ids = (modules: ModuleFlags | null) => visibleSections(modules).map((s) => s.id);

describe("nav sections", () => {
  it("has about eight sections, not one per module", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual([
      "Home",
      "Work",
      "Gates",
      "PRs",
      "Machines",
      "Decisions",
      "Delivery",
      "Processes",
      "Knowledge",
      "Settings",
    ]);
    expect(ids(ALL)).toHaveLength(10);
  });

  it("shows only the sections every project has when no module is on, and Settings always", () => {
    expect(ids(OFF)).toEqual(["home", "work", "gates", "decisions", "settings"]);
    // Before the server says, the same: nothing appears and then vanishes
    expect(ids(null)).toEqual(["home", "work", "gates", "decisions", "settings"]);
  });

  it("shows each optional section when its module is on", () => {
    expect(ids({ ...OFF, github: true })).toContain("prs");
    expect(ids({ ...OFF, review: true })).toContain("prs");
    expect(ids({ ...OFF, machines: true })).toContain("machines");
    expect(ids({ ...OFF, nodes: true })).toContain("machines");
    expect(ids({ ...OFF, placement: true })).toContain("machines");
    expect(ids({ ...OFF, cloud: true })).toContain("machines");
    expect(ids({ ...OFF, delivery: true })).toContain("delivery");
    expect(ids({ ...OFF, processes: true })).toContain("processes");
    expect(ids({ ...OFF, delivery: true })).not.toContain("processes");
  });

  it("says how to turn a hidden section on", () => {
    expect(sectionAvailable("delivery", OFF)).toBe(false);
    expect(SECTIONS.find((s) => s.id === "delivery")!.enable).toContain("delivery.enabled: true");
    expect(SECTIONS.find((s) => s.id === "processes")!.enable).toContain("processes:");
    expect(sectionAvailable("settings", OFF)).toBe(true);
  });
});

describe("section tabs", () => {
  it("shows a module's tab only when the module is on", () => {
    expect(visibleTabs("gates", OFF).map((t) => t.id)).toEqual([null, "results"]);
    expect(visibleTabs("gates", { ...OFF, pipelines: true, triage: true, placement: true }).map((t) => t.label)).toEqual([
      "Queue",
      "Results",
      "Pipelines",
      "Triage",
      "Placement",
    ]);
    expect(visibleTabs("work", OFF)).toEqual([]);
    expect(visibleTabs("work", { ...OFF, agents: true }).map((t) => t.id)).toEqual([null, "locks"]);
    expect(visibleTabs("work", { ...OFF, agents: true, fill: true }).map((t) => t.id)).toEqual([null, "tasks", "locks"]);
    expect(visibleTabs("work", { ...OFF, agents: true, fill: true, planner: true }).map((t) => t.label)).toEqual([
      "Agents",
      "Tasks",
      "Planner",
      "Locks and budget",
    ]);
    expect(tabAvailable("work", "planner", OFF)).toBe(false);
    // Health always: Lair's self-checks, with the watchdog's part when it is on; Bus always: it says when the bus is off
    expect(visibleTabs("home", OFF).map((t) => t.id)).toEqual([null, "activity", "bus", "health"]);
    expect(visibleTabs("home", { ...OFF, watchdog: true }).map((t) => t.id)).toEqual([null, "activity", "bus", "health"]);
    expect(tabAvailable("gates", "triage", OFF)).toBe(false);
    expect(tabAvailable("gates", "results", OFF)).toBe(true);
  });

  it("names the owner's message file 'Owner messages', a tab of Decisions", () => {
    expect(visibleTabs("decisions", OFF).map((t) => [t.id, t.label])).toEqual([
      [null, "Decisions"],
      ["messages", "Owner messages"],
    ]);
    expect(OWNER_MESSAGES_LABEL).toBe("Owner messages");
    expect(SECTIONS.map((s) => s.label)).not.toContain("Inbox");
    expect(OWNER_MESSAGES_SUBTITLE).toContain("Decisions Lair needs from you are in Decisions");
  });
});
