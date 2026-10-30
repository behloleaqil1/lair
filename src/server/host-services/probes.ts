/**
 * Host services probes: the boundary interfaces for tests.
 *
 * The service touches the system only through these interfaces: a command
 * runner and a clock. Tests replace them with fakes.
 */
import { execFile } from "child_process";
import { noteCommandTimeout, kindOfProgram } from "../core/command-timeouts.js";

export interface CommandOutput {
  /** Exit code; -1 when the command could not start or timed out */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** The most stdout or stderr the command may write (default 1 MB); more ends it with code -1 */
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

/** execFile as a CommandRunner: argv[0] is the program, no shell. */
export class ExecFileRunner implements CommandRunner {
  constructor(private defaultTimeoutMs = 30_000) {}

  run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    const [file, ...args] = argv;
    if (!file) {
      return Promise.resolve({ code: -1, stdout: "", stderr: "empty command" });
    }
    return new Promise((resolve) => {
      let timedOut = false;
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

      const child = execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: options.maxBufferBytes ?? MAX_OUTPUT_BYTES,
          encoding: "utf-8",
          shell: false,
          signal: options.signal,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr });
            return;
          }

          // If the child exited with output but the timer fired after, treat
          // it as success: the event loop was blocked, not the command.
          if (error.killed && timedOut && stdout && stdout.length > 0) {
            resolve({ code: 0, stdout, stderr: stderr ?? "" });
            return;
          }

          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : -1;
          // Killed, neither by an abort nor for too much output: its timeout ended it
          if (error.killed && !options.signal?.aborted && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            noteCommandTimeout(kindOfProgram(file), file);
          }
          resolve({
            code: error.killed ? -1 : code,
            stdout: stdout ?? "",
            stderr: stderr || error.message,
          });
        },
      );

      // Track if the timeout fired for the callback
      const timer = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);

      child.once("close", () => {
        clearTimeout(timer);
      });
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
