/**
 * The breadcrumbs of a detail view: its section, its tab when it is not the
 * section's first, then the row itself. Each crumb but the last is a link
 * (the route without the detail), so the way back is one click.
 */
import type { Crumb } from "./ui/PageHeader";
import { sectionDef, tabDef } from "./nav";
import { routeHash, type Route } from "./router";

export function detailCrumbs(route: Route, current: string): Crumb[] {
  const section = sectionDef(route.section);
  const crumbs: Crumb[] = [{ label: section.label, href: routeHash({ ...route, tab: null, detail: null }) }];
  const tab = route.tab ? tabDef(route.section, route.tab) : null;
  if (tab && tab.id !== null) crumbs.push({ label: tab.label, href: routeHash({ ...route, detail: null }) });
  crumbs.push({ label: current });
  return crumbs;
}
