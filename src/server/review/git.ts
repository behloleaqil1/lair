/**
 * Git process calls for the local merge executor. No shell: argv only.
 */
import { execFile } from "child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult>;
}

/** Run the system `git`, never prompting for credentials. */
export function systemGit(timeoutMs = 10 * 60_000): GitRunner {
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        execFile(
          "git",
          args,
          {
            cwd: options.cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
            timeout: timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
              return;
            }
            const raw = (error as { code?: unknown }).code;
            resolve({
              code: typeof raw === "number" ? raw : 127,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? "") || error.message,
            });
          },
        );
      });
    },
  };
}
