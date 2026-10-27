/**
 * The planner's file access: bounded reads that stay inside configured roots
 * (also once symlinks are resolved), and the atomic write of the tasks file.
 * Opening and reading regular files is fill's code (agents/fill.ts).
 */
import { createHash, randomUUID } from "crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { openRegular, readAt } from "../agents/fill.js";
import { isInside } from "./config.js";

export const sha256 = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ReadResult = { ok: true; text: string; bytes: number; real: string } | { ok: false; reason: string };

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Where `path` really is, when it and its real path are both inside one of
 * `roots`: a symlink (anywhere on the path) that leads out is refused.
 */
export function checkedPath(path: string, roots: string[]): { ok: true; real: string } | { ok: false; reason: string } {
  const absolute = resolve(path);
  if (!roots.some((root) => isInside(resolve(root), absolute))) {
    return { ok: false, reason: `${absolute} is outside the configured roots (${roots.join(", ")})` };
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? `${absolute} does not exist` : `${absolute} cannot be read (${code ?? message(e)})` };
  }
  if (!roots.some((root) => isInside(realRoot(root), real))) {
    return { ok: false, reason: `${absolute} is a symlink out of the configured roots (to ${real})` };
  }
  return { ok: true, real };
}

/**
 * Read a regular file inside `roots`, never following a symlink as its last
 * component (checkedPath resolved those). "whole": the file, refused when it
 * is larger than maxBytes; "tail": its last maxBytes, from the first whole
 * line.
 */
export function readInside(path: string, roots: string[], maxBytes: number, mode: "whole" | "tail"): ReadResult {
  const checked = checkedPath(path, roots);
  if (!checked.ok) return checked;
  const opened = openRegular(checked.real, true);
  if ("error" in opened) return { ok: false, reason: `${path} ${opened.error}` };
  try {
    if (mode === "whole" && opened.size > maxBytes) {
      return { ok: false, reason: `${path} is larger than ${maxBytes} bytes (${opened.size})` };
    }
    const start = Math.max(0, opened.size - maxBytes);
    let text = readAt(opened.fd, start, opened.size - start).toString("utf-8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return { ok: true, text, bytes: opened.size, real: checked.real };
  } catch (e) {
    return { ok: false, reason: `${path} cannot be read (${message(e)})` };
  } finally {
    closeSync(opened.fd);
  }
}

/** The tasks file as Lair may rewrite it: a regular file, not a symlink, at most maxBytes. */
export function readTasksFile(path: string, maxBytes: number): ReadResult {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? `${path} does not exist` : `${path} cannot be read (${code ?? message(e)})` };
  }
  if (isLink) return { ok: false, reason: `${path} is a symlink: Lair reads and writes the tasks file only as a regular file` };
  const opened = openRegular(path, true);
  if ("error" in opened) return { ok: false, reason: `${path} ${opened.error}` };
  try {
    if (opened.size > maxBytes) return { ok: false, reason: `${path} is larger than ${maxBytes} bytes (${opened.size})` };
    return { ok: true, text: readAt(opened.fd, 0, opened.size).toString("utf-8"), bytes: opened.size, real: path };
  } catch (e) {
    return { ok: false, reason: `${path} cannot be read (${message(e)})` };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Replace the tasks file with `text`: a new file in the same directory
 * (exclusive, same mode), written and fsynced, then renamed over it. Only
 * when the file still has the content whose hash is `expectHash`, so an edit
 * made since it was read is never lost.
 */
export function writeTasksFile(path: string, text: string, expectHash: string, maxBytes: number): { ok: true } | { ok: false; reason: string } {
  const current = readTasksFile(path, maxBytes);
  if (!current.ok) return current;
  if (sha256(current.text) !== expectHash) return { ok: false, reason: `${path} changed since Lair read it` };
  let mode = 0o644;
  try {
    mode = lstatSync(path).mode & 0o777;
  } catch {
    // keep the default
  }
  const tmp = join(dirname(path), `.${basename(path)}.lair-${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    const bytes = Buffer.from(text, "utf-8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    return { ok: true };
  } catch (e) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    return { ok: false, reason: `${path} could not be written (${message(e)})` };
  }
}

/** Remove control characters, collapse whitespace, cut to `max` characters. One line. */
export function clean(text: unknown, max: number): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  let out = "";
  for (const ch of raw.slice(0, max * 4)) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  const flat = out.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}
