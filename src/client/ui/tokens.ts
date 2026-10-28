/**
 * The design tokens (tokens.css) by name, for TypeScript: inline styles that
 * need a token write `space(2)` instead of "8px", and the kit's status
 * badges take their colour, icon and word from STATUS.
 */
import type { IconName } from "./Icon";

/** The steps of the 4 px spacing scale (`--space-<n>` is n × 4 px) */
export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;

/** `var(--space-<n>)`: n × 4 px */
export function space(n: Space): string {
  return `var(--space-${n})`;
}

export type TextSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

/** `var(--text-<size>)` */
export function textSize(size: TextSize): string {
  return `var(--text-${size})`;
}

/** The semantic colours (and neutral); each has `--color-<tone>` and `--color-<tone>-subtle`. */
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** `var(--color-<name>)` */
export function color(name: Tone | "text" | "text-muted" | "accent" | "border" | "border-strong" | "surface" | "bg"): string {
  return `var(--color-${name})`;
}

/**
 * The status words every view uses (docs/design/settings-v2.md, "Status
 * everywhere uses the same badges and words"). A status is never shown by
 * colour alone: it has an icon and a word.
 */
export type Status = "ok" | "waiting" | "attention" | "failing" | "off";

export const STATUS: Record<Status, { tone: Tone; icon: IconName; word: string }> = {
  ok: { tone: "success", icon: "check-circle", word: "ok" },
  waiting: { tone: "info", icon: "clock", word: "waiting" },
  attention: { tone: "warning", icon: "alert", word: "attention" },
  failing: { tone: "danger", icon: "x-circle", word: "failing" },
  off: { tone: "neutral", icon: "minus-circle", word: "off" },
};

/** The icon a tone shows when it marks a state */
export const TONE_ICON: Record<Tone, IconName> = {
  success: "check-circle",
  warning: "alert",
  danger: "x-circle",
  info: "info",
  neutral: "dot",
};

/**
 * The badge classes the view models name (badge-success, badge-warning,
 * badge-error, badge-neutral) as kit tones.
 */
export function toneOf(badge: string): Tone {
  const name = badge.startsWith("badge-") ? badge.slice("badge-".length) : badge;
  switch (name) {
    case "success":
    case "ok":
      return "success";
    case "warning":
    case "attention":
      return "warning";
    case "error":
    case "danger":
    case "failing":
      return "danger";
    case "info":
    case "waiting":
      return "info";
    default:
      return "neutral";
  }
}
