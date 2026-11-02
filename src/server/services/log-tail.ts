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
import { basename } from "path";
import { readTail, type TailRead } from "./async-fs.js";
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

/** The last `maxBytes` of a regular file (no symlink), with its size and time; null when it is not one. */
export function readTailBytes(path: string, maxBytes: number = MAX_TAIL_BYTES): Promise<TailRead | null> {
  return readTail(path, maxBytes, true);
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
export async function readLogTail(path: string, count: number = DEFAULT_TAIL_LINES): Promise<LogTailView | null> {
  const read = await readTailBytes(path);
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
