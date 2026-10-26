/**
 * Watchdog probes: the only places the watchdog touches the system.
 *
 * Detectors, playbooks and executors read processes, files, commands and the
 * time through these four small interfaces, so tests replace only this
 * boundary (a fake process table, a fake command runner, a fake clock, and
 * real files in a temp dir).
 */
import { execFile } from "child_process";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "fs";

// ============ INTERFACES ============

/** One running process, as `ps` reports it. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Seconds since the process started */
  elapsedSeconds: number;
  /** The command line split on whitespace (`ps` does not keep argv boundaries) */
  argv: string[];
  /** The command line as one string */
  command: string;
}

/** Lists the processes on this machine. */
export interface ProcessTable {
  list(): Promise<ProcessInfo[]>;
}

export interface FileStat {
  mtimeMs: number;
  isDirectory: boolean;
}

/** File reads (and the one append the escalation writer needs). */
export interface FileSystem {
  /** null when the path does not exist or cannot be read */
  stat(path: string): FileStat | null;
  /** Entry names in a directory; [] when it does not exist */
  list(dir: string): string[];
  /** File content (the last `maxBytes` bytes when given); null when missing */
  read(path: string, maxBytes?: number): string | null;
  append(path: string, text: string): void;
}

export interface CommandOutput {
  /** Exit code; -1 when the command could not start or timed out */
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command from an argv array. Never through a shell. */
export interface CommandRunner {
  run(argv: string[], options?: { timeoutMs?: number }): Promise<CommandOutput>;
}

export interface Clock {
  /** Milliseconds since the epoch */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Probes {
  processes: ProcessTable;
  fs: FileSystem;
  runner: CommandRunner;
  clock: Clock;
}

// ============ REAL IMPLEMENTATIONS ============

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** execFile as a CommandRunner: argv[0] is the program, no shell. */
export class ExecFileRunner implements CommandRunner {
  constructor(private defaultTimeoutMs = 120_000) {}

  run(argv: string[], options: { timeoutMs?: number } = {}): Promise<CommandOutput> {
    const [file, ...args] = argv;
    if (!file) {
      return Promise.resolve({ code: -1, stdout: "", stderr: "empty command" });
    }
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: options.timeoutMs ?? this.defaultTimeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf-8",
          shell: false,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : -1;
          resolve({
            code: error.killed ? -1 : code,
            stdout: stdout ?? "",
            stderr: stderr || error.message,
          });
        },
      );
    });
  }
}

/** `ps -A -ww -o pid=,ppid=,etime=,args=` (works on Linux and macOS). */
export const PS_ARGV = ["ps", "-A", "-ww", "-o", "pid=,ppid=,etime=,args="];

export class PsProcessTable implements ProcessTable {
  constructor(private runner: CommandRunner = new ExecFileRunner(10_000)) {}

  async list(): Promise<ProcessInfo[]> {
    const out = await this.runner.run(PS_ARGV, { timeoutMs: 10_000 });
    if (out.code !== 0) {
      throw new Error(`ps failed (${out.code}): ${out.stderr.trim()}`);
    }
    return parsePsOutput(out.stdout);
  }
}

/**
 * Parse `ps -o pid=,ppid=,etime=,args=` output. Lines that don't parse are
 * skipped.
 */
export function parsePsOutput(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/);
    if (!match) continue;
    const elapsed = parseElapsed(match[3]);
    if (elapsed === null) continue;
    const command = match[4];
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsedSeconds: elapsed,
      argv: command.split(/\s+/),
      command,
    });
  }
  return processes;
}

/** Parse a `ps` etime value: [[dd-]hh:]mm:ss. Returns seconds or null. */
export function parseElapsed(value: string): number | null {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

export class NodeFileSystem implements FileSystem {
  stat(path: string): FileStat | null {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  }

  list(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  read(path: string, maxBytes?: number): string | null {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const length = maxBytes !== undefined ? Math.min(size, maxBytes) : size;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf-8");
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  append(path: string, text: string): void {
    appendFileSync(path, text);
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The real probes. */
export function systemProbes(commandTimeoutMs = 120_000): Probes {
  return {
    processes: new PsProcessTable(),
    fs: new NodeFileSystem(),
    runner: new ExecFileRunner(commandTimeoutMs),
    clock: systemClock,
  };
}
