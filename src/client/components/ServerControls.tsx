/**
 * The owner's "Restart" and "Update and restart" (src/server/restart/), in
 * the footer. Shown only to a browser signed in as the owner. Each asks for
 * confirmation; while the update runs its output is shown, a failed update
 * shows its error (nothing restarted), and after the restart the dashboard
 * waits for the new server to answer.
 */
import { useEffect, useRef, useState } from "react";
import type { RestartStatusView } from "../../shared/lifecycle-types";
import { ownerStatus } from "../owner-session";
import { managerWarning, requestRestart, restartQuestion, restartStatus } from "../server-controls";

const POLL_MS = 1000;
/** How long to wait for the new server before saying it has not come back */
const COMEBACK_MS = 120_000;

const button = {
  padding: "0.1rem 0.5rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "0.8rem",
};

const panel = {
  position: "fixed" as const,
  right: "1rem",
  bottom: "3.5rem",
  width: "min(40rem, calc(100vw - 2rem))",
  maxHeight: "50vh",
  overflow: "auto",
  textAlign: "left" as const,
  zIndex: 10,
  border: "1px solid var(--border)",
};

export function ServerControls({ refreshKey }: { refreshKey?: number }) {
  const [status, setStatus] = useState<RestartStatusView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [watching, setWatching] = useState(false);
  const before = useRef<string | null>(null);
  const since = useRef(0);

  // Signed in as the owner? Then load the restart state
  useEffect(() => {
    if (watching) return;
    let cancelled = false;
    ownerStatus()
      .then(async (owner) => {
        if (!owner.signedIn) {
          if (!cancelled) setStatus(null);
          return;
        }
        const next = await restartStatus();
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, watching]);

  // After a request: follow the update, then wait for the new server
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      restartStatus()
        .then((next) => {
          if (before.current && next.startedAt !== before.current) {
            setStatus(next);
            setWatching(false);
            setNotice(`Lair restarted at ${new Date(next.startedAt).toLocaleTimeString()}`);
            return;
          }
          setStatus(next);
          if (next.state === "failed" || next.state === "idle") setWatching(false);
        })
        .catch(() => {
          // Down while it restarts
          if (Date.now() - since.current > COMEBACK_MS) {
            setWatching(false);
            setNotice("Lair has not come back: is a service manager running it (launchd KeepAlive, systemd Restart=always)?");
          } else {
            setNotice("Restarting: waiting for Lair to answer again...");
          }
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watching]);

  if (!status) return null;

  const busy = watching || status.state === "updating" || status.state === "restarting";
  const warning = managerWarning(status);

  const ask = async (update: boolean) => {
    if (!window.confirm(restartQuestion(update, status))) return;
    setNotice(null);
    const result = await requestRestart(update).catch((e: unknown) => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
      data: undefined,
    }));
    if (!result.success || !result.data) {
      setNotice(result.error ?? "The restart was refused");
      return;
    }
    before.current = result.data.startedAt;
    since.current = Date.now();
    setStatus(result.data);
    setShowLog(update);
    setNotice(update ? "Updating..." : "Restarting...");
    setWatching(true);
  };

  const log = status.output.length > 0 || status.error;
  return (
    <>
      <span>•</span>
      <span data-server-controls="owner">
        <button type="button" style={button} disabled={busy} onClick={() => void ask(false)}>
          Restart
        </button>{" "}
        {status.update.configured && (
          <button type="button" style={button} disabled={busy} onClick={() => void ask(true)}>
            Update and restart
          </button>
        )}{" "}
        {log && (
          <button type="button" style={button} onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide update log" : "Update log"}
          </button>
        )}
      </span>
      {status.state === "failed" && status.error && (
        <span style={{ color: "var(--error)" }} data-server-update="failed">
          {status.error}
        </span>
      )}
      {notice && <span>{notice}</span>}
      {warning && !busy && (
        <span title={warning} style={{ color: "var(--warning)" }}>
          (no service manager seen: Restart may only stop Lair)
        </span>
      )}
      {showLog && log && (
        <div className="card" style={panel} data-server-update="log">
          {status.error && <div style={{ color: "var(--error)", marginBottom: "0.5rem" }}>{status.error}</div>}
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{status.output.join("\n")}</pre>
        </div>
      )}
    </>
  );
}
