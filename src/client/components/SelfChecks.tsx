/**
 * Home → Health: Lair's self-checks (src/server/supervisor/), the failing
 * and warning ones with their fix, and "Connect an AI tool": a short-lived
 * ops token for any MCP-capable tool. The owner's only, like the route.
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { attentionRows, healthSummary, mcpConfig, mintOpsToken, type HealthRow } from "../health-checks-view";
import type { DiagnosticsView } from "../../shared/supervisor-types";
import { linkTo } from "../router";
import { Badge, ErrorState, Loading, OwnerOnlyNotice, Time, useOwnerSignedIn } from "./ui";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

const TONE: Record<HealthRow["status"], string> = { failing: "error", warning: "warning", ok: "success", unknown: "neutral" };

export function SelfChecksCard({ view, project }: { view: DiagnosticsView; project: string }) {
  const rows = attentionRows(view, project);
  const summary = healthSummary(view, project);
  return (
    <div className="card" data-card="self-checks">
      <h3>Lair's self-checks</h3>
      {!view.enabled && summary.total === 0 ? (
        <p className="muted small">The self-checks are off (supervisor.checks.enabled: false in the default project).</p>
      ) : summary.total === 0 ? (
        <p className="muted small">No check has run yet: the first round runs shortly after Lair starts.</p>
      ) : rows.length === 0 ? (
        <p className="all-clear" data-empty="self-checks">
          <Icon name="check-circle" />
          {`All ${summary.total - summary.unknown} measured checks pass${summary.unknown > 0 ? ` (${summary.unknown} could not be measured)` : ""}.`}
        </p>
      ) : (
        <ul className="plain-list" data-list="self-checks">
          {rows.map((row) => (
            <li key={row.key} data-check={row.key} className="mb-3">
              <Badge tone={TONE[row.status]}>{row.status}</Badge> <strong>{row.title}</strong> <span className="muted small">({row.where})</span>
              <div>{row.explanation}</div>
              {row.fix && <div className="muted small">{`Fix: ${row.fix}`}</div>}
              {row.failingSince && (
                <div className="muted small">
                  Failing since <Time iso={row.failingSince} />
                  {row.noticeId && (
                    <>
                      {" "}
                      · <a href={linkTo("decisions", row.noticeId)}>its notice</a>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {summary.lastRunAt && (
        <p className="muted small">
          Last checked <Time iso={summary.lastRunAt} />, every {view.intervalSeconds} s.
        </p>
      )}
    </div>
  );
}

function ConnectTool() {
  const [minted, setMinted] = useState<{ token: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token, info } = await mintOpsToken(60);
      setMinted({ token, expiresAt: info.expiresAt });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mint a token");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-card="connect-tool">
      <h3>Connect an AI tool</h3>
      <p className="muted small">
        Any MCP-capable tool can read Lair through its ops API (read-only, every call audited). This gives it a token for one hour,
        shown once and kept in Lair's memory only.
      </p>
      {minted ? (
        <>
          <p className="muted small">
            Add this to the tool's MCP config (or run <code>lair ops-mcp</code> with these variables). It stops working{" "}
            <Time iso={minted.expiresAt} />, or when Lair restarts.
          </p>
          <pre className="code-block">{mcpConfig(minted.token, window.location.origin)}</pre>
        </>
      ) : (
        <Button size="sm" onClick={() => void mint()} disabled={busy}>
          {busy ? "Minting..." : "Get a token for one hour"}
        </Button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function SelfChecks({ project, refreshKey }: { project: string; refreshKey: number }) {
  const signedIn = useOwnerSignedIn(refreshKey);
  const diagnostics = useApi<DiagnosticsView>("/health/diagnostics", project, refreshKey, { owner: true, skip: signedIn !== true });
  if (signedIn === false) {
    return (
      <div className="card" data-card="self-checks">
        <h3>Lair's self-checks</h3>
        <OwnerOnlyNotice text="Lair's self-checks are shown to the owner only." />
      </div>
    );
  }
  if (signedIn === null || (diagnostics.loading && !diagnostics.data)) return <Loading what="Lair's self-checks" />;
  if (diagnostics.error && !diagnostics.data) return <ErrorState what="Lair's self-checks" error={diagnostics.error} />;
  if (!diagnostics.data) return null;
  return (
    <>
      <SelfChecksCard view={diagnostics.data} project={project} />
      <ConnectTool />
    </>
  );
}
