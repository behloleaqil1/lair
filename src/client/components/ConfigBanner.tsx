/**
 * "projects/x.yaml has an error; the previous config is still running: ..."
 * One line per project file whose latest version the server refused (live
 * config reload, src/server/reload/). Gone once the file is fixed.
 */
import { useEffect, useState } from "react";
import type { ConfigProblem } from "../../shared/lifecycle-types";
import { configStatus, problemText } from "../server-controls";
import { Callout } from "../ui/Card";

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
    <div className="config-banner">
      {problems.map((p) => (
        <Callout key={p.project} tone="danger" alert data-config-problem={p.project}>
          {problemText(p)}
        </Callout>
      ))}
    </div>
  );
}
