/**
 * Revert checks (src/cli/revert-checks.ts). The pure parts are tested directly; the end-to-end cases run
 * the real CLI (through tsx, as CI does) on a throwaway git repository whose tests run under the real
 * vitest (the repository's node_modules, linked), so the JSON report, the name filter, the revert and the
 * restore are all the real thing.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type VitestReport,
  clean,
  exemptionFromEvents,
  hunksTouching,
  isGuardedCode,
  judgeBaseline,
  judgeReverted,
  lineCount,
  parseBody,
  parseHunks,
  pathProblem,
  requirement,
  revertHunks,
  testNameProblem,
} from "./revert-checks";

const ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(__dirname, "revert-checks.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

describe("parseBody", () => {
  it("reads file, name and range forms, and CRLF bodies", () => {
    const body = [
      "Intro",
      "revert-check: src/a.test.ts guards src/a.ts",
      "revert-check: src/a.test.ts > suite > does a thing guards src/a.ts:12",
      "revert-check:   src/b.test.ts guards src/b.ts:3-9  ",
    ].join("\r\n");
    const parsed = parseBody(body);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.checks.map(({ testFile, testName, sourceFile, range }) => ({ testFile, testName, sourceFile, range }))).toEqual([
      { testFile: "src/a.test.ts", testName: undefined, sourceFile: "src/a.ts", range: undefined },
      { testFile: "src/a.test.ts", testName: "suite does a thing", sourceFile: "src/a.ts", range: { start: 12, end: 12 } },
      { testFile: "src/b.test.ts", testName: undefined, sourceFile: "src/b.ts", range: { start: 3, end: 9 } },
    ]);
  });

  it("ignores lines in fenced code blocks and indented lines", () => {
    const body = [
      "```",
      "revert-check: src/x.test.ts guards src/x.ts",
      "```",
      "~~~~md",
      "revert-check: src/y.test.ts guards src/y.ts",
      "```",
      "revert-check: still inside the tilde fence",
      "~~~~",
      "    revert-check: src/z.test.ts guards src/z.ts",
      "  revert-check: src/z.test.ts guards src/z.ts",
    ].join("\n");
    expect(parseBody(body)).toEqual({ checks: [], malformed: [], exemptionLines: [] });
  });

  it("an unclosed fence hides the rest of the body", () => {
    expect(parseBody("```\nrevert-check: src/a.test.ts guards src/a.ts\n").checks).toEqual([]);
  });

  it("reports malformed lines with a reason", () => {
    const parsed = parseBody(
      [
        "revert-check: src/a.test.ts src/a.ts",
        "revert-check:",
        "revert-check: src/a.test.ts guards src/a.ts:x",
        "revert-check: src/a.test.ts guards src/a.ts:0",
        "revert-check: src/a.test.ts guards src/a.ts:9-3",
        "revert-check: src/a test.ts guards src/a.ts",
      ].join("\n"),
    );
    expect(parsed.checks).toEqual([]);
    expect(parsed.malformed).toHaveLength(6);
    expect(parsed.malformed[3].reason).toContain("bad line range");
  });

  it("collects body exemption lines without treating them as checks", () => {
    const parsed = parseBody("no revert-check: trivial\nRevert-Check-Exempt: infra\n");
    expect(parsed.checks).toEqual([]);
    expect(parsed.exemptionLines).toHaveLength(2);
  });
});

describe("input validation", () => {
  it("rejects option-like, absolute and escaping paths", () => {
    expect(pathProblem("src/a.ts")).toBeNull();
    expect(pathProblem(".github/x.ts")).toBeNull();
    expect(pathProblem("-t")).toContain("'-'");
    expect(pathProblem("--root=x")).toContain("'-'");
    expect(pathProblem("/etc/passwd")).toContain("relative");
    expect(pathProblem("C:/x.ts")).toContain("relative");
    expect(pathProblem("src\\a.ts")).toContain("relative");
    expect(pathProblem("../x.ts")).toContain("'..'");
    expect(pathProblem("src/../../x.ts")).toContain("'..'");
    expect(pathProblem("src//a.ts")).toContain("empty");
    expect(pathProblem("src/a.ts;rm")).toContain("only letters");
    expect(pathProblem("src/$(x).ts")).toContain("only letters");
  });

  it("rejects test names that start with '-' or carry control characters", () => {
    expect(testNameProblem("clamps a value")).toBeNull();
    expect(testNameProblem("-t")).toContain("'-'");
    expect(testNameProblem("--root=/x")).toContain("'-'");
    expect(testNameProblem("a\u0007b")).toContain("control");
    expect(testNameProblem("x".repeat(201))).toContain("longer");
  });

  it("clean() neutralises control characters in printed PR text", () => {
    expect(clean("a\u001b[31mb\nc")).toBe("a?[31mb?c");
  });
});

describe("requirement (the coverage rule)", () => {
  const code = ["src/server/x.ts"];
  const req = (title: string, changedFiles = code, exempt = false) => requirement({ mode: "auto", title, changedFiles, exempt });

  it("fix and feat titles that change code need lines, in every conventional spelling", () => {
    for (const title of ["fix: a", "fix(scope): a", "feat!: a", "feat(scope)!: a", "FIX: a", "security: a"]) {
      expect(req(title).required, title).toBe(true);
    }
  });

  it("a title that is not conventional counts as a behaviour change", () => {
    expect(req("Fix the thing").required).toBe(true);
    expect(req("Fix the thing").reason).toContain("not a conventional");
    expect(req("").required).toBe(true);
  });

  it("non-behaviour types need none", () => {
    for (const type of ["build", "chore", "ci", "docs", "perf", "refactor", "revert", "style", "test"]) {
      expect(req(`${type}(x): y`).required, type).toBe(false);
    }
  });

  it("only code under src/ and scripts/ counts; tests, fixtures and docs do not", () => {
    expect(req("fix: a", ["src/client/App.tsx"]).required).toBe(true);
    expect(req("fix: a", ["scripts/build.sh"]).required).toBe(true);
    expect(req("fix: a", ["src/server/x.test.ts", "src/server/testing/fake.ts", "docs/a.md", "README.md", "fixtures/a.json"]).required).toBe(false);
    expect(isGuardedCode("src/shared/types.ts")).toBe(true);
    expect(isGuardedCode("src/server/__tests__/x.ts")).toBe(false);
    expect(isGuardedCode("src/server/data.json")).toBe(false);
    expect(isGuardedCode("brain-trainer/train.py")).toBe(false);
    expect(isGuardedCode("srcx/a.ts")).toBe(false);
  });

  it("the code paths are configurable", () => {
    const only = (changedFiles: string[]) => requirement({ mode: "auto", title: "fix: a", changedFiles, exempt: false, codePaths: ["src/server/"] });
    expect(only(["src/client/App.tsx"])).toEqual({ required: false, reason: "the PR changes no code under src/server/ (tests, fixtures and docs do not count)" });
    expect(only(["src/server/x.ts"]).required).toBe(true);
  });

  it("the owner's label lifts it; modes always and never override the rule", () => {
    expect(req("fix: a", code, true)).toEqual({ required: false, reason: "the owner set the exemption label" });
    expect(requirement({ mode: "always", title: "docs: a", changedFiles: [], exempt: false }).required).toBe(true);
    expect(requirement({ mode: "never", title: "fix: a", changedFiles: code, exempt: false }).required).toBe(false);
  });
});

describe("exemptionFromEvents", () => {
  const ev = (event: string, actor: string, label = "revert-check-exempt") => JSON.stringify({ event, label, actor });

  it("exempt only while the label is on and the last labeling actor is allowed", () => {
    expect(exemptionFromEvents(ev("labeled", "owner"), "revert-check-exempt", ["owner"]).exempt).toBe(true);
    expect(exemptionFromEvents(ev("labeled", "Owner"), "Revert-Check-Exempt", ["owner"]).exempt).toBe(true);
    expect(exemptionFromEvents(ev("labeled", "someone"), "revert-check-exempt", ["owner"])).toEqual({
      exempt: false,
      reason: "the 'revert-check-exempt' label was set by 'someone', who may not grant exemptions",
    });
    expect(exemptionFromEvents([ev("labeled", "owner"), ev("unlabeled", "owner")].join("\n"), "revert-check-exempt", ["owner"]).exempt).toBe(false);
    expect(exemptionFromEvents([ev("labeled", "owner"), ev("unlabeled", "x"), ev("labeled", "x")].join("\n"), "revert-check-exempt", ["owner"]).exempt).toBe(false);
    expect(exemptionFromEvents([ev("labeled", "x"), ev("unlabeled", "x"), ev("labeled", "owner")].join("\n"), "revert-check-exempt", ["owner"]).exempt).toBe(true);
    expect(exemptionFromEvents(ev("labeled", "owner", "other"), "revert-check-exempt", ["owner"]).exempt).toBe(false);
  });

  it("no allowed actors, an empty history or unreadable lines never exempt", () => {
    expect(exemptionFromEvents(ev("labeled", "owner"), "revert-check-exempt", [""]).exempt).toBe(false);
    expect(exemptionFromEvents("", "revert-check-exempt", ["owner"]).exempt).toBe(false);
    expect(exemptionFromEvents(`${ev("labeled", "owner")}\nnot json`, "revert-check-exempt", ["owner"]).exempt).toBe(false);
    expect(exemptionFromEvents(JSON.stringify({ event: "labeled", label: "revert-check-exempt" }), "revert-check-exempt", ["owner"]).exempt).toBe(false);
  });
});

describe("line-range revert", () => {
  // The PR adds two header lines (shifting everything) and changes one body line
  const base = "a\nb\nc\nd\n";
  const current = "h1\nh2\na\nb\nC\nd\n";
  const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+h1\n+h2\n@@ -3 +5 @@\n-c\n+C\n";

  it("maps the range through the PR's hunks instead of reusing the line numbers in the base", () => {
    const hunks = parseHunks(diff);
    expect(hunks).toEqual([
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
      { oldStart: 3, oldCount: 1, newStart: 5, newCount: 1 },
    ]);
    const touching = hunksTouching(hunks, { start: 5, end: 5 });
    expect(touching).toEqual([hunks[1]]);
    expect(revertHunks(base, current, touching)).toBe("h1\nh2\na\nb\nc\nd\n");
    expect(revertHunks(base, current, hunksTouching(hunks, { start: 1, end: 2 }))).toBe("a\nb\nC\nd\n");
    expect(revertHunks(base, current, hunks)).toBe(base);
  });

  it("a range with no change of the PR selects nothing", () => {
    expect(hunksTouching(parseHunks(diff), { start: 3, end: 4 })).toEqual([]);
  });

  it("pure deletions next to the range are put back", () => {
    const d = parseHunks("@@ -2,2 +1,0 @@\n-b\n-c\n");
    expect(hunksTouching(d, { start: 2, end: 2 })).toEqual(d);
    expect(revertHunks("a\nb\nc\nd\n", "a\nd\n", d)).toBe("a\nb\nc\nd\n");
  });

  it("counts lines with and without a final newline", () => {
    expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb")]).toEqual([0, 1, 1, 2]);
  });
});

describe("judging vitest runs", () => {
  const file = "/repo/src/a.test.ts";
  const report = (statuses: string[], message = "", name = file): VitestReport => ({
    numFailedTests: statuses.filter((s) => s === "failed").length,
    testResults: [{ name, message, assertionResults: statuses.map((status) => ({ status })) }],
  });
  const run = (r?: VitestReport, extra: Partial<{ timedOut: boolean; exitCode: number | null }> = {}) => ({
    timedOut: false,
    exitCode: r && r.numFailedTests > 0 ? 1 : 0,
    report: r,
    ...extra,
  });

  it("the baseline must run at least one test and pass", () => {
    expect(judgeBaseline(run(report(["passed", "skipped"])), file).ok).toBe(true);
    // vitest 1.x counts skipped tests as passed: a name that matches nothing has only skipped tests
    expect(judgeBaseline(run(report(["skipped", "skipped"])), file, "nope").detail).toContain("no matching test");
    expect(judgeBaseline(run(report(["passed", "failed"])), file).detail).toContain("before anything is reverted");
    expect(judgeBaseline(run(report([], "Failed to load url ./x")), file).detail).toContain("fails to load");
    expect(judgeBaseline(run(report(["passed"]), { exitCode: 1 }), file).ok).toBe(false);
  });

  it("the reverted run must have a failing test; a crash, an empty run or a pass is a failure", () => {
    expect(judgeReverted(run(report(["failed", "passed"])), file).ok).toBe(true);
    const crash = judgeReverted(run(report([], "Failed to load url ./missing")), file);
    expect(crash.ok).toBe(false);
    expect(crash.detail).toContain("crashed when reverted");
    expect(judgeReverted(run(report(["skipped"])), file, "x").detail).toContain("no matching test");
    expect(judgeReverted(run(report(["passed"])), file).detail).toContain("still passes");
  });

  it("a timeout, a missing report or a run of other files is a failure", () => {
    for (const judge of [judgeBaseline, judgeReverted]) {
      expect(judge(run(report(["failed"]), { timedOut: true }), file).detail).toContain("timed out");
      expect(judge({ timedOut: false, exitCode: 1, reportError: "no report file" }, file).detail).toContain("no report");
      const widened = { numFailedTests: 1, testResults: [report(["failed"]).testResults[0], { name: "/repo/src/b.test.ts", assertionResults: [] }] };
      expect(judge(run(widened), file).detail).toContain("other test files");
    }
  });
});

// ---- End to end: the real CLI on a throwaway repository with real vitest ----

const CALC_BASE = `export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(n: number, _lo: number, _hi: number): number {
  return n;
}
`;
// Two header lines shift every line; clamp's body (line 8 here, line 6 on the base) changes
const CALC_PR = `// Arithmetic helpers
// for the revert-check fixture
export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
`;
const CALC_TEST = `import { describe, expect, it } from "vitest";
import { add, clamp } from "./calc";

describe("clamp", () => {
  it("keeps a value inside the bounds", () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-1, 0, 10)).toBe(0);
  });
});

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
`;

let repo = "";
let scratch = "";
let bodies = 0;

function sh(cwd: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
}

function write(rel: string, text: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function commit(message: string): void {
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("VITEST") && k !== "GITHUB_OUTPUT" && k !== "NODE_ENV" && k !== "TEST") env[k] = v;
  }
  return { ...env, NO_COLOR: "1", ...extra };
}

/** Runs the CLI as CI does: tsx src/cli/revert-checks.ts [options] <body file> base */
function cli(body: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string> } = {}): { code: number | null; out: string } {
  const bodyFile = join(scratch, `body-${++bodies}.md`);
  writeFileSync(bodyFile, body);
  const r = spawnSync(TSX, [SCRIPT, ...args, bodyFile, "base"], {
    cwd: opts.cwd ?? repo,
    env: childEnv(opts.env),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function expectCleanTree(): void {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  expect(r.stdout).toBe("");
  expect(readFileSync(join(repo, "src/calc.ts"), "utf8")).toBe(CALC_PR);
}

describe("revert-checks CLI end to end", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "revert-checks-scratch-"));
    repo = mkdtempSync(join(tmpdir(), "revert-checks-repo-"));
    sh(repo, "git", ["init", "-q"]);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    write(".gitignore", "node_modules\n.cache\n");
    write("package.json", JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "vitest run" } }));
    write("vitest.config.mjs", 'export default { cacheDir: ".cache" };\n');
    write("src/calc.ts", CALC_BASE);
    write("src/calc.test.ts", CALC_TEST.replace(/describe\("clamp"[\s\S]*?\n}\);\n\n/, ""));
    write("src/same.ts", "export const same = 1;\n");
    write("src/same.test.ts", 'import { expect, it } from "vitest";\nimport { same } from "./same";\nit("is one", () => expect(same).toBe(1));\n');
    // The base version fails to load: reverting to it crashes the test file instead of failing a test
    write("src/loader.ts", 'import "./missing-module";\nexport const value = 1;\n');
    commit("base");
    sh(repo, "git", ["branch", "base"]);
    write("src/calc.ts", CALC_PR);
    write("src/calc.test.ts", CALC_TEST);
    write("src/loader.ts", "export const value = 2;\n");
    write("src/loader.test.ts", 'import { expect, it } from "vitest";\nimport { value } from "./loader";\nit("is two", () => expect(value).toBe(2));\n');
    write("src/fresh.ts", "export const fresh = true;\n");
    write("src/fresh.test.ts", 'import { expect, it } from "vitest";\nimport { fresh } from "./fresh";\nit("is fresh", () => expect(fresh).toBe(true));\n');
    write("src/broken.test.ts", 'import { expect, it } from "vitest";\nimport { add } from "./calc";\nit("is wrong", () => expect(add(2, 2)).toBe(5));\n');
    write("src/slow.test.ts", 'import { it } from "vitest";\nimport "./calc";\nit("waits", async () => { await new Promise((r) => setTimeout(r, 30_000)); }, 60_000);\n');
    commit("pr");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("passes when the test fails with the change reverted (CRLF body)", () => {
    const r = cli("Fixes clamp.\r\nrevert-check: src/calc.test.ts guards src/calc.ts\r\n", ["--title=fix(calc): clamp"]);
    expect(r.out).toContain("1 line(s) in the PR body; required: yes");
    expect(r.out).toContain("PASS passes on the PR's code (2 passing); fails with the change reverted (1 failing)");
    expect(r.code).toBe(0);
    expectCleanTree();
  }, 120_000);

  it("fails when the named test still passes with the change reverted", () => {
    const r = cli("revert-check: src/calc.test.ts > add > adds two numbers guards src/calc.ts\n");
    expect(r.out).toContain("the test still passes with the change reverted");
    expect(r.code).toBe(1);
    expectCleanTree();
  }, 120_000);

  it("a line range reverts only the PR's hunk at that line of the PR's version (run from a subdirectory)", () => {
    const r = cli("revert-check: src/calc.test.ts > clamp guards src/calc.ts:8\n", [], { cwd: join(repo, "src") });
    expect(r.out).toContain("reverted 1 changed hunk(s) touching lines 8-8");
    expect(r.out).toContain("PASS");
    expect(r.code).toBe(0);
    expectCleanTree();
  }, 120_000);

  it("a range over a hunk the test does not depend on fails", () => {
    const r = cli("revert-check: src/calc.test.ts > clamp guards src/calc.ts:1-2\n");
    expect(r.out).toContain("still passes");
    expect(r.code).toBe(1);
    expectCleanTree();
  }, 120_000);

  it("an import crash on the reverted code is a failure, not a pass", () => {
    const r = cli("revert-check: src/loader.test.ts guards src/loader.ts\n");
    expect(r.out).toContain("crashed when reverted");
    expect(r.out).toContain("missing-module");
    expect(r.code).toBe(1);
    expect(readFileSync(join(repo, "src/loader.ts"), "utf8")).toBe("export const value = 2;\n");
    expectCleanTree();
  }, 120_000);

  it("a test name that matches nothing is a failure", () => {
    const r = cli("revert-check: src/calc.test.ts > no such test guards src/calc.ts\n");
    expect(r.out).toContain("no matching test");
    expect(r.code).toBe(1);
    expectCleanTree();
  }, 120_000);

  it("a test that already fails on the PR's code is a failure", () => {
    const r = cli("revert-check: src/broken.test.ts guards src/calc.ts\n");
    expect(r.out).toContain("fails on the PR's code before anything is reverted");
    expect(r.code).toBe(1);
    expectCleanTree();
  }, 120_000);

  it("a run over the time limit is killed and is a failure", () => {
    const started = Date.now();
    const r = cli("revert-check: src/slow.test.ts guards src/calc.ts\n", ["--timeout=3"]);
    expect(r.out).toContain("timed out");
    expect(r.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(25_000);
    expectCleanTree();
  }, 120_000);

  it("refuses a file that is new in the PR and never deletes it", () => {
    const r = cli("revert-check: src/fresh.test.ts guards src/fresh.ts\n");
    expect(r.out).toContain("is new in this PR");
    expect(r.code).toBe(2);
    expect(existsSync(join(repo, "src/fresh.ts"))).toBe(true);
  }, 60_000);

  it("an empty revert is refused: an unchanged file, or a range with no change", () => {
    const same = cli("revert-check: src/same.test.ts guards src/same.ts\n");
    expect(same.out).toContain("nothing to revert");
    expect(same.code).toBe(2);
    const range = cli("revert-check: src/calc.test.ts guards src/calc.ts:4\n");
    expect(range.out).toContain("contain no change of this PR");
    expect(range.code).toBe(2);
    const past = cli("revert-check: src/calc.test.ts guards src/calc.ts:8-99\n");
    expect(past.out).toContain("past the end");
    expect(past.code).toBe(2);
  }, 60_000);

  it("refuses option-like, escaping and non-test paths before touching anything", () => {
    const outside = join(scratch, "outside.ts");
    writeFileSync(outside, "keep\n");
    const cases: [string, string][] = [
      ["revert-check: src/calc.test.ts > --root=/tmp guards src/calc.ts", "starts with '-'"],
      ["revert-check: -t guards src/calc.ts", "starts with '-'"],
      ["revert-check: src/calc.test.ts guards -x.ts", "starts with '-'"],
      [`revert-check: src/calc.test.ts guards ../${outside.split("/").pop()}`, "'..'"],
      [`revert-check: src/calc.test.ts guards ${outside}`, "relative"],
      ["revert-check: src/calc.ts guards src/calc.ts", "not a test file"],
      ["revert-check: src/calc.test.ts guards src/calc.test.ts", "cannot guard itself"],
      ["revert-check: src/nope.test.ts guards src/calc.ts", "does not exist"],
    ];
    for (const [line, reason] of cases) {
      const r = cli(`${line}\n`);
      expect(r.out, line).toContain(reason);
      expect(r.code, line).toBe(2);
    }
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
    expectCleanTree();
  }, 60_000);

  it("required lines: zero (fenced examples only) is exit 2, and a body line cannot exempt", () => {
    const fenced = cli("```\nrevert-check: src/calc.test.ts guards src/calc.ts\n```\n", ["--title=fix(calc): clamp"]);
    expect(fenced.out).toContain("0 line(s) in the PR body; required: yes");
    expect(fenced.code).toBe(2);
    const bodyExempt = cli("no revert-check: trivial\nrevert-check-exempt: trust me\n", ["--title=feat: x"]);
    expect(bodyExempt.out).toContain("a body line does not exempt a PR");
    expect(bodyExempt.code).toBe(2);
    expect(cli("", ["--title=Fix clamp"]).code).toBe(2);
    expect(cli("", ["--title=chore: tidy"]).code).toBe(0);
  }, 60_000);

  it("only the owner's label exempts", () => {
    const events = join(scratch, "events.ndjson");
    const args = ["--title=fix(calc): clamp", "--exempt-actors=owner", `--label-events=${events}`];
    writeFileSync(events, `${JSON.stringify({ event: "labeled", label: "revert-check-exempt", actor: "owner" })}\n`);
    const ok = cli("", args);
    expect(ok.out).toContain("'owner' set the 'revert-check-exempt' label");
    expect(ok.code).toBe(0);
    writeFileSync(events, `${JSON.stringify({ event: "labeled", label: "revert-check-exempt", actor: "author" })}\n`);
    expect(cli("", args).code).toBe(2);
    expect(cli("", [...args.slice(0, 2), `--label-events=${join(scratch, "missing.ndjson")}`]).code).toBe(2);
  }, 60_000);

  it("--count prints and exports the parsed count without running anything", () => {
    const out = join(scratch, "github-output");
    writeFileSync(out, "");
    const r = cli("```\nrevert-check: a.test.ts guards b.ts\n```\nrevert-check: src/calc.test.ts guards src/calc.ts\n", ["--count", "--title=fix: x"], {
      env: { GITHUB_OUTPUT: out },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("count=1\nrequired=true\n");
    expect(r.out).not.toContain("PASS");
  }, 60_000);

  it("malformed lines, too many lines, bad options and a bad base are exit 2", () => {
    expect(cli("revert-check: src/calc.test.ts src/calc.ts\n").code).toBe(2);
    const many = Array.from({ length: 11 }, () => "revert-check: src/calc.test.ts guards src/calc.ts").join("\n");
    const tooMany = cli(many);
    expect(tooMany.out).toContain("too many revert-check lines: 11 (at most 10)");
    expect(tooMany.code).toBe(2);
    expect(cli("", ["--bogus"]).code).toBe(2);
    expect(cli("", ["--timeout=0"]).code).toBe(2);
    expect(cli("", ["--require=sometimes"]).code).toBe(2);
    expect(cli("", ["--code-paths=../x/"]).code).toBe(2);
    expect(cli("", ["--title=fix: x", "--code-paths=lib/"]).out).toContain("required: no (the PR changes no code under lib/");
    const r = spawnSync(TSX, [SCRIPT, join(scratch, "none.md"), "--", "-x"], { cwd: repo, env: childEnv(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expectCleanTree();
  }, 60_000);
});
