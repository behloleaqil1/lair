/**
 * A row's detail, as the kit's side drawer over its section (ui/Drawer.tsx):
 * breadcrumbs back to the section, the title, a line with the id or status,
 * and the detail's actions. It takes the focus when it opens and gives it
 * back when it closes; Esc, the close button and a click outside close it;
 * Tab stays inside it. Its URL is the section's with the row's id
 * (router.ts), so it can be shared; the breadcrumbs come from that URL.
 */
import type { ReactNode } from "react";
import { Drawer } from "../ui/Drawer";
import { Breadcrumbs, type Crumb } from "../ui/PageHeader";
import { detailCrumbs } from "../crumbs";
import { parseRoute } from "../router";

interface Props {
  title: ReactNode;
  /** A line under the title: the id, the status */
  subtitle?: ReactNode;
  /** Beside the title: the detail's own actions */
  actions?: ReactNode;
  /** The breadcrumbs; by default the section (and tab) of the current URL, then the title */
  crumbs?: Crumb[];
  onClose: () => void;
  children: ReactNode;
}

function currentCrumbs(title: ReactNode): Crumb[] {
  if (typeof window === "undefined") return [];
  return detailCrumbs(parseRoute(window.location.hash), typeof title === "string" ? title : "Detail");
}

export function DetailPanel({ title, subtitle, actions, crumbs, onClose, children }: Props) {
  const items = crumbs ?? currentCrumbs(title);
  return (
    <Drawer
      title={title}
      subtitle={subtitle}
      actions={actions}
      crumbs={items.length > 0 ? <Breadcrumbs items={items} /> : undefined}
      onClose={onClose}
    >
      {children}
    </Drawer>
  );
}

/** A titled part of a detail panel. */
export function DetailSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
