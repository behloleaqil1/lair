/**
 * The Settings pages (docs/design/settings-v2.md, "Pages"): organised by
 * task, not by file, each with its own URL (#/settings?tab=<page>, Overview
 * the first). The pages S2-2 rebuilds stay reachable in "All settings
 * (classic)", the phase-1 form, until then. Without a DOM, so tests check
 * the same rules the shell (components/Settings.tsx) follows.
 */
import { routeHash } from "./router";

export type SettingsPage = "overview" | "ai" | "team" | "work" | "gates" | "classic" | "yaml" | "history";

export interface PageDef {
  id: SettingsPage;
  label: string;
  /** "What does this do?": the line under the page's title */
  about: string;
}

export const SETTINGS_PAGES: readonly PageDef[] = [
  {
    id: "overview",
    label: "Overview",
    about: "What this project has set up, what needs you, and a link to where each part is fixed. Nothing here changes a setting.",
  },
  {
    id: "ai",
    label: "AI",
    about:
      "The AI tools Lair can start and whether each is signed in, the profiles (a tool and a model with a name), and the roles: who builds, who reviews each risk tier, who plans and who supervises.",
  },
  {
    id: "team",
    label: "Team",
    about: "The agents (dragons): what each runs on and where. Select several to move them to another profile at once.",
  },
  {
    id: "work",
    label: "Work",
    about:
      "Where tasks come from (a tasks file or the planner), limits (max active, waits, recovery budget), and the capacity check that decides whether there is room for another run.",
  },
  {
    id: "gates",
    label: "Gates",
    about:
      "Pipelines and their steps, executors (GitHub Actions, local), triage (infra patterns, re-checks, flaky policy), and placement (which machine runs what).",
  },
  {
    id: "classic",
    label: "All settings (classic)",
    about: "Every setting of the project's YAML, one section per block, with its defaults. Advanced fields are folded.",
  },
  {
    id: "yaml",
    label: "YAML",
    about: "The whole file as text, with the same checks, the same review and the same history as every other page.",
  },
  {
    id: "history",
    label: "History",
    about: "Every version Settings saved or found on disk, with its diff. Restore saves a version again through the same checks.",
  },
];

/** The page a URL's tab names (Overview for none, or one that is not a page). */
export function pageOf(tab: string | null): SettingsPage {
  return SETTINGS_PAGES.find((p) => p.id !== "overview" && p.id === tab)?.id ?? "overview";
}

/** A page's tab in the URL: null for Overview. */
export function tabOf(page: SettingsPage): string | null {
  return page === "overview" ? null : page;
}

/** The URL of a page, with a field or section to show on it (`detail`: a dotted YAML key). */
export function pageHref(page: SettingsPage, detail: string | null = null, project: string | null = null): string {
  return routeHash({ section: "settings", tab: tabOf(page), detail, project });
}

/** The page that edits a YAML key (dotted, from the top level): AI for the profiles and roles, Team for the agents, Work for agents.fill, Gates for pipelines/triage/placement. */
export function pageForKey(key: string): SettingsPage {
  if (key === "") return "overview";
  if (key === "ai" || key.startsWith("ai.profiles") || key.startsWith("ai.roles")) return "ai";
  if (key === "dragons" || key.startsWith("dragons.")) return "team";
  if (key === "agents" || key.startsWith("agents.")) return "work";
  if (key === "pipelines" || key.startsWith("pipelines.")) return "gates";
  if (key === "executors" || key.startsWith("executors.")) return "gates";
  if (key === "triage" || key.startsWith("triage.")) return "gates";
  if (key === "placement" || key.startsWith("placement.")) return "gates";
  return "classic";
}

/** "1 unsaved change", "3 unsaved changes". */
export function unsavedText(count: number): string {
  return count === 1 ? "1 unsaved change" : `${count} unsaved changes`;
}
