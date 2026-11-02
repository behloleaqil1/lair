/**
 * Async, single-flight, bounded cache with age tracking.
 *
 * Routes and timers read from the cache; only one refresh runs at a time.
 * A failed refresh keeps the last good value, marked stale. A cache older
 * than its limit shows as stale, not as an error.
 *
 * Used by the process snapshot (one ps for all modules), the data service
 * (queue file, dragons, gates, PRs) and any other background refresher.
 */

export interface CacheEntry<T> {
  /** The cached value */
  value: T;
  /** When the value was refreshed (ms since epoch) */
  refreshedAt: number;
  /** Whether the value is known to be stale (refresh failed, or past max age) */
  stale: boolean;
  /** Age of the cache in milliseconds */
  ageMs: number;
  /** The error message if the last refresh failed */
  error?: string;
}

export interface AsyncCacheOptions<T> {
  /** How to get a fresh value; may throw */
  refresh: () => Promise<T>;
  /** Maximum age before the cache is considered stale (ms); default 60_000 */
  maxAgeMs?: number;
  /** Timeout for a single refresh call (ms); default 30_000 */
  refreshTimeoutMs?: number;
  /** A clock for testing */
  clock?: () => number;
}

/**
 * A cache that refreshes in the background with single-flight semantics.
 * Multiple callers waiting for a refresh share the same promise.
 */
export class AsyncCache<T> {
  private value: T | undefined;
  private refreshedAt: number | null = null;
  private error: string | undefined;
  private inflight: Promise<T> | null = null;
  private readonly maxAgeMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly refreshFn: () => Promise<T>;
  private readonly clock: () => number;

  constructor(options: AsyncCacheOptions<T>) {
    this.refreshFn = options.refresh;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 30_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Get the cached value, refreshing if needed or if the cache is stale.
   * Returns immediately from cache if available and fresh enough.
   */
  async get(): Promise<CacheEntry<T>> {
    const now = this.clock();
    const ageMs = this.refreshedAt === null ? Infinity : now - this.refreshedAt;
    const stale = ageMs > this.maxAgeMs;

    // Return from cache if we have a value and it's fresh enough
    if (this.value !== undefined && !stale) {
      return {
        value: this.value,
        refreshedAt: this.refreshedAt!,
        stale: false,
        ageMs,
        error: this.error,
      };
    }

    // Refresh needed; if one is already in flight, wait for it
    if (this.inflight) {
      try {
        const value = await this.inflight;
        const nowAfter = this.clock();
        return {
          value,
          refreshedAt: this.refreshedAt!,
          stale: false,
          ageMs: this.refreshedAt === null ? 0 : nowAfter - this.refreshedAt,
        };
      } catch {
        // Inflight failed; return stale value if we have one
        if (this.value !== undefined) {
          return {
            value: this.value,
            refreshedAt: this.refreshedAt!,
            stale: true,
            ageMs: this.refreshedAt === null ? Infinity : this.clock() - this.refreshedAt,
            error: this.error,
          };
        }
        throw new Error(this.error ?? "Cache refresh failed");
      }
    }

    // Start a new refresh
    try {
      const value = await this.refresh();
      return {
        value,
        refreshedAt: this.refreshedAt!,
        stale: false,
        ageMs: 0,
      };
    } catch (e) {
      // Return stale value if we have one
      if (this.value !== undefined) {
        return {
          value: this.value,
          refreshedAt: this.refreshedAt!,
          stale: true,
          ageMs: this.refreshedAt === null ? Infinity : this.clock() - this.refreshedAt,
          error: this.error,
        };
      }
      throw e;
    }
  }

  /**
   * A value refreshed after this call, never one cached before it: a refresh
   * already in flight may have started earlier, so it is waited out first.
   * Rejects when that refresh fails (no stale value stands in for it).
   */
  async fresh(): Promise<CacheEntry<T>> {
    if (this.inflight) await this.inflight.catch(() => undefined);
    const value = await this.refresh();
    const refreshedAt = this.refreshedAt ?? this.clock();
    return { value, refreshedAt, stale: false, ageMs: this.clock() - refreshedAt };
  }

  /**
   * Get the cached value without triggering a refresh.
   * Returns undefined if no value has been cached yet.
   */
  peek(): CacheEntry<T> | undefined {
    if (this.value === undefined) return undefined;
    const now = this.clock();
    const ageMs = this.refreshedAt === null ? Infinity : now - this.refreshedAt;
    return {
      value: this.value,
      refreshedAt: this.refreshedAt!,
      stale: ageMs > this.maxAgeMs || this.error !== undefined,
      ageMs,
      error: this.error,
    };
  }

  /**
   * Trigger a background refresh without waiting. If a refresh is already
   * in flight, this is a no-op.
   */
  triggerRefresh(): void {
    if (this.inflight) return;
    this.refresh().catch(() => {
      // Errors are recorded in this.error
    });
  }

  /**
   * Perform the refresh with timeout and single-flight semantics.
   */
  private async refresh(): Promise<T> {
    if (this.inflight) return this.inflight;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);

    this.inflight = (async () => {
      try {
        const value = await Promise.race([
          this.refreshFn(),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error(`Refresh timed out after ${this.refreshTimeoutMs}ms`)),
            );
          }),
        ]);
        this.value = value;
        this.refreshedAt = this.clock();
        this.error = undefined;
        return value;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        clearTimeout(timeout);
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /**
   * Clear the cache, forcing the next get() to refresh.
   */
  clear(): void {
    this.value = undefined;
    this.refreshedAt = null;
    this.error = undefined;
  }

  /**
   * Whether a refresh is currently in progress.
   */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /**
   * The age of the current cache entry in milliseconds, or null if no value.
   */
  get ageMs(): number | null {
    if (this.refreshedAt === null) return null;
    return this.clock() - this.refreshedAt;
  }
}
