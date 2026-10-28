/**
 * `lair bus <command>`: CLI for the bus API (for tools without MCP).
 *
 *   lair bus report --kind DONE --task <id> --summary-file <f> [--gate <id>] [--pr <n>] [--sha <sha>]
 *   lair bus whoami
 *   lair bus inbox
 *   lair bus ack --message <id> [--note <text>]
 *   lair bus send --to orchestrator|owner --text <text> [--priority <1-10>]
 *   lair bus board
 *
 * Reads LAIR_BUS_TOKEN and LAIR_URL from the environment (Lair sets them for
 * agent runs). The token is never printed.
 *
 * Exit codes: 0 success; 1 refused by Lair; 2 usage error; 3 Lair unreachable.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { isBusTokenFormat, redactBusToken } from "../server/bus/tokens.js";

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
  "",
  "Reads LAIR_BUS_TOKEN and LAIR_URL from the environment.",
].join("\n");

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
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
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
    if (!isBusTokenFormat(token)) throw new UsageError("LAIR_BUS_TOKEN is not set (Lair sets it for agent runs)");

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

  let base: URL;
  try {
    base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
  } catch {
    return usage("LAIR_URL is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return usage("LAIR_URL is not an http(s) URL");
  }

  const url = new URL("/api/bus/call", base).toString();
  let status: number;
  let text: string;
  try {
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
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
