/**
 * Shown above actions that need the owner's session (owner-actions.ts),
 * while this browser is not signed in as the owner: the server refuses them
 * with 403 until it is. Signing in happens once, in the Decisions view.
 */
import { useEffect, useState } from "react";
import { ownerStatus } from "../owner-session";

interface Props {
  /** What needs the session, e.g. "Starting and stopping dragons" */
  what: string;
  /** Re-checks when it changes (the views' refresh key) */
  refreshKey?: number;
}

export function SignInHint({ what, refreshKey }: Props) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    ownerStatus()
      .then((status) => {
        if (!cancelled) setSignedIn(status.signedIn);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
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
