/**
 * A side drawer: a panel from the right over a scrim, for a row's detail or
 * an edit form, so the list behind stays in view. Like Dialog it is modal:
 * named by its title, it takes the focus, keeps Tab inside, closes on Esc,
 * the close button or a click on the scrim, and gives the focus back.
 * `header` replaces the title block (a PageHeader with breadcrumbs).
 */
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { useFocusTrap } from "./focus";
import { Icon } from "./Icon";

export interface DrawerProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** A line under the title: the id, the status */
  subtitle?: ReactNode;
  /** Above the title: breadcrumbs */
  crumbs?: ReactNode;
  /** Beside the title: the detail's actions */
  actions?: ReactNode;
  size?: "md" | "lg";
  initialFocus?: RefObject<HTMLElement>;
  className?: string;
}

export function Drawer({ title, onClose, children, subtitle, crumbs, actions, size = "md", initialFocus, className }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, onClose, initialFocus);
  return (
    <div className="layer layer-drawer">
      <div className="scrim" onClick={onClose} />
      <div
        className={`drawer drawer-${size}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <div className="drawer-header">
          <div className="drawer-heading">
            {crumbs}
            <h2 id={titleId} className="drawer-title">
              {title}
            </h2>
            {subtitle && <div className="drawer-subtitle">{subtitle}</div>}
          </div>
          <div className="drawer-actions">
            {actions}
            <button type="button" className="btn btn-ghost btn-sm icon-button" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
