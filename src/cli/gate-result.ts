/**
 * Signed results from an existing gate system (docs/configuration.md,
 * "Results from an existing gate system"):
 *
 *   lair-node keygen --out <file>             an Ed25519 key pair: <file> (0600) and <file>.pub
 *   lair-node gate-result submit [options]    sign a finished gate result and POST it to triage
 *
 * A project whose gates run in its own queue and runner scripts (not Lair
 * pipelines) calls `gate-result submit` after each gate. It builds a
 * GateResult (src/shared/policy-types.ts) from flags or a JSON file, lists
 * the JUnit XML reports' SHA-256 in `result.reports` so the signature covers
 * them, signs it with signGateResult() (src/server/gates/signature.ts) and
 * POSTs {signed, reports} to /api/triage/results, which accepts it only from
 * a node in `triage.trusted_nodes`.
 *
 * Exit codes: 0 accepted, 1 refused (the server's reason is printed),
 * 2 usage (bad flags or unreadable input), 3 the server is unreachable.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "crypto";
import {
  type Dirent,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { parseArgs } from "util";
import { z } from "zod";
import type { GateReportDigest, GateResult, GateStepResult, SignedGateResult } from "../shared/policy-types.js";
import { generateNodeKeyPair, signGateResult } from "../server/gates/signature.js";
import { FULL_SHA } from "../server/triage/config.js";

export const EXIT = { ok: 0, refused: 1, usage: 2, unreachable: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

export const DEFAULT_SERVER = "http://127.0.0.1:4777";

const MiB = 1024 * 1024;

/** Every input is bounded; the server's own caps are in src/server/triage/routes.ts. */
export const LIMITS = {
  keyBytes: 16 * 1024,
  resultFileBytes: 32 * MiB,
  /** One report's content (the server takes up to 8 MiB; room is left for a bundle's wrapper) */
  reportBytes: 8 * MiB - 4096,
  /** All reports together, under the server's 32 MiB body limit once JSON-escaped */
  reportsTotal: 20 * MiB,
  /** Reports per result (the server's limit) */
  reportsMax: 50,
  /** A bundle of JUnit files, when there are more files than reportsMax */
  bundleBytes: 6 * MiB,
  reportFiles: 10_000,
  walkDepth: 8,
  /** A step's output: its last lines, as much as triage reads */
  outputBytes: 2 * MiB,
  outputLines: 20_000,
  bodyBytes: 31 * MiB,
  steps: 200,
  arg: 1000,
};

class UsageError extends Error {}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ============ KEYGEN ============

const KEYGEN_USAGE = `Usage: lair-node keygen --out <file>

Writes a new Ed25519 key pair for a node that signs gate results:
  <file>       the private key (PEM, mode 0600): only the gate runner reads it
  <file>.pub   the public key (PEM): name it in triage.trusted_nodes

Keep both outside every repository an agent can write to. An existing key is
never overwritten: remove it first to replace it.
`;

export function keygenCommand(argv: string[], io: CliIo): ExitCode {
  let out: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { out: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      io.out(KEYGEN_USAGE);
      return EXIT.ok;
    }
    out = values.out;
  } catch (e) {
    io.err(`${reason(e)}\n\n${KEYGEN_USAGE}`);
    return EXIT.usage;
  }
  if (!out) {
    io.err(`--out is required\n\n${KEYGEN_USAGE}`);
    return EXIT.usage;
  }
  const privatePath = resolve(out);
  const publicPath = `${privatePath}.pub`;
  for (const file of [privatePath, publicPath]) {
    if (existsSync(file)) {
      io.err(`${file} exists: a key is never overwritten (results signed with it would stop verifying). Remove it first to replace it.\n`);
      return EXIT.refused;
    }
  }
  const keys = generateNodeKeyPair(basename(privatePath));
  let wrotePrivate = false;
  try {
    mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
    writeFileSync(privatePath, keys.privateKey, { mode: 0o600, flag: "wx" });
    wrotePrivate = true;
    chmodSync(privatePath, 0o600);
    writeFileSync(publicPath, keys.publicKey, { mode: 0o644, flag: "wx" });
  } catch (e) {
    if (wrotePrivate) {
      try {
        unlinkSync(privatePath);
      } catch {}
    }
    io.err(`Cannot write the key pair: ${reason(e)}\n`);
    return EXIT.refused;
  }
  io.out(
    `Wrote ${privatePath} (private key, mode 0600) and ${publicPath} (public key).\n` +
      `Trust it in the project's YAML:\n` +
      `  triage:\n    trusted_nodes:\n      - id: <node id>\n        public_key_file: ${publicPath}\n`,
  );
  return EXIT.ok;
}

// ============ THE NODE'S KEY ============

/** The private key (PEM) and its public key, refusing a key others can read. */
export function loadNodeKey(path: string): { privateKey: string; publicKey: string } {
  let size: number;
  let mode: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
    mode = stat.mode;
  } catch (e) {
    throw new UsageError(`--key ${path}: cannot read it (${reason(e)})`);
  }
  if (size > LIMITS.keyBytes) throw new UsageError(`--key ${path}: too large for a key`);
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new UsageError(`--key ${path}: other users can read it (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`);
  }
  const pem = readFileSync(path, "utf-8");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new UsageError(`--key ${path}: not a PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new UsageError(`--key ${path}: an Ed25519 key is needed, not ${key.asymmetricKeyType ?? "this key type"}`);
  }
  return { privateKey: pem, publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }).toString() };
}

// ============ INPUT ============

const STATUSES = ["passed", "failed", "error"] as const;
const STEP_STATUSES = ["passed", "failed", "skipped", "timed_out"] as const;

/** --result <file>: the result's fields (GateResult's names); flags override them. */
const ResultFileSchema = z
  .object({
    id: z.string().optional(),
    pipelineId: z.string().optional(),
    commitSha: z.string().optional(),
    branch: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    steps: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            status: z.enum(STEP_STATUSES).optional(),
            exitCode: z.number().int().optional(),
            durationMs: z.number().min(0).optional(),
            output: z.string().optional(),
            error: z.string().max(10_000).optional(),
            startedAt: z.string().max(64).optional(),
            completedAt: z.string().max(64).optional(),
          })
          .strict(),
      )
      .max(LIMITS.steps)
      .optional(),
    startedAt: z.union([z.string(), z.number()]).optional(),
    completedAt: z.union([z.string(), z.number()]).optional(),
    pipelineVersion: z.string().max(200).optional(),
    /** JUnit XML files (relative paths resolve against the JSON file's directory) */
    reports: z
      .array(z.union([z.string().min(1), z.object({ path: z.string().min(1), step: z.string().max(200).optional() }).strict()]))
      .max(LIMITS.reportFiles)
      .optional(),
    /** Directories searched for *.xml */
    reportDirs: z
      .array(z.union([z.string().min(1), z.object({ path: z.string().min(1), step: z.string().max(200).optional() }).strict()]))
      .max(100)
      .optional(),
  })
  .strict();

type ResultFile = z.infer<typeof ResultFileSchema>;

const SUBMIT_OPTIONS = {
  key: { type: "string" },
  node: { type: "string" },
  project: { type: "string" },
  server: { type: "string" },
  result: { type: "string" },
  id: { type: "string" },
  pipeline: { type: "string" },
  sha: { type: "string" },
  branch: { type: "string" },
  status: { type: "string" },
  step: { type: "string", multiple: true },
  output: { type: "string", multiple: true },
  report: { type: "string", multiple: true },
  "report-dir": { type: "string", multiple: true },
  "report-step": { type: "string" },
  started: { type: "string" },
  finished: { type: "string" },
  "pipeline-version": { type: "string" },
  recheck: { type: "string" },
  timeout: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export const SUBMIT_USAGE = `Usage: lair-node gate-result submit --key <file> --node <id> --project <id> [options]

Signs a finished gate result with the node's key and sends it to Lair's
triage (POST /api/triage/results). The node must be in the project's
triage.trusted_nodes.

  --key <file>             the node's Ed25519 private key (lair-node keygen; mode 0600)
  --node <id>              the node id, as in triage.trusted_nodes
  --project <id>           the Lair project
  --server <url>           the Lair server (default ${DEFAULT_SERVER})

The result, from flags, or from --result <file.json> (GateResult's field
names; flags override its fields):
  --id <gate id>           unique per result (letters, digits, '.', '_', ':', '-')
  --pipeline <id>          the gate's pipeline or track: passes and incidents are per pipeline
  --sha <full sha>         the exact commit the gate tested (40 or 64 hex characters)
  --branch <name>
  --status passed|failed|error
  --step <name>:<exit code>[:<duration ms>]
                           repeat for each step; exit 0 is passed, any other failed.
                           <name>:skipped and <name>:timeout[:<ms>] are also accepted
  --output <step>=<file>   a step's console output (its last ${LIMITS.outputLines} lines), parsed for causes
  --report <file>          a JUnit XML report (repeat)
  --report-dir <dir>       every *.xml under it (repeat)
  --report-step <step>     the step that wrote the reports
  --started <time>         ISO 8601 or Unix seconds (default: --finished minus the steps' durations)
  --finished <time>        (default: now)
  --pipeline-version <v>   what review's gate.source: signed compares with review.merge.gate.pipeline_versions
  --recheck <id>           this result answers the triage re-check with this id

  --timeout <seconds>      for the request (default 30)
  --dry-run                print the signed request instead of sending it

Exit codes: 0 accepted, 1 refused (the server's reason is printed),
2 usage, 3 the server is unreachable.
`;

interface ReportSource {
  path: string;
  name: string;
  step?: string;
}

export interface ReportPayload {
  name: string;
  step?: string;
  content: string;
}

export interface SubmitBody {
  signed: SignedGateResult;
  reports: { name: string; content: string }[];
  recheckId?: string;
}

export interface Submission {
  server: string;
  project: string;
  timeoutMs: number;
  dryRun: boolean;
  body: SubmitBody;
}

function bounded(flag: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.length > LIMITS.arg) throw new UsageError(`${flag}: too long`);
  return value;
}

function required(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`${flag} is required`);
  return value;
}

/** A time as ms: ISO 8601, Unix seconds or Unix milliseconds. */
function parseTime(value: string | number, flag: string): number {
  const text = String(value).trim();
  const t = /^\d{1,11}$/.test(text) ? Number(text) * 1000 : /^\d{12,14}$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(t)) throw new UsageError(`${flag} ${text}: not a time (ISO 8601 or Unix seconds)`);
  return t;
}

/** <name>:<exit code>[:<duration ms>]; a name may contain ':' (the last fields are read first). */
const STEP_FLAG = /^(.+?):(-?\d{1,9}|skipped|timeout)(?::(\d{1,12}))?$/;

export function parseStepFlag(value: string): GateStepResult {
  const match = STEP_FLAG.exec(value);
  if (!match || match[1].length > 200) {
    throw new UsageError(`--step ${value}: expected <name>:<exit code>[:<duration ms>], <name>:skipped or <name>:timeout[:<ms>]`);
  }
  const [, name, code, ms] = match;
  const durationMs = ms === undefined ? undefined : Number(ms);
  if (code === "skipped") return { name, status: "skipped" };
  if (code === "timeout") return { name, status: "timed_out", ...(durationMs !== undefined ? { durationMs } : {}) };
  const exitCode = Number(code);
  return { name, status: exitCode === 0 ? "passed" : "failed", exitCode, ...(durationMs !== undefined ? { durationMs } : {}) };
}

function readResultFile(path: string): ResultFile {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > LIMITS.resultFileBytes) throw new Error(`larger than ${LIMITS.resultFileBytes / MiB} MiB`);
    text = readFileSync(path, "utf-8");
  } catch (e) {
    throw new UsageError(`--result ${path}: cannot read it (${reason(e)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--result ${path}: not JSON (${reason(e)})`);
  }
  const parsed = ResultFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(`--result ${path}: ${issue.path.join(".") || "the file"}: ${issue.message}`);
  }
  return parsed.data;
}

/** The last lines of a file, at most `maxBytes` of them, starting at a whole line. */
export function readTail(path: string, maxBytes: number, maxLines: number): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a file");
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buffer.subarray(0, read).toString("utf-8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : text;
    }
    const lines = text.split("\n");
    return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  } finally {
    closeSync(fd);
  }
}

/** Every *.xml under `dir` (symlinks are not followed), in name order. */
function findReports(dir: string, step: string | undefined, found: ReportSource[], flag: string): void {
  const root = resolve(dir);
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch (e) {
    throw new UsageError(`${flag} ${dir}: cannot read it (${reason(e)})`);
  }
  const files: string[] = [];
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const { path, depth } = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (depth < LIMITS.walkDepth) pending.push({ path: full, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) {
        files.push(full);
        if (found.length + files.length > LIMITS.reportFiles) {
          throw new UsageError(`${flag} ${dir}: more than ${LIMITS.reportFiles} report files`);
        }
      }
    }
  }
  files.sort();
  for (const file of files) found.push({ path: file, name: relative(root, file).slice(0, 500), step });
}

/** A report's text, or null (with a warning) when it is too large to send. */
function readReport(source: ReportSource, warn: (text: string) => void): ReportPayload | null {
  let size: number;
  try {
    const stat = statSync(source.path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch (e) {
    throw new UsageError(`--report ${source.path}: cannot read it (${reason(e)})`);
  }
  if (size > LIMITS.reportBytes) {
    warn(`report ${source.path} not sent: larger than ${Math.floor(LIMITS.reportBytes / MiB)} MiB`);
    return null;
  }
  return { name: source.name, step: source.step, content: readFileSync(source.path, "utf-8") };
}

const FAILING = /<(failure|error)[\s>/]/;

/** A JUnit document without its BOM and XML declaration, to go inside a <testsuites> bundle. */
function xmlBody(xml: string): string {
  let start = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < xml.length && " \t\r\n".includes(xml[start])) start++;
  if (xml.startsWith("<?xml", start)) {
    const end = xml.indexOf("?>", start);
    if (end >= 0 && end - start < 1024) start = end + 2;
  }
  return xml.slice(start);
}

/**
 * The reports to send: reports with failures first, within the total budget;
 * more files than the server takes are bundled per step into <testsuites>
 * documents (the signature covers the bundles, which is what is sent).
 */
export function packReports(reports: ReportPayload[], warn: (text: string) => void): ReportPayload[] {
  const ordered = [...reports.filter((r) => FAILING.test(r.content)), ...reports.filter((r) => !FAILING.test(r.content))];
  const kept: ReportPayload[] = [];
  let total = 0;
  let dropped = 0;
  for (const report of ordered) {
    if (total + report.content.length > LIMITS.reportsTotal) {
      dropped++;
      continue;
    }
    total += report.content.length;
    kept.push(report);
  }
  if (dropped > 0) {
    warn(`${dropped} report(s) not sent: over ${LIMITS.reportsTotal / MiB} MiB in all (reports with failures are sent first)`);
  }
  if (kept.length <= LIMITS.reportsMax) return kept;

  const byStep = new Map<string, ReportPayload[]>();
  for (const report of kept) {
    const key = report.step ?? "";
    const group = byStep.get(key);
    if (group) group.push(report);
    else byStep.set(key, [report]);
  }
  const bundles: ReportPayload[] = [];
  for (const [step, group] of byStep) {
    let parts: string[] = [];
    let size = 0;
    const flush = () => {
      if (parts.length === 0) return;
      bundles.push({
        name: `${step || "reports"}-bundle-${bundles.filter((b) => (b.step ?? "") === step).length + 1}.xml`,
        ...(step ? { step } : {}),
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${parts.join("\n")}\n</testsuites>\n`,
      });
      parts = [];
      size = 0;
    };
    for (const report of group) {
      const body = xmlBody(report.content);
      if (parts.length > 0 && size + body.length > LIMITS.bundleBytes) flush();
      parts.push(body);
      size += body.length;
    }
    flush();
  }
  if (bundles.length > LIMITS.reportsMax) {
    throw new UsageError(`the reports need ${bundles.length} bundles, more than the ${LIMITS.reportsMax} a result takes`);
  }
  return bundles;
}

function reportSources(list: ResultFile["reports"], base: string): ReportSource[] {
  return (list ?? []).map((entry) => {
    const path = typeof entry === "string" ? entry : entry.path;
    const full = resolve(base, path);
    return { path: full, name: basename(full), step: typeof entry === "string" ? undefined : entry.step };
  });
}

/** Parse the flags (and the result file) into a signed request. */
function parseSubmitFlags(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: SUBMIT_OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError(reason(e));
  }
}

export function buildSubmission(argv: string[], warn: (text: string) => void, now: () => number = Date.now): Submission {
  const values = parseSubmitFlags(argv);
  const flag = (name: keyof typeof SUBMIT_OPTIONS) => {
    const value = values[name];
    return typeof value === "string" ? bounded(`--${name}`, value) : undefined;
  };

  const keyPath = required("--key", flag("key"));
  const nodeId = required("--node", flag("node"));
  const project = required("--project", flag("project"));
  if (nodeId.length > 128) throw new UsageError("--node: at most 128 characters");
  if (project.length > 200) throw new UsageError("--project: at most 200 characters");
  const server = flag("server") ?? DEFAULT_SERVER;
  try {
    const url = new URL(server);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    throw new UsageError(`--server ${server}: not an http(s) URL`);
  }
  const timeoutText = flag("timeout") ?? "30";
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new UsageError(`--timeout ${timeoutText}: whole seconds from 1 to 600`);
  }

  const resultPath = flag("result");
  const file: ResultFile = resultPath ? readResultFile(resultPath) : {};
  const fileBase = resultPath ? dirname(resolve(resultPath)) : process.cwd();

  const id = required("--id", flag("id") ?? file.id);
  const pipelineId = required("--pipeline", flag("pipeline") ?? file.pipelineId);
  const commitSha = required("--sha", flag("sha") ?? file.commitSha).toLowerCase();
  if (!FULL_SHA.test(commitSha)) throw new UsageError(`--sha ${commitSha}: not a full commit sha (40 or 64 hex characters)`);
  const branch = required("--branch", flag("branch") ?? file.branch);
  const statusText = required("--status", flag("status") ?? file.status);
  if (!(STATUSES as readonly string[]).includes(statusText)) throw new UsageError(`--status ${statusText}: one of ${STATUSES.join(", ")}`);
  const status = statusText as GateResult["status"];

  // Steps: --step flags replace the file's steps
  const stepFlags = values.step ?? [];
  let steps: GateStepResult[];
  if (stepFlags.length > 0) {
    steps = stepFlags.map((s) => parseStepFlag(bounded("--step", s)!));
  } else {
    steps = (file.steps ?? []).map((s) => {
      const stepStatus = s.status ?? (s.exitCode === undefined ? undefined : s.exitCode === 0 ? "passed" : "failed");
      if (!stepStatus) throw new UsageError(`--result: step ${s.name} needs a status or an exitCode`);
      return { ...s, status: stepStatus };
    });
  }
  if (steps.length > LIMITS.steps) throw new UsageError(`at most ${LIMITS.steps} steps`);
  const names = new Set<string>();
  for (const step of steps) {
    if (names.has(step.name)) throw new UsageError(`step ${step.name} is given twice`);
    names.add(step.name);
  }
  if (status === "passed") {
    const failed = steps.filter((s) => s.status === "failed" || s.status === "timed_out").map((s) => s.name);
    if (failed.length > 0) throw new UsageError(`--status passed, but step(s) ${failed.join(", ")} failed`);
  }
  for (const entry of values.output ?? []) {
    const at = entry.indexOf("=");
    const name = at > 0 ? entry.slice(0, at) : "";
    const path = at > 0 ? entry.slice(at + 1) : "";
    const step = steps.find((s) => s.name === name);
    if (!step || !path) throw new UsageError(`--output ${entry}: expected <step>=<file> for one of the steps`);
    try {
      step.output = readTail(path, LIMITS.outputBytes, LIMITS.outputLines);
    } catch (e) {
      throw new UsageError(`--output ${entry}: cannot read it (${reason(e)})`);
    }
  }

  // Times: the gate's duration is exactly finished - started (the signature checks compare them)
  const finishedValue = flag("finished") ?? file.completedAt;
  const startedValue = flag("started") ?? file.startedAt;
  const finished = finishedValue === undefined ? now() : parseTime(finishedValue, "--finished");
  const stepsMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const started = startedValue === undefined ? finished - stepsMs : parseTime(startedValue, "--started");
  if (finished < started) throw new UsageError("--finished is before --started");

  // Reports
  const reportStep = flag("report-step");
  if (reportStep !== undefined && !names.has(reportStep)) throw new UsageError(`--report-step ${reportStep}: not one of the steps`);
  const sources: ReportSource[] = [
    ...reportSources(file.reports, fileBase),
    ...(values.report ?? []).map((path) => ({ path: resolve(path), name: basename(path), step: reportStep })),
  ];
  for (const entry of file.reportDirs ?? []) {
    const path = typeof entry === "string" ? entry : entry.path;
    findReports(resolve(fileBase, path), typeof entry === "string" ? undefined : entry.step, sources, "--result reportDirs");
  }
  for (const dir of values["report-dir"] ?? []) findReports(dir, reportStep, sources, "--report-dir");
  if (sources.length > LIMITS.reportFiles) throw new UsageError(`more than ${LIMITS.reportFiles} report files`);
  const reports = packReports(
    sources.map((s) => readReport(s, warn)).filter((r): r is ReportPayload => r !== null),
    warn,
  );

  const recheckId = flag("recheck");
  const digests: GateReportDigest[] = reports.map((r) => ({ name: r.name, ...(r.step ? { step: r.step } : {}), sha256: sha256(r.content) }));
  const result: GateResult = {
    id,
    pipelineId,
    commitSha,
    branch,
    projectId: project,
    nodeId,
    status,
    steps,
    selectedSteps: steps.map((s) => s.name),
    durationMs: finished - started,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(finished).toISOString(),
    pipelineVersion: flag("pipeline-version") ?? file.pipelineVersion ?? "",
    ...(digests.length > 0 ? { reports: digests } : {}),
  };

  const key = loadNodeKey(keyPath);
  const body: SubmitBody = {
    signed: signGateResult(result, key.privateKey, key.publicKey),
    reports: reports.map((r) => ({ name: r.name, content: r.content })),
    ...(recheckId ? { recheckId } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > LIMITS.bodyBytes) {
    throw new UsageError(`the request is ${Math.ceil(bytes / MiB)} MiB, over ${LIMITS.bodyBytes / MiB} MiB: send fewer reports or less output`);
  }
  return { server, project, timeoutMs: timeoutSeconds * 1000, dryRun: values["dry-run"] === true, body };
}

// ============ SENDING ============

interface ServerReply {
  success?: boolean;
  error?: string;
  data?: { record?: { id?: string; status?: string; verdict?: string } };
}

/** POST {signed, reports} to triage: 0 accepted, 1 refused, 3 unreachable. */
export async function postSignedResult(
  server: string,
  project: string,
  body: SubmitBody,
  timeoutMs: number,
): Promise<{ code: ExitCode; message: string }> {
  const url = new URL("/api/triage/results", server);
  url.searchParams.set("project", project);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    return { code: EXIT.unreachable, message: `Cannot reach Lair at ${url.origin} (${reason(e)}${cause})` };
  }
  let text = "";
  try {
    text = await response.text();
  } catch {}
  let reply: ServerReply | undefined;
  try {
    reply = JSON.parse(text) as ServerReply;
  } catch {}
  if (response.ok && reply?.success === true) {
    const record = reply.data?.record;
    const verdict = record?.verdict ? `, ${record.verdict}` : "";
    return {
      code: EXIT.ok,
      message: `Accepted ${body.signed.result.id}: triage record ${record?.id ?? "?"} (${record?.status ?? body.signed.result.status}${verdict})`,
    };
  }
  const why = typeof reply?.error === "string" ? reply.error : text.slice(0, 500) || response.statusText;
  return { code: EXIT.refused, message: `Refused (HTTP ${response.status}): ${why}` };
}

/** `lair-node gate-result <subcommand> ...` */
export async function gateResultCommand(argv: string[], io: CliIo, now: () => number = Date.now): Promise<ExitCode> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    io.out(SUBMIT_USAGE);
    return EXIT.ok;
  }
  if (sub !== "submit") {
    io.err(`${sub ? `Unknown gate-result command: ${sub}` : "A gate-result command is required"}\n\n${SUBMIT_USAGE}`);
    return EXIT.usage;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(SUBMIT_USAGE);
    return EXIT.ok;
  }
  let submission: Submission;
  try {
    submission = buildSubmission(rest, (text) => io.err(`warning: ${text}\n`), now);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\nRun lair-node gate-result submit --help for the options.\n`);
      return EXIT.usage;
    }
    io.err(`${reason(e)}\n`);
    return EXIT.usage;
  }
  if (submission.dryRun) {
    io.out(`${JSON.stringify(submission.body, null, 2)}\n`);
    return EXIT.ok;
  }
  const outcome = await postSignedResult(submission.server, submission.project, submission.body, submission.timeoutMs);
  if (outcome.code === EXIT.ok) io.out(`${outcome.message}\n`);
  else io.err(`${outcome.message}\n`);
  return outcome.code;
}
