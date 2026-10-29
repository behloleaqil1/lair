/**
 * Cached data service: expensive operations run in the background.
 *
 * Routes read from the cache immediately. A cache older than its limit shows
 * as stale, not as an error. Each data source has its own AsyncCache with:
 * - Single-flight refresh (one at a time)
 * - Configurable max age
 * - Stale value on refresh failure
 * - Age tracking
 *
 * Part of reliability A2: dashboard probes off the request path.
 */
import { execFile } from "child_process";
import { AsyncCache, type CacheEntry } from "../core/async-cache.js";
import type { ProjectConfig, PullRequest, MergedPR } from "../../shared/types.js";

export interface CachedData<T> {
  /** The cached value */
  value: T;
  /** When the cache was refreshed (ISO string) */
  refreshedAt: string;
  /** Age of the cache in milliseconds */
  ageMs: number;
  /** Whether the cache is stale (refresh failed or past max age) */
  stale: boolean;
  /** Error message if the last refresh failed */
  error?: string;
}

function toCached<T>(entry: CacheEntry<T>): CachedData<T> {
  return {
    value: entry.value,
    refreshedAt: new Date(entry.refreshedAt).toISOString(),
    ageMs: entry.ageMs,
    stale: entry.stale,
    error: entry.error,
  };
}

export interface DataCacheOptions {
  /** Maximum age for PR cache (ms); default 60_000 */
  prMaxAgeMs?: number;
  /** Maximum age for merged PR cache (ms); default 120_000 */
  mergedPrMaxAgeMs?: number;
  /** Maximum age for git info cache (ms); default 30_000 */
  gitMaxAgeMs?: number;
  /** Timeout for gh commands (ms); default 15_000 */
  ghTimeoutMs?: number;
  /** Timeout for git commands (ms); default 5_000 */
  gitTimeoutMs?: number;
  /** A clock for testing */
  clock?: () => number;
}

/**
 * Run a command asynchronously with timeout.
 */
async function execAsync(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        encoding: "utf-8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

interface GitInfo {
  mainHead: string;
  mainDate: string;
}

/**
 * Cached data for a project's expensive operations.
 */
export class ProjectDataCache {
  private readonly prCache: AsyncCache<PullRequest[]>;
  private readonly mergedPrCache: AsyncCache<MergedPR[]>;
  private readonly gitCache: AsyncCache<GitInfo>;
  private readonly config: ProjectConfig;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: ProjectConfig, options: DataCacheOptions = {}) {
    this.config = config;
    const clock = options.clock ?? (() => Date.now());
    const ghTimeout = options.ghTimeoutMs ?? 15_000;
    const gitTimeout = options.gitTimeoutMs ?? 5_000;

    this.prCache = new AsyncCache({
      refresh: () => this.fetchPullRequests(ghTimeout),
      maxAgeMs: options.prMaxAgeMs ?? 60_000,
      refreshTimeoutMs: ghTimeout + 1000,
      clock,
    });

    this.mergedPrCache = new AsyncCache({
      refresh: () => this.fetchMergedPrs(ghTimeout),
      maxAgeMs: options.mergedPrMaxAgeMs ?? 120_000,
      refreshTimeoutMs: ghTimeout + 1000,
      clock,
    });

    this.gitCache = new AsyncCache({
      refresh: () => this.fetchGitInfo(gitTimeout),
      maxAgeMs: options.gitMaxAgeMs ?? 30_000,
      refreshTimeoutMs: gitTimeout + 1000,
      clock,
    });
  }

  /**
   * Start background refresh timers.
   */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    // Initial refresh
    this.prCache.triggerRefresh();
    this.mergedPrCache.triggerRefresh();
    this.gitCache.triggerRefresh();
    
    this.timer = setInterval(() => {
      this.prCache.triggerRefresh();
      this.mergedPrCache.triggerRefresh();
      this.gitCache.triggerRefresh();
    }, intervalMs);
    this.timer.unref();
  }

  /**
   * Stop background refresh timers.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get cached pull requests.
   */
  async getPullRequests(): Promise<CachedData<PullRequest[]>> {
    const entry = await this.prCache.get();
    return toCached(entry);
  }

  /**
   * Peek at cached pull requests without triggering refresh.
   */
  peekPullRequests(): CachedData<PullRequest[]> | undefined {
    const entry = this.prCache.peek();
    return entry ? toCached(entry) : undefined;
  }

  /**
   * Get cached merged PRs.
   */
  async getMergedPrs(): Promise<CachedData<MergedPR[]>> {
    const entry = await this.mergedPrCache.get();
    return toCached(entry);
  }

  /**
   * Peek at cached merged PRs without triggering refresh.
   */
  peekMergedPrs(): CachedData<MergedPR[]> | undefined {
    const entry = this.mergedPrCache.peek();
    return entry ? toCached(entry) : undefined;
  }

  /**
   * Get cached git info (main head and date).
   */
  async getGitInfo(): Promise<CachedData<GitInfo>> {
    const entry = await this.gitCache.get();
    return toCached(entry);
  }

  /**
   * Peek at cached git info without triggering refresh.
   */
  peekGitInfo(): CachedData<GitInfo> | undefined {
    const entry = this.gitCache.peek();
    return entry ? toCached(entry) : undefined;
  }

  private async fetchPullRequests(timeoutMs: number): Promise<PullRequest[]> {
    if (!this.config.github) return [];

    const output = await execAsync(
      "gh",
      [
        "pr",
        "list",
        "-R",
        this.config.github,
        "--json",
        "number,title,headRefName,headRefOid,mergeable,updatedAt",
      ],
      timeoutMs,
    );

    if (!output) return [];

    try {
      interface GhPr {
        number: number;
        title: string;
        headRefName: string;
        headRefOid: string;
        mergeable: string;
        updatedAt: string;
      }
      const prs = JSON.parse(output) as GhPr[];
      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        mergeable: pr.mergeable,
        updatedAt: pr.updatedAt,
        // Gate results need to be looked up separately with the sync data service
        latestGate: undefined,
        mergeReady: false,
      }));
    } catch {
      return [];
    }
  }

  private async fetchMergedPrs(timeoutMs: number): Promise<MergedPR[]> {
    if (!this.config.github) return [];

    const output = await execAsync(
      "gh",
      [
        "pr",
        "list",
        "-R",
        this.config.github,
        "--state",
        "merged",
        "--json",
        "number,title,mergedAt",
        "-L",
        "10",
      ],
      timeoutMs,
    );

    if (!output) return [];

    try {
      interface GhMergedPr {
        number: number;
        title: string;
        mergedAt: string;
      }
      const all = JSON.parse(output) as GhMergedPr[];
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return all.filter((pr) => new Date(pr.mergedAt).getTime() > cutoff);
    } catch {
      return [];
    }
  }

  private async fetchGitInfo(timeoutMs: number): Promise<GitInfo> {
    const output = await execAsync(
      "git",
      ["-C", this.config.repo, "log", "-1", "--format=%H %ci", "origin/main"],
      timeoutMs,
    );

    if (!output) {
      return { mainHead: "unknown", mainDate: "unknown" };
    }

    const parts = output.trim().split(" ");
    return {
      mainHead: parts[0]?.slice(0, 8) || "unknown",
      mainDate: parts.slice(1).join(" ") || "unknown",
    };
  }
}

/**
 * Cache manager for multiple projects.
 */
export class DataCacheManager {
  private caches = new Map<string, ProjectDataCache>();
  private options: DataCacheOptions;

  constructor(options: DataCacheOptions = {}) {
    this.options = options;
  }

  /**
   * Get or create a cache for a project.
   */
  getCache(config: ProjectConfig): ProjectDataCache {
    let cache = this.caches.get(config.name);
    if (!cache) {
      cache = new ProjectDataCache(config, this.options);
      cache.start();
      this.caches.set(config.name, cache);
    }
    return cache;
  }

  /**
   * Remove a project's cache.
   */
  removeCache(name: string): void {
    const cache = this.caches.get(name);
    if (cache) {
      cache.stop();
      this.caches.delete(name);
    }
  }

  /**
   * Stop all caches.
   */
  stopAll(): void {
    for (const cache of this.caches.values()) {
      cache.stop();
    }
    this.caches.clear();
  }
}
