/**
 * Shown above actions that need the owner's session (owner-actions.ts),
 * while this browser is not signed in as the owner: the server refuses them
 * with 403 until it is. Signing in happens once, in the Decisions view.
 * `onStatus` hands each check's answer to the view, so it can disable a form
 * while the browser is signed out.
 */
import { useEffect, useRef, useState } from "react";
import { ownerStatus } from "../owner-session";

interface Props {
  /** What needs the session, e.g. "Starting and stopping dragons" */
  what: string;
  /** Re-checks when it changes (the views' refresh key) */
  refreshKey?: number;
  /** Called after every check: true when this browser is signed in as the owner */
  onStatus?: (signedIn: boolean) => void;
}

export function SignInHint({ what, refreshKey, onStatus }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const report = useRef(onStatus);
  report.current = onStatus;

  useEffect(() => {
    let cancelled = false;
    const settle = (value: boolean) => {
      if (cancelled) return;
      setSignedIn(value);
      report.current?.(value);
    };
    ownerStatus()
      .then((status) => settle(status.signedIn))
      .catch(() => settle(false));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (signedIn !== false) return null;
  return (
    <div
      className="card"
      data-owner-hint="signed-out"
      style={{ borderColor: "var(--warning)", color: "var(--text-secondary)", marginBottom: "1rem" }}
    >
      {what} needs this browser to be signed in as the owner: sign in from Decisions.
    </div>
  );
}
