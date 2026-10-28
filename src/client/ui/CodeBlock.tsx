/**
 * Ids, commands and logs, in the monospace face. Code is inline; CodeBlock
 * is a block that scrolls past `maxHeight` and can be scrolled with the
 * keyboard (it is focusable, and named by `label` when it has one).
 */
import type { ReactNode } from "react";

export function Code({ children }: { children: ReactNode }) {
  return <code className="code-inline">{children}</code>;
}

export function CodeBlock({
  children,
  label,
  wrap = true,
  maxHeight,
  tone,
  className,
}: {
  children: ReactNode;
  /** What it holds ("Gate log"): names the scrolling region */
  label?: string;
  /** Wrap long lines (default), or scroll sideways */
  wrap?: boolean;
  maxHeight?: number | string;
  /** danger: an error's output */
  tone?: "danger";
  className?: string;
}) {
  return (
    <pre
      className={`code-block${wrap ? "" : " code-block-nowrap"}${tone ? ` code-block-${tone}` : ""}${className ? ` ${className}` : ""}`}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      tabIndex={0}
      role={label ? "region" : undefined}
      aria-label={label}
    >
      {children}
    </pre>
  );
}
