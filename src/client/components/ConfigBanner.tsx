/**
 * "projects/x.yaml has an error; the previous config is still running: ..."
 * One line per project file whose latest version the server refused (live
 * config reload, src/server/reload/). Gone once the file is fixed.
 */
import { useEffect, useState } from "react";
import type { ConfigProblem } from "../../shared/lifecycle-types";
import { configStatus, problemText } from "../server-controls";

export function ConfigBanner({ refreshKey }: { refreshKey?: number }) {
  const [problems, setProblems] = useState<ConfigProblem[]>([]);

  useEffect(() => {
    let cancelled = false;
    configStatus()
      .then((status) => {
        if (!cancelled) setProblems(status.problems);
      })
      .catch(() => {
        // The server is away (restarting): keep what was shown
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (problems.length === 0) return null;
  return (
    <div style={{ padding: "0 2rem", maxWidth: "1400px", width: "100%", margin: "1rem auto 0" }}>
      {problems.map((p) => (
        <div
          key={p.project}
          className="card"
          role="alert"
          data-config-problem={p.project}
          style={{ border: "1px solid var(--error)", marginBottom: "0.5rem", padding: "0.75rem 1rem", whiteSpace: "pre-wrap" }}
        >
          {problemText(p)}
        </div>
      ))}
    </div>
  );
}
