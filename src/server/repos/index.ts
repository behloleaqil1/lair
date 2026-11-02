/**
 * The project's repositories (`repos:`, config.ts), the PR references in
 * task text (refs.ts), one git host per repository (hosts.ts), and the ready
 * guard's source of PR facts built from them (RepoSources).
 */
import type { ProjectConfig } from "../../shared/types.js";
import type { ReadyFacts, ReadyFactsSource } from "../ready-guard/guard.js";
import { tokenFrom, type FetchLike } from "../review/github.js";
import { readyFactsFromHost } from "./checks.js";
import { parseReposConfig, type RepoEntry } from "./config.js";
import { RepoHosts } from "./hosts.js";

export { parseReposConfig, type RepoEntry, type ReposResult } from "./config.js";
export { parsePrRefs, taskRepoOf, bareRepo, type PrRef } from "./refs.js";
export { RepoHosts } from "./hosts.js";
export { newestChecks, readyFactsFromHost } from "./checks.js";

/** What the ready guard reads of the review module (a ReviewService): its repository, its host's settings and its facts. */
export interface ReviewFacts {
  readonly settings: { repo: string; apiUrl: string; tokenEnv: string; tokenCmd: string[] | null; defaultBranch: string | null };
  readyFacts(n: number): Promise<ReadyFacts>;
}

export interface RepoSourcesOptions {
  /** The project's review module, if it is on */
  review: (project: string) => ReviewFacts | undefined;
  /** Tests stand in for the API here */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** One request to another repository's host may take this long (default 20 s) */
  timeoutMs?: number;
  now?: () => number;
  warn?: (text: string) => void;
}

interface Built {
  config: ProjectConfig;
  settings: ReviewFacts["settings"];
  repos: RepoEntry[];
  legacy: boolean;
  hosts: RepoHosts;
}

/**
 * The ready guard's source per project. The review module's repository is
 * read through the review module (its gate and findings, as before); any
 * other repository `repos:` lists is read through a host of its own. A
 * project without `repos:` (or with an invalid one) gets the review
 * repository alone and `legacy`: only `PR #n` forms name a PR, as before.
 * The list and the hosts are kept until the project's config or review
 * settings change (a reload).
 */
export class RepoSources {
  private readonly built = new Map<string, Built>();

  constructor(private readonly options: RepoSourcesOptions) {}

  readyFacts(project: string, config: ProjectConfig): ReadyFactsSource | undefined {
    const review = this.options.review(project);
    if (!review) return undefined;
    let built = this.built.get(project);
    if (!built || built.config !== config || built.settings !== review.settings) {
      const parsed = config.repos === undefined ? null : parseReposConfig(config);
      if (parsed && !parsed.ok) {
        (this.options.warn ?? console.warn)(`[repos] ${project}: repos: is invalid, the ready guard reads only ${review.settings.repo}: ${parsed.errors.join("; ")}`);
      }
      const shared = parsed?.ok === true && parsed.repos.length > 0 ? parsed.repos : null;
      const { settings } = review;
      const repos = shared ?? [{ repo: settings.repo, default: true, base: settings.defaultBranch, ciCounts: true, refs: [] }];
      const hosts = new RepoHosts({
        repos,
        apiUrl: settings.apiUrl,
        token: tokenFrom(settings.tokenEnv, settings.tokenCmd, this.options.env ?? process.env),
        fetch: this.options.fetch,
        timeoutMs: this.options.timeoutMs ?? 20_000,
        now: this.options.now,
      });
      built = { config, settings, repos, legacy: shared === null, hosts };
      this.built.set(project, built);
    }
    const { hosts, repos, legacy } = built;
    const reviewRepo = review.settings.repo.toLowerCase();
    return {
      repos,
      legacy,
      facts: (repo, pr) => (repo.toLowerCase() === reviewRepo ? review.readyFacts(pr) : readyFactsFromHost(hosts.host(repo), pr)),
    };
  }
}
