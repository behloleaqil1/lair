/**
 * The git host as the review module sees it: one repository's pull requests,
 * their files, commits and checks, and the host's own merge. GitHub is the
 * built-in provider (github.ts); others implement the same interface.
 */

export interface HostPullRequest {
  number: number;
  title: string;
  url: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** The host account that opened it (often shared by every agent) */
  user: string | null;
  labels: string[];
  /** null: not computed yet */
  mergeable: boolean | null;
  updatedAt: string | null;
  /** The PR description (absent from hosts that don't return it) */
  body?: string | null;
}

export interface HostFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks; null for binary or very large files */
  patch: string | null;
}

export interface PersonIdentity {
  name: string;
  email: string;
}

export interface HostCommit {
  sha: string;
  author: PersonIdentity;
  committer: PersonIdentity;
  /** The committer date (ISO 8601), or null when the host gives none */
  committedAt: string | null;
  /** The full message: trailers such as Co-authored-by publish emails too */
  message: string;
}

export interface HostCheck {
  name: string;
  /** A check run (made by an app) or a commit status (posted by an account) */
  kind: "check_run" | "status";
  /** For a check run: the app that created it */
  app: { id: number; slug: string } | null;
  /** For a commit status: the account that posted it */
  creator: string | null;
  state: "pending" | "success" | "failure" | "skipped";
  detail: string;
  url: string | null;
  /** When it completed (or last changed) */
  at: string | null;
}

export interface HostRepo {
  private: boolean;
  defaultBranch: string;
}

export interface HostMergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

export interface GitHost {
  /** "owner/name" */
  readonly repo: string;
  getRepo(): Promise<HostRepo>;
  listOpenPullRequests(): Promise<HostPullRequest[]>;
  getPullRequest(n: number): Promise<HostPullRequest>;
  listFiles(n: number): Promise<HostFile[]>;
  listCommits(n: number): Promise<HostCommit[]>;
  /** The file's text at `ref`, or null if it doesn't exist there */
  getFileContent(path: string, ref: string): Promise<string | null>;
  /** The commit a branch points at */
  branchHead(branch: string): Promise<string>;
  /** How far `head` is ahead of and behind `base` */
  compare(base: string, head: string): Promise<{ aheadBy: number; behindBy: number }>;
  /** Check runs and commit statuses for exactly this commit */
  listChecks(sha: string): Promise<HostCheck[]>;
  /** The ref a clone fetches to get the PR's head (e.g. refs/pull/7/head) */
  pullHeadRef(n: number): string;
  /** The host's own merge; `sha` must still be the head or the host refuses */
  merge(
    n: number,
    options: { method: "squash" | "merge" | "rebase"; sha: string; title: string; message: string },
  ): Promise<HostMergeResult>;
  /** Close a PR that was merged outside the host (a local squash), with a comment */
  closePullRequest(n: number, comment: string): Promise<void>;
  /** An account's public email, or null when it shows none */
  publicEmail(login: string): Promise<string | null>;
  /** The account the token belongs to (who the host's merge commit is authored by) */
  viewer(): Promise<{ login: string; email: string | null }>;
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HostError";
  }
}
