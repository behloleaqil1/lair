#!/usr/bin/env tsx
/**
 * Genericity guard (CONTRIBUTING.md, "No private details"): fails when a
 * tracked file or a commit message holds a real home-directory path, an email
 * address that isn't a placeholder, or a name from the private denylist.
 *
 * What it reads
 * - Files: every file `git ls-files --cached --others --exclude-standard`
 *   lists, so README, scripts/, .github/, brain-trainer/, prompts/ and the rest
 *   are covered, not only src/. Skipped: the lockfile, the baseline, symbolic
 *   links (never followed) and binary files (a NUL byte in the first 8 KB).
 * - Commit messages, with `--commits <range>` (CI passes the pull request's or
 *   the push's range). The few pushed before this check existed are listed by
 *   id in PUSHED_BEFORE_THE_CHECK, skipped and counted.
 * - The denylist: names that must never appear (private projects, people,
 *   machines, companies). It is private, so it is never committed:
 *     CI:    the GENERIC_DENYLIST repository secret, passed as an env variable
 *     local: GENERIC_DENYLIST if set, else the gitignored .generic-denylist file
 *   One entry per line, `#` starts a comment. An entry is a name, matched in
 *   any case and spacing and inside compound identifiers ("Acme Corp" matches
 *   acme-corp, AcmeCorpClient and acme_corp; a name of 5 or more characters
 *   also matches inside a longer word), or `sha256:<hex>` of the name
 *   normalised (lowercase, letters and digits only), matched as a whole part
 *   or run of up to 4 parts. Under CI (CI set and not "false" or "0") a missing
 *   or empty denylist is an error (exit 2), never a silent skip. A hit prints
 *   the entry's number, never the name: CI logs are public.
 *
 * Escape hatches (both show up in review)
 * - `generic-ignore: <reason>` on a line skips that line; the summary counts them.
 * - .generic-baseline: known violations, one per line as `file<TAB>kind<TAB>hash`
 *   (a hash of the matched text, so lines moving don't matter).
 *   `--update-baseline` rewrites it. With `--base-ref <ref>` (CI), the run
 *   fails when the baseline holds an entry the base ref's baseline lacks: the
 *   baseline can only shrink. An entry nothing matches any more fails too, so
 *   it can't hide the same text coming back. Denylisted names and commit
 *   messages are never baselined.
 *
 * Exit codes: 0 pass; 1 violations, a grown or stale baseline; 2 error (no
 * denylist under CI, a committed denylist, not a git work tree, nothing to
 * check, a git call that failed or timed out).
 */
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

export const DENYLIST_FILE = ".generic-denylist";
export const DENYLIST_ENV = "GENERIC_DENYLIST";
export const BASELINE_FILE = ".generic-baseline";
/** The marker, a colon and a reason (one in angle brackets is the docs' placeholder); [:] keeps this line from being one */
const IGNORE_MARKER = /generic-ignore[:]\s*[^\s<]/;
/** Files never read: the lockfile (registry URLs and hashes only) and the guard's own baseline */
const SKIP_FILES = new Set(["package-lock.json", BASELINE_FILE]);
/** Longest run of identifier parts a name is matched across ("acme corp api" is 3) */
const MAX_PARTS = 4;
/** Shortest name matched inside a longer word ("acmecorpapi"); shorter ones only as whole parts */
const SUBSTRING_MIN = 5;
const GIT_TIMEOUT_MS = 30_000;
/**
 * Commits pushed before commit messages were checked, whose messages break the
 * rule. History is never rewritten (no force-push), so they are skipped by
 * their full id, which no other commit can have; the summary counts them.
 * Nothing is ever added here for a commit made after the check existed.
 */
const PUSHED_BEFORE_THE_CHECK = new Set([
  "caf9fb3a258da60aec7d31395971b568c8f8953e", // a home path, quoted as what it replaced
  "476a13bc2fe637cf8c58e0949a13829ef372edf5", // a test fixture's home path
]);

export type Kind = "home-path" | "email" | "denylisted-name";

export interface Violation {
  /** A path relative to the root, or `commit <sha>` */
  file: string;
  line: number;
  column: number;
  kind: Kind;
  /** What the report prints: the matched text, or `entry N` for a denylisted name */
  shown: string;
  /** The matched text (never printed for a denylisted name) */
  text: string;
}

export class GuardError extends Error {}

// ============ DENYLIST ============

export interface Denylist {
  /** Normalised names, with their entry number */
  names: Map<string, number>;
  /** sha256 of normalised names, with their entry number */
  hashes: Map<string, number>;
  size: number;
}

/** Lowercase, letters and digits only: "Acme Corp" and "acme-corp" are both "acmecorp" */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseDenylist(text: string): Denylist {
  const names = new Map<string, number>();
  const hashes = new Map<string, number>();
  let entry = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    entry++;
    const hash = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(line);
    if (hash) {
      hashes.set(hash[1].toLowerCase(), entry);
      continue;
    }
    const name = normalizeName(line);
    if (name.length < 3) throw new GuardError(`denylist entry ${entry} has fewer than 3 letters or digits: it would match everywhere`);
    names.set(name, entry);
  }
  return { names, hashes, size: names.size + hashes.size };
}

function ciMode(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
}

export function loadDenylist(root: string, env: NodeJS.ProcessEnv): { list: Denylist; source: string } | null {
  let found: { list: Denylist; source: string } | null = null;
  const fromEnv = env[DENYLIST_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    found = { list: parseDenylist(fromEnv), source: `the ${DENYLIST_ENV} variable` };
  } else if (existsSync(join(root, DENYLIST_FILE))) {
    found = { list: parseDenylist(readFileSync(join(root, DENYLIST_FILE), "utf-8")), source: DENYLIST_FILE };
  }
  if (found && found.list.size === 0) found = null;
  if (!found && ciMode(env)) {
    throw new GuardError(
      `no denylist under CI: set the ${DENYLIST_ENV} repository secret (one name per line) and pass it to this step; ` +
        "without it private names would go unchecked",
    );
  }
  return found;
}

// ============ CHECKS ============

/**
 * Home folders: /Users/<name>, /home/<name>, /var/home/<name>, C:\Users\<name>.
 * Not preceded by a letter, digit, dot, hyphen or tilde, so a URL path such
 * as example.com/home/about is not one. Placeholders that name nobody are allowed.
 */
const UNIX_HOME = /(?<![\w.~-])\/(?:Users|home|var\/home)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const WINDOWS_HOME = /(?<!\w)[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([A-Za-z0-9][A-Za-z0-9._-]*)/g;
/** "user" is the placeholder CONTRIBUTING.md asks for; macOS's Shared folder belongs to nobody */
const GENERIC_HOMES = new Set(["user", "Shared"]);

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** RFC 2606 / RFC 6761: names reserved for examples and tests */
const RESERVED_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost"]);
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost"]);

/** A placeholder or no one's mailbox: reserved domains, GitHub's noreply addresses, git's SSH user. */
export function isAllowedEmail(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  for (const reserved of RESERVED_DOMAINS) if (domain === reserved || domain.endsWith(`.${reserved}`)) return true;
  if (RESERVED_TLDS.has(domain.slice(domain.lastIndexOf(".") + 1))) return true;
  if (domain === "users.noreply.github.com") return true;
  if (domain === "github.com" && (local === "noreply" || local === "git")) return true;
  // git@host:owner/repo is an SSH remote, not a person
  if (local === "git" && (domain === "gitlab.com" || domain === "bitbucket.org")) return true;
  return false;
}

interface Part {
  text: string;
  column: number;
}

/** A line's identifier parts, lowercase: "AcmeCorp-api_v2" is acme, corp, api, v, 2 */
function partsOf(line: string): { parts: Part[]; words: Part[] } {
  const parts: Part[] = [];
  const words: Part[] = [];
  for (const word of line.matchAll(/[A-Za-z0-9]+/g)) {
    words.push({ text: word[0].toLowerCase(), column: word.index! + 1 });
    for (const part of word[0].matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g)) {
      parts.push({ text: part[0].toLowerCase(), column: word.index! + part.index! + 1 });
    }
  }
  return { parts, words };
}

/** Denylist hits on a line: entry number to the column of its first hit */
function denylistHits(line: string, list: Denylist, hashOf: (text: string) => string): Map<number, number> {
  const hits = new Map<number, number>();
  const hit = (entry: number | undefined, column: number) => {
    if (entry !== undefined && !hits.has(entry)) hits.set(entry, column);
  };
  const { parts, words } = partsOf(line);
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let n = 0; n < MAX_PARTS && i + n < parts.length; n++) {
      joined += parts[i + n].text;
      hit(list.names.get(joined), parts[i].column);
      if (list.hashes.size > 0) hit(list.hashes.get(hashOf(joined)), parts[i].column);
    }
  }
  for (const word of words) {
    if (list.hashes.size > 0) hit(list.hashes.get(hashOf(word.text)), word.column);
    for (const [name, entry] of list.names) {
      if (name.length < SUBSTRING_MIN || hits.has(entry)) continue;
      const at = word.text.indexOf(name);
      if (at >= 0) hit(entry, word.column + at);
    }
  }
  return hits;
}

export interface TextResult {
  violations: Violation[];
  ignoredLines: number;
}

/** Check one text (a file's content or a commit message). */
export function checkText(file: string, content: string, list: Denylist | null, hashOf: (text: string) => string = sha256): TextResult {
  const violations: Violation[] = [];
  let ignoredLines = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = { file, line: i + 1 };
    if (IGNORE_MARKER.test(line)) {
      ignoredLines++;
      continue;
    }
    for (const pattern of [UNIX_HOME, WINDOWS_HOME]) {
      for (const m of line.matchAll(pattern)) {
        if (GENERIC_HOMES.has(m[1])) continue;
        violations.push({ ...at, column: m.index! + 1, kind: "home-path", shown: m[0], text: m[0] });
      }
    }
    for (const m of line.matchAll(EMAIL)) {
      if (isAllowedEmail(m[0])) continue;
      violations.push({ ...at, column: m.index! + 1, kind: "email", shown: m[0], text: m[0] });
    }
    if (list) {
      for (const [entry, column] of denylistHits(line, list, hashOf)) {
        violations.push({ ...at, column, kind: "denylisted-name", shown: `entry ${entry}`, text: `entry ${entry}` });
      }
    }
  }
  return { violations, ignoredLines };
}

// ============ GIT ============

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { code?: string; signal?: string; stderr?: string; message: string };
    const why = err.code === "ETIMEDOUT" || err.signal === "SIGTERM" ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : (err.stderr || err.message).trim();
    throw new GuardError(`git ${args.join(" ")} failed: ${why}`);
  }
}

export function listFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

/** The commit messages of a range ("base..head"), newest first. */
export function commitMessages(root: string, range: string): { sha: string; message: string }[] {
  if (range.startsWith("-")) throw new GuardError(`not a commit range: ${range}`);
  const out = git(root, ["log", "--format=%H%x1f%B%x1e", range, "--"]);
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.includes("\x1f"))
    .map((record) => {
      const [sha, message] = record.split("\x1f");
      return { sha: sha.trim(), message };
    });
}

/** A file's text, or null when it isn't one to read (a symbolic link, gone, binary). */
function readText(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null; // Deleted in the work tree but still tracked
  }
  if (!st.isFile()) return null;
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8192).includes(0)) return null;
  return buffer.toString("utf-8");
}

// ============ BASELINE ============

export function baselineKey(v: Violation): string {
  return `${v.file}\t${v.kind}\t${sha256(v.text).slice(0, 16)}`;
}

function baselinable(v: Violation): boolean {
  return v.kind !== "denylisted-name" && !v.file.startsWith("commit ");
}

/** Baseline keys, each with how many times it is listed */
export function parseBaseline(text: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.split("\t").length !== 3) throw new GuardError(`${BASELINE_FILE}: not a file<TAB>kind<TAB>hash line: ${line}`);
    keys.set(line, (keys.get(line) ?? 0) + 1);
  }
  return keys;
}

function baselineAt(root: string, ref: string): Map<string, number> {
  if (ref.startsWith("-")) throw new GuardError(`not a ref: ${ref}`);
  const listed = git(root, ["ls-tree", "--name-only", ref, "--", BASELINE_FILE]).trim();
  return listed ? parseBaseline(git(root, ["show", `${ref}:${BASELINE_FILE}`])) : new Map();
}

function writeBaseline(root: string, violations: Violation[]): number {
  const keys = violations.filter(baselinable).map(baselineKey).sort();
  const header = [
    "# Genericity guard baseline: known violations, to be fixed. It may only shrink (CI compares it with the base branch).",
    "# Written by: npm run check:generic -- --update-baseline",
    "# Format: file<TAB>kind<TAB>sha256 of the matched text (first 16 hex digits)",
  ];
  writeFileSync(join(root, BASELINE_FILE), `${[...header, ...keys].join("\n")}\n`);
  return keys.length;
}

// ============ RUN ============

export interface Options {
  root: string;
  env: NodeJS.ProcessEnv;
  updateBaseline: boolean;
  baseRef?: string;
  commits?: string;
  log: (line: string) => void;
}

export function parseArgs(argv: string[]): Pick<Options, "updateBaseline" | "baseRef" | "commits"> {
  const options: Pick<Options, "updateBaseline" | "baseRef" | "commits"> = { updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next === "") throw new GuardError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--update-baseline") options.updateBaseline = true;
    else if (arg === "--base-ref") options.baseRef = value();
    else if (arg === "--commits") options.commits = value();
    else throw new GuardError(`unknown argument: ${arg}`);
  }
  return options;
}

const LABEL: Record<Kind, string> = {
  "home-path": "Home path",
  email: "Email address",
  "denylisted-name": "Denylisted name",
};

/** One run of the guard; returns the exit code. */
export function run(options: Options): number {
  const { root, log } = options;
  const files = listFiles(root);
  if (files.includes(DENYLIST_FILE)) {
    throw new GuardError(
      `${DENYLIST_FILE} is tracked by git: it holds private names, so it must stay out of the repository (git rm --cached ${DENYLIST_FILE})`,
    );
  }
  const denylist = loadDenylist(root, options.env);
  const hashCache = new Map<string, string>();
  const hashOf = (text: string) => {
    let hash = hashCache.get(text);
    if (hash === undefined) hashCache.set(text, (hash = sha256(text)));
    return hash;
  };

  const violations: Violation[] = [];
  let ignoredLines = 0;
  let filesChecked = 0;
  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    const text = readText(join(root, file));
    if (text === null) continue;
    filesChecked++;
    const result = checkText(file, text, denylist?.list ?? null, hashOf);
    violations.push(...result.violations);
    ignoredLines += result.ignoredLines;
  }
  if (filesChecked === 0) throw new GuardError(`no files to check in ${root}: wrong folder, or nothing is tracked`);

  let commitsChecked = 0;
  let commitsSkipped = 0;
  if (options.commits) {
    for (const commit of commitMessages(root, options.commits)) {
      if (PUSHED_BEFORE_THE_CHECK.has(commit.sha)) {
        commitsSkipped++;
        continue;
      }
      commitsChecked++;
      const result = checkText(`commit ${commit.sha.slice(0, 12)}`, commit.message, denylist?.list ?? null, hashOf);
      violations.push(...result.violations);
      ignoredLines += result.ignoredLines;
    }
  }

  const skipped = commitsSkipped > 0 ? `; ${commitsSkipped} pushed before the check skipped` : "";
  log(`Checked ${filesChecked} files${options.commits ? ` and ${commitsChecked} commit messages (${options.commits}${skipped})` : ""}`);
  log(
    denylist
      ? `denylist: ${denylist.list.size} entries, from ${denylist.source}`
      : `denylist: none, so names are NOT checked (set ${DENYLIST_ENV} or create the gitignored ${DENYLIST_FILE})`,
  );
  log(`generic-ignore lines: ${ignoredLines}`);

  if (options.updateBaseline) {
    const written = writeBaseline(root, violations);
    log(`Wrote ${written} entries to ${BASELINE_FILE}`);
    const left = violations.filter((v) => !baselinable(v));
    for (const v of left) log(`  not baselined (fix it): ${v.file}:${v.line}:${v.column} ${LABEL[v.kind]}: ${v.shown}`);
    return left.length > 0 ? 1 : 0;
  }

  const baselinePath = join(root, BASELINE_FILE);
  const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf-8")) : new Map<string, number>();
  const listed = [...baseline.values()].reduce((a, b) => a + b, 0);
  log(`baseline: ${listed} entries`);
  let failed = false;

  if (options.baseRef) {
    const base = baselineAt(root, options.baseRef);
    const grown = [...baseline].filter(([key, count]) => count > (base.get(key) ?? 0));
    if (grown.length > 0) {
      failed = true;
      log(`\n✗ ${BASELINE_FILE} grew against ${options.baseRef}: fix these instead of baselining them:`);
      for (const [key] of grown) log(`  ${key.split("\t").slice(0, 2).join(" ")}`);
    }
  }

  const unused = new Map(baseline);
  const fresh: Violation[] = [];
  for (const v of violations) {
    const key = baselineKey(v);
    const left = baselinable(v) ? (unused.get(key) ?? 0) : 0;
    if (left > 0) unused.set(key, left - 1);
    else fresh.push(v);
  }
  const stale = [...unused].filter(([, count]) => count > 0);
  if (stale.length > 0) {
    failed = true;
    log(`\n✗ ${stale.length} ${BASELINE_FILE} entries match nothing any more: remove them (npm run check:generic -- --update-baseline)`);
    for (const [key] of stale) log(`  ${key.split("\t").slice(0, 2).join(" ")}`);
  }

  if (fresh.length > 0) {
    failed = true;
    log(`\n✗ Found ${fresh.length} violation(s):\n`);
    for (const v of fresh) {
      log(`  ${v.file}:${v.line}:${v.column}`);
      const note = v.kind === "denylisted-name" ? " (the name itself is not printed: CI logs are public)" : "";
      log(`    ${LABEL[v.kind]}: ${v.shown}${note}\n`);
    }
    log("See CONTRIBUTING.md, 'No private details', for what to use instead (/home/user/..., user@example.com).");
    log("A line that must stay as it is takes a `generic-ignore: <reason>` comment.");
  }

  if (!failed) log("✓ No private details found");
  return failed ? 1 : 0;
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exitCode = run({ root: resolve(process.cwd()), env: process.env, log: (line) => console.log(line), ...args });
  } catch (e) {
    console.error(`✗ check-generic: ${e instanceof GuardError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 2;
  }
}

/** Run as a script (tsx scripts/check-generic.ts), not when a test imports it */
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
