/**
 * The Settings pages (docs/design/settings-v2.md, "Pages"): organised by
 * task, not by file, each with its own URL (#/settings?tab=<page>, Overview
 * the first). The pages S2-2 rebuilds stay reachable in "All settings
 * (classic)", the phase-1 form, until then. Without a DOM, so tests check
 * the same rules the shell (components/Settings.tsx) follows.
 */
import { routeHash } from "./router";

export type SettingsPage = "overview" | "classic" | "yaml" | "history";

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

/** The page that edits a YAML key (dotted, from the top level). */
export function pageForKey(key: string): SettingsPage {
  return key === "" ? "overview" : "classic";
}

/** "1 unsaved change", "3 unsaved changes". */
export function unsavedText(count: number): string {
  return count === 1 ? "1 unsaved change" : `${count} unsaved changes`;
}
