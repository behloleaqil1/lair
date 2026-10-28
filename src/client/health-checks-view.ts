/**
 * Home → Health's self-checks panel: which of Lair's checks need a look
 * (the failing ones first, then the warnings), from GET /api/health/diagnostics,
 * and what an MCP-capable tool needs to read Lair's ops API.
 */
import type { CheckResult, CheckStatus, DiagnosticsView, OpsTokenView } from "../shared/supervisor-types";
import { fetchApi, ownerHeaders } from "./owner-session";

export interface HealthRow {
  key: string;
  status: CheckStatus;
  title: string;
  /** "Lair" for a check of the server, else the project */
  where: string;
  explanation: string;
  fix: string | null;
  failingSince: string | null;
  noticeId: string | null;
}

export interface HealthSummary {
  /** The checks shown: the server's and this project's */
  total: number;
  failing: number;
  warning: number;
  unknown: number;
  lastRunAt: string | null;
}

/** The server's checks and the project's. */
function shown(view: DiagnosticsView, project: string): CheckResult[] {
  const own = view.projects.find((p) => p.project === project);
  return [...view.server, ...(own?.checks ?? [])];
}

/** The checks that need a look, failing first; each with its fix. */
export function attentionRows(view: DiagnosticsView, project: string): HealthRow[] {
  const rank = (s: CheckStatus) => (s === "failing" ? 0 : 1);
  return shown(view, project)
    .filter((c) => c.status === "failing" || c.status === "warning")
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((c) => ({
      key: `${c.scope}:${c.id}`,
      status: c.status,
      title: c.title,
      where: c.scope === "server" ? "Lair" : c.scope,
      explanation: c.explanation,
      fix: c.fix,
      failingSince: c.failingSince,
      noticeId: c.noticeId,
    }));
}

export function healthSummary(view: DiagnosticsView, project: string): HealthSummary {
  const checks = shown(view, project);
  const own = view.projects.find((p) => p.project === project);
  return {
    total: checks.length,
    failing: checks.filter((c) => c.status === "failing").length,
    warning: checks.filter((c) => c.status === "warning").length,
    unknown: checks.filter((c) => c.status === "unknown").length,
    lastRunAt: own?.lastRunAt ?? view.lastRunAt,
  };
}

/** What an MCP client's config needs to run `lair ops-mcp` with this token. */
export function mcpConfig(token: string, serverUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        lair: { command: "lair", args: ["ops-mcp"], env: { LAIR_OPS_TOKEN: token, LAIR_URL: serverUrl } },
      },
    },
    null,
    2,
  );
}

/** Mint an ops token for an interactive session (owner only); the token is in the answer this once. */
export function mintOpsToken(ttlMinutes = 60): Promise<{ token: string; info: OpsTokenView }> {
  return fetchApi<{ token: string; info: OpsTokenView }>("/api/supervisor/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerHeaders() },
    body: JSON.stringify({ ttl_minutes: ttlMinutes }),
  });
}
