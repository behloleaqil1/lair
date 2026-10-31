/**
 * CI guards: static tests that fail the build when a finding reviewers keep
 * raising comes back.
 *
 * 1. Timeout guard: every network call (fetch, an injected fetch) and every
 *    child process (execFile, spawn, an injected spawner) under src/server/
 *    is bounded by a timeout or an abort signal, or is named on an allow-list
 *    with a reason, one call site per entry.
 * 2. Wiring guard: every module directory under src/server/ is imported from
 *    the server startup (index.ts), or is listed with a reason; an entry for
 *    a directory index.ts imports is stale and fails.
 *
 * The route guard (no mutating method on a public route) lives in
 * human-auth/route-ownership.test.ts beside the route scan it uses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test .ts file under dir */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

// ============================================================================
// TIMEOUT GUARD: every network call and child process has a bound
// ============================================================================

/**
 * The source with comments, string, template and regex literal contents
 * replaced by spaces (same length, newlines kept), so the scanner sees code
 * only: "fetch(" in a message or a comment is not a call, and parens or
 * braces inside a literal do not upset the balancing.
 */
export function maskSource(source: string): string {
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let prev = ""; // the last code character
  let word = ""; // the identifier that ends at prev, if any
  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
      prev = c;
      word = "";
      continue;
    }
    if (c === "`") {
      // The whole template, ${} expressions included (nested templates and braces are counted)
      let k = i + 1;
      let depth = 0;
      while (k < n) {
        const t = source[k];
        if (t === "\\") {
          k += 2;
          continue;
        }
        if (depth === 0 && t === "`") break;
        if (t === "$" && source[k + 1] === "{") {
          depth++;
          k += 2;
          continue;
        }
        if (depth > 0 && t === "{") depth++;
        if (depth > 0 && t === "}") depth--;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      prev = "`";
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || REGEX_AFTER_WORD.test(word))) {
      let k = i + 1;
      let inClass = false;
      while (k < n && source[k] !== "\n") {
        const t = source[k];
        if (t === "\\") {
          k += 2;
          continue;
        }
        if (inClass) {
          if (t === "]") inClass = false;
        } else if (t === "[") inClass = true;
        else if (t === "/") break;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      prev = "/";
      word = "";
      continue;
    }
    if (!/\s/.test(c)) {
      word = /[\w$]/.test(c) ? (/[\w$]/.test(prev) ? word + c : c) : "";
      prev = c;
    }
    i++;
  }
  return out.join("");
}

const REGEX_AFTER_WORD = /^(?:return|typeof|case|of|in|delete|void|throw|new|else|do|yield|await)$/;

/** The index of the bracket that closes the one at `open`, or -1 */
function closing(masked: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[masked[open]];
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === masked[open]) depth++;
    else if (ch === want && --depth === 0) return k;
  }
  return -1;
}

/** The index of the bracket that opens the one at `close`, or -1 */
function opening(masked: string, close: number): number {
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const want = pairs[masked[close]];
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const ch = masked[k];
    if (ch === masked[close]) depth++;
    else if (ch === want && --depth === 0) return k;
  }
  return -1;
}

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "with", "await"]);

/** True when the "{" at `open` starts a function or method body (not a class, object, type or control block) */
function isFunctionBody(masked: string, open: number): boolean {
  const before = masked.slice(Math.max(0, open - 400), open);
  if (/=>\s*$/.test(before)) return true;
  // ")" then an optional return type with no braces, parens or "=" in it
  const m = /\)\s*(?::[^(){};=]*)?$/.exec(before);
  if (!m) return false;
  const close = open - before.length + m.index;
  const start = opening(masked, close);
  if (start < 0) return false;
  const name = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, start - 60), start))?.[1];
  return !(name && CONTROL_WORDS.has(name));
}

/** [open, close] of every function or method body */
function functionBodies(masked: string): Array<[number, number]> {
  const bodies: Array<[number, number]> = [];
  const stack: number[] = [];
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === "{") stack.push(k);
    else if (masked[k] === "}") {
      const open = stack.pop();
      if (open !== undefined && isFunctionBody(masked, open)) bodies.push([open, k]);
    }
  }
  return bodies;
}

/** The arguments of a call split at top-level commas, trimmed */
function topLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export type CallKind = "network" | "process";

export interface CallSite {
  /** Path relative to src/server/ */
  file: string;
  /** 1-based line of the callee */
  line: number;
  /** The source line (trimmed), for messages and allow-list matching */
  code: string;
  /** The callee as written, e.g. "fetch", "this.fetchFn", "spawn", "this.spawner.spawn" */
  callee: string;
  kind: CallKind;
  /** How the call is bounded, or null when nothing bounds it */
  guard: "in-call" | "pass-through" | "timer" | null;
}

/** fetch, an injected fetch (x.fetch, fetchFn, fetchImpl, somethingFetch), execFile or spawn (also x.spawn: an injected spawner) */
const CALLEE = /(?<![\w$])((?:[\w$]+\s*\??\.\s*)*)(fetch|fetchFn|fetchImpl|[A-Za-z_$][\w$]*Fetch|execFile|spawn)\s*\(/g;
/** A timeout or an abort signal named in the call's own arguments */
const IN_CALL_GUARD = /(?<![\w$])(?:timeout\w*|signal)(?![\w$])/;
/** What a timer does to end the process it guards */
const ENDS_PROCESS = /(?:\.|(?<![\w$]))(?:kill|abort|destroy|terminate|stop|signalTree)\w*\s*\(/;
/** Tokens after which "name(...) {" or "name(...): T" declares a method or function */
const DECLARATION_PREV = new Set(["", "{", "}", ";", ",", "async", "static", "public", "private", "protected", "override", "function"]);
/** An assignment to a fetch-like name: "this.fetchFn =", "fetchImpl: HttpFetch =", "fetch:" */
const FETCH_TARGET = /(?:^|[\s.{,(])(?:fetch|fetchFn|fetchImpl|[A-Za-z_$][\w$]*Fetch)\s*(?::\s*[\w$.<>[\]| ]+)?\s*(?:=(?![=>])|:)/;

/**
 * Every network call (fetch and injected fetches) and child process
 * (execFile, spawn, injected spawners) in one source file, each with what
 * bounds it. The check is statement-aware: the arguments are read up to
 * the matching paren across lines.
 *
 * A call is bounded ("guard") when:
 * - in-call: its own arguments name a timeout (timeout, timeoutMs,
 *   AbortSignal.timeout) or an abort signal;
 * - pass-through: it is `(url, init) => fetch(url, init)` assigned to a
 *   fetch-like name, so the bound belongs to the callers of that name,
 *   which the scan checks as injected fetches;
 * - timer (child processes only): the enclosing function starts a
 *   setTimeout that kills, aborts or stops it.
 */
export function findCalls(file: string, source: string): CallSite[] {
  const masked = maskSource(source);
  const lines = source.split("\n");
  const bodies = functionBodies(masked);
  const calls: CallSite[] = [];
  for (const match of masked.matchAll(CALLEE)) {
    const start = match.index ?? 0;
    const name = match[2];
    const callee = (match[1] + name).replace(/\s+/g, "");
    const member = match[1].length > 0;
    const open = start + match[0].length - 1;
    const close = closing(masked, open);
    if (close < 0) continue;
    const before = masked.slice(Math.max(0, start - 200), start);
    const prevToken = /([\w$]+|[^\s\w$])?\s*$/.exec(before)?.[1] ?? "";
    const after = masked.slice(close + 1).trimStart()[0] ?? "";
    // "spawn(argv: string[]): Promise<X>;" or "async spawn(...) {": a declaration, not a call
    if (!member && (after === "{" || after === ":") && DECLARATION_PREV.has(prevToken)) continue;
    const kind: CallKind = name === "execFile" || name === "spawn" ? "process" : "network";
    const args = masked.slice(open + 1, close);
    let guard: CallSite["guard"] = null;
    if (IN_CALL_GUARD.test(args)) guard = "in-call";
    else if (kind === "network" && isPassThrough(before, args)) guard = "pass-through";
    else if (kind === "process" && timerEndsIt(masked, bodies, start)) guard = "timer";
    const line = masked.slice(0, start).split("\n").length;
    calls.push({ file, line, code: (lines[line - 1] ?? "").trim(), callee, kind, guard });
  }
  return calls;
}

/** `(url, init) => fetch(url, init)`: the arrow's parameters forwarded unchanged, assigned to a fetch-like name */
function isPassThrough(before: string, args: string): boolean {
  const arrow = /\(([^()]*)\)\s*=>\s*$/.exec(before);
  if (!arrow) return false;
  const params = topLevelArgs(arrow[1]).map((p) => /^[\w$]+/.exec(p)?.[0] ?? "");
  const forwarded = topLevelArgs(args);
  if (params.length === 0 || params.join(",") !== forwarded.join(",")) return false;
  const statement = before.slice(0, arrow.index).split(/[;\n]/).pop() ?? "";
  return FETCH_TARGET.test(statement);
}

/** True when the outermost function around `at` starts a setTimeout whose callback ends the process */
function timerEndsIt(masked: string, bodies: Array<[number, number]>, at: number): boolean {
  const outer = bodies.filter(([o, c]) => o < at && at < c).sort((a, b) => a[0] - b[0])[0];
  if (!outer) return false;
  const body = masked.slice(outer[0], outer[1]);
  for (const timer of body.matchAll(/(?<![\w$.])setTimeout\s*\(/g)) {
    const open = outer[0] + (timer.index ?? 0) + timer[0].length - 1;
    const close = closing(masked, open);
    if (close > 0 && ENDS_PROCESS.test(masked.slice(open + 1, close))) return true;
  }
  return false;
}

/**
 * A call allowed without a bound. `site` is text from the call's own
 * source line that names exactly one call site in the file (never just
 * "spawn(" for a whole file); it must contain the callee and its "(".
 */
export interface AllowEntry {
  file: string;
  site: string;
  reason: string;
}

/** True when the call is bounded, or one allow-list entry names exactly this call site */
export function isAllowedCall(call: CallSite, allowed: readonly AllowEntry[], all: readonly CallSite[]): boolean {
  if (call.guard) return true;
  return allowed.some((entry) => {
    if (entry.file !== call.file || !call.code.includes(entry.site)) return false;
    return all.filter((c) => c.file === entry.file && c.code.includes(entry.site)).length === 1;
  });
}

/** Allow-list entries that are wrong: no reason, no callee, no call, several calls, or a call that is bounded anyway */
export function allowListProblems(allowed: readonly AllowEntry[], all: readonly CallSite[]): string[] {
  const problems: string[] = [];
  for (const entry of allowed) {
    const label = `${entry.file} "${entry.site}"`;
    if (entry.reason.trim().length < 20) problems.push(`${label}: needs a reason`);
    const sites = all.filter((c) => c.file === entry.file && c.code.includes(entry.site));
    if (sites.length === 0) {
      problems.push(`${label}: matches no call: remove the stale entry`);
      continue;
    }
    if (sites.length > 1) problems.push(`${label}: matches ${sites.length} calls (lines ${sites.map((s) => s.line).join(", ")}): name one call site`);
    if (!sites.some((s) => entry.site.includes(`${s.callee.split(".").pop()}(`))) problems.push(`${label}: must contain the callee and its "("`);
    for (const s of sites) if (s.guard) problems.push(`${label}: line ${s.line} is bounded (${s.guard}): remove the entry`);
  }
  return problems;
}

/** Network calls allowed without a bound: none today. Add one only with a reason a reviewer can check. */
export const FETCH_TIMEOUT_ALLOWED: readonly AllowEntry[] = [];

/** Child processes allowed without a bound, one call site each */
export const EXEC_TIMEOUT_ALLOWED: readonly AllowEntry[] = [
  {
    file: "agents/probes.ts",
    site: "const child = spawn(file, args, {",
    reason: "starts an agent run, long-running by design and detached into its own process group; the agents service ends it (stop, run limits), not a call timeout",
  },
  {
    file: "agents/service.ts",
    site: "this.probes.spawner.spawn(argv,",
    reason: "the agents service launching a run through that spawner; the run is long-running by design and the service stops it",
  },
  {
    file: "gates/executors/local.ts",
    site: 'spawn("taskkill",',
    reason: "fire-and-forget Windows taskkill of a known pid while ending a step; nothing waits on it, so it cannot hold a caller",
  },
  {
    file: "services/managed-process.ts",
    site: "this.child = spawn(cmd, args, {",
    reason: "starts a long-running managed service process; stop() ends it with a grace period and health checks watch it",
  },
];

/** Every fetch and injected fetch in one source file */
export function findFetchCalls(file: string, source: string): CallSite[] {
  return findCalls(file, source).filter((c) => c.kind === "network");
}

/** Every execFile, spawn and injected spawner call in one source file */
export function findExecCalls(file: string, source: string): CallSite[] {
  return findCalls(file, source).filter((c) => c.kind === "process");
}

export function isAllowedFetch(call: CallSite, all: readonly CallSite[]): boolean {
  return isAllowedCall(call, FETCH_TIMEOUT_ALLOWED, all);
}

export function isAllowedExec(call: CallSite, all: readonly CallSite[]): boolean {
  return isAllowedCall(call, EXEC_TIMEOUT_ALLOWED, all);
}

function serverCalls(): { fetches: CallSite[]; execs: CallSite[] } {
  const fetches: CallSite[] = [];
  const execs: CallSite[] = [];
  for (const file of sourceFiles(SERVER_DIR)) {
    const rel = relative(SERVER_DIR, file).split("\\").join("/");
    const source = readFileSync(file, "utf8");
    fetches.push(...findFetchCalls(rel, source));
    execs.push(...findExecCalls(rel, source));
  }
  return { fetches, execs };
}

const where = (c: CallSite) => `${c.file}:${c.line} ${c.code.slice(0, 100)}`;

describe("timeout guard", () => {
  const { fetches, execs } = serverCalls();

  it("finds the server's calls (guards the scan itself)", () => {
    expect(fetches.length).toBeGreaterThan(5);
    expect(execs.length).toBeGreaterThan(10);
  });

  it("bounds every fetch() and injected fetch, or names it on FETCH_TIMEOUT_ALLOWED", () => {
    expect(
      fetches.filter((c) => !isAllowedFetch(c, fetches)).map(where),
      "pass a timeout or an abort signal in the call (signal: AbortSignal.timeout(ms)), or add one FETCH_TIMEOUT_ALLOWED entry for this call site with a reason",
    ).toEqual([]);
  });

  it("bounds every execFile/spawn and injected spawner, or names it on EXEC_TIMEOUT_ALLOWED", () => {
    expect(
      execs.filter((c) => !isAllowedExec(c, execs)).map(where),
      "pass a timeout or an abort signal in the call, kill it from a setTimeout in the same function, or add one EXEC_TIMEOUT_ALLOWED entry for this call site with a reason",
    ).toEqual([]);
  });

  it("keeps every allow-list entry live: one unbounded call site, the callee named, a reason", () => {
    expect(allowListProblems(FETCH_TIMEOUT_ALLOWED, fetches)).toEqual([]);
    expect(allowListProblems(EXEC_TIMEOUT_ALLOWED, execs)).toEqual([]);
  });

  describe("the scanner, on source strings", () => {
    const allowedFetches = (source: string) => {
      const calls = findFetchCalls("example.ts", source);
      return calls.map((c) => isAllowedFetch(c, calls));
    };
    const allowedExecs = (source: string) => {
      const calls = findExecCalls("example.ts", source);
      return calls.map((c) => isAllowedExec(c, calls));
    };

    it("flags a fetch with no bound, and passes one whose signal is lines below the call", () => {
      const bad = ["async function get(url: string) {", "  return await fetch(url, {", '    method: "GET",', "  });", "}"].join("\n");
      const good = [
        "async function get(url: string) {",
        "  return await fetch(url, {",
        '    method: "GET",',
        "    signal: AbortSignal.timeout(5_000),",
        "  });",
        "}",
      ].join("\n");
      expect(findFetchCalls("example.ts", bad).map((c) => [c.line, c.guard])).toEqual([[2, null]]);
      expect(allowedFetches(bad)).toEqual([false]);
      expect(findFetchCalls("example.ts", good).map((c) => [c.line, c.guard])).toEqual([[2, "in-call"]]);
      expect(allowedFetches(good)).toEqual([true]);
    });

    it("checks injected fetches: flags this.fetchFn() with no signal, passes one with a timeout", () => {
      expect(allowedFetches(`class A { async get() { return this.fetchFn(url, { method: "GET" }); } }`)).toEqual([false]);
      expect(allowedFetches(`class A { async get() { return this.options.fetch(url, { method: "GET", signal }); } }`)).toEqual([true]);
      expect(allowedFetches(`async function get(o) { return o.fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) }); }`)).toEqual([true]);
    });

    it("passes a pass-through wrapper assigned to a fetch name, and flags one that is not", () => {
      expect(allowedFetches("this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));")).toEqual([true]);
      expect(allowedFetches("fetch: options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),")).toEqual([true]);
      expect(allowedFetches("const get = (url, init) => fetch(url, init);")).toEqual([false]);
      expect(allowedFetches("this.fetchFn = (url, init) => fetch(url, { ...init, keepalive: true });")).toEqual([false]);
    });

    it("ignores fetch( and spawn( in strings, templates, comments and regex literals", () => {
      const source = [
        'const a = "await fetch(url)"; // fetch(url)',
        "/* spawn(cmd, args) */ const b = `fetch(${url})`;",
        "const c = /spawn\\(|fetch\\(/.test(text);",
      ].join("\n");
      expect(findFetchCalls("example.ts", source)).toEqual([]);
      expect(findExecCalls("example.ts", source)).toEqual([]);
    });

    it("skips method declarations and interface signatures, and still sees a call in a ternary", () => {
      const source = [
        "interface Spawner {",
        "  spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner>;",
        "}",
        "class Fake implements Spawner {",
        "  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {",
        "    return owner;",
        "  }",
        "}",
        "const r = ready ? spawn(file, args, { stdio: 'ignore' }) : null;",
      ].join("\n");
      expect(findExecCalls("example.ts", source).map((c) => c.line)).toEqual([9]);
      expect(allowedExecs(source)).toEqual([false]);
    });

    it("passes a child process killed by a timer in its function, and flags a timer that does not end it", () => {
      const killed = [
        "function run(argv: string[], options: { timeoutMs: number }): Promise<number> {",
        "  return new Promise((resolve) => {",
        "    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });",
        "    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);",
        "    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });",
        "  });",
        "}",
      ].join("\n");
      const logged = [
        "function run(argv: string[]): void {",
        "  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });",
        "  setTimeout(() => console.log('still running'), 1_000);",
        "}",
      ].join("\n");
      expect(findExecCalls("example.ts", killed).map((c) => c.guard)).toEqual(["timer"]);
      expect(allowedExecs(killed)).toEqual([true]);
      expect(allowedExecs(logged)).toEqual([false]);
      expect(allowedExecs("execFile('git', ['status'], { timeout: 10_000 }, done);")).toEqual([true]);
      expect(allowedExecs("const out = await this.spawner.spawn(argv, { cwd });")).toEqual([false]);
    });

    it("allows exactly the call site an entry names, never the rest of the file", () => {
      const source = ["function a() {", '  spawn("one", []);', '  spawn("two", []);', "}"].join("\n");
      const calls = findExecCalls("example.ts", source);
      const reason = "an example reason that is long enough";
      const one: AllowEntry[] = [{ file: "example.ts", site: 'spawn("one",', reason }];
      const broad: AllowEntry[] = [{ file: "example.ts", site: "spawn(", reason }];
      expect(calls.map((c) => isAllowedCall(c, one, calls))).toEqual([true, false]);
      expect(calls.map((c) => isAllowedCall(c, broad, calls))).toEqual([false, false]);
      expect(allowListProblems(broad, calls)).toEqual(['example.ts "spawn(": matches 2 calls (lines 2, 3): name one call site']);
    });

    it("reports stale entries: no such call, a bounded call, no callee, no reason", () => {
      const source = ["function a() {", "  execFile('git', ['status'], { timeout: 5_000 }, done);", "}"].join("\n");
      const calls = findExecCalls("example.ts", source);
      const reason = "an example reason that is long enough";
      expect(allowListProblems([{ file: "example.ts", site: 'spawn("gone",', reason }], calls)).toEqual([
        'example.ts "spawn("gone",": matches no call: remove the stale entry',
      ]);
      expect(allowListProblems([{ file: "example.ts", site: "execFile('git',", reason }], calls)).toEqual([
        "example.ts \"execFile('git',\": line 2 is bounded (in-call): remove the entry",
      ]);
      expect(allowListProblems([{ file: "example.ts", site: "'status'", reason: "short" }], calls)).toEqual([
        "example.ts \"'status'\": needs a reason",
        "example.ts \"'status'\": must contain the callee and its \"(\"",
        "example.ts \"'status'\": line 2 is bounded (in-call): remove the entry",
      ]);
    });
  });
});

// ============================================================================
// WIRING GUARD: every module directory is imported from the server startup
// ============================================================================

/**
 * Directories under src/server/ that index.ts does not import, each with a
 * reason. An entry for a directory index.ts imports is stale and fails.
 */
export const UNWIRED_ALLOWED: Readonly<Record<string, string>> = {
  "brain-bench": "the model bench the brain trainer uses; imported by brain-trainer/, which index.ts imports",
  cleanup: "not mounted: its routes are registered only by tests (see UNMOUNTED in human-auth/route-ownership.test.ts)",
  diagnostics: "imported only by routes/diagnostics.ts, which the server does not register",
  jobs: "scheduler job definitions; imported by routes/scheduler.ts, which index.ts registers",
  machines: "machine config and SSH helpers; imported by fleet/, services/ and ai/",
  policy: "merge policy helpers; imported by review/",
  "ready-guard": "ready guard helpers; imported by agents/ and review/",
};

/** The directories index.ts imports at run time (static, re-export or dynamic; type-only imports do not count) */
export function importedDirectories(indexSource: string): Set<string> {
  const code = indexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const dirs = new Set<string>();
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\bfrom\s*)?['"]\.\/([^/'"]+)\//g)) {
    if (!m[1]) dirs.add(m[2]);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]\.\/([^/'"]+)\//g)) dirs.add(m[1]);
  return dirs;
}

/** Module directories that are neither imported nor allowed, and allow-list entries that are stale */
export function wiringProblems(indexSource: string, modules: readonly string[], allowed: Readonly<Record<string, string>>): string[] {
  const imported = importedDirectories(indexSource);
  const problems: string[] = [];
  for (const mod of modules) {
    if (!imported.has(mod) && !(mod in allowed)) problems.push(`${mod}: not imported from index.ts`);
  }
  for (const [dir, reason] of Object.entries(allowed)) {
    if (!modules.includes(dir)) problems.push(`${dir}: on UNWIRED_ALLOWED but no such directory`);
    else if (imported.has(dir)) problems.push(`${dir}: on UNWIRED_ALLOWED but index.ts imports it: remove the stale entry`);
    if (reason.trim().length < 20) problems.push(`${dir}: needs a reason`);
  }
  return problems;
}

function moduleDirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

describe("wiring guard", () => {
  it("imports every module directory from index.ts, or lists it in UNWIRED_ALLOWED (no stale entries)", () => {
    const indexSource = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(
      wiringProblems(indexSource, moduleDirectories(SERVER_DIR), UNWIRED_ALLOWED),
      "wire the module from index.ts (behind its switch), or list it in UNWIRED_ALLOWED with a reason; remove entries index.ts now imports",
    ).toEqual([]);
  });

  describe("on source strings", () => {
    const allowed = { helpers: "shared helpers imported by other modules" };

    it("flags a module index.ts does not import, and passes imported ones", () => {
      const index = [
        'import { mountAgents } from "./agents/index.js";',
        "import {",
        "  mountTriage,",
        '} from "./triage/mount.js";',
        'export { thing } from "./reexported/index.js";',
        'const late = await import("./late/index.js");',
      ].join("\n");
      expect(wiringProblems(index, ["agents", "triage", "reexported", "late", "helpers", "brand-new"], allowed)).toEqual([
        "brand-new: not imported from index.ts",
      ]);
    });

    it("does not count type-only, commented-out or look-alike imports", () => {
      const index = [
        'import type { Types } from "./typed/index.js";',
        '// import { off } from "./commented/index.js";',
        'import { near } from "./agents-extra.js";',
      ].join("\n");
      expect(wiringProblems(index, ["typed", "commented", "agents"], {})).toEqual([
        "typed: not imported from index.ts",
        "commented: not imported from index.ts",
        "agents: not imported from index.ts",
      ]);
    });

    it("fails a stale entry: an allowed directory index.ts imports, or one that does not exist", () => {
      const index = 'import { h } from "./helpers/index.js";';
      expect(wiringProblems(index, ["helpers"], allowed)).toEqual([
        "helpers: on UNWIRED_ALLOWED but index.ts imports it: remove the stale entry",
      ]);
      expect(wiringProblems("", [], allowed)).toEqual(["helpers: on UNWIRED_ALLOWED but no such directory"]);
    });
  });
});
