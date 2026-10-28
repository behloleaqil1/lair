/**
 * Shared process snapshot: one ps call per interval for all modules.
 *
 * The watchdog, agents and health checks all need the process table. Before
 * this, each called ps itself, and under load those calls piled up. Now one
 * AsyncCache holds the snapshot; every module reads from it.
 *
 * A failed ps keeps the last good snapshot, marked stale. A ps that times out
 * after the child exited (the event loop was blocked) counts as success if
 * the output is valid.
 */
import { execFile } from "child_process";
import type { ProcessInfo } from "../watchdog/probes.js";
import { parsePsOutput, PS_ARGV, PS_LINE_MAX } from "../watchdog/probes.js";
import { AsyncCache, type CacheEntry } from "./async-cache.js";

export interface ProcessSnapshotEntry {
  /** The process list */
  processes: ProcessInfo[];
  /** When the snapshot was taken (ms since epoch) */
  takenAt: number;
  /** Whether the snapshot is stale (refresh failed or timed out) */
  stale: boolean;
  /** Age of the snapshot in milliseconds */
  ageMs: number;
  /** The error if the last refresh failed */
  error?: string;
}

export interface ProcessCacheOptions {
  /** How often to refresh the cache in the background (ms); default 5_000 */
  refreshIntervalMs?: number;
  /** Maximum age before the cache is considered stale (ms); default 10_000 */
  maxAgeMs?: number;
  /** Timeout for the ps command (ms); default 15_000 */
  psTimeoutMs?: number;
  /** Maximum output from ps (bytes); default 64 MiB */
  psMaxBytes?: number;
  /** A clock for testing */
  clock?: () => number;
}

/**
 * Max output from ps: a busy machine can have many processes with long
 * argument lists (JVM classpaths, build commands). 64 MiB is generous.
 */
const DEFAULT_PS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Run ps and parse its output. Streams the output to handle large sizes
 * without throwing maxBuffer errors.
 */
async function runPs(timeoutMs: number, maxBytes: number): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = PS_ARGV;
    if (!file) {
      reject(new Error("empty ps command"));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;

    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        encoding: "buffer",
        shell: false,
      },
      (error, stdout) => {
        // If the child exited with output but the timer fired after, treat
        // it as success: the event loop was blocked, not ps.
        if (error && timedOut && stdout && stdout.length > 0) {
          try {
            const output = stdout.toString("utf-8");
            const processes = parsePsOutput(output);
            if (processes.length > 0) {
              resolve(processes);
              return;
            }
          } catch {
            // Fall through to error handling
          }
        }

        if (error) {
          if (error.killed) {
            timedOut = true;
            reject(new Error(`ps timed out after ${timeoutMs}ms`));
          } else {
            reject(new Error(`ps failed: ${error.message}`));
          }
          return;
        }

        try {
          const output = stdout.toString("utf-8");
          const processes = parsePsOutput(output);
          resolve(processes);
        } catch (e) {
          reject(new Error(`Failed to parse ps output: ${e instanceof Error ? e.message : String(e)}`));
        }
      },
    );

    // Track if we're timing out for the callback
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    child.once("close", () => {
      clearTimeout(timer);
    });
  });
}

/**
 * A shared process cache that all modules can read from.
 */
export class ProcessCache {
  private readonly cache: AsyncCache<ProcessInfo[]>;
  private readonly refreshIntervalMs: number;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ProcessCacheOptions = {}) {
    const psTimeoutMs = options.psTimeoutMs ?? 15_000;
    const maxBytes = options.psMaxBytes ?? DEFAULT_PS_MAX_BYTES;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
    this.clock = options.clock ?? (() => Date.now());

    this.cache = new AsyncCache({
      refresh: () => runPs(psTimeoutMs, maxBytes),
      maxAgeMs: options.maxAgeMs ?? 10_000,
      refreshTimeoutMs: psTimeoutMs + 1000, // A bit more than ps timeout
      clock: this.clock,
    });
  }

  /**
   * Start background refreshes at the configured interval.
   */
  start(): void {
    if (this.timer) return;
    // Trigger an initial refresh
    this.cache.triggerRefresh();
    this.timer = setInterval(() => {
      this.cache.triggerRefresh();
    }, this.refreshIntervalMs);
    // Don't block process exit
    this.timer.unref();
  }

  /**
   * Stop background refreshes.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get the process snapshot, refreshing if stale.
   */
  async get(): Promise<ProcessSnapshotEntry> {
    const entry = await this.cache.get();
    return {
      processes: entry.value,
      takenAt: entry.refreshedAt,
      stale: entry.stale,
      ageMs: entry.ageMs,
      error: entry.error,
    };
  }

  /**
   * Get the cached snapshot without triggering a refresh.
   * Returns undefined if no snapshot has been taken yet.
   */
  peek(): ProcessSnapshotEntry | undefined {
    const entry = this.cache.peek();
    if (!entry) return undefined;
    return {
      processes: entry.value,
      takenAt: entry.refreshedAt,
      stale: entry.stale,
      ageMs: entry.ageMs,
      error: entry.error,
    };
  }

  /**
   * Trigger a background refresh without waiting.
   */
  triggerRefresh(): void {
    this.cache.triggerRefresh();
  }

  /**
   * Whether a refresh is currently in progress.
   */
  get refreshing(): boolean {
    return this.cache.refreshing;
  }

  /**
   * The age of the current snapshot in milliseconds, or null if none.
   */
  get ageMs(): number | null {
    return this.cache.ageMs;
  }
}

/** The singleton process cache, initialized by the server. */
let sharedCache: ProcessCache | null = null;

/**
 * Get the shared process cache. Creates one if it doesn't exist.
 * The server should call initProcessCache() at startup with options.
 */
export function getProcessCache(): ProcessCache {
  if (!sharedCache) {
    sharedCache = new ProcessCache();
  }
  return sharedCache;
}

/**
 * Initialize the shared process cache with options.
 * Should be called once at server startup.
 */
export function initProcessCache(options?: ProcessCacheOptions): ProcessCache {
  if (sharedCache) {
    sharedCache.stop();
  }
  sharedCache = new ProcessCache(options);
  return sharedCache;
}

/**
 * Dispose of the shared process cache.
 * Should be called at server shutdown.
 */
export function disposeProcessCache(): void {
  if (sharedCache) {
    sharedCache.stop();
    sharedCache = null;
  }
}
