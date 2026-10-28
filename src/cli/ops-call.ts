/**
 * `lair ops call`: one call of Lair's read-only ops API, for any agent tool
 * that can run a command (docs/configuration.md#supervisor-chat-and-digest).
 * MCP-capable tools can use `lair ops-mcp` instead; both reach the same
 * route.
 *
 *   lair ops call <tool> [--args <json>]
 *
 * It reads LAIR_OPS_TOKEN (an ops token: Lair puts a run's in a supervisor
 * run's environment; the owner can mint one in Home > Health) and LAIR_URL
 * (default http://127.0.0.1:4777), checks the tool and its arguments with
 * the same list the server uses (src/server/supervisor/ops-catalog.ts), and
 * prints Lair's answer as JSON: `{tool, project, truncated, result}`. The
 * token is never printed.
 *
 * Exit codes: 0 the answer is printed; 1 Lair refused the call (it says
 * why); 2 a usage error, and nothing was sent; 3 Lair could not be reached,
 * or answered with a server error.
 */
import { OPS_TOOLS, opsTool, parseOpsArgs } from "../server/supervisor/ops-catalog.js";
import { DEFAULT_SERVER_URL, httpOpsClient } from "./ops-mcp.js";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;

export const OPS_CALL_USAGE = [
  "Usage: lair ops call <tool> [--args <json>]",
  "",
  "Calls one of Lair's read-only ops tools and prints the answer as JSON. Reads LAIR_OPS_TOKEN and",
  "LAIR_URL (default http://127.0.0.1:4777); Lair sets both for a supervisor run.",
  `Tools: ${OPS_TOOLS.map((t) => t.name).join(", ")}`,
].join("\n");

const TOKEN = /^lairops_[A-Za-z0-9_-]{43}$/;
const MAX_ARGS_CHARS = 16 * 1024;

type Fetch = Parameters<typeof httpOpsClient>[2];

export interface OpsCallDeps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  timeoutMs?: number;
}

class UsageError extends Error {}

/** Run `lair ops call <args>`; resolves to the exit code. */
export async function opsCall(args: string[], deps: OpsCallDeps): Promise<number> {
  const token = deps.env.LAIR_OPS_TOKEN ?? "";
  const say = (write: (line: string) => void, line: string) => write(token.length > 0 ? line.split(token).join("[token]") : line);

  let tool: string;
  let callArgs: Record<string, unknown>;
  let base: URL;
  try {
    const [name, ...rest] = args;
    if (name === undefined || name.startsWith("-")) throw new UsageError("the tool comes first");
    const spec = opsTool(name);
    if (!spec) throw new UsageError(`unknown tool ${name.slice(0, 80)}`);
    let raw: unknown = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== "--args") throw new UsageError(`unknown argument ${rest[i].slice(0, 40)}`);
      if (i + 1 >= rest.length) throw new UsageError("--args needs a JSON object");
      if (i > 0) throw new UsageError("--args is given twice");
      const text = rest[i + 1];
      if (text.length > MAX_ARGS_CHARS) throw new UsageError(`--args is longer than ${MAX_ARGS_CHARS} characters`);
      try {
        raw = JSON.parse(text);
      } catch {
        throw new UsageError("--args is not JSON");
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError("--args is not a JSON object");
      i++;
    }
    const parsed = parseOpsArgs(spec, raw);
    if (!parsed.ok) throw new UsageError(`invalid arguments for ${spec.name}: ${parsed.error}`);
    if (!TOKEN.test(token)) throw new UsageError("LAIR_OPS_TOKEN is not set to an ops token (Lair sets it for a supervisor run)");
    try {
      base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
    } catch {
      throw new UsageError("LAIR_URL is not a URL");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new UsageError("LAIR_URL is not an http(s) URL");
    tool = spec.name;
    callArgs = parsed.args;
  } catch (e) {
    say(deps.err, `lair ops call: ${e instanceof Error ? e.message : String(e)}`);
    say(deps.err, OPS_CALL_USAGE);
    return EXIT_USAGE;
  }

  const result = await httpOpsClient(base, token, deps.fetch, deps.timeoutMs).call(tool, callArgs);
  if (result.ok) {
    say(deps.out, JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  }
  if (result.status === 0) {
    say(deps.err, `lair ops call: ${result.error}`);
    return EXIT_UNAVAILABLE;
  }
  if (result.status >= 400 && result.status < 500) {
    say(deps.err, `lair ops call: refused (HTTP ${result.status}): ${result.error}`);
    return EXIT_REFUSED;
  }
  say(deps.err, `lair ops call: Lair answered HTTP ${result.status}: ${result.error}`);
  return EXIT_UNAVAILABLE;
}
