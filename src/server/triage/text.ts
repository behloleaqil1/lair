/**
 * Text helpers shared by the evidence parsers and the classifier: signatures,
 * test keys, "Caused by" chains, stack frames and file stems.
 */
import { createHash } from "crypto";
import type { CauseKind, FailureCause, SourceLocation, TestRef } from "../../shared/triage-types.js";

export const MAX_LINE = 300;
export const MAX_EVIDENCE = 12;
export const MAX_TESTS = 500;
const MAX_LOCATIONS = 8;
/** Every line a parser reads is cut to this many characters before any regular expression sees it */
export const MAX_LINE_LENGTH = 2000;
/** A parser reads at most this many lines of a log (the last ones: failures and summaries come last) */
export const MAX_LOG_LINES = 20_000;
/** Stack frames are short; longer lines are not read as frames */
const MAX_FRAME_LENGTH = 400;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** Remove terminal colour codes and carriage returns. */
export function cleanLog(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n");
}

/**
 * A log as lines a regular expression can read in linear time: colour codes
 * removed, at most MAX_LOG_LINES lines (the last ones), each cut to
 * MAX_LINE_LENGTH characters. Test output is written by the code under test,
 * so a parser never runs a pattern over an unbounded line.
 */
export function boundedLines(text: string): string[] {
  const lines = cleanLog(text).split("\n");
  const kept = lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines;
  return kept.map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) : l));
}

/** Cut a string to MAX_LINE_LENGTH characters. */
export function cut(text: string, max = MAX_LINE_LENGTH): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function clip(line: string, max = MAX_LINE): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** What changes between two runs of the same failure: times, ids, hashes, temp paths and numbers. */
export function normalise(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{7,64}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? "<hash>" : m))
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var)\/\S+/g, "<tmp>")
    .replace(/@[0-9a-f]{4,}\b/gi, "@<id>")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function signatureOf(kind: CauseKind, type: string | undefined, root: string, step?: string): string {
  const scope = kind === "step" || kind === "build" ? `${step ?? ""}|` : "";
  return shortHash(`${kind}|${scope}${normalise(type ?? "")}|${normalise(root)}`);
}

// ============ TESTS ============

const FILE_SUITE = /\/|\.[cm]?[jt]sx?$|\.py$/;

/** The suite part of a test key: a file path stays whole, a dotted class or module keeps its last segment. */
export function shortSuite(suite: string): string {
  if (FILE_SUITE.test(suite)) return suite;
  const parts = suite.split(".");
  return parts[parts.length - 1] || suite;
}

export function makeTest(suite: string, name: string, options: { file?: string; id?: string } = {}): TestRef {
  const cleanSuite = suite.trim();
  const cleanName = name.trim();
  return {
    suite: cleanSuite,
    name: cleanName,
    file: options.file,
    id: options.id ?? `${cleanSuite}#${cleanName}`,
    key: `${shortSuite(cleanSuite)}#${cleanName}`,
  };
}

/** A pytest node id (tests/test_x.py::TestA::test_b[1]) as a test. */
export function pytestTest(nodeId: string): TestRef {
  const parts = nodeId.split("::");
  const file = parts[0];
  // A node id without "::" is a module that failed to collect
  const name = parts.length > 1 ? parts[parts.length - 1] : "(collection)";
  const classes = parts.slice(1, -1);
  const module = file.replace(/\.py$/, "").split("/").filter(Boolean).join(".");
  const suite = [module, ...classes].join(".");
  return makeTest(suite, name, { file, id: nodeId });
}

/** The class, file or module a re-check runs for a test. */
export function testClass(test: TestRef): string {
  return test.file ?? test.suite;
}

// ============ THROWABLES AND CHAINS ============

const THROWABLE = /^((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*|[A-Z][\w$]*(?:Error|Exception|Failure|Fault|Throwable)|Error)(?::\s*(.*))?$/;
const AT_LOCATION = /^\S+\.\w+:\d+\)?$/;

/** Remove Gradle's short-format suffix " at File.java:42" (one scan for the last " at "). */
function stripAtLocation(text: string): string {
  const at = text.lastIndexOf(" at ");
  if (at < 0) return text;
  const rest = text.slice(at + 4).trim();
  return AT_LOCATION.test(rest) ? text.slice(0, at).trimEnd() : text;
}

/** "java.lang.IllegalStateException: boom" -> type and message; anything else -> message only. */
export function parseThrowable(line: string): { type?: string; message: string } {
  const text = stripAtLocation(cut(line).trim());
  const match = text.match(THROWABLE);
  if (match && (match[2] !== undefined || /[A-Z]/.test(match[1]))) {
    return { type: match[1], message: (match[2] ?? "").trim() };
  }
  return { message: text };
}

/**
 * The "Caused by" chain in a stack trace, outermost first. The cause is on
 * the same line (JVM traces, Gradle's short format) or on the next one
 * (Gradle's full format).
 */
export function causedByChain(lines: string[]): string[] {
  const chain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.indexOf("Caused by:");
    if (at < 0 || line.slice(0, at).trim() !== "") continue;
    let text = line.slice(at + "Caused by:".length).trim();
    if (!text) {
      for (let j = i + 1; j < lines.length && !text; j++) text = lines[j].trim();
    }
    if (text) chain.push(clip(stripAtLocation(cut(text))));
  }
  return chain;
}

const FIELD_ERROR = /Field error in object '[^']+' on field '[^']+'[^\n]*/;

/** Validation field errors ("Field error in object 'x' on field 'y': ...") as evidence. */
export function fieldErrors(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (found.length >= 4) break;
    if (!line.includes("Field error in object")) continue;
    const match = cut(line).match(FIELD_ERROR);
    if (match) found.push(clip(match[0]));
  }
  return found;
}

// ============ STACK FRAMES ============

const LIBRARY_PREFIXES = [
  "java.",
  "javax.",
  "jdk.",
  "sun.",
  "com.sun.",
  "kotlin.",
  "kotlinx.",
  "scala.",
  "org.junit.",
  "junit.",
  "org.opentest4j.",
  "org.gradle.",
  "worker.org.gradle.",
  "org.apache.maven.",
  "org.springframework.",
  "org.testcontainers.",
  "org.mockito.",
  "org.assertj.",
];
const JVM_FRAME = /^\s*at\s+(?:[\w.$@-]*\/\/?)?([\w$.]+)\.[\w$<>]+\(([\w$-]+\.(?:java|kt|kts|groovy|scala)):(\d+)\)/;
const JS_FRAME = /(?:\bat\s+(?:[^\s(]+\s+)?\(?|❯\s+)((?:[A-Za-z]:)?[^\s():]+\.[cm]?[jt]sx?):(\d+)(?::\d+)?\)?\s*$/;
const PY_FRAME = /^\s*File "([^"]+\.py)", line (\d+)|^([^\s:]+\.py):(\d+):/;
const COMPILER = [
  /^e:\s+(?:file:\/\/)?([^\s:]+\.(?:kt|kts|java)):(\d+)/,
  /^(?:file:\/\/)?([^\s:(]+\.[A-Za-z]{1,5}):(\d+)(?::\d+)?(?::|\s+-)\s*error\b/i,
  /^([^\s:(]+\.[A-Za-z]{1,5})\((\d+),\d+\):\s*error\b/i,
];

function isLibraryPath(path: string): boolean {
  return /node_modules\/|node:internal|^internal\/|site-packages\/|dist-packages\/|\/lib\/python\d/.test(path);
}

/** Source locations in project code (library frames left out), outermost first. */
export function sourceLocations(lines: string[]): SourceLocation[] {
  const seen = new Set<string>();
  const out: SourceLocation[] = [];
  const add = (file: string, line: number) => {
    const key = `${file}:${line}`;
    if (seen.has(key) || isLibraryPath(file)) return;
    seen.add(key);
    out.push({ file, line });
  };
  for (let i = 0; i < lines.length && i < MAX_LOG_LINES; i++) {
    if (out.length >= MAX_LOCATIONS) break;
    const raw = lines[i];
    if (raw.length > MAX_FRAME_LENGTH) continue;
    const jvm = raw.match(JVM_FRAME);
    if (jvm) {
      const cls = jvm[1];
      if (LIBRARY_PREFIXES.some((p) => cls.startsWith(p))) continue;
      const pkg = cls.split(".").slice(0, -1);
      add([...pkg, jvm[2]].join("/"), Number(jvm[3]));
      continue;
    }
    const py = raw.match(PY_FRAME);
    if (py) {
      add(py[1] ?? py[3], Number(py[2] ?? py[4]));
      continue;
    }
    const compiler = COMPILER.map((re) => raw.trim().match(re)).find((m) => m !== null);
    if (compiler) {
      add(compiler[1], Number(compiler[2]));
      continue;
    }
    const js = raw.match(JS_FRAME);
    if (js) add(js[1], Number(js[2]));
  }
  return out;
}

// ============ FILES ============

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** A file's name without its extension and test markers: OrderServiceTest.java, order.test.ts, test_order.py -> orderservice, order */
export function stem(path: string): string {
  const name = basename(path)
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/\.(test|spec)$/i, "")
    .replace(/^test_/i, "")
    .replace(/_test$/i, "")
    .replace(/(Tests?|IT|Spec)$/, "");
  return name.toLowerCase().replace(/[-_.]/g, "");
}

// ============ GROUPING ============

/** One failure as a parser saw it, before grouping. */
export interface RawFailure {
  test?: TestRef;
  type?: string;
  message: string;
  /** The stack trace or body lines */
  lines: string[];
  parser: string;
  step?: string;
  /** Extra text checked against the context patterns (a section title, say) */
  contextText?: string;
  kind?: CauseKind;
  /** Extra evidence lines to keep */
  evidence?: string[];
}

function evidenceFor(raw: RawFailure, causedBy: string[]): string[] {
  const head = raw.type ? `${raw.type}${raw.message ? `: ${raw.message}` : ""}` : raw.message;
  const lines = [clip(head), ...causedBy.map((c) => `Caused by: ${c}`), ...fieldErrors(raw.lines), ...(raw.evidence ?? [])];
  return [...new Set(lines.filter((l) => l.length > 0))].slice(0, MAX_EVIDENCE);
}

function rootOf(raw: RawFailure, causedBy: string[]): string {
  if (causedBy.length > 0) return causedBy[causedBy.length - 1];
  return clip(raw.type ? `${raw.type}${raw.message ? `: ${raw.message}` : ""}` : raw.message);
}

function toCause(raw: RawFailure, kind: CauseKind): FailureCause {
  const causedBy = causedByChain(raw.lines);
  const rootCause = rootOf(raw, causedBy);
  const root = parseThrowable(rootCause);
  return {
    signature: signatureOf(kind, root.type ?? raw.type, root.message || rootCause, raw.step),
    kind,
    step: raw.step,
    parser: raw.parser,
    type: raw.type ? clip(raw.type, 200) : undefined,
    message: clip(raw.message),
    causedBy,
    rootCause,
    tests: raw.test ? [raw.test] : [],
    testCount: raw.test ? 1 : 0,
    locations: sourceLocations(raw.lines),
    evidence: evidenceFor(raw, causedBy),
  };
}

const seenKeys = new WeakMap<FailureCause, Set<string>>();

function addTests(cause: FailureCause, tests: TestRef[]): void {
  let seen = seenKeys.get(cause);
  if (!seen) {
    seen = new Set(cause.tests.map((t) => t.key));
    seenKeys.set(cause, seen);
  }
  for (const test of tests) {
    if (seen.has(test.key)) continue;
    seen.add(test.key);
    cause.testCount++;
    if (cause.tests.length < MAX_TESTS) cause.tests.push(test);
  }
}

/**
 * Group raw failures into causes. A failure matching a context pattern is a
 * context failure, and every context failure of one step is ONE cause (its
 * detail comes from the failure with the longest "Caused by" chain, since
 * later tests often only say the context already failed). Other failures
 * with the same signature are one cause too.
 */
export function groupFailures(raws: RawFailure[], contextPatterns: RegExp[]): FailureCause[] {
  const causes: FailureCause[] = [];
  const bySignature = new Map<string, FailureCause>();
  const contexts = new Map<string, RawFailure[]>();

  for (const raw of raws) {
    const text = cut(
      [raw.test?.name ?? "", raw.contextText ?? "", raw.type ?? "", raw.message, ...causedByChain(raw.lines)]
        .map((t) => cut(t, 500))
        .join("\n"),
      4000,
    );
    const kind = raw.kind ?? (contextPatterns.some((p) => p.test(text)) ? "context" : raw.test ? "test" : "build");
    if (kind === "context") {
      const scope = `${raw.parser}|${raw.step ?? ""}`;
      const list = contexts.get(scope) ?? [];
      list.push(raw);
      contexts.set(scope, list);
      continue;
    }
    const cause = toCause(raw, kind);
    const existing = bySignature.get(cause.signature);
    if (existing) {
      addTests(existing, cause.tests);
      continue;
    }
    bySignature.set(cause.signature, cause);
    causes.push(cause);
  }

  const contextCauses: FailureCause[] = [];
  for (const list of contexts.values()) {
    const leaders = list.filter((r) => !isFollower(r));
    const followers = list.filter((r) => isFollower(r));
    // Leaders with the same root cause are one group; followers (later tests
    // that only say the context already failed) join the deepest leader
    const groups = new Map<string, RawFailure[]>();
    for (const raw of leaders.length > 0 ? leaders : followers) {
      const signature = toCause(raw, "context").signature;
      groups.set(signature, [...(groups.get(signature) ?? []), raw]);
    }
    if (leaders.length > 0 && followers.length > 0) {
      const deepest = deepestOf(leaders);
      for (const group of groups.values()) {
        if (group.includes(deepest)) group.push(...followers);
      }
    }
    for (const group of groups.values()) {
      const best = deepestOf(group);
      const cause = toCause(best, "context");
      cause.tests = [];
      cause.testCount = 0;
      addTests(
        cause,
        group.flatMap((r) => (r.test ? [r.test] : [])),
      );
      const others = [
        ...new Set(group.filter((r) => r !== best).map((r) => clip(r.type ? `${r.type}: ${r.message}` : r.message))),
      ].filter((o) => o !== cause.evidence[0]);
      cause.evidence = [
        ...cause.evidence,
        `${cause.testCount} test(s) failed with this one context failure`,
        ...others.slice(0, 3).map((o) => `also: ${o}`),
      ].slice(0, MAX_EVIDENCE);
      contextCauses.push(cause);
    }
  }
  return [...contextCauses, ...causes];
}

/** A failure that only reports that a shared context failed earlier. */
const FOLLOWER = /failure threshold \(\d+\) exceeded|skipping repeated attempt|context (has )?already failed|previous (attempt|failure) to (load|start)/i;

function isFollower(raw: RawFailure): boolean {
  return FOLLOWER.test(cut(`${raw.type ?? ""}: ${raw.message}`)) && causedByChain(raw.lines).length === 0;
}

function deepestOf(raws: RawFailure[]): RawFailure {
  let best = raws[0];
  let depth = causedByChain(best.lines).length;
  for (const raw of raws.slice(1)) {
    const d = causedByChain(raw.lines).length;
    if (d > depth) {
      best = raw;
      depth = d;
    }
  }
  return best;
}

/** Merge causes with the same signature (from different reports or parsers). */
export function mergeCauses(causes: FailureCause[]): FailureCause[] {
  const out: FailureCause[] = [];
  const bySignature = new Map<string, FailureCause>();
  for (const cause of causes) {
    const existing = bySignature.get(cause.signature);
    if (existing) {
      addTests(existing, cause.tests);
      continue;
    }
    const copy = { ...cause, tests: [...cause.tests] };
    bySignature.set(cause.signature, copy);
    out.push(copy);
  }
  return out;
}
