/**
 * Bounded, asynchronous file reads for request handlers and timer ticks
 * (issue #245). A synchronous fs call runs on the event loop: on a saturated
 * disk one readdir of a folder of thousands of files, or one read of a
 * large log, stalls every request and timer for seconds. These helpers go
 * through fs/promises (the libuv thread pool), and every read is bounded:
 * - a file is opened without blocking (O_NONBLOCK: a FIFO where a file
 *   should be can't hang anything), checked on the open descriptor to be a
 *   regular file, and read up to a byte cap;
 * - a listing stops at an entry cap and yields to the event loop between
 *   batches (the batching follows the DirCache of PR #277);
 * - concurrent listings of one folder share one read (SingleFlight), and
 *   many small reads run a few at a time (mapLimit), so a burst of requests
 *   can't fill the thread pool.
 */
import { constants, type Stats } from "fs";
import { lstat, open, opendir, stat } from "fs/promises";

const NONBLOCK = constants.O_NONBLOCK ?? 0;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The most entries a listing returns unless the caller says otherwise */
export const MAX_LIST_ENTRIES = 100_000;
/** Entries read before a listing yields to the event loop */
const LIST_BATCH = 500;

export interface TailRead {
  text: string;
  /** The file's size when it was read */
  size: number;
  mtime: Date;
  /** The file is larger than what was read: the text starts mid-file */
  partial: boolean;
}

/**
 * The last `maxBytes` of a regular file as UTF-8, with its size and time;
 * null when it is missing, unreadable or not a regular file. `noFollow`
 * refuses a symlink as the last path component.
 */
export async function readTail(path: string, maxBytes: number, noFollow = false): Promise<TailRead | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NONBLOCK | (noFollow ? NOFOLLOW : 0));
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    const length = Math.min(st.size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(buffer, done, length - done, st.size - length + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return { text: buffer.subarray(0, done).toString("utf-8"), size: st.size, mtime: st.mtime, partial: st.size > length };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The last `maxBytes` of a regular file as text, or null (see readTail). */
export async function readTailText(path: string, maxBytes: number, noFollow = false): Promise<string | null> {
  return (await readTail(path, maxBytes, noFollow))?.text ?? null;
}

/**
 * A whole regular file of at most `maxBytes` as text; null when it is
 * missing, unreadable, not a regular file, or larger than that.
 */
export async function readSmallFile(path: string, maxBytes: number): Promise<string | null> {
  const read = await readTail(path, maxBytes + 1);
  return read && read.size <= maxBytes && !read.partial ? read.text : null;
}

/**
 * The names in a folder, in the order the OS lists them (as readdir), at
 * most `maxEntries`; [] when it is missing or unreadable. What was read
 * before an error stands.
 */
export async function listDir(path: string, maxEntries = MAX_LIST_ENTRIES): Promise<string[]> {
  const names: string[] = [];
  let dir;
  try {
    dir = await opendir(path, { bufferSize: 128 });
  } catch {
    return names;
  }
  try {
    for await (const entry of dir) {
      names.push(entry.name);
      if (names.length >= maxEntries) break;
      if (names.length % LIST_BATCH === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  } catch {
    // What was read before the error stands
  } finally {
    // A for-await that ran to the end (or broke off) closed it already
    try {
      await dir.close();
    } catch {
      // Already closed
    }
  }
  return names;
}

/** stat (following a symlink), or null when the path can't be looked at. */
export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** lstat (a symlink itself), or null when the path can't be looked at. */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** fn over items, at most `limit` at a time; results in the items' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/**
 * One read at a time per key: a caller that asks while a read of the same
 * key is in flight gets that read's result, so concurrent requests never
 * list one folder twice at once. Nothing is kept once it settles.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, read: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const started = read().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }
}
