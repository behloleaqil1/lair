/**
 * Host services probes: the boundary the module touches the system through.
 *
 * A command runner (probe and start commands) and a clock. Tests replace
 * them with fakes, or run the real ExecFileRunner on real processes.
 */
import { spawn, type ChildProcess } from "child_process";
import { noteCommandTimeout } from "../core/command-timeouts.js";

export interface CommandOutput {
  /** Exit code; -1 when the command could not start, timed out, wrote too much or was stopped */
  code: number;
  stdout: string;
  stderr: string;
  /** Killed because it ran past its timeout: always a failure, whatever it printed */
  timedOut?: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** The most stdout plus stderr the command may write (default 1 MB); more ends it with code -1 */
  maxBufferBytes?: number;
  /** Kills the command when it aborts */
  signal?: AbortSignal;
}

/** Runs a command from an argv array. Never through a shell. */
export interface CommandRunner {
  run(argv: string[], options?: RunOptions): Promise<CommandOutput>;
}

export interface Clock {
  /** Milliseconds since the epoch */
  now(): number;
  /** Wait `ms`, or less: resolves as soon as `signal` aborts */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface HostServicesProbes {
  runner: CommandRunner;
  clock: Clock;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
/** After its exit, how long a command's pipes may stay open (a child it left behind can hold them) */
const CLOSE_AFTER_EXIT_MS = 500;

/**
 * A command as a CommandRunner: argv[0] is the program, no shell, no stdin.
 *
 * Every run ends within its timeout plus `killGraceMs` plus a moment:
 * at the timeout the child gets SIGTERM, after `killGraceMs` SIGKILL, and the
 * result is returned even if the child's pipes never close. A timed-out or
 * killed command is always code -1, never a success. Only the exact child
 * this runner spawned is signalled (no process group, no name).
 */
export class ExecFileRunner implements CommandRunner {
  constructor(
    private readonly defaultTimeoutMs = 30_000,
    private readonly killGraceMs = 2_000,
  ) {}

  run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    const [file, ...args] = argv;
    if (!file) return Promise.resolve({ code: -1, stdout: "", stderr: "empty command", timedOut: false });
    if (options.signal?.aborted) return Promise.resolve({ code: -1, stdout: "", stderr: "stopped", timedOut: false });
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = options.maxBufferBytes ?? MAX_OUTPUT_BYTES;

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolve({ code: -1, stdout: "", stderr: "could not start", timedOut: false });
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let killed = false;
      let exitCode: number | null = null;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];

      const finish = (code: number, note?: string) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        options.signal?.removeEventListener("abort", stop);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          code: killed ? -1 : code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: note ?? Buffer.concat(stderr).toString("utf8"),
          timedOut,
        });
      };
      // SIGTERM now, SIGKILL after the grace, and the result even if the child never exits
      const stop = () => {
        if (killed || settled) return;
        killed = true;
        child.kill("SIGTERM");
        timers.push(
          setTimeout(() => {
            child.kill("SIGKILL");
            timers.push(setTimeout(() => finish(-1, timedOut ? "timed out" : "stopped"), 1_000));
          }, this.killGraceMs),
        );
      };

      timers.push(
        setTimeout(() => {
          if (exitCode !== null) return; // it exited in time; only its pipes are still open
          timedOut = true;
          noteCommandTimeout("probe", file);
          stop();
        }, timeoutMs),
      );
      options.signal?.addEventListener("abort", stop, { once: true });

      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          stop();
          return;
        }
        into.push(chunk);
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      child.on("error", (e: NodeJS.ErrnoException) => {
        finish(-1, e.code === "ENOENT" ? "not found" : "could not start");
      });
      child.on("exit", (code) => {
        exitCode = code ?? -1;
        timers.push(setTimeout(() => finish(exitCode ?? -1), CLOSE_AFTER_EXIT_MS));
      });
      child.on("close", (code) => finish(exitCode ?? code ?? -1));
    });
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The real probes. */
export function systemHostServicesProbes(commandTimeoutMs = 30_000): HostServicesProbes {
  return {
    runner: new ExecFileRunner(commandTimeoutMs),
    clock: systemClock,
  };
}
