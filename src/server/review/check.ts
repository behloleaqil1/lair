/**
 * The pre-merge check (`review.merge.check_cmd`): the project's own command,
 * run after the policy allows a merge and before the executor publishes it
 * (for example, a check that the PR's migrations still come after the target
 * branch's). Anything but exit 0, a timeout included, refuses the merge with
 * the command's first output lines as the reason.
 *
 * - An argv, never a shell. The program (argv[0]) is the config's own.
 * - `{pr}`, `{head}`, `{base}` and `{repo}` come from the PR and the config;
 *   each is shape-checked before it is used, and none may start with `-`, so
 *   no value becomes an option.
 * - Its environment is Lair's minimal one (BASE_ENV: PATH, HOME, USER, LANG,
 *   TMPDIR, TERM, SHELL), never the server's tokens or other variables.
 * - A timeout, and bounded output.
 */
import { spawn, type ChildProcess } from "child_process";
import { agentEnvironment } from "../agents/probes.js";

export interface CheckOutput {
  /** The exit code; null when it could not start, or was killed */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why it could not start */
  error?: string;
}

export interface CheckRunOptions {
  cwd: string;
  /** The command's whole environment: nothing else is inherited */
  env: Record<string, string>;
  timeoutMs: number;
  /** stdout and stderr are each kept up to this many bytes; the rest is read and dropped */
  maxOutputBytes: number;
}

/** Runs argv[0] with the rest as its arguments, never through a shell. */
export interface CheckRunner {
  run(argv: string[], options: CheckRunOptions): Promise<CheckOutput>;
}

/** What a check's stdout and stderr are each kept to. */
export const CHECK_OUTPUT_BYTES = 64 * 1024;
/** A refusal quotes at most this many of the command's lines, each cut to REASON_LINE_CHARS. */
export const REASON_LINES = 5;
const REASON_LINE_CHARS = 200;

export interface CheckValues {
  pr: number;
  head: string;
  base: string;
  repo: string;
}

type Placeholder = keyof CheckValues;

const SHAPES: Record<Placeholder, { valid: (value: string) => boolean; what: string }> = {
  pr: { valid: (v) => /^[1-9]\d{0,9}$/.test(v), what: "a PR number" },
  head: { valid: (v) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v), what: "a full commit sha" },
  base: {
    valid: (v) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(v) && !v.includes("..") && !v.includes("//"),
    what: "a branch name",
  },
  repo: {
    valid: (v) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/.test(v) && !v.includes(".."),
    what: "owner/name",
  },
};

const PLACEHOLDER = /\{(pr|head|base|repo)\}/g;

/** The minimal environment a check runs with: BASE_ENV from `source`, and no LAIR_* variable. */
export function checkEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return agentEnvironment(source, [], {});
}

/**
 * Text someone else wrote, as one plain line: ANSI escapes dropped, other
 * control characters made spaces.
 */
export function plainLine(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      // ESC [ parameters final-byte: skip the whole sequence
      if (text[i + 1] === "[") {
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
      }
      continue;
    }
    out += code < 0x20 || code === 0x7f ? " " : text[i];
  }
  return out;
}

/** The first non-empty lines of `text`, plain and cut. */
export function firstLines(text: string, max = REASON_LINES): string[] {
  return text
    .slice(0, 16 * 1024)
    .split("\n")
    .map((line) => plainLine(line).trim())
    .filter((line) => line.length > 0)
    .slice(0, max)
    .map((line) => (line.length > REASON_LINE_CHARS ? `${line.slice(0, REASON_LINE_CHARS - 3)}...` : line));
}

/** The value as a refusal may quote it: plain, cut, in quotes. */
function quoted(value: string): string {
  const plain = plainLine(value);
  return JSON.stringify(plain.length > 80 ? `${plain.slice(0, 77)}...` : plain);
}

/**
 * The argv to run: each placeholder the template uses filled with its value,
 * once that value has the right shape; or why it can't be run.
 */
export function expandCheckCommand(template: string[], values: CheckValues): { argv: string[] } | { error: string } {
  const strings: Record<Placeholder, string> = {
    pr: String(values.pr),
    head: values.head,
    base: values.base,
    repo: values.repo,
  };
  const used = new Set<Placeholder>();
  for (const arg of template.slice(1)) for (const match of arg.matchAll(PLACEHOLDER)) used.add(match[1] as Placeholder);
  for (const name of used) {
    const value = strings[name];
    if (value.startsWith("-") || !SHAPES[name].valid(value)) {
      return { error: `{${name}} would be ${quoted(value)}, which is not ${SHAPES[name].what}: check_cmd was not run` };
    }
  }
  return {
    argv: template.map((arg, index) =>
      index === 0 ? arg : arg.replace(PLACEHOLDER, (_whole, name: string) => strings[name as Placeholder]),
    ),
  };
}

export interface PreMergeCheck {
  runner: CheckRunner;
  template: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/** Run the pre-merge check: null when it passed (exit 0), else the refusal's reason. */
export async function runPreMergeCheck(check: PreMergeCheck, values: CheckValues): Promise<string | null> {
  const expanded = expandCheckCommand(check.template, values);
  if ("error" in expanded) return `Pre-merge check: ${expanded.error}`;
  let out: CheckOutput;
  try {
    out = await check.runner.run(expanded.argv, {
      cwd: check.cwd,
      env: check.env,
      timeoutMs: check.timeoutSeconds * 1000,
      maxOutputBytes: CHECK_OUTPUT_BYTES,
    });
  } catch (e) {
    return `Pre-merge check: check_cmd could not run (${plainLine(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
  }
  if (out.code === 0 && !out.timedOut) return null;
  const lines = [...firstLines(out.stdout), ...firstLines(out.stderr)].slice(0, REASON_LINES);
  const said = lines.length > 0 ? `: ${lines.join(" | ")}` : "";
  if (out.timedOut) return `Pre-merge check: check_cmd did not finish within ${check.timeoutSeconds} s${said}`;
  if (out.code === null) {
    const why = out.error ? ` (${plainLine(out.error).slice(0, 200)})` : "";
    return `Pre-merge check: check_cmd could not run or was killed${why}${said}`;
  }
  return `Pre-merge check: check_cmd exited ${out.code}${said}`;
}

// ============ THE REAL RUNNER ============

/** Keeps the first `max` bytes of a stream and drops the rest. */
class Capture {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.max) return;
    const kept = chunk.length > this.max - this.size ? chunk.subarray(0, this.max - this.size) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

/** Kill the check and what it started (its process group, where there is one). */
function killTree(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is gone, or never was one: kill the process itself
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already ended
  }
}

/** spawn() with no shell, the given environment only, a timeout that kills the process group, and capped output. */
export function systemCheckRunner(): CheckRunner {
  return {
    run(argv, options) {
      return new Promise((resolve) => {
        const [file, ...args] = argv;
        if (!file) {
          resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: "empty command" });
          return;
        }
        const stdout = new Capture(options.maxOutputBytes);
        const stderr = new Capture(options.maxOutputBytes);
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        let timedOut = false;
        const done = (code: number | null, error?: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ code, stdout: stdout.text(), stderr: stderr.text(), timedOut, ...(error ? { error } : {}) });
        };
        let child: ChildProcess;
        try {
          child = spawn(file, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            // Its own process group, so a timeout also ends what it started
            detached: process.platform !== "win32",
            windowsHide: true,
          });
        } catch (e) {
          done(null, e instanceof Error ? e.message : String(e));
          return;
        }
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          child.stdout?.destroy();
          child.stderr?.destroy();
          done(null);
        }, options.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (e) => done(null, e.message));
        child.on("close", (code) => done(code));
      });
    },
  };
}
