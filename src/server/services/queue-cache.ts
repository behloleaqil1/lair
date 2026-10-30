/**
 * Queue file cache: parse once per change, serve from memory.
 *
 * The queue file used to be read and parsed synchronously on every dashboard
 * request (and once per agent in some views). With a 1 MB file on a loaded
 * machine each read blocked the event loop for seconds (issue #160). Now:
 *
 * - the file is read once per change, with async IO, and at most `maxBytes`
 *   of its end (an older start is dropped, never the newest lines);
 * - the parsed lines stay in memory; per-agent and per-type slices are built
 *   from them, so a request does no IO at all;
 * - one refresh runs at a time; a change that arrives meanwhile queues one
 *   more refresh;
 * - a failed read keeps the last good lines and reports the error.
 *
 * Changes are seen by a folder watch (so a replaced file is seen too) and by
 * a slow size/mtime check, for systems where watching is not reliable.
 */
import { constants, watch, type FSWatcher } from "fs";
import { open, stat } from "fs/promises";
import { basename, dirname } from "path";
import type { QueueLine, QueueLineType } from "../../shared/types.js";
import { parseQueueFile, filterByAgent, filterByType } from "../parsers/queue.js";

/** At most this much of the end of the queue file is read (4 MB, as fill reads it) */
export const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

/** Changes are coalesced this long before the file is read */
const DEBOUNCE_MS = 100;

/** The slow check for changes a watcher missed */
const CHECK_MS = 5_000;

/** The filesystem boundary: the file's end (at most maxBytes) and its size and mtime */
export interface QueueFileReader {
  read(path: string, maxBytes: number): Promise<{ text: string; size: number; mtimeMs: number; truncated: boolean }>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
}

/** Reads the real file without blocking: a FIFO is refused, not waited on */
export const fsQueueFileReader: QueueFileReader = {
  async read(path, maxBytes) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("the queue file is not a regular file");
      const truncated = info.size > maxBytes;
      const start = truncated ? info.size - maxBytes : 0;
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, start + length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      let text = buffer.subarray(0, length).toString("utf-8");
      // The first line of a tail is probably cut: drop it
      if (truncated) text = text.slice(text.indexOf("\n") + 1);
      return { text, size: info.size, mtimeMs: info.mtimeMs, truncated };
    } finally {
      await handle.close();
    }
  },
  async stat(path) {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
};

export interface QueueCacheOptions {
  reader?: QueueFileReader;
  clock?: () => number;
  debounceMs?: number;
  checkMs?: number;
  maxBytes?: number;
}

export interface QueueCacheState {
  /** When the lines were last read (epoch ms); 0 before the first read */
  refreshedAt: number;
  /** Size of the queue file at that read (bytes) */
  size: number;
  /** The read dropped the start of the file (it is larger than the cap) */
  truncated: boolean;
  /** Why the last read failed; the lines are the last good ones */
  error?: string;
}

/** One project's queue file, parsed once per change. */
export class QueueCache {
  private lines: QueueLine[] = [];
  private state: QueueCacheState = { refreshedAt: 0, size: 0, truncated: false };
  private seen = { size: -1, mtimeMs: -1 };
  private watcher: FSWatcher | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly reader: QueueFileReader;
  private readonly clock: () => number;
  private readonly debounceMs: number;
  private readonly checkMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly path: string,
    options: QueueCacheOptions = {},
  ) {
    this.reader = options.reader ?? fsQueueFileReader;
    this.clock = options.clock ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.checkMs = options.checkMs ?? CHECK_MS;
    this.maxBytes = options.maxBytes ?? MAX_QUEUE_BYTES;
  }

  /** Load the file once and start watching it. */
  async start(): Promise<void> {
    if (this.stopped) return;
    this.startWatching();
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  /** The parsed lines (never read from disk here). The array is replaced on a change, never edited. */
  getLines(): QueueLine[] {
    return this.lines;
  }

  getByAgent(agentId: string): QueueLine[] {
    return filterByAgent(this.lines, agentId);
  }

  getByType(types: QueueLineType[]): QueueLine[] {
    return filterByType(this.lines, types);
  }

  status(): QueueCacheState {
    return { ...this.state };
  }

  /** True once a read has finished (even a failed one, so a missing file doesn't hold requests) */
  get settled(): boolean {
    return this.state.refreshedAt !== 0 || this.state.error !== undefined;
  }

  /** Resolves when the first read has finished. */
  ready(): Promise<void> {
    return this.settled ? Promise.resolve() : (this.inFlight ?? this.refresh());
  }

  /** Read the file now. One read at a time: a call during a read waits for it and for one more read after it. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.again = false;
        await this.readOnce();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async readOnce(): Promise<void> {
    try {
      const file = await this.reader.read(this.path, this.maxBytes);
      this.lines = parseQueueFile(file.text);
      this.seen = { size: file.size, mtimeMs: file.mtimeMs };
      this.state = { refreshedAt: this.clock(), size: file.size, truncated: file.truncated };
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      // A missing file is an empty queue; any other failure keeps the last good lines
      if (missing) {
        this.lines = [];
        this.seen = { size: -1, mtimeMs: -1 };
      }
      this.state = {
        ...this.state,
        refreshedAt: missing ? this.clock() : this.state.refreshedAt,
        error: missing ? undefined : e instanceof Error ? e.message : String(e),
      };
    }
  }

  private startWatching(): void {
    try {
      // The folder, not the file, so a rename over the file is seen
      const name = basename(this.path);
      this.watcher = watch(dirname(this.path), { persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined || filename.toString() === name) this.scheduleRefresh();
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
    this.checkTimer = setInterval(() => void this.checkForChange(), this.checkMs);
    this.checkTimer.unref();
  }

  private async checkForChange(): Promise<void> {
    if (this.stopped) return;
    try {
      const now = await this.reader.stat(this.path);
      if (now.size !== this.seen.size || now.mtimeMs !== this.seen.mtimeMs) this.scheduleRefresh();
    } catch {
      if (this.seen.size !== -1) this.scheduleRefresh();
    }
  }

  private scheduleRefresh(): void {
    if (this.stopped || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }
}

/** One cache per project's queue file. */
export class QueueCacheManager {
  private caches = new Map<string, { path: string; cache: QueueCache }>();

  constructor(private readonly options: QueueCacheOptions = {}) {}

  /** The project's cache, started on first use; replaced when the project's queue file path changed. */
  get(project: string, queueFile: string): QueueCache {
    const have = this.caches.get(project);
    if (have && have.path === queueFile) return have.cache;
    have?.cache.stop();
    const cache = new QueueCache(queueFile, this.options);
    void cache.start();
    this.caches.set(project, { path: queueFile, cache });
    return cache;
  }

  stopAll(): void {
    for (const { cache } of this.caches.values()) cache.stop();
    this.caches.clear();
  }
}
