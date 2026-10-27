/**
 * Reading and writing project files for Settings: never through a symlink,
 * only regular files, and every write atomic (a temporary file in the same
 * directory, fsync, rename, fsync of the directory).
 */
import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "fs";
import { basename, dirname, join } from "path";
import { readRegularFile } from "../read-file.js";

/** A file Settings refuses to read or write (HTTP 400, nothing written). */
export class UnsafeFileError extends Error {
  readonly statusCode = 400;
  readonly code = "unsafe_file";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** `dir` is a real directory (not a symlink to one); with `create`, made (mode 0700) when it is missing. */
export function checkDirectory(dir: string, shown: string, create = false): void {
  let stats = lstatOrNull(dir);
  if (!stats && create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stats = lstatOrNull(dir);
  }
  if (!stats) throw new UnsafeFileError(`${shown} does not exist`);
  if (stats.isSymbolicLink()) throw new UnsafeFileError(`${shown} is a symlink; Settings never writes through one`);
  if (!stats.isDirectory()) throw new UnsafeFileError(`${shown} is not a directory`);
}

/** Why a path is not a regular file Settings may use, or null (also null when it doesn't exist). */
export function fileProblem(path: string, shown: string): string | null {
  const stats = lstatOrNull(path);
  if (!stats) return null;
  if (stats.isSymbolicLink()) return `${shown} is a symlink; Settings never reads or writes through one`;
  if (!stats.isFile()) return `${shown} is not a regular file`;
  return null;
}

/**
 * The text of a regular file, or null when it doesn't exist. Read with one
 * open, O_NOFOLLOW (src/server/read-file.ts): a symlink, a FIFO or a
 * directory is refused, also one that appears after the check here.
 */
export function readProjectFile(path: string, shown: string, maxBytes: number): string | null {
  const problem = fileProblem(path, shown);
  if (problem) throw new UnsafeFileError(problem);
  try {
    return readRegularFile(path, { maxBytes, noFollow: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    const text = e instanceof Error ? e.message : String(e);
    throw new UnsafeFileError(text.split(path).join(shown));
  }
}

/**
 * Replace `path` with `text` atomically. The temporary file is created next
 * to it (O_EXCL), gets the old file's mode (else `mode`), is fsynced and
 * renamed over the target; a rename replaces a directory entry, so a symlink
 * there is replaced, never written through. `beforeRename` runs last, for a
 * final check (it throws to cancel; the temporary file is removed).
 */
export function writeFileAtomic(
  path: string,
  text: string,
  options: { mode?: number; beforeRename?: () => void } = {},
): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const existing = lstatOrNull(path);
  const mode = existing?.isFile() ? existing.mode & 0o777 : (options.mode ?? 0o600);
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      fchmodSync(fd, mode);
      const bytes = Buffer.from(text, "utf-8");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    options.beforeRename?.();
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some file systems can't fsync a directory; the rename is still atomic
  }
}
