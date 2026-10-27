/**
 * The dashboard's hash routes: one per section, a tab, and the row whose
 * detail is open, so every view has a URL to share:
 *
 *   #/                         Home
 *   #/work/<agent>             Work, with that agent's detail open
 *   #/gates/<id>?tab=triage    Gates on its Triage tab, with gate <id> open
 *   #/prs/<n>, #/decisions/<id>, #/machines/<name>, ...
 *   ...&project=<name>         the project, when the server has several
 *
 * The views before the sections had ids of their own (Dragons, Agents,
 * Reviews, Nodes, Health, Activity, Triage, Owner messages, Orchestrator):
 * #/<old id> and #/<old id>/<detail> redirect to where each went
 * (LEGACY_VIEWS), so links to them keep working. A hash that is not a route
 * (the owner setup link's #owner-token=...) is left alone.
 */

export type SectionId = "home" | "work" | "gates" | "prs" | "machines" | "decisions" | "delivery" | "processes" | "settings";

export const SECTION_IDS: readonly SectionId[] = [
  "home",
  "work",
  "gates",
  "prs",
  "machines",
  "decisions",
  "delivery",
  "processes",
  "settings",
];

/** Each section's tabs besides its first (the default, tab null) */
export const SECTION_TABS: Record<SectionId, readonly string[]> = {
  home: ["activity", "health"],
  work: ["tasks", "locks"],
  gates: ["results", "pipelines", "triage", "placement"],
  prs: [],
  machines: ["nodes"],
  decisions: ["messages"],
  delivery: [],
  processes: [],
  settings: [],
};

export interface Route {
  section: SectionId;
  /** The section's tab; null for its first */
  tab: string | null;
  /** The id of the row whose detail is open */
  detail: string | null;
  /** The project the URL names; null: the one selected */
  project: string | null;
}

export const HOME: Route = { section: "home", tab: null, detail: null, project: null };

/** The views before the sections, and the section (and tab) each one went to */
export const LEGACY_VIEWS: Readonly<Record<string, { section: SectionId; tab: string | null }>> = {
  overview: { section: "home", tab: null },
  health: { section: "home", tab: "health" },
  activity: { section: "home", tab: "activity" },
  // The external orchestration loop's view is retired (GET /api/orchestrator stays): its old link opens the activity
  orchestrator: { section: "home", tab: "activity" },
  dragons: { section: "work", tab: null },
  agents: { section: "work", tab: null },
  triage: { section: "gates", tab: "triage" },
  reviews: { section: "prs", tab: null },
  nodes: { section: "machines", tab: "nodes" },
  inbox: { section: "decisions", tab: "messages" },
};

/** Longest detail id and project name taken from a URL */
const MAX_PART = 200;

function isSection(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

function isLegacy(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_VIEWS, value);
}

function decode(part: string): string | null {
  try {
    const value = decodeURIComponent(part);
    return value.length > 0 && value.length <= MAX_PART ? value : null;
  } catch {
    return null;
  }
}

/** True for a hash this router reads: "#/...", or a bare section or old view id ("#dragons"). */
export function isRouteHash(hash: string): boolean {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body === "" || body.startsWith("/")) return true;
  const word = body.split(/[/?]/)[0];
  return isSection(word) || isLegacy(word);
}

/** The route a location hash names; Home for anything else. */
export function parseRoute(hash: string): Route {
  if (!isRouteHash(hash)) return HOME;
  let body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body.startsWith("/")) body = `/${body}`;
  const [path, query = ""] = body.split("?", 2);
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter((p) => p.length > 0);
  const first = parts[0] ? decode(parts[0]) : null;
  const detail = parts[1] ? decode(parts[1]) : null;
  const projectParam = params.get("project");
  const project = projectParam && projectParam.length <= MAX_PART ? projectParam : null;

  let section: SectionId = "home";
  let tab: string | null = params.get("tab");
  if (first && isSection(first)) {
    section = first;
  } else if (first && isLegacy(first)) {
    const legacy = LEGACY_VIEWS[first];
    section = legacy.section;
    tab = tab ?? legacy.tab;
  } else if (first) {
    return { ...HOME, project };
  }
  if (tab !== null && !SECTION_TABS[section].includes(tab)) tab = null;
  return { section, tab, detail, project };
}

/** The canonical hash of a route. */
export function routeHash(route: Route): string {
  const params: string[] = [];
  if (route.tab) params.push(`tab=${encodeURIComponent(route.tab)}`);
  if (route.project) params.push(`project=${encodeURIComponent(route.project)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  if (route.section === "home" && !route.detail && !route.tab) return `#/${query}`;
  const detail = route.detail ? `/${encodeURIComponent(route.detail)}` : "";
  return `#/${route.section}${detail}${query}`;
}

/**
 * Where to send a hash that is not canonical (an old view's id, #/home, an
 * unknown tab), or null when it is canonical or not a route at all.
 */
export function redirectFor(hash: string): string | null {
  if (hash === "" || hash === "#" || !isRouteHash(hash)) return null;
  const canonical = routeHash(parseRoute(hash));
  return canonical === hash ? null : canonical;
}

/** A link to a section (its first tab, no detail open), or to a row's detail in it. */
export function linkTo(section: SectionId, detail: string | null = null, tab: string | null = null): string {
  return routeHash({ section, tab, detail, project: null });
}
