/**
 * The genericity guard: what it flags, what it lets through, and how it fails.
 *
 * The checks are tested in-process; the command (exit codes, CI rules, the
 * git file list, the baseline and commit messages) is run as CI runs it, on a
 * real git repository in a temp folder. Fixture paths and addresses are built
 * at run time, so the guard's own scan of this file has nothing to flag.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  baselineKey,
  checkText,
  GuardError,
  isAllowedEmail,
  loadDenylist,
  normalizeName,
  parseArgs,
  parseDenylist,
  sha256,
  type Violation,
} from "./check-generic.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-generic.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const CLI_TIMEOUT_MS = 60_000;

/** A home folder, built so this file holds none: home("Users", "alice") */
const home = (root: "Users" | "home", name: string) => ["", root, name].join("/");
const mail = (local: string, domain: string) => [local, domain].join("@");

const kinds = (violations: Violation[]) => violations.map((v) => `${v.kind}:${v.shown}`);
const check = (text: string, denylist: string | null = null) => checkText("f.ts", text, denylist === null ? null : parseDenylist(denylist)).violations;

describe("home paths", () => {
  it("flags macOS, Linux, /var/home and Windows home folders", () => {
    const windows = ["C:", "Users", "dave"].join("\\");
    const escaped = ["C:", "Users", "erin"].join("\\\\");
    const text = [
      `const a = "${home("Users", "alice")}/project";`,
      `const b = '${home("home", "bob")}/app';`,
      `cd /var${home("home", "carol")}`,
      `${windows}\\repo and "${escaped}\\\\repo"`,
      // Only the exact placeholder is one: "user-alice" names someone
      `${home("home", "user")}-alice/x`,
    ].join("\n");
    expect(kinds(check(text))).toEqual([
      `home-path:${home("Users", "alice")}`,
      `home-path:${home("home", "bob")}`,
      `home-path:/var${home("home", "carol")}`,
      `home-path:${windows}`,
      `home-path:${escaped}`,
      `home-path:${home("home", "user")}-alice`,
    ]);
  });

  it("lets the placeholders through, and a URL's /home is not a home folder", () => {
    const text = [
      `${home("home", "user")}/project`,
      `${home("Users", "user")}/project`,
      `${home("Users", "Shared")}/cache`,
      "https://example.com/home/about",
      "~/project and $HOME/project",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });
});

describe("email addresses", () => {
  it("allows only reserved domains, GitHub's noreply addresses and git's SSH user, compared exactly", () => {
    for (const ok of [
      mail("someone", "example.com"),
      mail("pass", "ntfy.example.com"),
      mail("builder", "laptop.example"),
      mail("x", "host.test"),
      mail("x", "spoof.invalid"),
      mail("123+user", "users.noreply.github.com"),
      mail("noreply", "github.com"),
      mail("git", "github.com"),
    ]) {
      expect(isAllowedEmail(ok), ok).toBe(true);
    }
    for (const bad of [
      mail("x-noreply", "corp.com"),
      mail("noreply", "corp.com"),
      mail("someone", "test.com"),
      mail("agents", "example.com.evil"),
      mail("someone", "users.noreply.github.com.evil"),
      mail("git", "corp.com"),
    ]) {
      expect(isAllowedEmail(bad), bad).toBe(false);
    }
  });

  it("finds addresses in text, and a decorator or a package version is not one", () => {
    const text = [`contact ${mail("john.doe", "company.com")} now`, "+@pytest.mark.skip(reason='x')", "vitest@3.2.4 and @types/node"].join("\n");
    expect(kinds(check(text))).toEqual([`email:${mail("john.doe", "company.com")}`]);
  });
});

describe("the denylist", () => {
  it("is names or sha256 hashes, one per line, with comments; a name too short to be one is refused", () => {
    const list = parseDenylist(`# private names\nAcme Corp\n\nsha256:${sha256("zedcorp")}\n${sha256("quux")}\n`);
    expect([...list.names]).toEqual([["acmecorp", 1]]);
    expect([...list.hashes.values()]).toEqual([2, 3]);
    expect(list.size).toBe(3);
    expect(normalizeName("Acme-Corp_ API")).toBe("acmecorpapi");
    expect(() => parseDenylist("ok-name\nab\n")).toThrow(GuardError);
  });

  it("matches a name in any case and spacing, inside compound identifiers and longer words", () => {
    const lines = ["acme corp", "acme-corp", "ACME_CORP", "AcmeCorpClient", "const acmeCorpApi = 1", "theacmecorpapi", "Acme\tCorp"];
    for (const line of lines) expect(kinds(check(line, "Acme Corp")), line).toEqual(["denylisted-name:entry 1"]);
    expect(check("acme and corp are fine apart: acme. corporate", "Acme Corp").map((v) => v.kind)).toEqual([]);
  });

  it("matches a short name only as a whole part, and a hashed name as a part or run of parts", () => {
    expect(kinds(check("zed-api ZedClient", "zed"))).toEqual(["denylisted-name:entry 1"]);
    expect(check("zedonk and blazed", "zed")).toEqual([]);
    const hashed = `sha256:${sha256("acmecorp")}`;
    expect(kinds(check("new AcmeCorpClient()", hashed))).toEqual(["denylisted-name:entry 1"]);
    expect(kinds(check("acme_corp", hashed))).toEqual(["denylisted-name:entry 1"]);
  });

  it("reports the entry number with its column, never the name", () => {
    const [v] = check("  see AcmeCorp here", "first-name\nAcme Corp");
    expect(v).toMatchObject({ kind: "denylisted-name", line: 1, column: 7, shown: "entry 2" });
    expect(JSON.stringify(v)).not.toMatch(/acme/i);
  });

  it("comes from GENERIC_DENYLIST, else .generic-denylist; under CI none or an empty one is an error", () => {
    const root = mkdtempSync(join(tmpdir(), "generic-guard-denylist-"));
    try {
      expect(loadDenylist(root, {})).toBeNull();
      expect(() => loadDenylist(root, { CI: "true" })).toThrow(/GENERIC_DENYLIST repository secret/);
      expect(() => loadDenylist(root, { CI: "1", GENERIC_DENYLIST: "  \n" })).toThrow(GuardError);
      writeFileSync(join(root, ".generic-denylist"), "# only a comment\n");
      expect(() => loadDenylist(root, { CI: "true" })).toThrow(GuardError);
      expect(loadDenylist(root, { CI: "false" })).toBeNull();
      writeFileSync(join(root, ".generic-denylist"), "file-name\n");
      expect(loadDenylist(root, { CI: "true" })).toMatchObject({ source: ".generic-denylist", list: { size: 1 } });
      expect(loadDenylist(root, { CI: "true", GENERIC_DENYLIST: "env-name\nother-name" })).toMatchObject({
        source: "the GENERIC_DENYLIST variable",
        list: { size: 2 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("generic-ignore and the baseline key", () => {
  it("a generic-ignore marker with a reason skips its line and is counted; the docs' placeholder is not a marker", () => {
    const path = home("Users", "alice");
    const marker = "generic-ignore";
    const result = checkText("f.md", `${path} <!-- ${marker}: quoting a bug report -->\n${path} ${marker}: <reason>\n`, null);
    expect(result.ignoredLines).toBe(1);
    expect(result.violations.map((v) => v.line)).toEqual([2]);
  });

  it("keys on file, kind and the matched text, so a line moving keeps its key", () => {
    const path = home("Users", "alice");
    const [before] = checkText("docs/a.md", `${path}\n`, null).violations;
    const [after] = checkText("docs/a.md", `new line\n\nx ${path}\n`, null).violations;
    expect(after.line).not.toBe(before.line);
    expect(baselineKey(after)).toBe(baselineKey(before));
    expect(baselineKey(before)).not.toContain("alice");
  });

  it("takes only the options it knows, each with its value", () => {
    expect(parseArgs(["--base-ref", "abc", "--commits", "a..b", "--update-baseline"])).toEqual({
      updateBaseline: true,
      baseRef: "abc",
      commits: "a..b",
    });
    expect(() => parseArgs(["--base-ref"])).toThrow(GuardError);
    expect(() => parseArgs(["--bogus"])).toThrow(GuardError);
  });
});

// ============ THE COMMAND ============

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", `user.email=${mail("test", "example.com")}`, "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf-8",
    timeout: 30_000,
  });
}

/** A git repository with these files, committed */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "generic-guard-"));
  roots.push(root);
  git(root, "init", "-q");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "start");
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The guard as CI runs it: its own process, its exit code and output */
function guard(root: string, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const base = { ...process.env };
  delete base.CI;
  delete base.GENERIC_DENYLIST;
  try {
    const out = execFileSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
      cwd: root,
      encoding: "utf-8",
      env: { ...base, ...env },
      timeout: CLI_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status: number | null; signal: string | null; stdout?: string; stderr?: string };
    if (e.status === null) throw new Error(`the guard did not finish (${e.signal ?? "no exit code"})`);
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const CLI = { timeout: 120_000 };

describe("the command", () => {
  it("passes a clean repository and says what it checked, the denylist's size and source", CLI, () => {
    const root = repo({ "src/a.ts": "export const x = 1;\n", "README.md": "# Project\n" });
    const { code, out } = guard(root, [], { CI: "true", GENERIC_DENYLIST: "acme corp\nzed-co" });
    expect(code).toBe(0);
    expect(out).toContain("Checked 2 files");
    expect(out).toContain("denylist: 2 entries, from the GENERIC_DENYLIST variable");
    expect(out).toContain("No private details found");
  });

  it("fails under CI with no denylist (exit 2), and says names are unchecked when run locally without one", CLI, () => {
    const root = repo({ "src/a.ts": "export const x = 1;\n" });
    const ci = guard(root, [], { CI: "true" });
    expect(ci.code).toBe(2);
    expect(ci.out).toContain("GENERIC_DENYLIST");
    expect(ci.out).not.toContain("No private details found");
    const local = guard(root);
    expect(local.code).toBe(0);
    expect(local.out).toContain("denylist: none, so names are NOT checked");
  });

  it("reads every tracked file (README, scripts, a Python file, CI config), not only src and docs", CLI, () => {
    const root = repo({
      "README.md": `Clone into ${home("Users", "alice")}/code\n`,
      "scripts/run.sh": `echo ${mail("ops", "company.com")}\n`,
      "trainer/train.py": "# trained for AcmeCorp\n",
      ".github/workflows/ci.yml": `path: ${home("home", "bob")}/x\n`,
      "src/ok.ts": "export {};\n",
    });
    const { code, out } = guard(root, [], { GENERIC_DENYLIST: "Acme Corp" });
    expect(code).toBe(1);
    expect(out).toContain(`README.md:1:12`);
    expect(out).toContain(`scripts/run.sh:1:6`);
    expect(out).toContain(`trainer/train.py:1:15`);
    expect(out).toContain(`.github/workflows/ci.yml:1:7`);
    expect(out).toContain("Denylisted name: entry 1");
    expect(out).not.toMatch(/acme/i);
    expect(out).toContain("Found 4 violation(s)");
  });

  it("skips binary files and never follows a symbolic link", CLI, () => {
    const outside = mkdtempSync(join(tmpdir(), "generic-guard-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "leak.txt"), `${home("Users", "alice")}\n`);
    const root = repo({ "src/a.ts": "export {};\n" });
    writeFileSync(join(root, "image.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(home("Users", "alice"))]));
    symlinkSync(join(outside, "leak.txt"), join(root, "link.txt"));
    git(root, "add", "-A");
    const { code, out } = guard(root);
    expect(out).toContain("Checked 1 files");
    expect(code).toBe(0);
  });

  it("fails with exit 2 when there is nothing to check or the folder isn't a git work tree", CLI, () => {
    const empty = repo({});
    expect(guard(empty)).toMatchObject({ code: 2, out: expect.stringContaining("no files to check") });
    const plain = mkdtempSync(join(tmpdir(), "generic-guard-plain-"));
    roots.push(plain);
    writeFileSync(join(plain, "a.ts"), "export {};\n");
    expect(guard(plain)).toMatchObject({ code: 2, out: expect.stringContaining("git ls-files") });
  });

  it("refuses a committed denylist (exit 2): it would publish the private names", CLI, () => {
    const root = repo({ "src/a.ts": "export {};\n", ".generic-denylist": "acme corp\n" });
    expect(guard(root)).toMatchObject({ code: 2, out: expect.stringContaining("is tracked by git") });
  });

  it("checks commit messages in a range", CLI, () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, { "src/b.ts": "export {};\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `fix: paths\n\nTested in ${home("Users", "alice")}/repo`);
    const sha = git(root, "rev-parse", "HEAD").trim();
    const { code, out } = guard(root, ["--commits", `${base}..HEAD`]);
    expect(code).toBe(1);
    expect(out).toContain("and 1 commit messages");
    expect(out).toContain(`commit ${sha.slice(0, 12)}:3:11`);
  });

  it("the baseline: holds known items across line moves, may not grow against the base ref, and fails on stale entries", CLI, () => {
    const leak = `${home("Users", "alice")}/x`;
    const root = repo({ "docs/a.md": `${leak}\n` });
    // A baseline that grows against the base ref fails, though it lists everything found
    expect(guard(root, ["--update-baseline"]).code).toBe(0);
    expect(guard(root).code).toBe(0);
    const grew = guard(root, ["--base-ref", "HEAD"]);
    expect(grew.code).toBe(1);
    expect(grew.out).toContain(".generic-baseline grew against HEAD");
    expect(grew.out).toContain("docs/a.md home-path");

    // Committed, it is the base: lines moving keep it passing; a second leak in the file is new
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "baseline");
    write(root, { "docs/a.md": `intro\n\n${leak}\n` });
    expect(guard(root, ["--base-ref", "HEAD"]).code).toBe(0);
    write(root, { "docs/a.md": `intro\n\n${leak}\n${home("Users", "bob")}\n` });
    const fresh = guard(root, ["--base-ref", "HEAD"]);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain("docs/a.md:4:1");

    // Fixed, the entry is stale: it would hide the same text coming back
    write(root, { "docs/a.md": "intro\n" });
    const stale = guard(root, ["--base-ref", "HEAD"]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("entries match nothing any more");
  });

  it("never baselines a denylisted name", CLI, () => {
    const root = repo({ "docs/a.md": "AcmeCorp\n" });
    const { code, out } = guard(root, ["--update-baseline"], { GENERIC_DENYLIST: "acme corp" });
    expect(code).toBe(1);
    expect(out).toContain("Wrote 0 entries");
    expect(out).toContain("not baselined (fix it): docs/a.md:1:1 Denylisted name: entry 1");
  });
});
