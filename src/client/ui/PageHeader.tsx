/**
 * The top of a page: breadcrumbs (where it is), the title with its status,
 * a line under it, and its actions; tabs go below. Sections and detail views
 * use it, so every page reads the same way.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface Crumb {
  label: string;
  /** Without one, the crumb is the current page */
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, i) => (
          <li key={`${i}-${item.label}`}>
            {i > 0 && <Icon name="chevron-right" size={12} className="breadcrumb-sep" />}
            {item.href && i < items.length - 1 ? (
              <a href={item.href}>{item.label}</a>
            ) : (
              <span aria-current={i === items.length - 1 ? "page" : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  crumbs,
  status,
  subtitle,
  actions,
  children,
  level = 2,
}: {
  title: ReactNode;
  crumbs?: Crumb[];
  /** A StatusBadge beside the title */
  status?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Below the title row: tabs */
  children?: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header className="page-header">
      {crumbs && <Breadcrumbs items={crumbs} />}
      <div className="page-header-row">
        <div className="page-header-title">
          <Heading className="page-title">{title}</Heading>
          {status}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {subtitle && <p className="page-subtitle muted">{subtitle}</p>}
      {children}
    </header>
  );
}
