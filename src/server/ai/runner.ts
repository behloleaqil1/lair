/**
 * How the AI tools service runs a tool's own commands (its model list, its
 * sign-in check, its version), locally or through ssh: argv arrays, never a
 * shell; a timeout; bounded output; and the environment an agent gets, never
 * the rest of this server's. Tests replace this one boundary.
 */
import { spawn, type ChildProcess } from "child_process";
import { noteCommandTimeout } from "../core/command-timeouts.js";

export type ToolRunFailure = "not_found" | "timeout" | "too_large" | "spawn";

export interface ToolRunOutput {
  /** The exit code; -1 when the command didn't run to its end (see failure) */
  code: number;
  stdout: string;
  stderr: string;
  failure?: ToolRunFailure;
  /** What went wrong, when failure is set */
  message?: string;
}

export interface ToolRunOptions {
  timeoutMs: number;
  /** stdout and stderr together; more ends the command (failure "too_large") */
  maxBytes: number;
  /** The process's whole environment */
  env: Record<string, string>;
}

export interface ToolRunner {
  run(argv: string[], options: ToolRunOptions): Promise<ToolRunOutput>;
}

/** After a kill, the result is given this long after at the latest (a child may hold the pipes open). */
const KILL_GRACE_MS = 1000;

/** The real runner: child_process.spawn without a shell, in its own process group so a kill reaches its children. */
export class SpawnToolRunner implements ToolRunner {
  run(argv: string[], options: ToolRunOptions): Promise<ToolRunOutput> {
    const [file, ...args] = argv;
    if (!file) return Promise.resolve({ code: -1, stdout: "", stderr: "", failure: "spawn", message: "empty command" });
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let failure: ToolRunFailure | undefined;
      let message: string | undefined;
      let settled = false;
      /** The timeout, and the grace after a kill (set once each; finish may run before either is) */
      const timers: { timeout?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};
      let child: ChildProcess | undefined;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        if (timers.timeout) clearTimeout(timers.timeout);
        if (timers.grace) clearTimeout(timers.grace);
        resolve({ code: failure ? -1 : code, stdout, stderr, ...(failure ? { failure, message } : {}) });
      };
      const stop = (why: ToolRunFailure, text: string) => {
        if (!failure) {
          failure = why;
          message = text;
        }
        const pid = child?.pid;
        try {
          if (pid !== undefined) process.kill(-pid, "SIGKILL");
        } catch {
          child?.kill("SIGKILL");
        }
        timers.grace ??= setTimeout(() => finish(-1), KILL_GRACE_MS);
      };

      try {
        child = spawn(file, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true });
      } catch (e) {
        failure = "spawn";
        message = e instanceof Error ? e.message : String(e);
        finish(-1);
        return;
      }
      timers.timeout = setTimeout(() => {
        noteCommandTimeout("tool", file);
        stop("timeout", `no answer after ${Math.round(options.timeoutMs / 1000)} s`);
      }, options.timeoutMs);
      const take = (into: "out" | "err") => (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          stop("too_large", `more than ${options.maxBytes} bytes of output`);
          return;
        }
        if (into === "out") stdout += chunk.toString("utf-8");
        else stderr += chunk.toString("utf-8");
      };
      child.stdout?.on("data", take("out"));
      child.stderr?.on("data", take("err"));
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (!failure) {
          failure = error.code === "ENOENT" ? "not_found" : "spawn";
          message = error.message;
        }
        finish(-1);
      });
      child.once("close", (code) => finish(code ?? -1));
    });
  }
}
