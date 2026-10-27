/**
 * A row's detail, as a side panel over its section. It takes the focus when
 * it opens and gives it back when it closes; Esc, the close button and a
 * click outside close it; Tab stays inside it. Its URL is the section's with
 * the row's id (router.ts), so it can be shared.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title: ReactNode;
  /** A line under the title: the id, the status */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DetailPanel({ title, subtitle, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <>
      <div className="overlay" onClick={() => close.current()} />
      <div className="detail-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
        <div className="detail-panel-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="detail-panel-subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="detail-panel-close" aria-label="Close" onClick={() => close.current()}>
            ×
          </button>
        </div>
        {children}
      </div>
    </>
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
