/**
 * Test integrity check (docs/design/quality.md §1). Heuristics over a PR's
 * diff and its changed test files, each finding explained with file:line:
 *
 * - self-asserting-test: a test whose assertions can only check values the
 *   test built itself or fakes' recorded calls, because it imports no
 *   production module it actually uses (imports that are only test libraries,
 *   fakes, mocked modules, types, or never referenced);
 * - skipped-test / focused-test: a skip, disable or `.only` added;
 * - assertion-weakened / tolerance-widened: an assertion replaced by a weaker
 *   one (an exact match becoming "is defined", a call check losing its
 *   arguments) or a tolerance widened;
 * - test-removed / assertion-removed: test files deleted, or fewer test cases
 *   or assertions than before;
 * - suite-loosened: exclusions added to the test runner config, or a coverage
 *   threshold lowered;
 * - error-swallowed: an empty catch (or `except: pass`) added in test code.
 *
 * The import analysis covers JavaScript/TypeScript and Python, where a test
 * must import what it tests. Languages whose tests share a package with the
 * code (Go, Java, Kotlin, C#) get every check except self-asserting-test.
 */
import { posix } from "path";
import type { FindingSeverity } from "../../shared/review-types.js";
import { matchPath } from "../policy/risk-rules.js";
import { addedLines, changeBlocks, parsePatch, removedLines, type DiffHunk, type DiffLine } from "./diff.js";

export type IntegrityRule =
  | "self-asserting-test"
  | "skipped-test"
  | "focused-test"
  | "assertion-weakened"
  | "tolerance-widened"
  | "test-removed"
  | "assertion-removed"
  | "suite-loosened"
  | "error-swallowed";

export interface IntegrityFile {
  path: string;
  previousPath: string | null;
  /** added, modified, removed, renamed, ... */
  status: string;
  /** The file's unified diff hunks, if the host gave them */
  patch: string | null;
  /** The whole file at the PR head (for changed test files), if available */
  content: string | null;
}

export interface IntegrityOptions {
  /** Globs for test files */
  testFiles: string[];
  /** Import prefixes that are the project's own code, besides relative imports */
  productionImports: string[];
  /** Globs the check skips */
  ignore: string[];
}

export interface IntegrityFinding {
  rule: IntegrityRule;
  severity: FindingSeverity;
  file: string;
  line: number | null;
  text: string;
}

const MAX_FINDINGS_PER_FILE = 20;

/** Test runner and coverage configs, where exclusions and thresholds live. */
const SUITE_CONFIGS = [
  "vitest.config.*",
  "vitest.workspace.*",
  "jest.config.*",
  "karma.conf.*",
  ".mocharc*",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "pyproject.toml",
  ".coveragerc",
  ".nycrc*",
  "codecov.yml",
  ".codecov.yml",
  "phpunit.xml*",
  "package.json",
];

function snippet(text: string): string {
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/** A comment line (but not a Rust attribute such as #[ignore]). */
function isComment(text: string): boolean {
  const t = text.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || (t.startsWith("#") && !t.startsWith("#["));
}

export function isTestFile(path: string, options: IntegrityOptions): boolean {
  return options.testFiles.some((g) => matchPath(g, path)) && !options.ignore.some((g) => matchPath(g, path));
}

// ============ ASSERTIONS ============

/** 3: exact value, 2: partial or structural, 1: existence or truthiness only. */
type Strength = 1 | 2 | 3;

interface AssertionKind {
  re: RegExp;
  strength: Strength;
  label: string;
}

// First match wins: the weak forms of a matcher come before its general form.
const ASSERTIONS: AssertionKind[] = [
  { re: /\.not\s*\.\s*(?:toBeNull|toBeUndefined|toBeNaN)\s*\(\s*\)/, strength: 1, label: "a not-null check" },
  { re: /\.not\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(/, strength: 1, label: "a not-equal check" },
  { re: /\.not\s*\.\s*toThrow\w*\s*\(\s*\)/, strength: 1, label: "a does-not-throw check" },
  { re: /\.(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(\s*\)/, strength: 1, label: "a truthiness check" },
  { re: /\.(?:toHaveBeenCalled|toBeCalled)\s*\(\s*\)/, strength: 1, label: "a was-called check" },
  { re: /\.(?:toThrow|toThrowError)\s*\(\s*\)/, strength: 1, label: "a throws-anything check" },
  { re: /\.toBeGreaterThan(?:OrEqual)?\s*\(\s*0\s*\)/, strength: 1, label: "a greater-than-zero check" },
  { re: /expect\s*\.\s*(?:anything|any)\s*\(/, strength: 1, label: "an any-value matcher" },
  { re: /\.to(?:\.not)?\.(?:exist|be\.ok|be\.true|be\.false)\b|\.to\.not\.be\.(?:null|undefined)\b/, strength: 1, label: "a truthiness check" },
  {
    re: /\.(?:toBe|toEqual|toStrictEqual|toBeNull|toBeUndefined|toBeNaN|toHaveLength|toHaveBeenCalledWith|toHaveBeenCalledTimes|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toBeCalledWith|toBeCalledTimes|toHaveReturnedWith|toMatchSnapshot|toMatchInlineSnapshot|toBeCloseTo)\s*\(/,
    strength: 3,
    label: "an exact check",
  },
  { re: /\bassert\s*\.\s*(?:strictEqual|deepStrictEqual|equal|deepEqual)\s*\(/, strength: 3, label: "an exact check" },
  { re: /\.to\.(?:deep\.)?(?:equal|eql|eq)\s*\(|\.to\.have\.(?:length|lengthOf)\s*\(/, strength: 3, label: "an exact check" },
  {
    re: /\.(?:assertEqual|assertEquals|assertListEqual|assertDictEqual|assertTupleEqual|assertSetEqual|assertSequenceEqual|assertCountEqual|assertMultiLineEqual|assertIs|assertIsNone|assertAlmostEqual)\s*\(/,
    strength: 3,
    label: "an exact check",
  },
  { re: /\b(?:assertEquals|assertSame|assertArrayEquals|assertIterableEquals|assertNull)\s*\(/, strength: 3, label: "an exact check" },
  { re: /\.(?:isEqualTo|isSameAs|containsExactly|containsExactlyInAnyOrder|isNull|hasSize|isEqualByComparingTo)\s*\(/, strength: 3, label: "an exact check" },
  { re: /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|Nil|Len|JSONEq|ElementsMatch)\s*\(/, strength: 3, label: "an exact check" },
  {
    re: /\.(?:toMatchObject|toContain|toContainEqual|toMatch|toHaveProperty|toBeInstanceOf|toThrow|toThrowError|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toHaveBeenCalledOnce)\s*\(/,
    strength: 2,
    label: "a partial check",
  },
  { re: /expect\s*\.\s*(?:objectContaining|arrayContaining|stringContaining|stringMatching)\s*\(/, strength: 2, label: "a partial check" },
  { re: /\bassert\s*\.\s*(?:match|throws|rejects|notStrictEqual|notDeepStrictEqual)\s*\(/, strength: 2, label: "a partial check" },
  { re: /\.to\.(?:include|contain|match|have\.property|be\.instanceOf|throw)\b/, strength: 2, label: "a partial check" },
  {
    re: /\.(?:assertIn|assertNotIn|assertRegex|assertIsInstance|assertRaises|assertRaisesRegex|assertGreater|assertGreaterEqual|assertLess|assertLessEqual)\s*\(/,
    strength: 2,
    label: "a partial check",
  },
  {
    re: /\b(?:assertThrows|assertDoesNotThrow)\s*\(|\.(?:contains|isInstanceOf|startsWith|endsWith|matches|isGreaterThan|isLessThan)\s*\(/,
    strength: 2,
    label: "a partial check",
  },
  { re: /\b(?:assert|require)\.(?:Contains|Subset|Greater|Less|Regexp|ErrorIs|ErrorContains|IsType)\s*\(/, strength: 2, label: "a partial check" },
  { re: /\.assert_(?:called|not_called|any_call|has_calls|awaited)\w*\s*\(|\bverify\s*\(\s*\w+/, strength: 2, label: "a mock call check" },
  { re: /\.(?:assertTrue|assertFalse|assertIsNotNone|assertIsNot|assertNotEqual)\s*\(/, strength: 1, label: "a truthiness check" },
  { re: /\b(?:assertTrue|assertFalse|assertNotNull|assertNotEquals|assertNotSame)\s*\(/, strength: 1, label: "a truthiness check" },
  { re: /\.(?:isNotNull|isTrue|isFalse|isNotEmpty)\s*\(\s*\)/, strength: 1, label: "a truthiness check" },
  { re: /\b(?:assert|require)\.(?:NotNil|True|False|NoError|Error|NotEmpty|NotEqual)\s*\(/, strength: 1, label: "a truthiness check" },
  { re: /(?<![\w.])assert(?:\.ok)?\s*\(/, strength: 1, label: "a truthiness check" },
];

/** Python's assert statement, by the comparison it makes. */
function pythonAssert(text: string): { strength: Strength; label: string } | null {
  const m = /^\s*assert\s+(.+)$/.exec(text);
  if (!m) return null;
  const expr = m[1];
  if (/\bis\s+not\s+None\b|!=/.test(expr)) return { strength: 1, label: "a not-equal or not-None check" };
  if (/==|\bis\s+None\b|\bpytest\.approx\b/.test(expr)) return { strength: 3, label: "an exact check" };
  if (/\bin\b|<=|>=|<|>|\bisinstance\s*\(/.test(expr)) return { strength: 2, label: "a partial check" };
  return { strength: 1, label: "a truthiness check" };
}

export function classifyAssertion(text: string): { strength: Strength; label: string } | null {
  if (isComment(text)) return null;
  for (const kind of ASSERTIONS) {
    if (kind.re.test(text)) return { strength: kind.strength, label: kind.label };
  }
  return pythonAssert(text);
}

/** Precision digits (higher is stricter) or a tolerance (lower is stricter). */
function toleranceOf(text: string): { kind: "precision" | "tolerance"; value: number } | null {
  const closeTo = /toBeCloseTo\s*\([^,]+,\s*(\d+)\s*\)/.exec(text) ?? /\bplaces\s*=\s*(\d+)/.exec(text);
  if (closeTo) return { kind: "precision", value: Number(closeTo[1]) };
  const tol = /\b(?:abs|rel|delta|tolerance|epsilon|eps|atol|rtol|within)\s*[=:(]\s*([0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?)/.exec(text);
  if (tol) return { kind: "tolerance", value: parseFloat(tol[1]) };
  return null;
}

const TEST_CASE = /^\s*(?:it|test|specify)\s*(?:\.\s*\w+\s*)?\(|^\s*(?:async\s+)?def\s+test\w*\s*\(|@Test\b|^\s*func\s+Test\w+\s*\(|#\[test\]/;

// ============ SKIPS ============

const SKIPS: { re: RegExp; what: string; rule: "skipped-test" | "focused-test" }[] = [
  {
    re: /\b(?:it|test|describe|context|suite|bench)\s*\.\s*(?:skip|todo|skipIf)\s*\(/,
    what: "a skipped test (.skip/.todo)",
    rule: "skipped-test",
  },
  { re: /\b(?:xit|xtest|xdescribe|xcontext)\s*\(/, what: "a disabled (x-prefixed) test", rule: "skipped-test" },
  {
    re: /\b(?:it|test|describe|context)\s*\.\s*only\s*\(|\b(?:fit|fdescribe)\s*\(/,
    what: "a focused test (.only), which skips every other test in the file",
    rule: "focused-test",
  },
  {
    re: /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/,
    what: "a skipped Python test",
    rule: "skipped-test",
  },
  { re: /@(?:Disabled|Ignore)\b|@Test\s*\(\s*enabled\s*=\s*false/, what: "a disabled JVM test", rule: "skipped-test" },
  { re: /\bt\.Skip(?:f|Now)?\s*\(/, what: "a skipped Go test", rule: "skipped-test" },
  { re: /#\[ignore\]/, what: "an ignored Rust test", rule: "skipped-test" },
  { re: /\[(?:Ignore|Skip)\b|\(\s*Skip\s*=/, what: "a skipped .NET test", rule: "skipped-test" },
  { re: /\bthis\.skip\s*\(\s*\)/, what: "a skipped mocha test", rule: "skipped-test" },
];

// ============ IMPORTS ============

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const PY_FILE = /\.py$/;

const JS_TEST_LIBRARIES = [
  "vitest",
  "@vitest",
  "jest",
  "@jest",
  "mocha",
  "chai",
  "chai-as-promised",
  "sinon",
  "@sinonjs",
  "expect",
  "jasmine",
  "ava",
  "tap",
  "uvu",
  "@testing-library",
  "nock",
  "msw",
  "testdouble",
  "proxyquire",
  "jest-mock-extended",
  "vitest-mock-extended",
  "ts-mockito",
  "@faker-js/faker",
  "fast-check",
];
/** Libraries that drive a running app (browser, HTTP): such a test exercises the app without importing it. */
const JS_DRIVERS = ["@playwright/test", "playwright", "cypress", "puppeteer", "selenium-webdriver", "webdriverio", "supertest"];
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "test",
  "timers",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads",
  "zlib",
]);
const PY_LIBRARIES = new Set([
  "__future__",
  "abc",
  "asyncio",
  "base64",
  "collections",
  "contextlib",
  "copy",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "enum",
  "fractions",
  "functools",
  "hashlib",
  "inspect",
  "io",
  "itertools",
  "json",
  "logging",
  "math",
  "operator",
  "os",
  "pathlib",
  "pickle",
  "queue",
  "random",
  "re",
  "secrets",
  "shutil",
  "socket",
  "sqlite3",
  "statistics",
  "string",
  "struct",
  "subprocess",
  "sys",
  "tempfile",
  "textwrap",
  "threading",
  "time",
  "traceback",
  "types",
  "typing",
  "uuid",
  "warnings",
  "weakref",
  // test libraries
  "pytest",
  "unittest",
  "mock",
  "hypothesis",
  "freezegun",
  "responses",
  "respx",
  "faker",
  "factory",
  "pytest_mock",
  "pytest_asyncio",
  "testfixtures",
  "parameterized",
  "ddt",
  "nose",
  "nose2",
  "time_machine",
  "pyfakefs",
  "moto",
]);

const HELPER_NAME = /(?:^|[._-])(?:mocks?|fakes?|stubs?|fixtures?|test-?utils?|test-?helpers?|test-?support|testing|conftest|factories)(?:[._-]|$)/i;
const HELPER_DIR = /(?:^|\/)(?:__mocks__|__fixtures__|mocks?|fakes?|stubs?|fixtures?|testing|test-?utils|test-?helpers)\//i;

type ImportClass = "production" | "helper" | "library" | "driver";

interface ImportInfo {
  specifier: string;
  /** Resolved path for relative imports, else the specifier */
  target: string;
  locals: string[];
  typeOnly: boolean;
  /** Side-effect or dynamic import: no bindings to check */
  unbound: boolean;
  cls: ImportClass;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?|py)$/, "").replace(/\/index$/, "");
}

function looksLikeHelper(target: string, options: IntegrityOptions): boolean {
  const base = target.slice(target.lastIndexOf("/") + 1);
  return HELPER_NAME.test(base) || HELPER_DIR.test(`${target}/`) || options.testFiles.some((g) => matchPath(g, target));
}

function classifyJs(specifier: string, testPath: string, options: IntegrityOptions): { cls: ImportClass; target: string } {
  if (JS_DRIVERS.some((d) => specifier === d || specifier.startsWith(`${d}/`))) return { cls: "driver", target: specifier };
  const relative = specifier.startsWith(".") || specifier.startsWith("/");
  if (relative || options.productionImports.some((p) => specifier.startsWith(p))) {
    const target = relative ? posix.normalize(posix.join(posix.dirname(testPath), specifier)) : specifier;
    return { cls: looksLikeHelper(target, options) ? "helper" : "production", target };
  }
  const root = specifier.startsWith("node:") ? specifier.slice(5) : specifier.split("/")[0];
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(root)) return { cls: "library", target: specifier };
  if (JS_TEST_LIBRARIES.some((l) => specifier === l || specifier.startsWith(`${l}/`))) {
    return { cls: "library", target: specifier };
  }
  // Another package: it may be the project's own (a workspace package), so it counts as production
  return { cls: "production", target: specifier };
}

function jsClauseLocals(clause: string): { locals: string[]; typeOnly: boolean } {
  const locals: string[] = [];
  let named = 0;
  let typeNamed = 0;
  const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
  if (namespace) locals.push(namespace[1]);
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      named++;
      if (/^type\s/.test(p)) {
        typeNamed++;
        continue;
      }
      const alias = /\sas\s+([\w$]+)$/.exec(p);
      locals.push(alias ? alias[1] : p.split(/\s+/)[0]);
    }
  }
  const defaultBinding = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
  if (defaultBinding) locals.push(defaultBinding[1]);
  return { locals, typeOnly: locals.length === 0 && named > 0 && named === typeNamed };
}

function jsImports(content: string, testPath: string, options: IntegrityOptions): { imports: ImportInfo[]; body: string } {
  const imports: ImportInfo[] = [];
  let body = content;
  const add = (specifier: string, locals: string[], typeOnly: boolean, unbound: boolean) => {
    const { cls, target } = classifyJs(specifier, testPath, options);
    imports.push({ specifier, target, locals, typeOnly, unbound, cls });
  };

  const statics = /(^|[\n;])\s*import\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(statics)) {
    const clause = m[3];
    const parsed = jsClauseLocals(clause);
    add(m[4], parsed.locals, m[2] !== undefined || parsed.typeOnly, false);
    body = body.replace(m[0].slice(m[1].length), " ");
  }
  for (const m of content.matchAll(/(^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    add(m[2], [], false, true);
  }
  for (const m of content.matchAll(/(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const binding = m[1];
    const locals = binding.startsWith("{")
      ? binding
          .slice(1, -1)
          .split(",")
          .map((p) => p.split(":").pop()!.trim())
          .filter(Boolean)
      : [binding];
    add(m[2], locals, false, false);
    body = body.replace(m[0], " ");
  }
  for (const m of content.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!imports.some((i) => i.specifier === m[1])) add(m[1], [], false, true);
  }
  return { imports, body };
}

function pyImports(content: string, options: IntegrityOptions): { imports: ImportInfo[]; body: string } {
  const imports: ImportInfo[] = [];
  let body = content;
  const classify = (module: string): ImportClass => {
    const top = module.replace(/^\.+/, "").split(".")[0];
    const last = module.split(".").pop() ?? module;
    if (options.productionImports.some((p) => module.startsWith(p))) return "production";
    if (!module.startsWith(".") && (PY_LIBRARIES.has(top) || top.startsWith("pytest_"))) return "library";
    if (HELPER_NAME.test(last) || HELPER_NAME.test(top) || /^tests?$/.test(top) || /^test_/.test(last)) return "helper";
    // Relative, a configured prefix, or another package that may be the project's own
    return "production";
  };

  for (const m of content.matchAll(/^[ \t]*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
    const names = m[2].replace(/[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    const locals = names.map((n) => {
      const alias = /\sas\s+(\w+)$/.exec(n);
      return alias ? alias[1] : n.split(/\s+/)[0];
    });
    const module = m[1];
    imports.push({
      specifier: module,
      target: module,
      locals: locals.filter((l) => l !== "*"),
      typeOnly: false,
      unbound: locals.includes("*"),
      cls: classify(module),
    });
    body = body.replace(m[0], " ");
  }
  for (const m of content.matchAll(/^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      const alias = /\sas\s+(\w+)$/.exec(p);
      const module = p.split(/\s+/)[0];
      imports.push({
        specifier: module,
        target: module,
        locals: [alias ? alias[1] : module.split(".")[0]],
        typeOnly: false,
        unbound: false,
        cls: classify(module),
      });
    }
    body = body.replace(m[0], " ");
  }
  return { imports, body };
}

function mockedTargets(content: string, testPath: string): Set<string> {
  const mocked = new Set<string>();
  for (const m of content.matchAll(/\b(?:vi|jest)\s*\.\s*(?:mock|doMock|unstable_mockModule)\s*\(\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    const target = spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(testPath), spec)) : spec;
    mocked.add(stripExtension(target));
  }
  return mocked;
}

function describeImport(i: ImportInfo, used: boolean, mocked: boolean): string {
  if (i.typeOnly) return `${i.specifier} (types only)`;
  if (i.cls === "library") return `${i.specifier} (test or standard library)`;
  if (i.cls === "helper") return `${i.specifier} (test helper or fake)`;
  if (mocked) return `${i.specifier} (production, replaced by a mock)`;
  if (!used) return `${i.specifier} (production, imported but never used)`;
  return i.specifier;
}

function selfAssertingFinding(
  file: IntegrityFile,
  source: { text: string; firstLine: number },
  options: IntegrityOptions,
): IntegrityFinding | null {
  const js = JS_FILE.test(file.path);
  if (!js && !PY_FILE.test(file.path)) return null;

  const rows = source.text.split(/\r?\n/);
  const assertions = rows
    .map((text, i) => ({ text, line: source.firstLine + i, kind: classifyAssertion(text) }))
    .filter((a) => a.kind !== null);
  if (assertions.length === 0) return null;

  const { imports, body } = js ? jsImports(source.text, file.path, options) : pyImports(source.text, options);
  if (imports.some((i) => i.cls === "driver")) return null;
  const mocked = js ? mockedTargets(source.text, file.path) : new Set<string>();

  const described: string[] = [];
  let exercised = false;
  for (const i of imports) {
    const isMocked = mocked.has(stripExtension(i.target));
    const used =
      i.unbound ||
      i.locals.some((local) => new RegExp(`(?<![\\w$.])${escapeRegExp(local)}(?![\\w$])`).test(body));
    if (i.cls === "production" && !i.typeOnly && used && !isMocked) {
      exercised = true;
      break;
    }
    described.push(describeImport(i, used, isMocked));
  }
  if (exercised) return null;

  const first = assertions[0];
  const importList = described.length > 0 ? described.slice(0, 6).join(", ") : "nothing";
  return {
    rule: "self-asserting-test",
    severity: "high",
    file: file.path,
    line: first.line,
    text:
      `No production code is exercised: the ${assertions.length} assertion(s) (first: \`${snippet(first.text)}\`) ` +
      `can only check values built in the test or fakes' recorded calls. Imports: ${importList}. ` +
      "Import and call the real module (if a package is the project's own, add its prefix to review.integrity.production_imports).",
  };
}

// ============ DIFF CHECKS ============

function lineOf(l: DiffLine): number | null {
  return l.newLine ?? l.oldLine;
}

function diffFindings(file: IntegrityFile, hunks: DiffHunk[]): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const removedText = new Set(removedLines(hunks).map((l) => l.text.trim()));
  const added = addedLines(hunks);
  const addedText = new Set(added.map((l) => l.text.trim()));
  // A line removed in one place and added in another is a move, not a change
  const reallyAdded = added.filter((l) => !removedText.has(l.text.trim()));

  for (const line of reallyAdded) {
    if (isComment(line.text)) continue;
    const skip = SKIPS.find((s) => s.re.test(line.text));
    if (skip) {
      findings.push({
        rule: skip.rule,
        severity: skip.rule === "skipped-test" ? "high" : "medium",
        file: file.path,
        line: line.newLine,
        text: `Adds ${skip.what}: \`${snippet(line.text)}\`. Fix the test or the code instead of skipping it.`,
      });
    }
  }

  for (let i = 0; i < reallyAdded.length; i++) {
    const text = reallyAdded[i].text;
    const next: DiffLine | undefined = reallyAdded[i + 1];
    const nextText =
      next !== undefined && next.newLine === (reallyAdded[i].newLine ?? 0) + 1 ? next.text : null;
    const swallowed =
      /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text) ||
      /\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/.test(text) ||
      /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*(?:#.*)?$/.test(text) ||
      (nextText !== null && /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(text) && /^\s*\}\s*$/.test(nextText)) ||
      (nextText !== null && /^\s*except\b[^:]*:\s*$/.test(text) && /^\s*pass\s*$/.test(nextText));
    if (swallowed) {
      findings.push({
        rule: "error-swallowed",
        severity: "medium",
        file: file.path,
        line: reallyAdded[i].newLine,
        text: `Catches and ignores errors in test code: \`${snippet(text)}\`. A swallowed error lets a broken test pass.`,
      });
    }
  }

  let removedAssertions = 0;
  let addedAssertions = 0;
  for (const block of changeBlocks(hunks)) {
    const before = block.removed
      .filter((l) => !addedText.has(l.text.trim()))
      .map((l) => ({ l, kind: classifyAssertion(l.text) }))
      .filter((a) => a.kind !== null);
    const after = block.added
      .filter((l) => !removedText.has(l.text.trim()))
      .map((l) => ({ l, kind: classifyAssertion(l.text) }))
      .filter((a) => a.kind !== null);
    removedAssertions += before.length;
    addedAssertions += after.length;
    const pairs = Math.min(before.length, after.length);
    for (let i = 0; i < pairs; i++) {
      const was = before[i];
      const now = after[i];
      if (now.kind!.strength < was.kind!.strength) {
        findings.push({
          rule: "assertion-weakened",
          severity: "high",
          file: file.path,
          line: now.l.newLine,
          text: `Weakens an assertion: \`${snippet(was.l.text)}\` became \`${snippet(now.l.text)}\` (${was.kind!.label} replaced by ${now.kind!.label}).`,
        });
        continue;
      }
      const oldTol = toleranceOf(was.l.text);
      const newTol = toleranceOf(now.l.text);
      if (
        oldTol &&
        newTol &&
        oldTol.kind === newTol.kind &&
        (oldTol.kind === "precision" ? newTol.value < oldTol.value : newTol.value > oldTol.value)
      ) {
        findings.push({
          rule: "tolerance-widened",
          severity: "medium",
          file: file.path,
          line: now.l.newLine,
          text: `Widens a tolerance: \`${snippet(was.l.text)}\` became \`${snippet(now.l.text)}\`.`,
        });
      }
    }
  }
  if (file.status !== "added" && removedAssertions > addedAssertions) {
    const firstHunk = hunks[0];
    findings.push({
      rule: "assertion-removed",
      severity: "medium",
      file: file.path,
      line: firstHunk ? firstHunk.newStart : null,
      text: `Removes assertions: ${removedAssertions} assertion line(s) removed, ${addedAssertions} added.`,
    });
  }

  const removedCases = removedLines(hunks).filter((l) => TEST_CASE.test(l.text) && !addedText.has(l.text.trim()));
  const addedCases = reallyAdded.filter((l) => TEST_CASE.test(l.text));
  if (removedCases.length > addedCases.length) {
    findings.push({
      rule: "test-removed",
      severity: "high",
      file: file.path,
      line: lineOf(removedCases[0]),
      text: `Removes test cases: ${removedCases.length} removed (first: \`${snippet(removedCases[0].text)}\`), ${addedCases.length} added.`,
    });
  }
  return findings;
}

const EXCLUSION =
  /\b(?:exclude|testPathIgnorePatterns|modulePathIgnorePatterns|coveragePathIgnorePatterns|testIgnore|ignore_glob|norecursedirs|collect_ignore|omit)\b|--ignore\b|--deselect\b|\s-k\s+["']?not\b/;
const THRESHOLD = /\b(thresholds?|branches|lines|functions|statements|fail_under|fail-under|cov-fail-under|minimum_coverage)\b["']?\s*[:=\s]\s*["']?(\d+(?:\.\d+)?)/;

function suiteFindings(file: IntegrityFile, hunks: DiffHunk[]): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const block of changeBlocks(hunks)) {
    const removedText = new Set(block.removed.map((l) => l.text.trim()));
    for (const line of block.added) {
      if (removedText.has(line.text.trim()) || isComment(line.text)) continue;
      if (EXCLUSION.test(line.text)) {
        findings.push({
          rule: "suite-loosened",
          severity: "high",
          file: file.path,
          line: line.newLine,
          text: `Adds a test exclusion or ignore entry: \`${snippet(line.text)}\`.`,
        });
      }
    }
    const thresholdsBefore = new Map<string, number>();
    for (const line of block.removed) {
      const m = THRESHOLD.exec(line.text);
      if (m) thresholdsBefore.set(m[1], Number(m[2]));
    }
    for (const line of block.added) {
      const m = THRESHOLD.exec(line.text);
      const before = m ? thresholdsBefore.get(m[1]) : undefined;
      if (m && before !== undefined && Number(m[2]) < before) {
        findings.push({
          rule: "suite-loosened",
          severity: "high",
          file: file.path,
          line: line.newLine,
          text: `Lowers a threshold: ${m[1]} from ${before} to ${m[2]}.`,
        });
      }
    }
  }
  return findings;
}

const TEST_NAMES = [
  /^\s*(?:it|test|specify)\s*(?:\.\s*\w+\s*)?\(\s*(["'`])(.+?)\1/,
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
  /^\s*func\s+(Test\w+)\s*\(/,
];

/** The names of the test cases on these lines. */
function testNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    for (const re of TEST_NAMES) {
      const m = re.exec(line);
      if (m) {
        names.push(m[m.length - 1]);
        break;
      }
    }
  }
  return names;
}

/**
 * A deleted test file blocks unless a test file this PR adds has all of its
 * test cases (a move or a rename the host didn't detect).
 */
function removedTestFinding(
  file: IntegrityFile,
  hunks: DiffHunk[],
  addedTests: { path: string; text: string }[],
): IntegrityFinding {
  const names = testNames(removedLines(hunks).map((l) => l.text));
  const home =
    names.length > 0 ? addedTests.find((t) => names.every((name) => t.text.includes(name))) : undefined;
  if (home) {
    return {
      rule: "test-removed",
      severity: "low",
      file: file.path,
      line: null,
      text: `Deletes a test file whose ${names.length} test case(s) all appear in ${home.path} (moved).`,
    };
  }
  return {
    rule: "test-removed",
    severity: "high",
    file: file.path,
    line: null,
    text:
      names.length > 0
        ? `Deletes a test file with ${names.length} test case(s) (first: ${names[0]}) that no added test file has.`
        : "Deletes a test file.",
  };
}

/**
 * Run every integrity check over a PR's changed files.
 */
export function checkTestIntegrity(files: IntegrityFile[], options: IntegrityOptions): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  // Test files this PR adds, for telling a moved test file from a deleted one
  const addedTests = files
    .filter((f) => f.status === "added" && isTestFile(f.path, options))
    .map((f) => ({
      path: f.path,
      text: f.content ?? addedLines(f.patch ? parsePatch(f.patch) : []).map((l) => l.text).join("\n"),
    }));

  for (const file of files) {
    if (options.ignore.some((g) => matchPath(g, file.path))) continue;
    const hunks = file.patch ? parsePatch(file.patch) : [];
    const perFile: IntegrityFinding[] = [];

    if (SUITE_CONFIGS.some((g) => matchPath(g, file.path))) perFile.push(...suiteFindings(file, hunks));

    const isTest =
      isTestFile(file.path, options) || (file.previousPath !== null && isTestFile(file.previousPath, options));
    if (isTest) {
      if (file.status === "removed") {
        perFile.push(removedTestFinding(file, hunks, addedTests));
      } else {
        perFile.push(...diffFindings(file, hunks));
        const source =
          file.content !== null
            ? { text: file.content, firstLine: 1 }
            : file.status === "added" && hunks.length > 0
              ? { text: addedLines(hunks).map((l) => l.text).join("\n"), firstLine: hunks[0].newStart }
              : null;
        if (source) {
          const finding = selfAssertingFinding(file, source, options);
          if (finding) perFile.push(finding);
        }
      }
    }
    findings.push(...perFile.slice(0, MAX_FINDINGS_PER_FILE));
  }
  return findings;
}
