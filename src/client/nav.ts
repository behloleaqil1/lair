/**
 * The dashboard's sections, their tabs, and which ones the nav shows for a
 * project (App.tsx renders them; router.ts maps URLs to them).
 *
 * A section whose module is off for the project is not in the nav. Opened
 * by its URL anyway, it says how to turn the module on (`enable`). Settings
 * is always there: it is where modules are turned on.
 */
import type { ModuleFlags } from "../shared/dashboard-types";
import type { SectionId } from "./router";

/**
 * The owner's message file (inbox_file: instructions to the orchestrator and
 * its replies) is "Owner messages", a tab of Decisions, so it isn't taken for
 * the decisions Lair asks the owner for.
 */
export const OWNER_MESSAGES_LABEL = "Owner messages";

/** Under the Owner messages heading */
export const OWNER_MESSAGES_SUBTITLE =
  "Instructions you send the orchestrator and its replies (inbox_file). Decisions Lair needs from you are in Decisions.";

export interface SectionDef {
  id: SectionId;
  label: string;
  /** The module(s) it needs; null: always shown */
  needs: ((modules: ModuleFlags) => boolean) | null;
  /** What to set to turn it on, for the empty state of a hidden section */
  enable: string;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "home", label: "Home", needs: null, enable: "" },
  { id: "work", label: "Work", needs: null, enable: "" },
  { id: "gates", label: "Gates", needs: null, enable: "" },
  {
    id: "prs",
    label: "PRs",
    needs: (m) => m.github || m.review,
    enable:
      "Set github: <owner>/<repository> in the project's YAML to list its pull requests; review.enabled: true adds risk tiers, required reviews and policy merge.",
  },
  {
    id: "machines",
    label: "Machines",
    needs: (m) => m.machines || m.nodes || m.placement,
    enable:
      "Add machines: to the project's YAML, or run lair-node on a machine to register it with this server; placement.enabled: true probes them.",
  },
  { id: "decisions", label: "Decisions", needs: null, enable: "" },
  {
    id: "delivery",
    label: "Delivery",
    needs: (m) => m.delivery,
    enable: "Set delivery.enabled: true and name the project's environments (docs/configuration.md#delivery).",
  },
  {
    id: "processes",
    label: "Processes",
    needs: (m) => m.processes,
    enable: "Add the helper processes Lair should supervise under processes: in the project's YAML.",
  },
  { id: "settings", label: "Settings", needs: null, enable: "" },
];

export function sectionDef(id: SectionId): SectionDef {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}

/** Is the section's module on? Before the flags arrive, only the sections that need none are. */
export function sectionAvailable(id: SectionId, modules: ModuleFlags | null): boolean {
  const def = sectionDef(id);
  if (def.needs === null) return true;
  return modules !== null && def.needs(modules);
}

/** The sections the nav shows for a project with these modules. */
export function visibleSections(modules: ModuleFlags | null): SectionDef[] {
  return SECTIONS.filter((s) => sectionAvailable(s.id, modules));
}

export interface TabDef {
  /** null: the section's first tab */
  id: string | null;
  label: string;
  /** The module(s) it needs; null: always shown */
  needs: ((modules: ModuleFlags) => boolean) | null;
  enable: string;
}

const TABS: Record<SectionId, readonly TabDef[]> = {
  home: [
    { id: null, label: "Overview", needs: null, enable: "" },
    { id: "activity", label: "Activity", needs: null, enable: "" },
    // Lair's self-checks are always there; the watchdog's part says how to turn it on
    { id: "health", label: "Health", needs: null, enable: "" },
  ],
  work: [
    { id: null, label: "Agents", needs: null, enable: "" },
    {
      id: "tasks",
      label: "Tasks",
      needs: (m) => m.fill,
      enable: "Set agents.enabled: true and agents.fill.enabled: true with a tasks_file, and Lair starts runs from it.",
    },
    {
      id: "planner",
      label: "Planner",
      needs: (m) => m.planner,
      enable:
        "Set planner.enabled: true in the project's YAML: Lair then keeps fill's tasks file itself, with an optional supervised planner agent (docs/configuration.md#planner).",
    },
    {
      id: "locks",
      label: "Locks and budget",
      needs: (m) => m.agents,
      enable: "Set agents.enabled: true in the project's YAML to let Lair supervise the agents' runs.",
    },
  ],
  gates: [
    { id: null, label: "Queue", needs: null, enable: "" },
    { id: "results", label: "Results", needs: null, enable: "" },
    {
      id: "pipelines",
      label: "Pipelines",
      needs: (m) => m.pipelines,
      enable: "Add a pipelines: block to the project's YAML (docs/configuration.md#gate-pipelines).",
    },
    {
      id: "triage",
      label: "Triage",
      needs: (m) => m.triage,
      enable: "Set triage.enabled: true in the project's YAML; it starts in observe mode: it classifies and records only.",
    },
    {
      id: "placement",
      label: "Placement",
      needs: (m) => m.placement,
      enable: "Set placement.enabled: true in the project's YAML; it starts in observe mode: advice only.",
    },
  ],
  prs: [],
  machines: [
    { id: null, label: "Machines", needs: null, enable: "" },
    { id: "nodes", label: "Nodes", needs: null, enable: "" },
  ],
  decisions: [
    { id: null, label: "Decisions", needs: null, enable: "" },
    { id: "messages", label: OWNER_MESSAGES_LABEL, needs: null, enable: "" },
  ],
  delivery: [],
  processes: [],
  settings: [],
};

/** A section's tab, by id (its first for null or an unknown id). */
export function tabDef(section: SectionId, tab: string | null): TabDef | null {
  const tabs = TABS[section];
  return tabs.find((t) => t.id === tab) ?? tabs[0] ?? null;
}

/** The tabs of a section the tab bar shows for a project with these modules (none for a one-tab section). */
export function visibleTabs(section: SectionId, modules: ModuleFlags | null): TabDef[] {
  const tabs = TABS[section].filter((t) => t.needs === null || (modules !== null && t.needs(modules)));
  return tabs.length > 1 ? tabs : [];
}

/** Is a tab's module on? */
export function tabAvailable(section: SectionId, tab: string | null, modules: ModuleFlags | null): boolean {
  const def = tabDef(section, tab);
  if (!def || def.needs === null) return true;
  return modules !== null && def.needs(modules);
}

