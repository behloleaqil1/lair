/**
 * Placement probes: the only places placement touches the system. Commands
 * (machine probes, load commands, the project's move command) go through the
 * watchdog's CommandRunner (execFile, argv only, never a shell, with a
 * timeout); the time comes from a Clock; queue and result files are read
 * through QueueFiles, with bounded reads. Tests replace the runner and the
 * clock, and use real files in a temp dir.
 */
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, statSync } from "fs";
import { ExecFileRunner, systemClock, type Clock, type CommandRunner } from "../watchdog/probes.js";

export type { CommandRunner, CommandOutput, RunOptions } from "../watchdog/probes.js";

export interface FileInfo {
  mtimeMs: number;
  /** When the file's name or metadata last changed: a rename (a runner's claim) sets it */
  ctimeMs: number;
  size: number;
  isFile: boolean;
}

/** Bounded, read-only file access. Every read is a regular file only, opened without blocking. */
export interface QueueFiles {
  /** Entry names in a directory, at most `max`; [] when it can't be read */
  list(dir: string, max: number): string[];
  stat(path: string): FileInfo | null;
  /** The first `maxBytes` of a regular file, or null */
  head(path: string, maxBytes: number): string | null;
  /** The last `maxBytes` of a regular file, or null */
  tail(path: string, maxBytes: number): string | null;
}

export interface PlacementProbes {
  runner: CommandRunner;
  clock: Pick<Clock, "now">;
  files: QueueFiles;
}

function readPart(path: string, maxBytes: number, from: "head" | "tail"): string | null {
  let fd: number | null = null;
  try {
    // O_NONBLOCK: a FIFO planted where a file should be can't hang the server
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const length = Math.max(0, Math.min(st.size, maxBytes));
    const buffer = Buffer.alloc(length);
    const position = from === "head" ? 0 : st.size - length;
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export class NodeQueueFiles implements QueueFiles {
  list(dir: string, max: number): string[] {
    try {
      const names = readdirSync(dir);
      return names.length > max ? names.slice(0, max) : names;
    } catch {
      return [];
    }
  }

  stat(path: string): FileInfo | null {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, isFile: st.isFile() };
    } catch {
      return null;
    }
  }

  head(path: string, maxBytes: number): string | null {
    return readPart(path, maxBytes, "head");
  }

  tail(path: string, maxBytes: number): string | null {
    return readPart(path, maxBytes, "tail");
  }
}

/** The real probes. */
export function systemPlacementProbes(commandTimeoutMs = 60_000): PlacementProbes {
  return { runner: new ExecFileRunner(commandTimeoutMs), clock: systemClock, files: new NodeQueueFiles() };
}
