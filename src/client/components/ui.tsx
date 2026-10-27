/**
 * Small pieces every section uses: times, the loading, error and empty
 * states (each says what to do), key-value lists, the tab bar and the
 * owner-only notice.
 */
import { useEffect, useState, type ReactNode } from "react";
import { absoluteTime, relativeTime } from "../time";
import { ownerStatus } from "../owner-session";
import { linkTo } from "../router";

export const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" } as const;

/** "5 min ago", with the absolute time on hover. */
export function Time({ iso, now }: { iso: string | null | undefined; now?: number }) {
  if (!iso) return <span style={muted}>—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      Loading {what}…
    </div>
  );
}

/** What to try when a read fails: the server is usually stopped or restarting. */
export const RETRY_HINT =
  "Check that the Lair server is running (npm start, or npm run dev); the dashboard tries again every 10 seconds.";

export function ErrorState({ what, error, hint = RETRY_HINT }: { what: string; error: string; hint?: string }) {
  return (
    <div className="error" role="alert">
      <strong>Could not load {what}:</strong> {error}
      <div style={{ marginTop: "0.25rem", fontSize: "0.85rem" }}>{hint}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card empty-state">
      <h3>{title}</h3>
      {children && <p style={muted}>{children}</p>}
    </div>
  );
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

export interface TabLink {
  id: string | null;
  label: string;
  href: string;
}

/** The tab bar of a section: links, so each tab has a URL. */
export function Tabs({ tabs, active, label }: { tabs: TabLink[]; active: string | null; label: string }) {
  if (tabs.length === 0) return null;
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map((tab) => (
        <a
          key={tab.id ?? "_"}
          href={tab.href}
          className={`tab ${tab.id === active ? "active" : ""}`}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
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
    <p className="owner-only" data-owner-only="signed-out" style={muted}>
      {text} Sign this browser in as the owner from <a href={linkTo("decisions")}>Decisions</a>.
    </p>
  );
}

/** A badge with the house colours: success, warning, error, neutral. */
export function Badge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone.startsWith("badge-") ? tone : `badge-${tone}`}`} title={title}>
      {children}
    </span>
  );
}
