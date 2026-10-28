/**
 * A modal dialog: centred over a scrim, role="dialog" (or "alertdialog" for
 * a confirmation), named by its title. It takes the focus when it opens,
 * keeps Tab inside, closes on Esc, the close button or a click on the
 * scrim, and gives the focus back when it closes. Render it only while it
 * is open.
 */
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { useFocusTrap } from "./focus";
import { Icon } from "./Icon";

export interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** The buttons at the bottom (Cancel, Confirm) */
  footer?: ReactNode;
  /** A line under the title */
  description?: ReactNode;
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "lg";
  /** The element to focus first (default: the dialog itself) */
  initialFocus?: RefObject<HTMLElement>;
  /** False: a click on the scrim does nothing (a form with unsaved input) */
  closeOnScrim?: boolean;
  className?: string;
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  description,
  role = "dialog",
  size = "md",
  initialFocus,
  closeOnScrim = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(ref, onClose, initialFocus);
  return (
    <div className="layer layer-dialog">
      <div className="scrim" onClick={closeOnScrim ? onClose : undefined} />
      <div
        className={`dialog dialog-${size}${className ? ` ${className}` : ""}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-header">
          <div>
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dialog-description">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-sm icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
