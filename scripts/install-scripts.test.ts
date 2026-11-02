// Drives scripts/install-scripts.mjs as npm runs it: a child process, from a copy in a fixture package (the script
// works on the package it sits in, whatever the working directory). The only fake is npm itself: INSTALL_SCRIPTS_NPM
// points at a script that logs its arguments and can fail, hang or succeed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "install-scripts.mjs");

const FAKE_NPM = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_NPM_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_NPM_SLEEP)));
const failFor = (process.env.FAKE_NPM_FAIL ?? "").split(",").filter(Boolean);
process.exit(args.some((a) => failFor.includes(a)) ? 1 : 0);
`;

type LockEntry = { version: string; hasInstallScript?: boolean; optional?: boolean; os?: string[]; name?: string };

const LOCK: Record<string, LockEntry> = {
  "node_modules/better-sqlite3": { version: "12.11.1", hasInstallScript: true },
  "node_modules/esbuild": { version: "0.28.2", hasInstallScript: true },
  "node_modules/vite/node_modules/esbuild": { version: "0.21.5", hasInstallScript: true },
  "node_modules/fsevents": { version: "2.3.3", hasInstallScript: true, optional: true, os: ["darwin"] },
  "node_modules/zod": { version: "3.23.8" },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(opts: {
  npmrc?: string | null;
  allowed?: string[];
  lock?: Record<string, LockEntry>;
  installed?: string[];
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "install-scripts-"));
  dirs.push(dir);
  if (opts.npmrc !== null) writeFileSync(join(dir, ".npmrc"), opts.npmrc ?? "# policy\nignore-scripts=true\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", allowedInstallScripts: opts.allowed ?? ["better-sqlite3", "esbuild", "fsevents"] }),
  );
  writeLock(dir, opts.lock ?? LOCK);
  for (const path of opts.installed ?? []) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, "package.json"), "{}");
  }
  writeFileSync(join(dir, "fake-npm.mjs"), FAKE_NPM);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT, join(dir, "scripts", "install-scripts.mjs"));
  return dir;
}

function writeLock(dir: string, entries: Record<string, LockEntry>) {
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" }, ...entries } }),
  );
}

function run(dir: string, command: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(dir, "scripts", "install-scripts.mjs"), command], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, INSTALL_SCRIPTS_NPM: join(dir, "fake-npm.mjs"), FAKE_NPM_LOG: join(dir, "npm.log"), ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

function npmCalls(dir: string): string[][] {
  const log = join(dir, "npm.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
}

const stamp = (dir: string) => existsSync(join(dir, "node_modules", ".install-scripts-stamp"));

describe("install-scripts check", () => {
  it("passes on this repository's own .npmrc, package.json and package-lock.json", () => {
    const r = run(REPO, "check");
    expect(r.out).toContain("install-scripts: ok");
    expect(r.status).toBe(0);
  });

  it("fails when a dependency with an install script is not on the list, nested ones included", () => {
    const real = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };
    const lock = { ...real.packages, "node_modules/vite/node_modules/new-native": { version: "1.0.0", hasInstallScript: true } };
    delete (lock as Record<string, unknown>)[""];
    const dir = repo({ lock });
    const r = run(dir, "check");
    expect(r.status).toBe(1);
    expect(r.out).toContain("new-native (node_modules/vite/node_modules/new-native) has an install script");
  });

  it("names an aliased package by its real name", () => {
    const dir = repo({ lock: { ...LOCK, "node_modules/innocent": { version: "1.0.0", name: "native-thing", hasInstallScript: true } } });
    const r = run(dir, "check");
    expect(r.status).toBe(1);
    expect(r.out).toContain("native-thing (node_modules/innocent)");
  });

  it("fails when .npmrc is missing, sets ignore-scripts=false, or turns it off again later", () => {
    for (const npmrc of [null, "ignore-scripts=false\n", "ignore-scripts=true\nignore-scripts=false\n", "# ignore-scripts=true\n"]) {
      const r = run(repo({ npmrc }), "check");
      expect(r.status, String(npmrc)).toBe(1);
      expect(r.out).toContain(".npmrc must set ignore-scripts=true");
    }
  });

  it("fails when a listed package has no install script any more", () => {
    const r = run(repo({ allowed: ["better-sqlite3", "esbuild", "fsevents", "zod"] }), "check");
    expect(r.status).toBe(1);
    expect(r.out).toContain('zod is in "allowedInstallScripts" but has no install script');
  });

  it("fails on a malformed list", () => {
    const dir = repo();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ allowedInstallScripts: "better-sqlite3" }));
    expect(run(dir, "check").status).toBe(1);
  });
});

describe("install-scripts rebuild and ensure", () => {
  const LINUX = ["node_modules/better-sqlite3", "node_modules/esbuild", "node_modules/vite/node_modules/esbuild", "node_modules/zod"];
  const MAC = [...LINUX, "node_modules/fsevents"];

  it("runs exactly the listed installed packages' scripts; optional fsevents on its own, only where installed", () => {
    const mac = repo({ installed: MAC });
    expect(run(mac, "rebuild").status).toBe(0);
    expect(npmCalls(mac)).toEqual([
      ["rebuild", "--ignore-scripts=false", "better-sqlite3", "esbuild"],
      ["rebuild", "--ignore-scripts=false", "fsevents"],
    ]);
    expect(stamp(mac)).toBe(true);

    const linux = repo({ installed: LINUX });
    expect(run(linux, "rebuild").status).toBe(0);
    expect(npmCalls(linux)).toEqual([["rebuild", "--ignore-scripts=false", "better-sqlite3", "esbuild"]]);
  });

  it("ensure rebuilds once, then again only when the lockfile changes", () => {
    const dir = repo({ installed: LINUX });
    expect(run(dir, "ensure").status).toBe(0);
    expect(run(dir, "ensure").status).toBe(0);
    expect(npmCalls(dir)).toHaveLength(1);
    writeLock(dir, { ...LOCK, "node_modules/better-sqlite3": { version: "12.12.0", hasInstallScript: true } });
    expect(run(dir, "ensure").status).toBe(0);
    expect(npmCalls(dir)).toHaveLength(2);
  });

  it("a failed required build exits 1, writes no stamp, and the next ensure tries again", () => {
    const dir = repo({ installed: LINUX });
    const r = run(dir, "ensure", { FAKE_NPM_FAIL: "better-sqlite3" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("npm rebuild better-sqlite3 esbuild failed (exit code 1)");
    expect(stamp(dir)).toBe(false);
    expect(run(dir, "ensure").status).toBe(0);
    expect(npmCalls(dir)).toHaveLength(2);
  });

  it("a failed optional build is a warning, as it is for npm", () => {
    const dir = repo({ installed: MAC });
    const r = run(dir, "rebuild", { FAKE_NPM_FAIL: "fsevents" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("warning: optional fsevents did not build (exit code 1)");
  });

  it("a hung build is killed at the timeout and fails", () => {
    const dir = repo({ installed: LINUX });
    const r = run(dir, "rebuild", { FAKE_NPM_SLEEP: "20000", INSTALL_SCRIPTS_TIMEOUT_MS: "300" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("failed (timed out)");
    expect(stamp(dir)).toBe(false);
  });

  it("refuses to run before npm ci", () => {
    const r = run(repo(), "rebuild");
    expect(r.status).toBe(1);
    expect(r.out).toContain("node_modules is missing");
  });
});

describe("install-scripts wiring", () => {
  it("vitest runs ensure as its global setup", async () => {
    const config = (await import("../vite.config")).default as { test?: { globalSetup?: string | string[] } };
    expect([config.test?.globalSetup ?? []].flat()).toContain("scripts/vitest-global-setup.mjs");
    expect(readFileSync(join(REPO, "scripts", "vitest-global-setup.mjs"), "utf8")).toMatch(/^\s*ensure\(\);$/m);
  });

  it("npm run build and npm run dev run ensure first, so npm ci && npm run build gives a working install", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const name of ["build", "dev"]) {
      expect(pkg.scripts[name], name).toMatch(/^node scripts\/install-scripts\.mjs ensure && /);
    }
  });
});
