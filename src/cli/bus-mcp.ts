/**
 * `lair bus-mcp`: Lair's bus API as an MCP server over stdio.
 *
 *   LAIR_BUS_TOKEN=<token> lair bus-mcp
 *
 * Each tool call is one POST to the Lair server's bus route, with the token
 * from LAIR_BUS_TOKEN and LAIR_URL (default http://127.0.0.1:4777). The server
 * checks the token, validates the arguments, and executes the request.
 *
 * Tools: whoami, report, inbox, ack, send, board
 *
 * Claims have ONE source of truth: the agents module. The bus does not keep
 * its own claim table. whoami shows the run's claimed task. A report for a
 * task the run doesn't hold is refused.
 *
 * stdout is the MCP protocol's; nothing else is written there. The token is
 * never printed. Exit codes: 0 when the client closed the session; 2 a
 * usage error (no token, a bad LAIR_URL).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "stream";
import { z } from "zod";
import { LAIR_VERSION } from "../shared/version.js";
import { isBusTokenFormat, redactBusToken } from "../server/bus/tokens.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4777";

export const BUS_MCP_USAGE = [
  "Usage: lair bus-mcp",
  "",
  "An MCP server over stdio for Lair's bus API. Reads LAIR_BUS_TOKEN (a bus token",
  "given to the run's environment) and LAIR_URL (default http://127.0.0.1:4777).",
].join("\n");

const MAX_RESPONSE_CHARS = 1024 * 1024;
const TIMEOUT_MS = 30_000;

// ============ Tool specs ============

const ReportKind = z.enum(["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"]);

const BUS_TOOLS = [
  {
    name: "whoami",
    description: "Get current agent identity, run id, and claimed task",
    shape: {},
  },
  {
    name: "report",
    description: "Report task status (WAITING, DONE, BLOCKED, PROGRESS, TICK). Your run must hold this task.",
    shape: {
      kind: ReportKind.describe("Status kind"),
      task: z.string().min(1).max(200).describe("Task identifier"),
      summary: z.string().min(1).max(10000).describe("Status summary"),
      gate_id: z.string().max(200).optional().describe("Gate id if relevant: one plain name (letters, digits, ., _ and -; no / or ..)"),
      pr: z.number().int().positive().optional().describe("PR number if relevant"),
      sha: z.string().max(64).optional().describe("Commit SHA if relevant: 7 to 64 hex digits"),
    },
  },
  {
    name: "inbox",
    description: "Get unread messages for this agent. Messages are marked as read when returned.",
    shape: {},
  },
  {
    name: "ack",
    description: "Acknowledge a message with an optional note",
    shape: {
      message_id: z.string().min(1).max(20).describe("Message id to acknowledge"),
      note: z.string().max(1000).optional().describe("Acknowledgement note"),
    },
  },
  {
    name: "send",
    description: "Send a message to orchestrator or owner. Agents cannot send to other agents.",
    shape: {
      to: z.enum(["orchestrator", "owner"]).describe("Recipient: orchestrator or owner"),
      text: z.string().min(1).max(10000).describe("Message text"),
      priority: z.number().int().min(1).max(10).default(5).optional().describe("Priority 1-10 (default 5)"),
    },
  },
  {
    name: "board",
    description: "Get the current board state: tasks, owners, and last reports",
    shape: {},
  },
] as const;

// ============ HTTP client ============

export type BusCallResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string };

export interface BusClient {
  call(tool: string, args: Record<string, unknown>): Promise<BusCallResult>;
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export function httpBusClient(base: URL, token: string, fetchImpl: Fetch, timeoutMs = TIMEOUT_MS): BusClient {
  const url = new URL("/api/bus/call", base).toString();
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
      if (status >= 200 && status < 300 && body.success === true) {
        return { ok: true, status, data: body.data };
      }
      const error = typeof body.error === "string" ? body.error.slice(0, 2000) : `HTTP ${status}`;
      // Never include the token in errors
      return { ok: false, status, error: redactBusToken(error, token) };
    },
  };
}

// ============ MCP server ============

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

export function createBusMcpServer(client: BusClient): McpServer {
  const server = new McpServer({ name: "lair-bus", version: LAIR_VERSION });

  for (const spec of BUS_TOOLS) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.shape,
        annotations: {
          readOnlyHint: spec.name === "whoami" || spec.name === "inbox" || spec.name === "board",
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const result = await client.call(spec.name, args);
        if (result.ok) return text(JSON.stringify(result.data, null, 2));
        return text(`Lair refused ${spec.name} (HTTP ${result.status}): ${result.error}`, true);
      },
    );
  }

  return server;
}

// ============ Entry point ============

export interface BusMcpDeps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  err: (line: string) => void;
  stdin?: Readable;
  stdout?: Writable;
}

export async function runBusMcp(deps: BusMcpDeps): Promise<number> {
  const token = deps.env.LAIR_BUS_TOKEN ?? "";
  if (!isBusTokenFormat(token)) {
    deps.err("lair bus-mcp: LAIR_BUS_TOKEN is not set to a bus token");
    deps.err(BUS_MCP_USAGE);
    return EXIT_USAGE;
  }

  let base: URL;
  try {
    base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
  } catch {
    deps.err("lair bus-mcp: LAIR_URL is not a URL");
    return EXIT_USAGE;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    deps.err("lair bus-mcp: LAIR_URL is not an http(s) URL");
    return EXIT_USAGE;
  }

  const server = createBusMcpServer(httpBusClient(base, token, deps.fetch));
  const stdin = deps.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, deps.stdout ?? process.stdout);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(transport);
  stdin.once("end", () => void server.close());
  await closed;
  return EXIT_OK;
}
