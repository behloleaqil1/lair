/**
 * What every section gets from App.tsx, and its header (the kit's PageHeader):
 * the title, its actions, and its tabs (links, so each has a URL).
 */
import type { ReactNode } from "react";
import type { ModuleFlags } from "../../shared/dashboard-types";
import { routeHash, type Route, type SectionId } from "../router";
import { visibleTabs } from "../nav";
import { Tabs } from "./ui";
import { PageHeader } from "../ui/PageHeader";

export interface SectionProps {
  project: string;
  refreshKey: number;
  route: Route;
  /** null until the server says which modules the project turns on */
  modules: ModuleFlags | null;
  /** The project is read_only: nothing is started, stopped or merged */
  readOnly: boolean;
  /** Open a row's detail on the current tab (null closes it) */
  open: (detail: string | null) => void;
}

/** The URL of a tab of the route's section (no detail open). */
export function tabHref(route: Route, tab: string | null): string {
  return routeHash({ section: route.section, tab, detail: null, project: route.project });
}

export function SectionHeader({
  title,
  section,
  route,
  modules,
  children,
}: {
  title: ReactNode;
  section: SectionId;
  route: Route;
  modules: ModuleFlags | null;
  /** Actions and one-line status beside the title */
  children?: ReactNode;
}) {
  const tabs = visibleTabs(section, modules).map((t) => ({ id: t.id, label: t.label, href: tabHref(route, t.id) }));
  return (
    <PageHeader title={title} actions={children}>
      <Tabs tabs={tabs} active={route.tab} label={`${typeof title === "string" ? title : "Section"} tabs`} />
    </PageHeader>
  );
}
