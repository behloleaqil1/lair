/**
 * Tabs, two kinds:
 *
 * - TabLinks: a section's tabs, each a link with its own URL (the dashboard's
 *   routes, router.ts). A nav of links; the current one has
 *   aria-current="page".
 * - Tabs: tabs inside a page that switch a panel without changing the URL
 *   (the WAI-ARIA tabs pattern): role tablist, tab and tabpanel; the arrow
 *   keys, Home and End move between tabs, and only the selected one is in
 *   the Tab order.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabLink {
  id: string | null;
  label: string;
  href: string;
}

export function TabLinks({ tabs, active, label }: { tabs: TabLink[]; active: string | null; label: string }) {
  if (tabs.length === 0) return null;
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map((tab) => (
        <a
          key={tab.id ?? "_"}
          href={tab.href}
          className={`tab${tab.id === active ? " active" : ""}`}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  panel: ReactNode;
}

/** The tab a key moves to from `index` of `count`; null for other keys. */
export function tabKeyTarget(index: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function Tabs({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  /** What the tabs are, for screen readers */
  label: string;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    tabs.findIndex((t) => t.id === selected),
  );
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabKeyTarget(index, event.key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const current = tabs[index];
  return (
    <div className="tabs-block">
      <div className="tabs" role="tablist" aria-label={label} ref={list}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={i === index}
            aria-controls={i === index ? `${base}-panel-${tab.id}` : undefined}
            tabIndex={i === index ? 0 : -1}
            className={`tab${i === index ? " active" : ""}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={onKey}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`${base}-panel-${current.id}`}
          aria-labelledby={`${base}-tab-${current.id}`}
          tabIndex={0}
          className="tab-panel"
        >
          {current.panel}
        </div>
      )}
    </div>
  );
}
