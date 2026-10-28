/**
 * Small pieces every section uses, on the component kit (src/client/ui/):
 * times, the loading, error and empty states (each says what to do),
 * key-value lists, the tab bar and the owner-only notice.
 */
import { useEffect, useState, type ReactNode } from "react";
import { absoluteTime, relativeTime } from "../time";
import { ownerStatus } from "../owner-session";
import { linkTo } from "../router";
import { Badge as KitBadge } from "../ui/Badge";
import { Callout } from "../ui/Card";
import { EmptyState as KitEmptyState } from "../ui/EmptyState";
import { TabLinks, type TabLink } from "../ui/Tabs";

/** Secondary text: the muted colour, the small size */
export const muted = { color: "var(--color-text-muted)", fontSize: "var(--text-sm)" } as const;

/** "5 min ago", with the absolute time on hover. */
export function Time({ iso, now }: { iso: string | null | undefined; now?: number }) {
  if (!iso) return <span className="muted small">—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

/** What to try when a read fails: the server is usually stopped or restarting. */
export const RETRY_HINT =
  "Check that the Lair server is running (npm start, or npm run dev); the dashboard tries again every 10 seconds.";

export function ErrorState({ what, error, hint = RETRY_HINT }: { what: string; error: string; hint?: string }) {
  return (
    <Callout tone="danger" alert className="error-state">
      <strong>Could not load {what}:</strong> {error}
      <div className="callout-hint">{hint}</div>
    </Callout>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <KitEmptyState title={title}>{children}</KitEmptyState>;
}

/** A section's module is off: what to set, and where. */
export function ModuleOff({ what, enable }: { what: string; enable: string }) {
  return (
    <EmptyState title={`${what} is off for this project`}>
      {enable} Change it in <a href={linkTo("settings")}>Settings</a> or the project&apos;s YAML; Lair reloads it without
      a restart.
    </EmptyState>
  );
}

/** A definition list of label and value rows; rows whose value is null are left out. */
export function KeyValues({ rows }: { rows: [string, ReactNode | null | undefined][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="kv">
      {shown.map(([label, value]) => (
        <div key={label} className="kv-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type { TabLink };

/** The tab bar of a section: links, so each tab has a URL. */
export function Tabs({ tabs, active, label }: { tabs: TabLink[]; active: string | null; label: string }) {
  return <TabLinks tabs={tabs} active={active} label={label} />;
}

/** Is this browser signed in as the owner? null until the server answers. Re-checked when `refreshKey` changes. */
export function useOwnerSignedIn(refreshKey?: number): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    ownerStatus()
      .then((s) => {
        if (!cancelled) setSignedIn(s.signedIn);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return signedIn;
}

/**
 * In place of something only the owner sees or does, while this browser is
 * not signed in as the owner: `text` says what ("The log is shown to the
 * owner only."), then where to sign in.
 */
export function OwnerOnlyNotice({ text }: { text: string }) {
  return (
    <p className="owner-only muted small" data-owner-only="signed-out">
      {text} Sign this browser in as the owner from <a href={linkTo("decisions")}>Decisions</a>.
    </p>
  );
}

/** A badge in a tone (success, warning, error, neutral, or a view model's badge-<tone> class), with the tone's icon. */
export function Badge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <KitBadge tone={tone} title={title}>
      {children}
    </KitBadge>
  );
}
