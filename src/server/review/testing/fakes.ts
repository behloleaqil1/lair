/**
 * Test stand-ins for the only things the review tests fake: the git host's
 * HTTP API, git process calls and the clock. The API and the git fake share
 * one in-memory repository (FakeRemote), so a push through the fake git is
 * what the fake API reports afterwards, as on a real host. Not part of the
 * build (tsconfig.server.json excludes testing/).
 */
import { createHash } from "crypto";
import type { FetchLike, FetchResponseLike } from "../github.js";
import type { GitResult, GitRunner } from "../git.js";
import type { Clock } from "../service.js";

export interface Person {
  name: string;
  email: string;
}

export interface FakeCommit {
  sha: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface FakeFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
  /** The file at the PR head, served by the contents API */
  content?: string;
}

export interface FakePull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  user: string;
  mergeable: boolean | null;
  files: FakeFile[];
  /** Its updated_at (default 2026-01-01T00:00:00Z) */
  updatedAt?: string;
}

export interface FakeCheckRun {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  completed_at: string | null;
  app: { id: number; slug: string };
}

export interface FakeStatus {
  context: string;
  state: "success" | "failure" | "error" | "pending";
  creator: string;
}

/** GitHub Actions, the app whose check runs count by default. */
export const ACTIONS_APP = { id: 15368, slug: "github-actions" };

/** The identity the host writes its own merges with. */
export const HOST_ACCOUNT: Person = { name: "Host Account", email: "account-owner@example.com" };

export class FakeClock implements Clock {
  constructor(public t: number) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeRemote {
  isPrivate = false;
  defaultBranch = "main";
  readonly commits = new Map<string, FakeCommit>();
  readonly branches = new Map<string, string>();
  readonly pulls = new Map<number, FakePull>();
  readonly checks = new Map<string, FakeCheckRun[]>();
  readonly statuses = new Map<string, FakeStatus[]>();
  /** Accounts' public emails (an account missing here shows none) */
  readonly publicEmails = new Map<string, string>();
  /** The account the token belongs to */
  viewer = "example-bot";
  readonly contents = new Map<string, string>();
  /** Every API request, so a test can show what was never called */
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  private counter = 0;

  constructor(readonly repo = "example-org/demo") {}

  commit(parents: string[], author: Person, message: string, committer: Person = author): string {
    const sha = createHash("sha1")
      .update(`${++this.counter}:${parents.join(",")}:${author.email}:${message}`)
      .digest("hex");
    this.commits.set(sha, { sha, parents, author, committer, message });
    return sha;
  }

  reachable(from: string): Set<string> {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return seen;
  }

  isAncestor(ancestor: string, of: string): boolean {
    return this.reachable(of).has(ancestor);
  }

  /** Commits reachable from `to` but not from `from`, newest first. */
  range(from: string, to: string): FakeCommit[] {
    const exclude = this.reachable(from);
    const out: FakeCommit[] = [];
    const seen = new Set<string>();
    const queue = [to];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha) || exclude.has(sha)) continue;
      seen.add(sha);
      const commit = this.commits.get(sha);
      if (!commit) continue;
      out.push(commit);
      queue.push(...commit.parents);
    }
    return out;
  }

  openPull(input: Partial<FakePull> & { number: number; headRef: string; headSha: string; files: FakeFile[] }): FakePull {
    const pull: FakePull = {
      title: `PR ${input.number}`,
      state: "open",
      merged: false,
      draft: false,
      baseRef: "main",
      labels: [],
      user: "example-bot",
      mergeable: true,
      ...input,
    };
    this.pulls.set(pull.number, pull);
    this.branches.set(pull.headRef, pull.headSha);
    this.indexContents(pull);
    return pull;
  }

  /** A push to the PR's branch: a new head (and optionally new files). */
  pushToPull(n: number, headSha: string, files?: FakeFile[]): void {
    const pull = this.pulls.get(n)!;
    pull.headSha = headSha;
    if (files) pull.files = files;
    this.branches.set(pull.headRef, headSha);
    this.indexContents(pull);
  }

  private indexContents(pull: FakePull): void {
    for (const f of pull.files) {
      if (f.content !== undefined) this.contents.set(`${pull.headSha}:${f.filename}`, f.content);
    }
  }

  /** Completed check runs at `sha`: [name, conclusion], made by `app` (GitHub Actions by default). */
  setChecks(sha: string, runs: [string, string][], app = ACTIONS_APP): void {
    this.checks.set(
      sha,
      runs.map(([name, conclusion], i) => ({
        name,
        status: "completed",
        conclusion,
        completed_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        app,
      })),
    );
  }

  /** Move a branch, refusing a non-fast-forward; a PR whose head lands on its base is merged. */
  push(branch: string, sha: string): boolean {
    const tip = this.branches.get(branch);
    if (tip && !this.isAncestor(tip, sha)) return false;
    this.branches.set(branch, sha);
    for (const pull of this.pulls.values()) {
      if (pull.state === "open" && pull.baseRef === branch && this.isAncestor(pull.headSha, sha)) {
        pull.state = "closed";
        pull.merged = true;
      }
    }
    return true;
  }
}

function pullJson(remote: FakeRemote, p: FakePull, detail: boolean): Record<string, unknown> {
  return {
    number: p.number,
    title: p.title,
    html_url: `https://github.com/${remote.repo}/pull/${p.number}`,
    state: p.state,
    ...(detail ? { merged: p.merged, mergeable: p.mergeable } : {}),
    merged_at: p.merged ? "2026-01-01T00:00:00Z" : null,
    draft: p.draft,
    head: { sha: p.headSha, ref: p.headRef },
    base: { ref: p.baseRef },
    user: { login: p.user },
    labels: p.labels.map((name) => ({ name })),
    updated_at: p.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

/** A stand-in for the GitHub REST API over one FakeRemote. */
export function fakeGitHubApi(remote: FakeRemote): FetchLike {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    remote.requests.push({ method, path: `${u.pathname}${u.search}`, body });
    const reply = (status: number, data: unknown): FetchResponseLike => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    const notFound = () => reply(404, { message: "Not Found" });

    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/users\/([^/]+)$/.exec(path))) {
      return reply(200, { login: m[1], email: remote.publicEmails.get(m[1]) ?? null });
    }
    if (method === "GET" && path === "/user") {
      return reply(200, { login: remote.viewer, email: remote.publicEmails.get(remote.viewer) ?? null });
    }

    const prefix = `/repos/${remote.repo}`;
    if (!path.startsWith(prefix)) return notFound();
    const rest = path.slice(prefix.length);
    const page = Number(u.searchParams.get("page") ?? "1");

    if (method === "GET" && rest === "") {
      return reply(200, { private: remote.isPrivate, default_branch: remote.defaultBranch });
    }
    if (method === "GET" && rest === "/pulls") {
      return reply(
        200,
        [...remote.pulls.values()].filter((p) => p.state === "open").map((p) => pullJson(remote, p, false)),
      );
    }
    if ((m = /^\/pulls\/(\d+)(\/files|\/commits|\/merge)?$/.exec(rest))) {
      const pull = remote.pulls.get(Number(m[1]));
      if (!pull) return notFound();
      const sub = m[2];
      if (!sub && method === "GET") return reply(200, pullJson(remote, pull, true));
      if (!sub && method === "PATCH") {
        if (body?.state === "closed") pull.state = "closed";
        return reply(200, pullJson(remote, pull, true));
      }
      if (sub === "/files" && method === "GET") {
        return reply(
          200,
          page > 1
            ? []
            : pull.files.map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: f.patch,
                previous_filename: f.previous_filename,
              })),
        );
      }
      if (sub === "/commits" && method === "GET") {
        const base = remote.branches.get(pull.baseRef)!;
        return reply(
          200,
          page > 1
            ? []
            : remote
                .range(base, pull.headSha)
                .reverse()
                .map((c) => ({ sha: c.sha, commit: { author: c.author, committer: c.committer, message: c.message } })),
        );
      }
      if (sub === "/merge" && method === "PUT") {
        if (body?.sha !== pull.headSha) return reply(409, { message: "Head branch was modified. Review and try the merge again." });
        if (pull.state !== "open" || pull.mergeable === false) return reply(405, { message: "Pull Request is not mergeable" });
        const tip = remote.branches.get(pull.baseRef)!;
        const message = `${String(body?.commit_title)}\n\n${String(body?.commit_message)}`;
        const result =
          body?.merge_method === "squash"
            ? remote.commit([tip], HOST_ACCOUNT, message)
            : remote.commit([tip, pull.headSha], HOST_ACCOUNT, message);
        remote.push(pull.baseRef, result);
        pull.state = "closed";
        pull.merged = true;
        return reply(200, { merged: true, sha: result, message: "Pull Request successfully merged" });
      }
    }
    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const text = remote.contents.get(`${u.searchParams.get("ref")}:${m[1]}`);
      return text === undefined ? notFound() : reply(200, text);
    }
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = remote.branches.get(m[1]);
      return sha ? reply(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : notFound();
    }
    if (method === "GET" && (m = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest))) {
      return reply(200, {
        ahead_by: remote.range(m[1], m[2]).length,
        behind_by: remote.range(m[2], m[1]).length,
      });
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) {
      const runs = remote.checks.get(m[1]) ?? [];
      return reply(200, {
        total_count: runs.length,
        check_runs: runs.map((r) => ({ ...r, html_url: null, started_at: r.completed_at })),
      });
    }
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]+)\/statuses$/.exec(rest))) {
      return reply(
        200,
        (remote.statuses.get(m[1]) ?? []).map((s) => ({
          context: s.context,
          state: s.state,
          description: s.state,
          target_url: null,
          updated_at: "2026-01-01T00:30:00Z",
          creator: { login: s.creator },
        })),
      );
    }
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(rest)) {
      return reply(201, { id: 1 });
    }
    return reply(404, { message: `Not Found: ${method} ${rest}` });
  };
}

interface Clone {
  branch: string;
  head: string;
  fetchHead: string | null;
  squash: string | null;
}

/**
 * A stand-in for the git CLI with the commands the local merge executor
 * runs, over the same FakeRemote: clone, fetch, rev-parse, merge-base,
 * merge, diff, commit, log and push.
 */
export class FakeGit implements GitRunner {
  readonly clones = new Map<string, Clone>();

  constructor(private readonly remote: FakeRemote) {}

  async run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
    const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
    const err = (code: number, stderr: string): GitResult => ({ code, stdout: "", stderr });
    let a = args;
    while (a[0] === "-c") a = a.slice(2);
    const [cmd, ...rest] = a;

    if (cmd === "clone") {
      const branch = rest[rest.indexOf("--branch") + 1];
      const dir = rest[rest.length - 1];
      const tip = this.remote.branches.get(branch);
      if (!tip) return err(128, `fatal: Remote branch ${branch} not found in upstream origin`);
      this.clones.set(dir, { branch, head: tip, fetchHead: null, squash: null });
      return ok();
    }
    const clone = options.cwd ? this.clones.get(options.cwd) : undefined;
    if (!clone) return err(128, "fatal: not a git repository");

    switch (cmd) {
      case "fetch": {
        const ref = rest[rest.length - 1];
        const pull = /^refs\/pull\/(\d+)\/head$/.exec(ref);
        const sha = pull
          ? this.remote.pulls.get(Number(pull[1]))?.headSha
          : this.remote.branches.get(ref.replace(/^refs\/heads\//, ""));
        if (!sha) return err(128, `fatal: couldn't find remote ref ${ref}`);
        clone.fetchHead = sha;
        return ok();
      }
      case "rev-parse": {
        const sha = rest[0] === "FETCH_HEAD" ? clone.fetchHead : rest[0] === "HEAD" ? clone.head : null;
        return sha ? ok(`${sha}\n`) : err(128, `fatal: ambiguous argument '${rest[0]}'`);
      }
      case "merge-base": {
        const from = rest[1] === "HEAD" ? clone.head : rest[1];
        return this.remote.isAncestor(from, rest[2]) ? ok() : err(1, "");
      }
      case "merge": {
        if (rest[0] === "--ff-only") {
          if (!this.remote.isAncestor(clone.head, rest[1])) return err(128, "fatal: Not possible to fast-forward, aborting.");
          clone.head = rest[1];
          return ok();
        }
        if (rest[0] === "--squash") {
          clone.squash = rest[1];
          return ok("Squash commit -- not updating HEAD\n");
        }
        break;
      }
      case "diff":
        return clone.squash && clone.squash !== clone.head ? err(1, "") : ok();
      case "commit": {
        if (!clone.squash) return err(1, "nothing to commit, working tree clean");
        const env = options.env ?? {};
        const parts: string[] = [];
        for (let i = 0; i < rest.length; i++) if (rest[i] === "-m") parts.push(rest[++i]);
        clone.head = this.remote.commit(
          [clone.head],
          { name: env.GIT_AUTHOR_NAME ?? "", email: env.GIT_AUTHOR_EMAIL ?? "" },
          parts.join("\n\n"),
          { name: env.GIT_COMMITTER_NAME ?? "", email: env.GIT_COMMITTER_EMAIL ?? "" },
        );
        clone.squash = null;
        return ok();
      }
      case "log": {
        const [from, to] = rest[rest.length - 1].split("..");
        const commits = this.remote.range(from, to === "HEAD" ? clone.head : to);
        return ok(
          commits
            .map(
              (c) =>
                `${[c.sha, c.author.name, c.author.email, c.committer.name, c.committer.email, `${c.message}\n`].join("\x1f")}\x1e`,
            )
            .join("\n"),
        );
      }
      case "push": {
        const target = rest[rest.length - 1].split(":")[1].replace(/^refs\/heads\//, "");
        return this.remote.push(target, clone.head)
          ? ok("Done\n")
          : err(1, `! [rejected] HEAD -> ${target} (non-fast-forward)`);
      }
    }
    return err(127, `fake git: unsupported command: ${args.join(" ")}`);
  }
}
