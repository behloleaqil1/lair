/**
 * A tooltip: a short hint shown while its trigger is hovered or focused,
 * read by screen readers through aria-describedby, closed by Esc. The
 * trigger is the one child (a Button, a link, an icon in a focusable
 * span); the hint must not hold anything to click.
 */
import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";

interface TriggerProps {
  "aria-describedby"?: string;
  onMouseEnter?: (e: unknown) => void;
  onMouseLeave?: (e: unknown) => void;
  onFocus?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
  onKeyDown?: (e: { key: string }) => void;
}

export function Tooltip({ content, children, placement = "top" }: { content: ReactNode; children: ReactElement; placement?: "top" | "bottom" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!isValidElement<TriggerProps>(children)) return children;
  const p = children.props;
  const describedBy = [p["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span className={`tooltip-anchor tooltip-${placement}`}>
      {cloneElement(children, {
        "aria-describedby": describedBy,
        onMouseEnter: (e: unknown) => {
          p.onMouseEnter?.(e);
          setOpen(true);
        },
        onMouseLeave: (e: unknown) => {
          p.onMouseLeave?.(e);
          setOpen(false);
        },
        onFocus: (e: unknown) => {
          p.onFocus?.(e);
          setOpen(true);
        },
        onBlur: (e: unknown) => {
          p.onBlur?.(e);
          setOpen(false);
        },
        onKeyDown: (e: { key: string }) => {
          p.onKeyDown?.(e);
          if (e.key === "Escape") setOpen(false);
        },
      })}
      <span id={id} role="tooltip" className={`tooltip${open ? " open" : ""}`}>
        {content}
      </span>
    </span>
  );
}
