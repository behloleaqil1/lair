/**
 * GitHub provider for the review module: the REST API over fetch. The token
 * comes from an environment variable or a command (e.g. `gh auth token`), is
 * sent only as an Authorization header to the configured API, and never
 * appears in errors or logs.
 */
import { execFile } from "child_process";
import {
  HostError,
  type GitHost,
  type HostCheck,
  type HostCommit,
  type HostFile,
  type HostMergeResult,
  type HostPullRequest,
  type HostRepo,
} from "./host.js";

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** The part of fetch() the provider uses, so tests can stand in for the API. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export type TokenSource = () => Promise<string | null>;

/** Read the token from `envName`, else from the output of `cmd` (cached once it succeeds). */
export function tokenFrom(
  envName: string,
  cmd: string[] | null,
  environment: NodeJS.ProcessEnv = process.env,
): TokenSource {
  let cached: Promise<string | null> | null = null;
  return () => {
    const fromEnv = environment[envName]?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);
    if (!cmd) return Promise.resolve(null);
    cached ??= new Promise<string | null>((resolve) => {
      execFile(cmd[0], cmd.slice(1), { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      });
    }).then((token) => {
      if (!token) cached = null;
      return token;
    });
    return cached;
  };
}

interface GhPull {
  number: number;
  title: string;
  html_url?: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  user?: { login?: string } | null;
  labels?: { name?: string }[];
  mergeable?: boolean | null;
  updated_at?: string;
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GhPerson {
  name?: string;
  email?: string;
}

interface GhCommit {
  sha: string;
  commit: { author?: GhPerson | null; committer?: GhPerson | null; message?: string };
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GhStatus {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
  updated_at?: string | null;
}

const SHA = /^[0-9a-f]{7,64}$/i;

function assertSha(sha: string): string {
  if (!SHA.test(sha)) throw new HostError(`Not a commit sha: ${sha.slice(0, 80)}`, 400);
  return sha;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function mapPull(p: GhPull): HostPullRequest {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url ?? null,
    state: p.merged || p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
    draft: p.draft === true,
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    user: p.user?.login ?? null,
    labels: (p.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null,
    updatedAt: p.updated_at ?? null,
  };
}

function person(p: GhPerson | null | undefined): { name: string; email: string } {
  return { name: p?.name ?? "", email: p?.email ?? "" };
}

export interface GitHubHostOptions {
  /** owner/name */
  repo: string;
  /** e.g. https://api.github.com */
  apiUrl: string;
  token: TokenSource;
  fetch?: FetchLike;
}

export class GitHubHost implements GitHost {
  readonly repo: string;
  private readonly api: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: GitHubHostOptions) {
    this.repo = options.repo;
    this.api = options.apiUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private async request(
    method: string,
    path: string,
    options: { body?: unknown; accept?: string; allow404?: boolean } = {},
  ): Promise<{ status: number; text: string }> {
    const token = await this.options.token();
    const headers: Record<string, string> = {
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lair-review",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchFn(`${this.api}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok && !(options.allow404 && response.status === 404)) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {}
      throw new HostError(`GitHub ${method} ${path.split("?")[0]}: ${response.status} ${message}`, response.status);
    }
    return { status: response.status, text };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { text } = await this.request(method, path, { body });
    return JSON.parse(text) as T;
  }

  private repoPath(suffix: string): string {
    return `/repos/${this.repo}${suffix}`;
  }

  async getRepo(): Promise<HostRepo> {
    const repo = await this.json<{ private?: boolean; default_branch?: string }>("GET", this.repoPath(""));
    return { private: repo.private === true, defaultBranch: repo.default_branch ?? "main" };
  }

  async listOpenPullRequests(): Promise<HostPullRequest[]> {
    const pulls = await this.json<GhPull[]>("GET", this.repoPath("/pulls?state=open&per_page=100"));
    return pulls.map(mapPull);
  }

  async getPullRequest(n: number): Promise<HostPullRequest> {
    return mapPull(await this.json<GhPull>("GET", this.repoPath(`/pulls/${n}`)));
  }

  async listFiles(n: number): Promise<HostFile[]> {
    const files: HostFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.json<GhFile[]>("GET", this.repoPath(`/pulls/${n}/files?per_page=100&page=${page}`));
      for (const f of batch) {
        files.push({
          path: f.filename,
          previousPath: f.previous_filename ?? null,
          status: f.status,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          patch: f.patch ?? null,
        });
      }
      if (batch.length < 100) break;
    }
    return files;
  }

  async listCommits(n: number): Promise<HostCommit[]> {
    const commits: HostCommit[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.json<GhCommit[]>("GET", this.repoPath(`/pulls/${n}/commits?per_page=100&page=${page}`));
      for (const c of batch) {
        commits.push({
          sha: c.sha,
          author: person(c.commit.author),
          committer: person(c.commit.committer),
          message: c.commit.message ?? "",
        });
      }
      if (batch.length < 100) break;
    }
    return commits;
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    const { status, text } = await this.request(
      "GET",
      this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`),
      { accept: "application/vnd.github.raw", allow404: true },
    );
    return status === 404 ? null : text;
  }

  async branchHead(branch: string): Promise<string> {
    const ref = await this.json<{ object?: { sha?: string } }>(
      "GET",
      this.repoPath(`/git/ref/heads/${encodePath(branch)}`),
    );
    if (!ref.object?.sha) throw new HostError(`Branch ${branch} has no commit`, 404);
    return ref.object.sha;
  }

  async compare(base: string, head: string): Promise<{ aheadBy: number; behindBy: number }> {
    const result = await this.json<{ ahead_by?: number; behind_by?: number }>(
      "GET",
      this.repoPath(`/compare/${assertSha(base)}...${assertSha(head)}`),
    );
    return { aheadBy: result.ahead_by ?? 0, behindBy: result.behind_by ?? 0 };
  }

  async listChecks(sha: string): Promise<HostCheck[]> {
    assertSha(sha);
    const runs = await this.json<{ check_runs?: GhCheckRun[] }>(
      "GET",
      this.repoPath(`/commits/${sha}/check-runs?per_page=100`),
    );
    const statuses = await this.json<{ statuses?: GhStatus[] }>("GET", this.repoPath(`/commits/${sha}/status`));
    const checks: HostCheck[] = (runs.check_runs ?? []).map((r): HostCheck => ({
      name: r.name,
      state:
        r.status !== "completed"
          ? "pending"
          : r.conclusion === "success"
            ? "success"
            : r.conclusion === "neutral" || r.conclusion === "skipped"
              ? "skipped"
              : "failure",
      detail: r.status !== "completed" ? r.status : (r.conclusion ?? "unknown"),
      url: r.html_url ?? null,
      at: r.completed_at ?? r.started_at ?? null,
    }));
    for (const s of statuses.statuses ?? []) {
      checks.push({
        name: s.context,
        state: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure",
        detail: s.description ?? s.state,
        url: s.target_url ?? null,
        at: s.updated_at ?? null,
      });
    }
    return checks;
  }

  pullHeadRef(n: number): string {
    return `refs/pull/${n}/head`;
  }

  async merge(
    n: number,
    options: { method: "squash" | "merge" | "rebase"; sha: string; title: string; message: string },
  ): Promise<HostMergeResult> {
    try {
      const result = await this.json<{ merged?: boolean; sha?: string; message?: string }>(
        "PUT",
        this.repoPath(`/pulls/${n}/merge`),
        {
          merge_method: options.method,
          sha: assertSha(options.sha),
          commit_title: options.title,
          commit_message: options.message,
        },
      );
      return { merged: result.merged === true, sha: result.sha ?? null, message: result.message ?? "" };
    } catch (e) {
      // 405: not mergeable, 409: the head moved, 422: invalid
      if (e instanceof HostError && [405, 409, 422].includes(e.status)) {
        return { merged: false, sha: null, message: e.message };
      }
      throw e;
    }
  }

  async closePullRequest(n: number, comment: string): Promise<void> {
    await this.json("POST", this.repoPath(`/issues/${n}/comments`), { body: comment });
    await this.json("PATCH", this.repoPath(`/pulls/${n}`), { state: "closed" });
  }
}
