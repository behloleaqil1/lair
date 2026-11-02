/**
 * One git host per listed repository (docs/design/pr-health.md section 4.3).
 * A host is built on first use and kept, so a rate-limit answer blocks only
 * that repository's host, and its default branch is asked once. The hosts of
 * a project share one token source. Tests pass `fetch`, the only stand-in.
 */
import { GitHubHost, type FetchLike, type TokenSource } from "../review/github.js";
import type { GitHost } from "../review/host.js";
import type { RepoEntry } from "./config.js";

export interface RepoHostsOptions {
  repos: RepoEntry[];
  /** e.g. https://api.github.com (review.api_url) */
  apiUrl: string;
  token: TokenSource;
  fetch?: FetchLike;
  /** One request may take this long; then it fails (a timeout is a failure) */
  timeoutMs?: number;
  now?: () => number;
}

interface Held {
  entry: RepoEntry;
  host: GitHost;
  base: Promise<string> | null;
}

export class RepoHosts {
  private readonly held = new Map<string, Held>();

  constructor(private readonly options: RepoHostsOptions) {}

  private get(repo: string): Held {
    const key = repo.toLowerCase();
    let held = this.held.get(key);
    if (held) return held;
    const entry = this.options.repos.find((r) => r.repo.toLowerCase() === key);
    if (!entry) throw new Error(`${repo.slice(0, 141)} is not one of the project's repositories`);
    const { apiUrl, token, fetch, timeoutMs, now } = this.options;
    held = { entry, host: new GitHubHost({ repo: entry.repo, apiUrl, token, fetch, timeoutMs, now }), base: null };
    this.held.set(key, held);
    return held;
  }

  /** The repository's host (throws for a repository the project does not list). */
  host(repo: string): GitHost {
    return this.get(repo).host;
  }

  /** The repository's base branch: `base` when set, else the host's default branch (read once; a failed read is asked again). */
  base(repo: string): Promise<string> {
    const held = this.get(repo);
    if (held.entry.base) return Promise.resolve(held.entry.base);
    held.base ??= held.host.getRepo().then(
      (r) => r.defaultBranch,
      (e: unknown) => {
        held.base = null;
        throw e;
      },
    );
    return held.base;
  }
}
