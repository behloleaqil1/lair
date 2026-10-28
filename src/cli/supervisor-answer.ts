/**
 * `lair supervisor answer`: how a supervisor run Lair started submits its
 * answer (docs/configuration.md#supervisor-chat-and-digest).
 *
 *   lair supervisor answer --conversation <id> --file <markdown> [--evidence-file <json>]
 *
 * It runs inside the supervisor's run, whose environment the agents module
 * built: LAIR_OPS_TOKEN (the run's ops token), LAIR_SUPERVISOR_CONVERSATION
 * (the conversation, when --conversation is left out) and LAIR_URL (default
 * http://127.0.0.1:4777). It posts to POST /api/ops/answer. Lair takes one
 * answer per question, only from the run that was asked, and only while
 * that run is active. The token is never printed.
 *
 * The answer file is Markdown (at most 20000 characters). The evidence file
 * is a JSON list of the tool calls the answer cites:
 * `[{"tool": "events.query", "args": {...}, "note": "what it showed"}]`.
 *
 * Exit codes: 0 recorded; 1 refused by Lair (it says why: a used, ended or
 * another run's token, an answer already given, an invalid answer); 2 a
 * usage or input error, and nothing was sent; 3 Lair could not be reached
 * or answered with a server error.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4777";

export const ANSWER_USAGE = [
  "Usage: lair supervisor answer --conversation <id> --file <markdown> [--evidence-file <json>]",
  "",
  "Submits a supervisor run's answer, once. Reads LAIR_OPS_TOKEN, LAIR_SUPERVISOR_CONVERSATION and LAIR_URL",
  "from the environment (Lair sets them for a supervisor run). The evidence file is a JSON list of",
  '{"tool": "<ops tool>", "args": {...}, "note": "what it showed"}.',
].join("\n");

const MAX_ANSWER_CHARS = 20_000;
const MAX_EVIDENCE_BYTES = 96 * 1024;
const MAX_RESPONSE_CHARS = 64 * 1024;
const TIMEOUT_MS = 30_000;
const TOKEN = /^lairops_[A-Za-z0-9_-]{43}$/;
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AnswerDeps {
  env: Record<string, string | undefined>;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
    status: number;
    text(): Promise<string>;
  }>;
  out: (line: string) => void;
  err: (line: string) => void;
  timeoutMs?: number;
}

class UsageError extends Error {}

const OPTIONS = ["--conversation", "--file", "--evidence-file"] as const;
type Option = (typeof OPTIONS)[number];

function parseOptions(args: string[]): Map<Option, string> {
  const values = new Map<Option, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i] as Option;
    if (!OPTIONS.includes(name)) throw new UsageError(`unknown argument ${args[i].slice(0, 40)}`);
    if (values.has(name)) throw new UsageError(`${name} is given twice`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) throw new UsageError(`${name} needs a value`);
    values.set(name, value);
    i++;
  }
  return values;
}

/** A whole regular file of at most `maxBytes`, as text. */
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

/** Run `lair supervisor answer <args>`; resolves to the exit code. */
export async function supervisorAnswer(args: string[], deps: AnswerDeps): Promise<number> {
  const token = deps.env.LAIR_OPS_TOKEN ?? "";
  const say = (write: (line: string) => void, line: string) => write(token.length > 0 ? line.split(token).join("[token]") : line);

  let request: { url: string; body: string; conversation: string };
  try {
    const options = parseOptions(args);
    if (!options.has("--file")) throw new UsageError("--file is required");
    const conversation = options.get("--conversation") ?? deps.env.LAIR_SUPERVISOR_CONVERSATION ?? "";
    if (!CONVERSATION.test(conversation)) {
      throw new UsageError("--conversation is the conversation's id (LAIR_SUPERVISOR_CONVERSATION holds it in a supervisor run)");
    }
    if (!TOKEN.test(token)) throw new UsageError("LAIR_OPS_TOKEN is not set to an ops token (Lair sets it for a supervisor run)");
    let base: URL;
    try {
      base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
    } catch {
      throw new UsageError("LAIR_URL is not a URL");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new UsageError("LAIR_URL is not an http(s) URL");

    const answer = readBounded(options.get("--file")!, MAX_ANSWER_CHARS * 4, "answer file").trim();
    if (answer.length === 0) throw new UsageError("the answer file is empty");
    if (answer.length > MAX_ANSWER_CHARS) throw new UsageError(`the answer is longer than ${MAX_ANSWER_CHARS} characters`);
    let evidence: unknown = [];
    const evidenceFile = options.get("--evidence-file");
    if (evidenceFile) {
      try {
        evidence = JSON.parse(readBounded(evidenceFile, MAX_EVIDENCE_BYTES, "evidence file"));
      } catch (e) {
        if (e instanceof UsageError) throw e;
        throw new UsageError("the evidence file is not JSON");
      }
      if (!Array.isArray(evidence)) throw new UsageError('the evidence file is not a JSON list of {"tool", "args", "note"}');
    }
    request = {
      url: new URL("/api/ops/answer", base).toString(),
      conversation,
      body: JSON.stringify({ conversation, answer, evidence }),
    };
  } catch (e) {
    // Nothing was sent
    say(deps.err, `lair supervisor answer: ${e instanceof Error ? e.message : String(e)}`);
    say(deps.err, ANSWER_USAGE);
    return EXIT_USAGE;
  }

  let status: number;
  let text: string;
  try {
    const response = await deps.fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: request.body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    status = response.status;
    text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
  } catch {
    say(deps.err, `lair supervisor answer: could not reach Lair at ${new URL(request.url).origin}`);
    return EXIT_UNAVAILABLE;
  }
  let body: { success?: boolean; error?: unknown; data?: { turn?: unknown } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  if (status >= 200 && status < 300 && body.success === true) {
    const turn = typeof body.data?.turn === "number" ? ` (question ${body.data.turn})` : "";
    say(deps.out, `Answer recorded for conversation ${request.conversation}${turn}`);
    return EXIT_OK;
  }
  const error = typeof body.error === "string" ? body.error.slice(0, 1000) : text.slice(0, 200).replace(/\s+/g, " ");
  if (status >= 400 && status < 500) {
    say(deps.err, `lair supervisor answer: refused (HTTP ${status}): ${error}`);
    return EXIT_REFUSED;
  }
  say(deps.err, `lair supervisor answer: Lair answered HTTP ${status}: ${error}`);
  return EXIT_UNAVAILABLE;
}
