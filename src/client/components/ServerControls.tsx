/**
 * The owner's "Restart" and "Update and restart" (src/server/restart/), in
 * the footer at the bottom of the nav. Shown only to a browser signed in as the owner. Each asks for
 * confirmation; while the update runs its output is shown, a failed update
 * shows its error (nothing restarted), and after the restart the dashboard
 * waits for the new server to answer.
 */
import { useEffect, useRef, useState } from "react";
import type { RestartStatusView } from "../../shared/lifecycle-types";
import { ownerStatus } from "../owner-session";
import { managerWarning, requestRestart, restartQuestion, restartStatus } from "../server-controls";
import { Button } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";

const POLL_MS = 1000;
/** How long to wait for the new server before saying it has not come back */
const COMEBACK_MS = 120_000;

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
      <span className="server-controls" data-server-controls="owner">
        <Button size="sm" disabled={busy} onClick={() => void ask(false)}>
          Restart
        </Button>
        {status.update.configured && (
          <Button size="sm" disabled={busy} onClick={() => void ask(true)}>
            Update and restart
          </Button>
        )}
        {log && (
          <Button size="sm" variant="ghost" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide update log" : "Update log"}
          </Button>
        )}
      </span>
      {status.state === "failed" && status.error && (
        <span className="server-note text-danger" data-server-update="failed">
          {status.error}
        </span>
      )}
      {notice && <span className="server-note" role="status">{notice}</span>}
      {warning && !busy && (
        <span className="server-note waiting" title={warning}>
          (no service manager seen: Restart may only stop Lair)
        </span>
      )}
      {showLog && log && (
        <div className="card server-log" data-server-update="log">
          {status.error && <p className="text-danger">{status.error}</p>}
          <CodeBlock label="Update log">{status.output.join("\n")}</CodeBlock>
        </div>
      )}
    </>
  );
}
