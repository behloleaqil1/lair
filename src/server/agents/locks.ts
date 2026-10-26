/**
 * Pid-owned lock files.
 *
 * A lock Lair takes is a file created exclusively (it fails if the file
 * exists) holding its owner:
 *
 *   pid=1234
 *   started=2026-01-01T12:00:00.000Z
 *   owner=lair run 1a2b3c4d task example-task
 *
 * The holder is alive only when a process with that pid runs AND started at
 * that time, so a pid the system reused for another process doesn't keep a
 * dead holder's lock. Legacy locks are read too: a file or directory with
 * only a pid (`1234`, `pid=1234`, or a `<dir>/<pid_file>`), whose holder is
 * dead when the pid isn't running or started after the lock was taken; and
 * one with no pid at all, which is stale once it is `stale_minutes` old.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { parsePid } from "../watchdog/view.js";
import type { ProcessOwner, ProcessSnapshot } from "./probes.js";

const MAX_LOCK_BYTES = 4096;

export type LockFormat = "lair" | "pid" | "none";

export interface LockOwnerLabel extends ProcessOwner {
  /** Who holds it, e.g. "lair run 1a2b3c4d task example-task" */
  label: string;
}

export interface LockFile {
  path: string;
  isDirectory: boolean;
  /** Where the holder is written: the lock file, or <dir>/<pid_file> */
  holderFile: string;
  format: LockFormat;
  pid: number | null;
  startedAt: number | null;
  owner?: string;
  /** The lock's own mtime: when it was taken, for legacy locks */
  mtimeMs: number;
  content: string;
}

function readSmall(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, MAX_LOCK_BYTES);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The text of a lock Lair writes. */
export function formatLock(owner: LockOwnerLabel): string {
  const label = owner.label.replace(/[\r\n]+/g, " ");
  return `pid=${owner.pid}\nstarted=${new Date(owner.startedAt).toISOString()}\nowner=${label}\n`;
}

/** Parse a lock's text: Lair's format, a pid only, or nothing usable. */
export function parseLockContent(text: string): Pick<LockFile, "format" | "pid" | "startedAt" | "owner"> {
  const pid = parsePid(text);
  const started = text.match(/^\s*started\s*[=:]\s*(\S+)\s*$/im);
  const at = started ? Date.parse(started[1]) : Number.NaN;
  const owner = text.match(/^\s*owner\s*[=:]\s*(.*\S)\s*$/im)?.[1];
  if (pid !== null && !Number.isNaN(at)) return { format: "lair", pid, startedAt: at, owner };
  if (pid !== null) return { format: "pid", pid, startedAt: null, owner };
  return { format: "none", pid: null, startedAt: null, owner };
}

/** Read a lock (a file, or a directory with a pid file). Null when there is none. */
export function readLock(path: string, pidFile = "pid"): LockFile | null {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  const isDirectory = st.isDirectory();
  const holderFile = isDirectory ? join(path, pidFile) : path;
  const content = readSmall(holderFile) ?? "";
  return { path, isDirectory, holderFile, mtimeMs: st.mtimeMs, content, ...parseLockContent(content) };
}

/**
 * Take a free lock. False when it exists (whoever holds it). The parent
 * directory is created when missing.
 */
export function createLock(path: string, owner: LockOwnerLabel): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, formatLock(owner), { flag: "wx" });
    return true;
  } catch (e) {
    // EEXIST, or EISDIR for a lock directory: someone holds it
    if ((e as NodeJS.ErrnoException).code === "EEXIST" || existsSync(path)) return false;
    throw e;
  }
}

function sameOwner(lock: LockFile, owner: ProcessOwner, toleranceMs: number): boolean {
  return (
    lock.format === "lair" &&
    lock.pid === owner.pid &&
    lock.startedAt !== null &&
    Math.abs(lock.startedAt - owner.startedAt) <= toleranceMs
  );
}

/**
 * Hand a lock `from` holds to `to` (a `hold: run` lock goes to the agent
 * process once it runs). Atomic: the new text replaces the file in one
 * rename. False when `from` doesn't hold it.
 */
export function transferLock(path: string, from: ProcessOwner, to: LockOwnerLabel, toleranceMs = 1000): boolean {
  const lock = readLock(path);
  if (!lock || lock.isDirectory || !sameOwner(lock, from, toleranceMs)) return false;
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, formatLock(to), { flag: "wx" });
  renameSync(tmp, path);
  return true;
}

/** Remove a lock `owner` holds. False when someone else holds it. True when it is gone. */
export function releaseLock(path: string, owner: ProcessOwner, toleranceMs = 1000): boolean {
  const lock = readLock(path);
  if (!lock) return true;
  if (!sameOwner(lock, owner, toleranceMs)) return false;
  return removeLock(lock).removed;
}

/**
 * Remove a lock, safely against a race: move it aside, check that what moved
 * is the lock that was read (nobody re-took it in between), then delete it.
 * A lock that changed in between is put back.
 */
export function removeLock(lock: LockFile): { removed: boolean; detail: string } {
  const aside = `${lock.path}.broken-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(lock.path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: true, detail: "already gone" };
    throw e;
  }
  const moved = readSmall(lock.isDirectory ? join(aside, lock.holderFile.slice(lock.path.length + 1)) : aside) ?? "";
  if (moved !== lock.content) {
    // Someone took the lock after it was read: put theirs back
    try {
      if (lock.isDirectory) {
        if (!existsSync(lock.path)) renameSync(aside, lock.path);
      } else {
        linkSync(aside, lock.path);
        unlinkSync(aside);
      }
    } catch {
      // the path was taken again meanwhile: the newest holder keeps it
    }
    if (existsSync(aside)) rmSync(aside, { recursive: true, force: true });
    return { removed: false, detail: "the lock changed while it was being removed; left to its new holder" };
  }
  rmSync(aside, { recursive: true, force: true });
  return { removed: true, detail: "removed" };
}

export type LockVerdict =
  | { state: "free" }
  | { state: "held"; lock: LockFile; detail: string }
  /** No holder pid and not old enough to break yet */
  | { state: "young"; lock: LockFile; detail: string; staleAt: number }
  | { state: "stale"; lock: LockFile; reason: string };

/** Whether a lock is free, held by a live process, or stale (its holder is gone). */
export function judgeLock(lock: LockFile | null, snapshot: ProcessSnapshot, staleMinutes: number): LockVerdict {
  if (!lock) return { state: "free" };
  const now = snapshot.now;
  if (lock.pid !== null) {
    if (lock.format === "lair") {
      if (snapshot.isAlive(lock.pid, lock.startedAt)) {
        return { state: "held", lock, detail: `held by live pid ${lock.pid}${lock.owner ? ` (${lock.owner})` : ""}` };
      }
      return { state: "stale", lock, reason: `holder ${snapshot.describe(lock.pid, lock.startedAt)}` };
    }
    // A pid only: dead when not running, or when that pid started after the lock was taken
    const started = snapshot.startedAt(lock.pid);
    if (started === null) {
      return { state: "stale", lock, reason: `holder pid ${lock.pid} (from ${lock.holderFile}) is not running` };
    }
    if (started > lock.mtimeMs + 2000) {
      return {
        state: "stale",
        lock,
        reason: `pid ${lock.pid} started ${new Date(started).toISOString()}, after the lock was taken (${new Date(lock.mtimeMs).toISOString()}): a different process`,
      };
    }
    return { state: "held", lock, detail: `held by live pid ${lock.pid} (a pid-only lock)` };
  }
  const ageMinutes = (now - lock.mtimeMs) / 60000;
  const staleAt = lock.mtimeMs + staleMinutes * 60000;
  if (ageMinutes >= staleMinutes) {
    return {
      state: "stale",
      lock,
      reason: `no holder pid in ${lock.holderFile} and the lock is ${Math.round(ageMinutes)} min old (stale after ${staleMinutes} min)`,
    };
  }
  return {
    state: "young",
    lock,
    staleAt,
    detail: `no holder pid in ${lock.holderFile}; it is broken at ${new Date(staleAt).toISOString()} (${staleMinutes} min old)`,
  };
}
