/**
 * Merge executor. Two methods, picked per repository by config:
 *
 * - host: the git host's own merge (squash, merge or rebase) through its API;
 * - local: a fast-forward or squash in a fresh clone, with the configured
 *   identity, then a push.
 *
 * Before anything is published, every commit that would land on the target
 * branch is checked: its author and committer emails, and any email in its
 * message (Co-authored-by trailers publish emails too), must match the
 * allow-list. One that doesn't stops the merge before the push.
 */
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import type { MergePlan } from "../../shared/review-types.js";
import type { MergeSettings } from "./config.js";
import type { GitRunner } from "./git.js";
import type { GitHost, HostRepo, PersonIdentity } from "./host.js";

export interface PublishedCommit {
  sha: string;
  author: PersonIdentity;
  committer: PersonIdentity;
  message: string;
}

export interface EmailViolation {
  sha: string;
  role: "author" | "committer" | "message";
  email: string;
}

export interface MergeExecution {
  merged: boolean;
  resultSha: string | null;
  commitsChecked: number;
  reasons: string[];
  emailViolations: EmailViolation[];
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 200);
}

// ============ EMAIL ALLOW-LIST ============

const emailPatternCache = new Map<string, RegExp>();

/** True if `email` matches one of the globs (`*` is any run of characters), case-insensitively. */
export function emailAllowed(email: string, allowed: string[]): boolean {
  const value = email.trim().toLowerCase();
  if (!value) return false;
  return allowed.some((glob) => {
    let re = emailPatternCache.get(glob);
    if (!re) {
      const source = glob
        .trim()
        .toLowerCase()
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      re = new RegExp(`^${source}$`);
      emailPatternCache.set(glob, re);
    }
    return re.test(value);
  });
}

/** "a***@example.com": enough to recognise, without repeating the address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export function checkCommitEmails(
  commits: PublishedCommit[],
  allowed: string[],
  roles: EmailViolation["role"][] = ["author", "committer", "message"],
): EmailViolation[] {
  const violations: EmailViolation[] = [];
  for (const c of commits) {
    if (roles.includes("author") && !emailAllowed(c.author.email, allowed)) {
      violations.push({ sha: c.sha, role: "author", email: c.author.email });
    }
    if (roles.includes("committer") && !emailAllowed(c.committer.email, allowed)) {
      violations.push({ sha: c.sha, role: "committer", email: c.committer.email });
    }
    if (roles.includes("message")) {
      for (const email of new Set(c.message.match(EMAIL_IN_TEXT) ?? [])) {
        if (!emailAllowed(email, allowed)) violations.push({ sha: c.sha, role: "message", email });
      }
    }
  }
  return violations;
}

export function describeViolations(violations: EmailViolation[]): string[] {
  return violations.map(
    (v) =>
      `commit ${short(v.sha)}: ${v.role === "message" ? "its message contains" : `${v.role} email`} ${
        v.email ? maskEmail(v.email) : "(empty)"
      }, which is not in review.merge.allowed_emails`,
  );
}

// ============ PLAN ============

/**
 * Pick the method. `auto` merges on the host only when that can't publish a
 * private email: a private repository, or a host account whose email is known
 * to be private. Otherwise it merges locally with the configured identity.
 */
export function planMerge(settings: MergeSettings, repo: HostRepo | null): MergePlan {
  const host = (reason: string): MergePlan => ({
    method: "host",
    strategy: settings.hostMethod,
    reason,
    warnings:
      settings.hostEmailPrivate === true
        ? []
        : ["The host writes the merge with its account's identity; Lair cannot check that email before it is published."],
  });
  const local = (reason: string): MergePlan => ({
    method: "local",
    strategy: settings.localStrategy,
    reason,
    warnings: [],
  });
  if (settings.method === "host") return host("review.merge.method is host");
  if (settings.method === "local") return local("review.merge.method is local");
  if (repo === null) return local("the repository's visibility is unknown, so Lair merges locally with the configured identity");
  if (repo.private) return host("private repository");
  if (settings.hostEmailPrivate === true) {
    return host("public repository whose host account keeps its email private (review.merge.host_email_private)");
  }
  return local("public repository, and the host account's email privacy is not known to be private");
}

// ============ HOST MERGE ============

export interface HostMergeInput {
  pr: number;
  headSha: string;
  strategy: "squash" | "merge" | "rebase";
  title: string;
  body: string;
  allowedEmails: string[];
}

/**
 * Merge through the host's API, after checking the commits it would publish:
 * every PR commit for merge, their authors and messages for rebase (the host
 * rewrites the committer), and Lair's own message for squash.
 */
export async function mergeOnHost(host: GitHost, input: HostMergeInput): Promise<MergeExecution> {
  let checked: PublishedCommit[];
  let roles: EmailViolation["role"][];
  if (input.strategy === "squash") {
    const ours = { name: "", email: "" };
    checked = [{ sha: input.headSha, author: ours, committer: ours, message: `${input.title}\n\n${input.body}` }];
    roles = ["message"];
  } else {
    checked = await host.listCommits(input.pr);
    roles = input.strategy === "merge" ? ["author", "committer", "message"] : ["author", "message"];
  }
  const violations = checkCommitEmails(checked, input.allowedEmails, roles);
  if (violations.length > 0) {
    return {
      merged: false,
      resultSha: null,
      commitsChecked: checked.length,
      reasons: describeViolations(violations),
      emailViolations: violations,
    };
  }
  const result = await host.merge(input.pr, {
    method: input.strategy,
    sha: input.headSha,
    title: input.title,
    message: input.body,
  });
  return {
    merged: result.merged,
    resultSha: result.sha,
    commitsChecked: checked.length,
    reasons: result.merged ? [] : [`the host refused the merge: ${result.message}`],
    emailViolations: [],
  };
}

// ============ LOCAL MERGE ============

export interface LocalMergeInput {
  cloneUrl: string;
  baseRef: string;
  headSha: string;
  /** What to fetch to get the head, e.g. refs/pull/7/head */
  fetchRef: string;
  strategy: "ff-only" | "squash";
  identity: PersonIdentity | null;
  allowedEmails: string[];
  title: string;
  body: string;
}

export interface LocalMergerOptions {
  git: GitRunner;
  /** Temporary clones are made (and removed) under this directory */
  workDir: string;
  /** `Authorization` header value for https clone URLs, e.g. from the host token */
  authHeader?: () => Promise<string | null>;
}

const LOG_FORMAT = "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e";

export function parseCommitLog(stdout: string): PublishedCommit[] {
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\s+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, an, ae, cn, ce, ...message] = record.split("\x1f");
      return {
        sha: sha.trim(),
        author: { name: an ?? "", email: ae ?? "" },
        committer: { name: cn ?? "", email: ce ?? "" },
        message: message.join("\x1f"),
      };
    });
}

export class LocalMerger {
  constructor(private readonly options: LocalMergerOptions) {}

  async merge(input: LocalMergeInput): Promise<MergeExecution> {
    const workDir = resolve(this.options.workDir);
    mkdirSync(workDir, { recursive: true });
    const dir = mkdtempSync(join(workDir, "merge-"));
    // The configured identity for everything git writes in the clone (the squash commit, reflogs),
    // so the machine's own git identity is never used
    const env: Record<string, string> = input.identity
      ? {
          GIT_AUTHOR_NAME: input.identity.name,
          GIT_AUTHOR_EMAIL: input.identity.email,
          GIT_COMMITTER_NAME: input.identity.name,
          GIT_COMMITTER_EMAIL: input.identity.email,
        }
      : {};
    if (/^https:\/\//i.test(input.cloneUrl)) {
      const header = (await this.options.authHeader?.()) ?? null;
      if (header) {
        // Passed in the environment, so it is in neither argv nor .git/config
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = `http.${new URL(input.cloneUrl).origin}/.extraheader`;
        env.GIT_CONFIG_VALUE_0 = header;
      }
    }
    const git = (args: string[], extra: Record<string, string> = {}) =>
      this.options.git.run(args, { cwd: dir, env: { ...env, ...extra } });
    let commitsChecked = 0;
    const fail = (reason: string): MergeExecution => ({
      merged: false,
      resultSha: null,
      commitsChecked,
      reasons: [reason],
      emailViolations: [],
    });

    try {
      const clone = await this.options.git.run(
        ["clone", "--no-tags", "--single-branch", "--branch", input.baseRef, "--", input.cloneUrl, dir],
        { cwd: workDir, env },
      );
      if (clone.code !== 0) return fail(`cloning ${input.baseRef} failed: ${firstLine(clone.stderr)}`);

      const fetched = await git(["fetch", "--no-tags", "origin", input.fetchRef]);
      if (fetched.code !== 0) return fail(`fetching ${input.fetchRef} failed: ${firstLine(fetched.stderr)}`);
      const fetchedSha = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
      if (fetchedSha !== input.headSha) {
        return fail(`the PR head moved: ${input.fetchRef} is ${short(fetchedSha)}, not ${short(input.headSha)}`);
      }
      const base = (await git(["rev-parse", "HEAD"])).stdout.trim();

      if (input.strategy === "ff-only") {
        const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", input.headSha]);
        if (ancestor.code !== 0) {
          return fail(`${input.baseRef} has commits the PR lacks, so a fast-forward is impossible: update the branch`);
        }
        const ff = await git(["merge", "--ff-only", input.headSha]);
        if (ff.code !== 0) return fail(`the fast-forward failed: ${firstLine(ff.stderr)}`);
      } else {
        if (!input.identity) return fail("a squash merge needs review.merge.identity");
        const squash = await git(["merge", "--squash", input.headSha]);
        if (squash.code !== 0) return fail(`the squash merge failed: ${firstLine(squash.stderr || squash.stdout)}`);
        const staged = await git(["diff", "--cached", "--quiet"]);
        if (staged.code === 0) return fail("the squash merge changes nothing");
        const commit = await git([
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--no-verify",
          "-m",
          input.title,
          "-m",
          input.body,
        ]);
        if (commit.code !== 0) return fail(`the squash commit failed: ${firstLine(commit.stderr)}`);
      }

      const log = await git(["log", LOG_FORMAT, `${base}..HEAD`]);
      if (log.code !== 0) return fail(`listing the commits to publish failed: ${firstLine(log.stderr)}`);
      const commits = parseCommitLog(log.stdout);
      commitsChecked = commits.length;
      if (commits.length === 0) return fail("there is nothing to publish");
      const violations = checkCommitEmails(commits, input.allowedEmails);
      if (violations.length > 0) {
        return {
          merged: false,
          resultSha: null,
          commitsChecked,
          reasons: describeViolations(violations),
          emailViolations: violations,
        };
      }

      const result = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const push = await git(["push", "--porcelain", "origin", `HEAD:refs/heads/${input.baseRef}`]);
      if (push.code !== 0) return fail(`the push was refused: ${firstLine(push.stderr || push.stdout)}`);
      return { merged: true, resultSha: result, commitsChecked, reasons: [], emailViolations: [] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
