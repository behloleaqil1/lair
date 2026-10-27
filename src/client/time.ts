/**
 * Times as the dashboard shows them: relative ("5 min ago", "in 3 min"),
 * with the absolute local time on hover (components/Time.tsx).
 */

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** "just now", "5 min ago", "3 h ago", "4 days ago", "in 12 min"; "—" for no time. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const at = parse(iso);
  if (at === null) return "—";
  const diff = now - at;
  if (Math.abs(diff) < 45_000) return "just now";
  return diff > 0 ? `${span(diff)} ago` : `in ${span(-diff)}`;
}

/** The local date and time; "" for no time. */
export function absoluteTime(iso: string | null | undefined): string {
  const at = parse(iso);
  return at === null ? "" : new Date(at).toLocaleString();
}

/** "42 s", "3.5 min", "1 h 5 min"; "—" when unknown. */
export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  if (seconds < 3600) return `${Math.round(seconds / 6) / 10} min`;
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The time between two instants, in seconds; null when either is unknown. */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = parse(from);
  const b = parse(to);
  return a === null || b === null || b < a ? null : (b - a) / 1000;
}

/** git's committer date (%ci: "2026-10-24 14:35:00 +0200") as ISO 8601, or null for anything else. */
export function gitDateToIso(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec((value ?? "").trim());
  return m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : null;
}
