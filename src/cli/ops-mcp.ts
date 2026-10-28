/**
 * `lair ops-mcp`: Lair's ops API as an MCP server over stdio, for any
 * MCP-capable agent tool (docs/configuration.md#supervisor-self-checks-and-the-ops-api).
 *
 *   LAIR_OPS_TOKEN=<token> lair ops-mcp
 *
 * Each tool call is one POST /api/ops/call to the Lair server, with the
 * token from LAIR_OPS_TOKEN (an ops token: minted for a supervisor run, or
 * by the owner for an interactive session) and LAIR_URL (default
 * http://127.0.0.1:4777). The server checks the token, the project and the
 * arguments, audits the call, and redacts and bounds the answer; this
 * bridge only checks the arguments early with the same list
 * (src/server/supervisor/ops-catalog.ts). Read tools only.
 *
 * stdout is the MCP protocol's; nothing else is written there. The token is
 * never printed. Exit codes: 0 when the client closed the session; 2 a
 * usage error (no token, a bad LAIR_URL).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "stream";
import { OPS_TOOLS } from "../server/supervisor/ops-catalog.js";
import { LAIR_VERSION } from "../shared/version.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4777";

export const OPS_MCP_USAGE = [
  "Usage: lair ops-mcp",
  "",
  "An MCP server over stdio for Lair's read-only ops API. Reads LAIR_OPS_TOKEN (an ops token:",
  "Home > Health > Connect an AI tool mints one for the owner) and LAIR_URL (default http://127.0.0.1:4777).",
].join("\n");

const TOKEN = /^lairops_[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type OpsCallResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; error: string };

export interface OpsClient {
  call(tool: string, args: Record<string, unknown>): Promise<OpsCallResult>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** The ops API over HTTP: one POST /api/ops/call per tool call. */
export function httpOpsClient(base: URL, token: string, fetchImpl: Fetch, timeoutMs = TIMEOUT_MS): OpsClient {
  const url = new URL("/api/ops/call", base).toString();
  return {
    async call(tool, args) {
      let status: number;
      let text: string;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ tool, args }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
      } catch {
        return { ok: false, status: 0, error: `Lair could not be reached at ${base.origin}` };
      }
      let body: { success?: unknown; data?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        body = {};
      }
      if (status >= 200 && status < 300 && body.success === true) return { ok: true, status, data: body.data };
      const error = typeof body.error === "string" ? body.error.slice(0, 2000) : `HTTP ${status}`;
      return { ok: false, status, error: error.split(token).join("[token]") };
    },
  };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** The MCP server: one tool per ops tool, each forwarded to `client`. */
export function createOpsMcpServer(client: OpsClient): McpServer {
  const server = new McpServer({ name: "lair-ops", version: LAIR_VERSION });
  for (const spec of OPS_TOOLS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.shape, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: Record<string, unknown>) => {
        const result = await client.call(spec.name, args);
        if (result.ok) return text(JSON.stringify(result.data, null, 2));
        return text(`Lair refused ${spec.name} (HTTP ${result.status}): ${result.error}`, true);
      },
    );
  }
  return server;
}

export interface OpsMcpDeps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  err: (line: string) => void;
  stdin?: Readable;
  stdout?: Writable;
}

/** Run `lair ops-mcp` until the client closes the session; resolves to the exit code. */
export async function runOpsMcp(deps: OpsMcpDeps): Promise<number> {
  const token = deps.env.LAIR_OPS_TOKEN ?? "";
  if (!TOKEN.test(token)) {
    deps.err("lair ops-mcp: LAIR_OPS_TOKEN is not set to an ops token");
    deps.err(OPS_MCP_USAGE);
    return EXIT_USAGE;
  }
  let base: URL;
  try {
    base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
  } catch {
    deps.err("lair ops-mcp: LAIR_URL is not a URL");
    return EXIT_USAGE;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    deps.err("lair ops-mcp: LAIR_URL is not an http(s) URL");
    return EXIT_USAGE;
  }
  const server = createOpsMcpServer(httpOpsClient(base, token, deps.fetch));
  const stdin = deps.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, deps.stdout ?? process.stdout);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(transport);
  // The stdio transport doesn't watch for the end of its input: the client closing it ends the session
  stdin.once("end", () => void server.close());
  await closed;
  return EXIT_OK;
}
