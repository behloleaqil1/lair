/**
 * Badges: a short word in a tinted pill. A badge that marks a state carries
 * the tone's icon too, so colour is never the only signal (WCAG 1.4.1):
 * StatusBadge for the five status words every view shares (ok, waiting,
 * attention, failing, off), Badge for a view's own word in a tone.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { STATUS, TONE_ICON, toneOf, type Status, type Tone } from "./tokens";

export interface BadgeProps {
  /** A kit tone, or a view model's badge class (badge-success, badge-error, ...) */
  tone?: Tone | string;
  children: ReactNode;
  title?: string;
  /** No icon: a plain label, not a state (a branch name, a count) */
  plain?: boolean;
  className?: string;
}

export function Badge({ tone = "neutral", children, title, plain, className }: BadgeProps) {
  const t = toneOf(tone);
  return (
    <span className={`badge badge-${t === "danger" ? "error" : t}${className ? ` ${className}` : ""}`} title={title} data-tone={t}>
      {!plain && <Icon name={TONE_ICON[t]} size={12} className="badge-icon" />}
      {children}
    </span>
  );
}

/** One of the shared status words, with its colour and icon; `children` replaces the word when a view says more. */
export function StatusBadge({ status, children, title }: { status: Status; children?: ReactNode; title?: string }) {
  const s = STATUS[status];
  return (
    <span className={`badge badge-${s.tone === "danger" ? "error" : s.tone}`} title={title} data-status={status}>
      <Icon name={s.icon} size={12} className="badge-icon" />
      {children ?? s.word}
    </span>
  );
}
