/**
 * Revert checks (CONTRIBUTING.md, "Revert checks"): proves that a pull request's tests guard the code
 * they claim to guard.
 *
 *   tsx src/cli/revert-checks.ts [options] <pr-body-file> <base-ref>
 *
 * Each line of the PR body (outside fenced code blocks, not indented) of the form
 *
 *   revert-check: <test file>[ > <test name>] guards <source file>[:<line>|:<start>-<end>]
 *
 * is one check. The named test must pass on the PR's code. Then the PR's change to the source file is
 * reverted to the base version (the whole file, or only the changed hunks that touch the given lines of
 * the PR's version), and the same test must FAIL with at least one failing test. A test that fails to
 * load when reverted (an import crash), a name that matches no test, a timeout and a revert that
 * changes nothing are failures, never passes. The file is restored after each check.
 *
 * Options:
 *   --title=<text>          PR title; with --require=auto it decides whether lines are required
 *   --require=auto|always|never   default auto (see requirement())
 *   --exempt-label=<name>   the label that exempts a PR (default revert-check-exempt)
 *   --exempt-actors=<a,b>   the logins whose label counts (CI passes the repository owner)
 *   --code-paths=<a/,b/>    the directories whose code makes lines required (default src/,scripts/)
 *   --label-events=<file>   the PR's labeled/unlabeled events, one JSON object per line, oldest first:
 *                           {"event":"labeled","label":"<name>","actor":"<login>"}
 *   --count                 parse and decide only: print the count and the requirement, run nothing
 *   --max-checks=<n>        at most n lines (default 10)
 *   --timeout=<seconds>     limit for each test run (default 120)
 * With GITHUB_OUTPUT set, `count=<n>` and `required=<true|false>` are appended to it.
 *
 * Exit codes: 0 every check passed (or none was required and none given); 1 a check failed;
 * 2 bad input (malformed line, bad path, nothing to revert, lines required but none given, too many
 * lines, unknown option); 3 internal error (git failed, a file could not be restored).
 *
 * This file imports only node: built-ins, because CI runs the base commit's copy from a temporary file.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_INPUT = 2;
export const EXIT_INTERNAL = 3;

export const DEFAULT_EXEMPT_LABEL = "revert-check-exempt";
export const DEFAULT_MAX_CHECKS = 10;
export const DEFAULT_TIMEOUT_SECONDS = 120;
const GIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_TAIL_CHARS = 6_000;
const MAX_TEST_NAME = 200;

/** Conventional title types that by definition change no behaviour: their PRs need no revert check. */
export const NON_BEHAVIOUR_TYPES = ["build", "chore", "ci", "docs", "perf", "refactor", "revert", "style", "test"];
/** Where changed code makes lines required (--code-paths), for these extensions; tests never count. */
export const DEFAULT_CODE_PATHS = ["src/", "scripts/"];
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|sh)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const TEST_DIRS = new Set(["testing", "__tests__", "__mocks__", "fixtures"]);

export interface LineRange {
  start: number;
  end: number;
}

export interface RevertCheck {
  line: string;
  testFile: string;
  testName?: string;
  sourceFile: string;
  range?: LineRange;
}

export interface ParsedBody {
  checks: RevertCheck[];
  malformed: { line: string; reason: string }[];
  /** Lines that try to exempt the PR from the body; only the owner's label exempts. */
  exemptionLines: string[];
}

class InternalError extends Error {}

/** Control characters from PR text are replaced before printing (the log is the CI's command channel). */
export function clean(text: string): string {
  let out = "";
  for (const ch of text) out += isControl(ch) ? "?" : ch;
  return out;
}

function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

const LINE_RE = /^revert-check:\s*(.*?)\s+guards\s+(\S+)\s*$/;
const TEST_PART_RE = /^(\S+)(?:\s+>\s+(.+))?$/;
const SOURCE_PART_RE = /^([^:\s]+)(?::(\d+)(?:-(\d+))?)?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Reads the revert-check lines of a PR body. CRLF bodies (web edits) are accepted. Lines inside fenced code
 * blocks are examples and do not count; so do indented lines.
 */
export function parseBody(body: string): ParsedBody {
  const result: ParsedBody = { checks: [], malformed: [], exemptionLines: [] };
  let fence: { char: string; len: number } | null = null;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && f[2].trim() === "") fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { char: f[1][0], len: f[1].length };
      continue;
    }
    if (/^(no revert-check:|revert-check-exempt:)/i.test(line)) {
      result.exemptionLines.push(line);
      continue;
    }
    if (!line.startsWith("revert-check:")) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      result.malformed.push({ line, reason: "expected 'revert-check: <test file>[ > <test name>] guards <source file>[:<lines>]'" });
      continue;
    }
    const t = TEST_PART_RE.exec(m[1]);
    const s = SOURCE_PART_RE.exec(m[2]);
    if (!t) {
      result.malformed.push({ line, reason: "the test part must be a test file, optionally followed by ' > <test name>'" });
      continue;
    }
    if (!s) {
      result.malformed.push({ line, reason: "the source part must be <file>, <file>:<line> or <file>:<start>-<end>" });
      continue;
    }
    const check: RevertCheck = { line, testFile: t[1], sourceFile: s[1] };
    if (t[2] !== undefined) check.testName = t[2].split(/\s+>\s+/).join(" ").trim();
    if (s[2] !== undefined) {
      const start = Number(s[2]);
      const end = s[3] === undefined ? start : Number(s[3]);
      if (start < 1 || end < start) {
        result.malformed.push({ line, reason: `bad line range ${s[2]}${s[3] === undefined ? "" : `-${s[3]}`}: lines start at 1 and the start may not exceed the end` });
        continue;
      }
      check.range = { start, end };
    }
    result.checks.push(check);
  }
  return result;
}

/** A repo-relative path, never an option, an absolute path or a path that leaves the repository. */
export function pathProblem(path: string): string | null {
  if (path.startsWith("-")) return "starts with '-'";
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return "must be relative to the repository root";
  if (!/^[A-Za-z0-9_.@+/-]+$/.test(path)) return "may contain only letters, digits and _ . @ + / -";
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "has an empty, '.' or '..' part";
  return null;
}

export function testNameProblem(name: string): string | null {
  if (name.startsWith("-")) return "starts with '-'";
  if (name.length > MAX_TEST_NAME) return `is longer than ${MAX_TEST_NAME} characters`;
  if ([...name].some(isControl)) return "contains control characters";
  return null;
}

export function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || path.split("/").some((seg) => TEST_DIRS.has(seg));
}

/** A changed file that makes revert-check lines required: code under one of the code paths, not a test. */
export function isGuardedCode(path: string, codePaths: string[] = DEFAULT_CODE_PATHS): boolean {
  return codePaths.some((p) => path.startsWith(p)) && CODE_EXT_RE.test(path) && !isTestPath(path);
}

export type RequireMode = "auto" | "always" | "never";

export interface Requirement {
  required: boolean;
  reason: string;
}

/**
 * The coverage rule. With mode auto, a PR needs at least one revert-check line when it changes code
 * (isGuardedCode) and its title is not of a non-behaviour type (NON_BEHAVIOUR_TYPES). A title that is not
 * a conventional "type(scope): subject" title counts as a behaviour change. The owner's exemption label
 * lifts the requirement; nothing in the body does.
 */
export function requirement(input: {
  mode: RequireMode;
  title: string;
  changedFiles: string[];
  exempt: boolean;
  codePaths?: string[];
}): Requirement {
  if (input.mode === "never") return { required: false, reason: "--require=never" };
  if (input.exempt) return { required: false, reason: "the owner set the exemption label" };
  if (input.mode === "always") return { required: true, reason: "--require=always" };
  const codePaths = input.codePaths ?? DEFAULT_CODE_PATHS;
  const code = input.changedFiles.filter((p) => isGuardedCode(p, codePaths));
  if (code.length === 0) {
    return { required: false, reason: `the PR changes no code under ${codePaths.join(" or ")} (tests, fixtures and docs do not count)` };
  }
  const changes = `it changes ${code.length} code file(s), e.g. ${code[0]}`;
  const m = /^([A-Za-z]+)(?:\([^)]*\))?!?:\s*\S/.exec(input.title.trim());
  if (!m) return { required: true, reason: `the title is not a conventional 'type(scope): subject' title, so it counts as a behaviour change, and ${changes}` };
  const type = m[1].toLowerCase();
  if (NON_BEHAVIOUR_TYPES.includes(type)) return { required: false, reason: `the title type '${type}' changes no behaviour` };
  return { required: true, reason: `a '${type}' PR and ${changes}` };
}

/**
 * Whether the exemption label is on the PR and was set by an allowed actor. The events are the PR's
 * labeled/unlabeled events, oldest first, one JSON object per line. Anything unreadable means no exemption.
 */
export function exemptionFromEvents(ndjson: string, label: string, actors: string[]): { exempt: boolean; reason: string } {
  const allowed = new Set(actors.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const want = label.toLowerCase();
  let last: { event: string; actor: string } | null = null;
  for (const raw of ndjson.split("\n")) {
    if (raw.trim() === "") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(raw);
    } catch {
      return { exempt: false, reason: "the label history could not be read" };
    }
    const e = ev as { event?: unknown; label?: unknown; actor?: unknown };
    if (typeof e.event !== "string" || typeof e.label !== "string" || typeof e.actor !== "string") {
      return { exempt: false, reason: "the label history could not be read" };
    }
    if (e.label.toLowerCase() === want && (e.event === "labeled" || e.event === "unlabeled")) last = { event: e.event, actor: e.actor };
  }
  if (!last || last.event !== "labeled") return { exempt: false, reason: `the PR does not carry the '${label}' label` };
  if (!allowed.has(last.actor.toLowerCase())) {
    return { exempt: false, reason: `the '${label}' label was set by '${clean(last.actor)}', who may not grant exemptions` };
  }
  return { exempt: true, reason: `'${clean(last.actor)}' set the '${label}' label` };
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** The hunk headers of a `git diff -U0` output. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * The hunks that touch lines start-end of the PR's version. A pure deletion (newCount 0) sits after line
 * newStart; it touches the range when it is inside it or next to it.
 */
export function hunksTouching(hunks: Hunk[], range: LineRange): Hunk[] {
  return hunks.filter((h) =>
    h.newCount > 0
      ? h.newStart <= range.end && h.newStart + h.newCount - 1 >= range.start
      : h.newStart >= range.start - 1 && h.newStart <= range.end,
  );
}

/** The PR's text with the given hunks put back to their base lines (the reverse of applying them). */
export function revertHunks(baseText: string, currentText: string, hunks: Hunk[]): string {
  const base = baseText.split("\n");
  const lines = currentText.split("\n");
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const at = h.newCount > 0 ? h.newStart - 1 : h.newStart;
    const from = h.oldCount > 0 ? h.oldStart - 1 : h.oldStart;
    lines.splice(at, h.newCount, ...base.slice(from, from + h.oldCount));
  }
  return lines.join("\n");
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** The subset of vitest's JSON report the checks read. */
export interface VitestReport {
  numFailedTests: number;
  testResults: {
    name: string;
    status?: string;
    message?: string;
    assertionResults: { fullName?: string; status: string }[];
  }[];
}

export interface TestRun {
  timedOut: boolean;
  exitCode: number | null;
  report?: VitestReport;
  reportError?: string;
}

export interface Verdict {
  ok: boolean;
  detail: string;
}

function asReport(value: unknown): VitestReport | null {
  const r = value as VitestReport;
  if (!r || typeof r !== "object" || typeof r.numFailedTests !== "number" || !Array.isArray(r.testResults)) return null;
  for (const t of r.testResults) {
    if (!t || typeof t.name !== "string" || !Array.isArray(t.assertionResults)) return null;
  }
  return r;
}

/**
 * Counts from the per-test statuses: vitest 1.x counts skipped tests as passed in numPassedTests, so a name
 * that matches nothing would otherwise look like a passing run.
 */
export function summarize(report: VitestReport): { files: string[]; passed: number; failed: number; loadErrors: string[] } {
  let passed = 0;
  let failed = 0;
  const loadErrors: string[] = [];
  for (const file of report.testResults) {
    for (const a of file.assertionResults) {
      if (a.status === "passed") passed++;
      else if (a.status === "failed") failed++;
    }
    if (file.message) loadErrors.push(file.message.split("\n")[0]);
  }
  return { files: report.testResults.map((t) => t.name), passed, failed, loadErrors };
}

function commonProblem(run: TestRun, absTest: string, what: string): string | null {
  if (run.timedOut) return `${what}: the test run timed out`;
  if (!run.report) {
    return `${what}: vitest wrote no report (exit code ${run.exitCode ?? "none"})${run.reportError ? `: ${run.reportError}` : ""}`;
  }
  const others = summarize(run.report).files.filter((f) => f !== absTest);
  if (others.length > 0) return `${what}: vitest ran other test files too (${others.length}), so the run is not the named test`;
  return null;
}

/** Before any revert the named test must run and pass. */
export function judgeBaseline(run: TestRun, absTest: string, testName?: string): Verdict {
  const problem = commonProblem(run, absTest, "on the PR's code");
  if (problem) return { ok: false, detail: problem };
  const s = summarize(run.report as VitestReport);
  if (s.loadErrors.length > 0 && s.passed + s.failed === 0) {
    return { ok: false, detail: `the test file fails to load on the PR's code: ${clean(s.loadErrors[0])}` };
  }
  if (s.passed + s.failed === 0) {
    return { ok: false, detail: `no matching test: nothing ran${testName ? ` for the name '${clean(testName)}'` : ""}` };
  }
  if (s.failed > 0 || s.loadErrors.length > 0 || run.exitCode !== 0) {
    return { ok: false, detail: `the test fails on the PR's code before anything is reverted (${s.failed} failing, exit code ${run.exitCode})` };
  }
  return { ok: true, detail: `passes on the PR's code (${s.passed} passing)` };
}

/** With the change reverted at least one test must fail; a crash or an empty run proves nothing. */
export function judgeReverted(run: TestRun, absTest: string, testName?: string): Verdict {
  const problem = commonProblem(run, absTest, "with the change reverted");
  if (problem) return { ok: false, detail: problem };
  const report = run.report as VitestReport;
  const s = summarize(report);
  if (s.failed > 0 && report.numFailedTests > 0) return { ok: true, detail: `fails with the change reverted (${s.failed} failing)` };
  if (s.loadErrors.length > 0) {
    return {
      ok: false,
      detail: `the test file crashed when reverted (an import or load error), which proves nothing about the change: ${clean(s.loadErrors[0])}`,
    };
  }
  if (s.passed === 0) {
    return { ok: false, detail: `no matching test ran with the change reverted${testName ? ` for the name '${clean(testName)}'` : ""}` };
  }
  return { ok: false, detail: "the test still passes with the change reverted: it does not guard the change" };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd: string, args: string[], allowFail = false): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new InternalError(`git ${args[0]} failed: ${r.error.message}`);
  if (r.signal) throw new InternalError(`git ${args[0]} was stopped by ${r.signal}`);
  const status = r.status ?? 1;
  const stderr = r.stderr.toString();
  if (status !== 0 && !allowFail) throw new InternalError(`git ${args[0]} exited ${status}: ${clean(stderr.trim().slice(0, 300))}`);
  return { status, stdout: r.stdout, stderr };
}

interface PreparedCheck {
  check: RevertCheck;
  absTest: string;
  absSource: string;
  original: Buffer;
  reverted: Buffer;
  revertNote: string;
}

function regularFileProblem(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return "is a symbolic link";
    if (!st.isFile()) return "is not a regular file";
    return null;
  } catch {
    return "does not exist";
  }
}

/** Validates one check and computes its reverted file. Returns the reason when the check cannot run. */
function prepare(repoRoot: string, baseSha: string, check: RevertCheck): PreparedCheck | string {
  const { testFile, testName, sourceFile, range } = check;
  const tp = pathProblem(testFile);
  if (tp) return `test file '${clean(testFile)}' ${tp}`;
  if (!TEST_FILE_RE.test(testFile)) return `'${clean(testFile)}' is not a test file (*.test.ts, *.spec.ts and the like)`;
  if (testName !== undefined) {
    const np = testNameProblem(testName);
    if (np) return `test name '${clean(testName)}' ${np}`;
  }
  const sp = pathProblem(sourceFile);
  if (sp) return `source file '${clean(sourceFile)}' ${sp}`;
  if (sourceFile === testFile) return "a test cannot guard itself";
  for (const p of [testFile, sourceFile]) {
    const fp = regularFileProblem(join(repoRoot, p));
    if (fp) return `'${p}' ${fp}`;
    if (git(repoRoot, ["ls-files", "--error-unmatch", "--", p], true).status !== 0) return `'${p}' is not tracked by git`;
  }
  if (git(repoRoot, ["cat-file", "-e", `${baseSha}:${sourceFile}`], true).status !== 0) {
    return `'${sourceFile}' is new in this PR: reverting it only removes the module, which proves nothing; guard a changed file that exists on the base branch`;
  }
  const absSource = join(repoRoot, sourceFile);
  const original = readFileSync(absSource);
  const base = git(repoRoot, ["show", `${baseSha}:${sourceFile}`]).stdout;
  let reverted: Buffer;
  let revertNote: string;
  if (!range) {
    reverted = base;
    revertNote = "the whole file";
  } else {
    const current = original.toString("latin1");
    const count = lineCount(current);
    if (range.end > count) return `lines ${range.start}-${range.end} are past the end of '${sourceFile}' (${count} lines)`;
    const diff = git(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "-U0", baseSha, "--", sourceFile]).stdout;
    const touching = hunksTouching(parseHunks(diff.toString("latin1")), range);
    if (touching.length === 0) return `lines ${range.start}-${range.end} of '${sourceFile}' contain no change of this PR: nothing to revert`;
    reverted = Buffer.from(revertHunks(base.toString("latin1"), current, touching), "latin1");
    revertNote = `${touching.length} changed hunk(s) touching lines ${range.start}-${range.end}`;
  }
  if (reverted.equals(original)) return `nothing to revert: '${sourceFile}' is the same as on the base branch`;
  return { check, absTest: join(repoRoot, testFile), absSource, original, reverted, revertNote };
}

// The file currently reverted and the test run in progress, for the INT/TERM handler
let pendingRestore: { abs: string; original: Buffer } | null = null;
let activeChild: ChildProcess | null = null;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

function restorePending(): void {
  if (!pendingRestore) return;
  const { abs, original } = pendingRestore;
  writeFileSync(abs, original);
  if (!readFileSync(abs).equals(original)) throw new InternalError(`could not restore ${abs}`);
  pendingRestore = null;
}

/**
 * Runs `npm test` (vitest) for one test file in its own process group, with a hard time limit that kills
 * the whole group. Passing the file as an absolute path keeps it from being read as an option.
 */
async function runTest(
  repoRoot: string,
  absTest: string,
  testName: string | undefined,
  timeoutMs: number,
  reportFile: string,
): Promise<TestRun & { output: string }> {
  const args = ["test", "--", "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`];
  if (testName !== undefined) args.push(`--testNamePattern=${escapeRegExp(testName)}`);
  args.push(absTest);
  rmSync(reportFile, { force: true });
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn("npm", args, {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    activeChild = child;
    const keep = (d: Buffer) => {
      output = (output + d.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      activeChild = null;
      const run: TestRun & { output: string } = { timedOut, exitCode, output };
      if (!timedOut) {
        try {
          const report = asReport(JSON.parse(readFileSync(reportFile, "utf8")));
          if (report) run.report = report;
          else run.reportError = "the report has an unexpected shape";
        } catch (err) {
          run.reportError = (err as NodeJS.ErrnoException).code === "ENOENT" ? "no report file" : `unreadable report: ${(err as Error).message}`;
        }
      }
      done(run);
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        timers.push(setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS));
        // A process that left the group may hold the pipes open: stop waiting for them
        timers.push(
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(null);
          }, KILL_GRACE_MS * 2),
        );
      }, timeoutMs),
    );
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function tail(output: string, log: (line: string) => void): void {
  const lines = output.trimEnd().split("\n").slice(-30);
  for (const line of lines) log(`    | ${clean(line)}`);
}

export interface MainIO {
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

const USAGE = "usage: revert-checks [--title=<t>] [--require=auto|always|never] [--exempt-label=<l>] [--exempt-actors=<a,b>] [--code-paths=<a/,b/>] [--label-events=<file>] [--count] [--max-checks=<n>] [--timeout=<s>] <pr-body-file> <base-ref>";

function positiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  return /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : null;
}

export async function main(argv: string[], io: MainIO = { log: (l) => console.log(l), env: process.env }): Promise<number> {
  const { log } = io;
  let opts: ReturnType<typeof parseCli>;
  try {
    opts = parseCli(argv);
  } catch (err) {
    log(`revert-checks: ${clean((err as Error).message)}`);
    log(USAGE);
    return EXIT_INPUT;
  }
  try {
    return await run(opts, io);
  } catch (err) {
    if (err instanceof InternalError) {
      log(`revert-checks: internal error: ${err.message}`);
      return EXIT_INTERNAL;
    }
    throw err;
  }
}

function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      title: { type: "string", default: "" },
      require: { type: "string", default: "auto" },
      "exempt-label": { type: "string", default: DEFAULT_EXEMPT_LABEL },
      "exempt-actors": { type: "string", default: "" },
      "code-paths": { type: "string", default: DEFAULT_CODE_PATHS.join(",") },
      "label-events": { type: "string" },
      count: { type: "boolean", default: false },
      "max-checks": { type: "string" },
      timeout: { type: "string" },
    },
  });
  if (positionals.length !== 2) throw new Error("expected <pr-body-file> <base-ref>");
  const mode = values.require as string;
  if (mode !== "auto" && mode !== "always" && mode !== "never") throw new Error("--require must be auto, always or never");
  const maxChecks = positiveInt(values["max-checks"], DEFAULT_MAX_CHECKS);
  const timeoutSeconds = positiveInt(values.timeout, DEFAULT_TIMEOUT_SECONDS);
  if (maxChecks === null) throw new Error("--max-checks must be a positive integer");
  if (timeoutSeconds === null) throw new Error("--timeout must be a positive integer");
  const [bodyFile, baseRef] = positionals;
  if (baseRef.startsWith("-")) throw new Error("the base ref may not start with '-'");
  const codePaths = (values["code-paths"] as string).split(",").filter(Boolean);
  if (codePaths.length === 0 || codePaths.some((p) => !p.endsWith("/") || pathProblem(p.slice(0, -1)) !== null)) {
    throw new Error("--code-paths must be repo-relative directories ending in '/', separated by commas");
  }
  return {
    title: values.title as string,
    mode: mode as RequireMode,
    codePaths,
    exemptLabel: values["exempt-label"] as string,
    exemptActors: (values["exempt-actors"] as string).split(","),
    labelEvents: values["label-events"] as string | undefined,
    countOnly: values.count as boolean,
    maxChecks,
    timeoutSeconds,
    bodyFile,
    baseRef,
  };
}

async function run(opts: ReturnType<typeof parseCli>, io: MainIO): Promise<number> {
  const { log, env } = io;
  let body: string;
  try {
    body = readFileSync(opts.bodyFile, "utf8");
  } catch {
    log(`revert-checks: cannot read the PR body file '${clean(opts.bodyFile)}'`);
    return EXIT_INPUT;
  }
  const top = git(process.cwd(), ["rev-parse", "--show-toplevel"], true);
  if (top.status !== 0) {
    log("revert-checks: not inside a git repository");
    return EXIT_INPUT;
  }
  const repoRoot = top.stdout.toString().trim();
  const resolved = git(repoRoot, ["rev-parse", "--verify", "--quiet", `${opts.baseRef}^{commit}`], true);
  if (resolved.status !== 0) {
    log(`revert-checks: base ref '${clean(opts.baseRef)}' not found`);
    return EXIT_INPUT;
  }
  const baseSha = git(repoRoot, ["merge-base", resolved.stdout.toString().trim(), "HEAD"]).stdout.toString().trim();
  const changedFiles = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", baseSha, "HEAD"])
    .stdout.toString()
    .split("\0")
    .filter(Boolean);

  let exempt = false;
  if (opts.labelEvents !== undefined) {
    let events = "";
    try {
      events = readFileSync(opts.labelEvents, "utf8");
    } catch {
      log("Exemption: the label history file is missing, so no exemption applies");
    }
    const ex = exemptionFromEvents(events, opts.exemptLabel, opts.exemptActors);
    exempt = ex.exempt;
    log(`Exemption: ${ex.reason}`);
  }

  const parsed = parseBody(body);
  const count = parsed.checks.length;
  const req = requirement({ mode: opts.mode, title: opts.title, changedFiles, exempt, codePaths: opts.codePaths });
  log(`Revert checks: ${count} line(s) in the PR body; required: ${req.required ? "yes" : "no"} (${req.reason})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `count=${count}\nrequired=${req.required}\n`);

  if (parsed.malformed.length > 0) {
    for (const m of parsed.malformed) log(`  malformed: ${clean(m.line)}\n    ${m.reason}`);
    return EXIT_INPUT;
  }
  if (count > opts.maxChecks) {
    log(`  too many revert-check lines: ${count} (at most ${opts.maxChecks})`);
    return EXIT_INPUT;
  }
  if (req.required && count === 0) {
    log("  this PR needs at least one 'revert-check:' line (outside code blocks), see CONTRIBUTING.md, \"Revert checks\"");
    if (parsed.exemptionLines.length > 0) {
      log(`  a body line does not exempt a PR; only the owner's '${opts.exemptLabel}' label does (then re-run this job)`);
    }
    return EXIT_INPUT;
  }
  if (opts.countOnly) return EXIT_OK;
  if (count === 0) {
    log("  nothing to check");
    return EXIT_OK;
  }

  const prepared: PreparedCheck[] = [];
  let bad = 0;
  for (const [i, check] of parsed.checks.entries()) {
    const p = prepare(repoRoot, baseSha, check);
    if (typeof p === "string") {
      log(`  [${i + 1}/${count}] ${clean(check.line)}\n    cannot run: ${p}`);
      bad++;
    } else {
      prepared.push(p);
    }
  }
  if (bad > 0) return EXIT_INPUT;

  const tmp = mkdtempSync(join(tmpdir(), "revert-checks-"));
  const baselines = new Map<string, Verdict>();
  let failed = 0;
  try {
    for (const [i, p] of prepared.entries()) {
      const { check } = p;
      log(`  [${i + 1}/${count}] ${clean(check.line)}`);
      const timeoutMs = opts.timeoutSeconds * 1000;
      const key = `${check.testFile}\0${check.testName ?? ""}`;
      let baseline = baselines.get(key);
      let baselineOutput = "";
      if (!baseline) {
        const r = await runTest(repoRoot, p.absTest, check.testName, timeoutMs, join(tmp, `baseline-${i}.json`));
        baseline = judgeBaseline(r, p.absTest, check.testName);
        baselines.set(key, baseline);
        baselineOutput = r.output;
      }
      if (!baseline.ok) {
        log(`    FAIL ${baseline.detail}`);
        tail(baselineOutput, log);
        failed++;
        continue;
      }
      pendingRestore = { abs: p.absSource, original: p.original };
      writeFileSync(p.absSource, p.reverted);
      let reverted: TestRun & { output: string };
      try {
        reverted = await runTest(repoRoot, p.absTest, check.testName, timeoutMs, join(tmp, `reverted-${i}.json`));
      } finally {
        restorePending();
      }
      const verdict = judgeReverted(reverted, p.absTest, check.testName);
      if (verdict.ok) {
        log(`    PASS ${baseline.detail}; ${verdict.detail} (reverted ${p.revertNote})`);
      } else {
        log(`    FAIL ${verdict.detail} (reverted ${p.revertNote})`);
        tail(reverted.output, log);
        failed++;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`Summary: ${count - failed} passed, ${failed} failed`);
  return failed > 0 ? EXIT_CHECK_FAILED : EXIT_OK;
}

function isEntryPoint(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const stop = (code: number) => () => {
    if (activeChild) killGroup(activeChild, "SIGKILL");
    try {
      restorePending();
    } catch (err) {
      console.log(`revert-checks: ${(err as Error).message}`);
      process.exit(EXIT_INTERNAL);
    }
    process.exit(code);
  };
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      try {
        restorePending();
      } catch {
        // reported below
      }
      console.log(`revert-checks: internal error: ${(err as Error).stack ?? err}`);
      process.exit(EXIT_INTERNAL);
    },
  );
}
