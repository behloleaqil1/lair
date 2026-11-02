/**
 * Async directory cache backed by DirWatch (issue #245).
 *
 * A DirCache maintains an in-memory view of a directory's entries (files and
 * subdirectories). It starts with a one-time async readdir, then stays in
 * sync through the DirWatch's events. Lookups never touch the filesystem.
 *
 * The cache is designed for the tick path (fill, agents) where thousands of
 * files made synchronous readdir calls block the event loop for seconds.
 * With the cache, a tick looks up entries from memory in microseconds.
 *
 * Usage:
 *   const cache = new DirCache(dir, { accept: (name) => name.endsWith('.req') });
 *   await cache.start();
 *   const entries = cache.entries();      // instant lookup
 *   const exists = cache.has('foo.req');  // instant lookup
 *   cache.stop();
 */
import { opendir, stat } from "fs/promises";
import { DirWatch, type DirEntryEvent, type DirWatchOptions } from "./dir-watch.js";

/** An entry in the cache: its name and whether it is a directory. */
export interface CachedEntry {
  name: string;
  isDirectory: boolean;
}

export interface DirCacheOptions {
  /** Whether an entry (its name in the folder) is cached (default: all entries). */
  accept?: (name: string) => boolean;
  /** DirWatch options passed through (debounceMs, pollMs, etc.). */
  watchOptions?: Partial<Omit<DirWatchOptions, "accept" | "onEvent" | "onError">>;
  /** Called when the watch reports an error. */
  onError?: (message: string) => void;
}

/** How many entries to read before yielding to the event loop during initial load. */
const BATCH_SIZE = 500;

export class DirCache {
  private readonly entries = new Map<string, CachedEntry>();
  private watcher: DirWatch | null = null;
  private ready = false;
  private stopped = false;
  private readonly accept: (name: string) => boolean;
  private readonly watchOptions: Partial<DirWatchOptions>;
  private readonly onError?: (message: string) => void;

  constructor(
    readonly dir: string,
    options: DirCacheOptions = {},
  ) {
    this.accept = options.accept ?? (() => true);
    this.watchOptions = options.watchOptions ?? {};
    this.onError = options.onError;
  }

  /** "idle" before start(), "loading" during initial read, "ready" when usable, "stopped" after stop(). */
  get state(): "idle" | "loading" | "ready" | "stopped" {
    if (this.stopped) return "stopped";
    if (this.ready) return "ready";
    if (this.watcher) return "loading";
    return "idle";
  }

  /** The number of cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Load the directory's entries asynchronously, then start the watch.
   * Returns when the initial load is complete and the cache is ready.
   * Does nothing if already started or stopped.
   */
  async start(): Promise<void> {
    if (this.stopped || this.watcher) return;

    // Start the watch before the initial read so entries created between
    // the read and the watch reaching the same point are not missed
    this.watcher = new DirWatch(this.dir, {
      ...this.watchOptions,
      accept: this.accept,
      onEvent: (event, path, name) => this.onEvent(event, name),
      onError: this.onError,
    });
    this.watcher.start();

    await this.initialLoad();
    this.ready = true;
  }

  /**
   * Read the directory entries asynchronously in batches, yielding to the
   * event loop between batches so the server stays responsive during load.
   */
  private async initialLoad(): Promise<void> {
    let handle;
    try {
      handle = await opendir(this.dir);
    } catch {
      // Directory doesn't exist or can't be read: start empty
      return;
    }
    try {
      let batch = 0;
      for await (const entry of handle) {
        if (this.stopped) break;
        if (!this.accept(entry.name)) continue;
        this.entries.set(entry.name, {
          name: entry.name,
          isDirectory: entry.isDirectory(),
        });
        batch++;
        if (batch >= BATCH_SIZE) {
          batch = 0;
          // Yield to the event loop
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Handle events from DirWatch. */
  private onEvent(event: DirEntryEvent, name: string): void {
    if (this.stopped) return;
    switch (event) {
      case "add":
        this.entries.set(name, { name, isDirectory: false });
        break;
      case "addDir":
        this.entries.set(name, { name, isDirectory: true });
        break;
      case "unlink":
      case "unlinkDir":
        this.entries.delete(name);
        break;
      case "change":
        // A change doesn't affect the directory/file type; entry stays
        break;
    }
  }

  /** Stop watching and clear the cache. */
  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.watcher?.stop();
    this.watcher = null;
    this.entries.clear();
  }

  /**
   * All cached entries. Returns an empty array before start() completes.
   * The returned array is a snapshot; mutations don't affect the cache.
   */
  list(): CachedEntry[] {
    return [...this.entries.values()];
  }

  /** All cached file names (not directories). */
  files(): string[] {
    return [...this.entries.values()].filter((e) => !e.isDirectory).map((e) => e.name);
  }

  /** All cached directory names (not files). */
  directories(): string[] {
    return [...this.entries.values()].filter((e) => e.isDirectory).map((e) => e.name);
  }

  /** Whether the cache has an entry with this name. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Get a cached entry by name, or undefined. */
  get(name: string): CachedEntry | undefined {
    return this.entries.get(name);
  }

  /** Whether a name is a file (not a directory) in the cache. */
  isFile(name: string): boolean {
    const entry = this.entries.get(name);
    return entry !== undefined && !entry.isDirectory;
  }

  /** Whether a name is a directory (not a file) in the cache. */
  isDirectory(name: string): boolean {
    const entry = this.entries.get(name);
    return entry !== undefined && entry.isDirectory;
  }
}

/**
 * A simple async file existence check by path (not from a cache).
 * For one-off checks where a full cache isn't needed.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * A simple async directory existence check by path (not from a cache).
 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}
