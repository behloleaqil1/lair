/**
 * `lair bus <command>`: CLI for the bus API (for tools without MCP).
 *
 *   lair bus report --kind DONE --task <id> --summary-file <f> [--gate <id>] [--pr <n>] [--sha <sha>]
 *   lair bus whoami
 *   lair bus inbox
 *   lair bus ack --message <id> [--note <text>]
 *   lair bus send --to orchestrator|owner --text <text> [--priority <1-10>]
 *   lair bus board
 *   lair bus token create|list|revoke ...   (the owner's: TOKEN_USAGE)
 *
 * Reads LAIR_BUS_TOKEN and LAIR_URL from the environment (Lair sets them for
 * agent runs; a worker outside Lair's runs sets an external worker token,
 * which only reports). The token is never printed. `lair bus token` reads
 * LAIR_OWNER_SESSION instead, and never prints it.
 *
 * Exit codes: 0 success; 1 refused by Lair; 2 usage error; 3 Lair unreachable.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { isBusTokenFormat, isExtTokenFormat, redactBusToken } from "../server/bus/tokens.js";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4777";

export const USAGE = [
  "Usage: lair bus <command> [options]",
  "",
  "Commands:",
  "  whoami                                      Get agent identity and claimed task",
  "  report --kind <kind> --task <id> --summary-file <f> [--gate <id>] [--pr <n>] [--sha <sha>]",
  "                                              Report task status (WAITING|DONE|BLOCKED|PROGRESS|TICK)",
  "  inbox                                       Get unread messages",
  "  ack --message <id> [--note <text>]          Acknowledge a message",
  "  send --to orchestrator|owner --text <text> [--priority <1-10>]",
  "                                              Send a message",
  "  board                                       Get the board state",
  "  token create|list|revoke ...                The owner's external worker tokens (lair bus token)",
  "",
  "Reads LAIR_BUS_TOKEN and LAIR_URL from the environment. An external worker's token only reports.",
].join("\n");

export const TOKEN_USAGE = [
  "Usage: lair bus token <command> --project <p> [options]",
  "",
  "  create --worker <id> [--ttl <n>m|h|d] [--kinds PROGRESS,WAITING,DONE,BLOCKED]",
  "                    A report-only token for a worker outside Lair's runs, printed once (default 24h, at most 30d)",
  "  list              The project's external worker tokens (never the tokens)",
  "  revoke <id>       Revoke one",
  "",
  "The owner's: reads LAIR_OWNER_SESSION (a dashboard's owner session) and LAIR_URL from the environment.",
].join("\n");

const TTL = /^([1-9]\d{0,4})([mhd])$/;
const TTL_MINUTES = { m: 1, h: 60, d: 24 * 60 } as const;

const MAX_SUMMARY_CHARS = 10_000;
const MAX_SUMMARY_FILE_BYTES = 50 * 1024;
const MAX_RESPONSE_CHARS = 64 * 1024;
const TIMEOUT_MS = 30_000;

const KINDS = ["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"] as const;
type ReportKind = (typeof KINDS)[number];

export interface BusCliDeps {
  env: Record<string, string | undefined>;
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
  ) => Promise<{ status: number; text(): Promise<string> }>;
  out: (line: string) => void;
  err: (line: string) => void;
  timeoutMs?: number;
}

class UsageError extends Error {}

function readBounded(path: string, maxBytes: number, what: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new UsageError(`the ${what} ${code === "ENOENT" ? "does not exist" : `cannot be read (${code ?? "error"})`}`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new UsageError(`the ${what} is not a regular file`);
    if (stats.size > maxBytes) throw new UsageError(`the ${what} is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function parseArgs(args: string[]): { command: string; options: Map<string, string> } {
  if (args.length === 0) throw new UsageError("missing command");
  const command = args[0];
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (options.has(name)) throw new UsageError(`${arg} is given twice`);
      options.set(name, value);
      i++;
    } else {
      throw new UsageError(`unexpected argument: ${arg.slice(0, 40)}`);
    }
  }
  return { command, options };
}

function require(options: Map<string, string>, ...names: string[]): void {
  for (const name of names) {
    if (!options.has(name)) throw new UsageError(`--${name} is required`);
  }
}

export async function busCli(args: string[], deps: BusCliDeps): Promise<number> {
  if (args[0] === "token") return tokenCli(args.slice(1), deps);
  const token = deps.env.LAIR_BUS_TOKEN ?? "";
  const say = (write: (line: string) => void, line: string) =>
    write(token.length > 0 ? redactBusToken(line, token) : line);
  const usage = (why: string) => {
    say(deps.err, `lair bus: ${why}`);
    say(deps.err, USAGE);
    return EXIT_USAGE;
  };

  let request: { tool: string; args: Record<string, unknown> };
  try {
    if (!isBusTokenFormat(token) && !isExtTokenFormat(token)) {
      throw new UsageError("LAIR_BUS_TOKEN is not set (Lair sets it for agent runs; the owner makes an external worker's: lair bus token create)");
    }

    const { command, options } = parseArgs(args);

    switch (command) {
      case "whoami":
        request = { tool: "whoami", args: {} };
        break;

      case "report": {
        require(options, "kind", "task", "summary-file");
        const kind = options.get("kind")!.toUpperCase();
        if (!KINDS.includes(kind as ReportKind)) {
          throw new UsageError(`--kind must be one of: ${KINDS.join(", ")}`);
        }
        const summary = readBounded(options.get("summary-file")!, MAX_SUMMARY_FILE_BYTES, "summary file").trim();
        if (summary.length > MAX_SUMMARY_CHARS) throw new UsageError(`summary is longer than ${MAX_SUMMARY_CHARS} characters`);
        const pr = options.get("pr");
        const prNum = pr ? Number(pr) : undefined;
        if (pr && (!Number.isInteger(prNum) || prNum! <= 0)) throw new UsageError("--pr must be a positive integer");
        request = {
          tool: "report",
          args: {
            kind,
            task: options.get("task")!,
            summary,
            ...(options.has("gate") ? { gate_id: options.get("gate") } : {}),
            ...(prNum !== undefined ? { pr: prNum } : {}),
            ...(options.has("sha") ? { sha: options.get("sha") } : {}),
          },
        };
        break;
      }

      case "inbox":
        request = { tool: "inbox", args: {} };
        break;

      case "ack":
        require(options, "message");
        request = {
          tool: "ack",
          args: {
            message_id: options.get("message")!,
            ...(options.has("note") ? { note: options.get("note") } : {}),
          },
        };
        break;

      case "send": {
        require(options, "to", "text");
        const to = options.get("to")!;
        if (to !== "orchestrator" && to !== "owner") {
          throw new UsageError("--to must be orchestrator or owner");
        }
        const priority = options.get("priority");
        const priNum = priority ? Number(priority) : undefined;
        if (priority && (!Number.isInteger(priNum) || priNum! < 1 || priNum! > 10)) {
          throw new UsageError("--priority must be 1-10");
        }
        request = {
          tool: "send",
          args: {
            to,
            text: options.get("text")!,
            ...(priNum !== undefined ? { priority: priNum } : {}),
          },
        };
        break;
      }

      case "board":
        request = { tool: "board", args: {} };
        break;

      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }

  return callLair(deps, say, usage, "POST", "/api/bus/call", () => ({ authorization: `Bearer ${token}` }), request);
}

/**
 * `lair bus token create|list|revoke`: the owner's external worker tokens. The owner session goes as the dashboard
 * sends it (header, origin, same-origin), so the server checks it as any owner-only request; it is never printed.
 */
async function tokenCli(args: string[], deps: BusCliDeps): Promise<number> {
  const session = deps.env.LAIR_OWNER_SESSION ?? "";
  const say = (write: (line: string) => void, line: string) => write(session.length > 0 ? line.split(session).join("[owner-session]") : line);
  const usage = (why: string) => {
    say(deps.err, `lair bus token: ${why}`);
    say(deps.err, TOKEN_USAGE);
    return EXIT_USAGE;
  };

  let method: "GET" | "POST" = "POST";
  let path: string;
  let payload: Record<string, unknown> | undefined;
  try {
    if (session.length < 20) throw new UsageError("LAIR_OWNER_SESSION is not set (a dashboard's owner session)");
    // `revoke <id>`: the one argument that isn't an option
    const id = args[0] === "revoke" && args[1] !== undefined && !args[1].startsWith("--") ? args[1] : undefined;
    const { command, options } = parseArgs(id === undefined ? args : [args[0], ...args.slice(2)]);
    require(options, "project");
    const query = `?project=${encodeURIComponent(options.get("project")!)}`;
    switch (command) {
      case "create": {
        require(options, "worker");
        const ttl = options.get("ttl");
        const ttlParts = ttl === undefined ? null : TTL.exec(ttl);
        if (ttl !== undefined && ttlParts === null) throw new UsageError("--ttl must be minutes, hours or days: 90m, 24h, 7d");
        const kinds = options.get("kinds")?.split(",").map((kind) => kind.trim().toUpperCase());
        if (kinds?.some((kind) => !KINDS.includes(kind as ReportKind))) throw new UsageError(`--kinds must be some of: ${KINDS.join(", ")}`);
        path = `/api/bus/tokens${query}`;
        payload = {
          worker: options.get("worker"),
          ...(ttlParts ? { ttl_minutes: Number(ttlParts[1]) * TTL_MINUTES[ttlParts[2] as keyof typeof TTL_MINUTES] } : {}),
          ...(kinds ? { kinds } : {}),
        };
        break;
      }
      case "list":
        method = "GET";
        path = `/api/bus/tokens${query}`;
        break;
      case "revoke":
        if (id === undefined) throw new UsageError("revoke needs the token's id: lair bus token revoke <id> --project <p>");
        path = `/api/bus/tokens/${encodeURIComponent(id)}/revoke${query}`;
        payload = {};
        break;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }

  return callLair(deps, say, usage, method, path, (origin) => ({ "x-lair-owner-session": session, origin, "sec-fetch-site": "same-origin" }), payload);
}

/** One request to Lair (JSON), its data printed: 0, else 1 refused, 2 a bad LAIR_URL, 3 unreachable or a server error */
async function callLair(
  deps: BusCliDeps,
  say: (write: (line: string) => void, line: string) => void,
  usage: (why: string) => number,
  method: "GET" | "POST",
  path: string,
  headers: (origin: string) => Record<string, string>,
  payload?: unknown,
): Promise<number> {
  let base: URL;
  try {
    base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
  } catch {
    return usage("LAIR_URL is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return usage("LAIR_URL is not an http(s) URL");
  }

  const url = new URL(path, base).toString();
  const init: Parameters<BusCliDeps["fetch"]>[1] = { method, headers: headers(base.origin), signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) };
  // A GET has no body
  if (payload !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  let status: number;
  let text: string;
  try {
    const response = await deps.fetch(url, init);
    status = response.status;
    text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
  } catch (e) {
    say(deps.err, `lair bus: could not reach Lair at ${base.origin}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_UNAVAILABLE;
  }

  let body: { success?: boolean; error?: unknown; data?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  if (status >= 200 && status < 300 && body.success === true) {
    say(deps.out, JSON.stringify(body.data, null, 2));
    return EXIT_OK;
  }

  const error = typeof body.error === "string" ? body.error.slice(0, 1000) : text.slice(0, 200).replace(/\s+/g, " ");
  if (status >= 400 && status < 500) {
    say(deps.err, `lair bus: refused (HTTP ${status}): ${error}`);
    return EXIT_REFUSED;
  }
  say(deps.err, `lair bus: Lair answered HTTP ${status}: ${error}`);
  return EXIT_UNAVAILABLE;
}
