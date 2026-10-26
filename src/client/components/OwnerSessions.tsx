/**
 * The browsers signed in as the owner, with a way to sign each one out.
 * Signing out needs this browser to be signed in too. Deleting
 * data/owner.token (and restarting the server) signs every browser out.
 */
import { useEffect, useState } from "react";
import { listOwnerSessions, revokeOwnerSession, type OwnerSessionInfo } from "../owner-session";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

const smallButton = {
  padding: "0.2rem 0.6rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "0.8rem",
};

function time(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function OwnerSessionList({
  sessions,
  busy,
  onRevoke,
}: {
  sessions: OwnerSessionInfo[];
  busy: boolean;
  onRevoke: (session: OwnerSessionInfo) => void;
}) {
  return (
    <table className="table" data-owner-sessions="list">
      <thead>
        <tr>
          <th>Browser</th>
          <th>Signed in</th>
          <th>Last used</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td>
              {s.userAgent || "unknown browser"}
              {s.current && <span className="badge badge-success" style={{ marginLeft: "0.5rem" }}>this browser</span>}
            </td>
            <td style={muted}>{time(s.createdAt)}</td>
            <td style={muted}>{time(s.lastUsedAt)}</td>
            <td>
              <button type="button" disabled={busy} onClick={() => onRevoke(s)} style={smallButton}>
                Sign out
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "Signed-in browsers": loads the list and signs browsers out. */
export function OwnerSessions({ onSignedOut }: { onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<OwnerSessionInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listOwnerSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the signed-in browsers");
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const revoke = async (session: OwnerSessionInfo) => {
    setBusy(true);
    setError(null);
    try {
      await revokeOwnerSession(session.id);
      if (session.current) onSignedOut();
      else setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign that browser out");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-owner-sessions="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <h3>Signed-in browsers</h3>
        <span style={muted}>This browser is signed in as the owner, so you can answer.</span>
        <button type="button" onClick={() => setOpen(!open)} style={smallButton}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && error && <div className="error">{error}</div>}
      {open && sessions && <OwnerSessionList sessions={sessions} busy={busy} onRevoke={(s) => void revoke(s)} />}
    </div>
  );
}
