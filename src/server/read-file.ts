/**
 * Read a config file safely: open it once (never blocking on a FIFO), check
 * on the open descriptor that it is a regular file (so what was checked is
 * what is read), and read at most `maxBytes`.
 */
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "fs";

export interface ReadOptions {
  maxBytes: number;
  /** Refuse a symbolic link as the last path component (O_NOFOLLOW) */
  noFollow?: boolean;
  /** Called with the open file's stat before it is read; throw to refuse it */
  check?: (stat: Stats) => void;
}

export function readRegularFile(path: string, options: ReadOptions): string {
  // O_NONBLOCK: opening a FIFO for reading must not wait for a writer
  const flags =
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (options.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${path} is a symbolic link`);
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > options.maxBytes) throw new Error(`${path} is larger than ${Math.floor(options.maxBytes / 1024)} KiB`);
    options.check?.(stat);
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > options.maxBytes) throw new Error(`${path} is larger than ${Math.floor(options.maxBytes / 1024)} KiB`);
    }
    return buffer.subarray(0, length).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
