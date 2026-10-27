/**
 * The end of a log file, bounded, for the dashboard's owner-only log views.
 *
 * Logs are written by agents and gate runs, so they are untrusted input of
 * any size and shape: at most MAX_TAIL_BYTES are read from the end, at most
 * MAX_TAIL_LINES lines are kept, each cut to MAX_TAIL_LINE_LENGTH characters
 * after colour codes are removed, and credentials of a known shape are
 * masked (delivery's redact()). The file is opened without following a
 * symlink and without blocking (a FIFO where a log should be can't hang
 * the server), and only a regular file is read.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { basename } from "path";
import { redact } from "../delivery/redact.js";
import type { LogTailView } from "../../shared/dashboard-types.js";

export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 1000;
export const MAX_TAIL_BYTES = 128 * 1024;
export const MAX_TAIL_LINE_LENGTH = 2000;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** The number of lines asked for, within 1..MAX_TAIL_LINES (DEFAULT_TAIL_LINES when absent or not a number). */
export function clampLines(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_TAIL_LINES;
  return Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(n)));
}

/** The last `maxBytes` of a regular file, with its size and time; null when it is not one. */
export function readTailBytes(
  path: string,
  maxBytes: number = MAX_TAIL_BYTES,
): { text: string; size: number; mtime: Date; partial: boolean } | null {
  let fd: number | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stat.size - length);
    return {
      text: buffer.subarray(0, read).toString("utf-8"),
      size: stat.size,
      mtime: stat.mtime,
      partial: stat.size > length,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The last `count` lines of `text`, cleaned and bounded. `partial` says the
 * text starts mid-file, so its first line is a fragment and is dropped.
 */
export function tailLines(text: string, count: number, partial = false): { lines: string[]; truncated: boolean } {
  const all = text.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  if (partial && all.length > 0) all.shift();
  const keep = Math.min(MAX_TAIL_LINES, Math.max(1, count));
  const lines = all.slice(-keep).map((line) => redact(line.length > MAX_TAIL_LINE_LENGTH ? line.slice(0, MAX_TAIL_LINE_LENGTH) : line));
  return { lines, truncated: partial || all.length > lines.length };
}

/** A log file's tail as the dashboard shows it, or null when there is no such regular file. */
export function readLogTail(path: string, count: number = DEFAULT_TAIL_LINES): LogTailView | null {
  const read = readTailBytes(path);
  if (!read) return null;
  const { lines, truncated } = tailLines(read.text, count, read.partial);
  return {
    file: basename(path),
    lines,
    truncated,
    sizeBytes: read.size,
    modifiedAt: read.mtime.toISOString(),
  };
}
