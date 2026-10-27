/**
 * Settings' Notifications card (the owner only, as the whole view): desktop
 * notifications on or off, the ntfy topic for a phone push, the daily
 * reminder, Save, and "Send test notification". Written to Lair's own
 * data/server.yaml by the server (src/server/notifications/), never to a
 * project file. ntfy.token_file is set in that file only: the card shows
 * whether one is set, never the token.
 */
import { useEffect, useState } from "react";
import type { ChannelResult, NotificationStatusView } from "../../shared/notification-types";
import {
  formFrom,
  loadNotifications,
  resultLine,
  saveNotifications,
  sendTestNotification,
  updateFromForm,
  type NotificationForm,
} from "../notifications-api";
import { inputStyle, smallButton } from "./SettingsForm";
import { Time } from "./ui";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
const row = { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" as const, marginTop: "0.5rem" };

export function NotificationSettings() {
  const [view, setView] = useState<NotificationStatusView | null>(null);
  const [form, setForm] = useState<NotificationForm>({ desktop: false, ntfyUrl: "", reminderHours: "4" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<ChannelResult[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadNotifications().then((reply) => {
      if (cancelled) return;
      if (reply.ok && reply.data) {
        setView(reply.data);
        setForm(formFrom(reply.data));
      } else {
        setError(reply.error ?? "Could not read the notification settings");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const checked = updateFromForm(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const reply = await saveNotifications(checked.update);
    setBusy(false);
    if (reply.ok && reply.data) {
      setView(reply.data);
      setForm(formFrom(reply.data));
      setMessage(reply.data.settings.enabled ? "Saved: notifications are on" : "Saved: notifications are off");
    } else {
      setError(reply.error ?? "Could not save");
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setResults(null);
    const reply = await sendTestNotification();
    setBusy(false);
    if (reply.ok && reply.data) setResults(reply.data.results);
    else setError(reply.error ?? "Could not send the test notification");
  };

  const saved = view ? formFrom(view) : null;
  const dirty =
    saved !== null &&
    (saved.desktop !== form.desktop || saved.ntfyUrl !== form.ntfyUrl.trim() || saved.reminderHours !== form.reminderHours.trim());

  return (
    <div className="card" data-notification-settings="" style={{ marginTop: "1rem" }}>
      <h3>Notifications</h3>
      <p style={muted}>
        Lair tells you when something needs your answer: one notification per minute at most, several items together,
        never for notices, and a reminder once a day while items wait longer than the hours below. Off until you turn a
        channel on. Kept in Lair&apos;s own <code>data/server.yaml</code>.
      </p>
      {view?.errors.map((e) => (
        <div key={e} className="error" style={{ marginBottom: "0.5rem" }}>
          {e}
        </div>
      ))}
      <label style={row}>
        <input
          type="checkbox"
          checked={form.desktop}
          disabled={busy || !view}
          onChange={(e) => setForm({ ...form, desktop: e.target.checked })}
        />
        Desktop notifications on this machine
        {view && (
          <span style={{ ...muted, color: view.desktopAvailable.ok ? "var(--text-secondary)" : "var(--warning)" }}>
            ({view.desktopAvailable.detail})
          </span>
        )}
      </label>
      <label style={{ display: "block", marginTop: "0.75rem" }}>
        <span style={muted}>
          Phone push: your ntfy topic URL (https://ntfy.sh/&lt;topic&gt;, or a self-hosted ntfy). Empty: none.
          {view?.settings.ntfyTokenFile ? " An access token is set in ntfy.token_file." : ""}
        </span>
        <input
          type="url"
          value={form.ntfyUrl}
          placeholder="https://ntfy.sh/your-private-topic"
          disabled={busy || !view}
          onChange={(e) => setForm({ ...form, ntfyUrl: e.target.value })}
          style={inputStyle}
        />
      </label>
      <label style={{ display: "block", marginTop: "0.75rem" }}>
        <span style={muted}>Daily reminder after this many hours (0: no reminder)</span>
        <input
          type="number"
          min={0}
          max={168}
          step={1}
          value={form.reminderHours}
          disabled={busy || !view}
          onChange={(e) => setForm({ ...form, reminderHours: e.target.value })}
          style={{ ...inputStyle, width: "6rem", display: "block" }}
        />
      </label>
      <div style={row}>
        <button style={smallButton} disabled={busy || !view || !dirty} onClick={() => void save()}>
          Save
        </button>
        <button
          style={smallButton}
          disabled={busy || !view?.settings.enabled || dirty}
          title={dirty ? "Save first" : !view?.settings.enabled ? "Turn a channel on first" : undefined}
          onClick={() => void test()}
        >
          Send test notification
        </button>
        {message && <span style={muted}>{message}</span>}
      </div>
      {error && (
        <div className="error" style={{ marginTop: "0.5rem" }}>
          {error}
        </div>
      )}
      {results && (
        <ul style={{ ...muted, margin: "0.5rem 0 0 1rem" }} data-test-results="">
          {results.map((r) => (
            <li key={r.channel} style={{ color: r.ok ? "var(--success)" : "var(--error)" }}>
              {resultLine(r)}
            </li>
          ))}
        </ul>
      )}
      {view?.last && !results && (
        <p style={{ ...muted, marginTop: "0.5rem" }}>
          Last sent <Time iso={view.last.at} />: {view.last.title} ({view.last.results.map(resultLine).join("; ") || "no channel"})
        </p>
      )}
    </div>
  );
}
