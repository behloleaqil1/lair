/**
 * What a list shows when it has nothing: what the thing is, why you'd want
 * it, and (when there is one) the one action that adds the first.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function EmptyState({
  title,
  children,
  action,
  icon,
  framed = true,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
  /** False: no card around it (inside a card already) */
  framed?: boolean;
}) {
  return (
    <div className={framed ? "card empty-state" : "empty-state"}>
      {icon && <Icon name={icon} size={20} className="empty-state-icon" />}
      <h3>{title}</h3>
      {children && <p className="empty-state-body muted">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
