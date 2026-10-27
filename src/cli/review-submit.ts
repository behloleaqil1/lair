/**
 * `lair review submit`: how a reviewer agent Lair started posts its review
 * (docs/configuration.md#reviews-by-agents).
 *
 *   lair review submit --pr <n> --head <sha> --verdict approve|request_changes
 *                      --summary-file <file> [--findings-file <file>]
 *
 * It runs inside the reviewer's run, whose environment the agents module
 * built: LAIR_REVIEW_TOKEN (the assignment token), LAIR_AGENT (the agent id),
 * LAIR_REVIEW_PROJECT and LAIR_URL (default http://127.0.0.1:4777). It posts
 * to the agents' review route, POST /api/review/prs/<n>/reviews. The token is
 * never printed: not in output, errors or usage.
 *
 * The findings file has one finding per line, `path:line: severity: text`
 * (severity critical, high, medium, low or info); blank lines are skipped.
 * With request_changes every finding blocks; with approve none does.
 *
 * Exit codes: 0 recorded; 1 refused by Lair (an invalid review, a wrong or
 * another agent's token, a closed PR); 2 a usage or input error (nothing was
 * sent); 3 Lair could not be reached or answered with a server error.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3;

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4777";

export const USAGE = [
  "Usage: lair review submit --pr <n> --head <sha> --verdict approve|request_changes",
  "                          --summary-file <file> [--findings-file <file>]",
  "",
  "Reads LAIR_REVIEW_TOKEN, LAIR_AGENT, LAIR_REVIEW_PROJECT and LAIR_URL from the environment",
  "(Lair sets them for a review run). Findings file: one `path:line: severity: text` per line.",
].join("\n");

/** As the review route takes them */
const MAX_SUMMARY_CHARS = 10_000;
const MAX_FINDINGS = 200;
const MAX_FINDING_TEXT = 4000;
const MAX_FINDING_PATH = 500;
const MAX_FINDINGS_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 5000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const TIMEOUT_MS = 30_000;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FINDING = /^(.+?):([1-9][0-9]{0,8}):\s*(critical|high|medium|low|info):\s*(\S.*)$/;

export interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string;
  line: number;
  text: string;
  blocking: boolean;
}

export interface SubmitDeps {
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

const OPTIONS = ["--pr", "--head", "--verdict", "--summary-file", "--findings-file"] as const;
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

/** Findings, one `path:line: severity: text` per line; an error names the first line that isn't one. */
export function parseFindings(text: string, blocking: boolean): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").slice(0, MAX_LINE_CHARS).trim();
    if (line.length === 0) continue;
    const match = FINDING.exec(line);
    if (!match) throw new UsageError(`findings line ${i + 1} is not \`path:line: severity: text\``);
    const [, file, lineNumber, severity, finding] = match;
    if (file.length > MAX_FINDING_PATH) throw new UsageError(`findings line ${i + 1}: the path is longer than ${MAX_FINDING_PATH}`);
    if (finding.length > MAX_FINDING_TEXT) throw new UsageError(`findings line ${i + 1}: the text is longer than ${MAX_FINDING_TEXT}`);
    findings.push({ severity: severity as Finding["severity"], file, line: Number(lineNumber), text: finding.trim(), blocking });
    if (findings.length > MAX_FINDINGS) throw new UsageError(`more than ${MAX_FINDINGS} findings`);
  }
  return findings;
}

/** Run `lair review submit <args>`; resolves to the exit code. */
export async function reviewSubmit(args: string[], deps: SubmitDeps): Promise<number> {
  const token = deps.env.LAIR_REVIEW_TOKEN ?? "";
  // Whatever is printed, the token is not
  const say = (write: (line: string) => void, line: string) =>
    write(token.length > 0 ? line.split(token).join("[token]") : line);
  const usage = (why: string) => {
    say(deps.err, `lair review submit: ${why}`);
    say(deps.err, USAGE);
    return EXIT_USAGE;
  };

  let request: { url: string; body: string; pr: number; head: string; verdict: string };
  try {
    const options = parseOptions(args);
    for (const required of ["--pr", "--head", "--verdict", "--summary-file"] as const) {
      if (!options.has(required)) throw new UsageError(`${required} is required`);
    }
    const prText = options.get("--pr")!;
    if (!/^[1-9][0-9]{0,9}$/.test(prText)) throw new UsageError("--pr is a PR number");
    const head = options.get("--head")!.toLowerCase();
    if (!FULL_SHA.test(head)) throw new UsageError("--head is the full head commit sha (40 or 64 hex digits)");
    const verdict = options.get("--verdict")!;
    if (verdict !== "approve" && verdict !== "request_changes") throw new UsageError("--verdict is approve or request_changes");

    if (!TOKEN.test(token)) throw new UsageError("LAIR_REVIEW_TOKEN is not set (Lair sets it for a review run)");
    const agent = deps.env.LAIR_AGENT ?? "";
    if (!AGENT_ID.test(agent)) throw new UsageError("LAIR_AGENT is not set to an agent id (Lair sets it for every run)");
    const project = deps.env.LAIR_REVIEW_PROJECT;
    if (project !== undefined && project !== "" && !PROJECT.test(project)) throw new UsageError("LAIR_REVIEW_PROJECT is not a project name");
    let base: URL;
    try {
      base = new URL(deps.env.LAIR_URL || DEFAULT_SERVER_URL);
    } catch {
      throw new UsageError("LAIR_URL is not a URL");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new UsageError("LAIR_URL is not an http(s) URL");

    const summary = readBounded(options.get("--summary-file")!, MAX_SUMMARY_CHARS * 4, "summary file").trim();
    if (summary.length > MAX_SUMMARY_CHARS) throw new UsageError(`the summary is longer than ${MAX_SUMMARY_CHARS} characters`);
    const findingsFile = options.get("--findings-file");
    const findings = findingsFile
      ? parseFindings(readBounded(findingsFile, MAX_FINDINGS_FILE_BYTES, "findings file"), verdict === "request_changes")
      : [];

    const pr = Number(prText);
    const url = new URL(`/api/review/prs/${pr}/reviews`, base);
    if (project) url.searchParams.set("project", project);
    request = {
      url: url.toString(),
      pr,
      head,
      verdict,
      body: JSON.stringify({
        reviewer: { id: agent, kind: "agent" },
        head_sha: head,
        verdict,
        summary,
        findings,
        assignment_token: token,
      }),
    };
  } catch (e) {
    // Nothing was sent
    return usage(e instanceof Error ? e.message : String(e));
  }

  let status: number;
  let text: string;
  try {
    const response = await deps.fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    status = response.status;
    text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
  } catch (e) {
    say(deps.err, `lair review submit: could not reach Lair at ${new URL(request.url).origin}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_UNAVAILABLE;
  }
  let body: { success?: boolean; error?: unknown; data?: { review?: { id?: unknown }; stale?: unknown } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  if (status >= 200 && status < 300 && body.success === true) {
    const id = typeof body.data?.review?.id === "string" ? body.data.review.id : "?";
    const stale = body.data?.stale === true ? " (stale: the PR's head has moved since)" : "";
    say(deps.out, `Review ${id} recorded for PR #${request.pr} at ${request.head.slice(0, 7)}: ${request.verdict}${stale}`);
    return EXIT_OK;
  }
  const error = typeof body.error === "string" ? body.error.slice(0, 1000) : text.slice(0, 200).replace(/\s+/g, " ");
  if (status >= 400 && status < 500) {
    say(deps.err, `lair review submit: refused (HTTP ${status}): ${error}`);
    return EXIT_REFUSED;
  }
  say(deps.err, `lair review submit: Lair answered HTTP ${status}: ${error}`);
  return EXIT_UNAVAILABLE;
}
