/**
 * The infra monitor's contact with the system.
 *
 * - Commands (machine probes, requeue_cmd) go through a CommandRunner: an
 *   argv array, never a shell, in its own process group, with a hard
 *   deadline. A command that does not finish in time is killed with its
 *   whole group and answers as a FAILURE (timedOut), whatever it printed.
 *   This is the one boundary tests replace (with the clock).
 * - The gate queue and runner pid files are read with async fs only (no
 *   synchronous call on the tick path, Lair #245), bounded, never through a
 *   symbolic link and never blocking on a FIFO.
 * - Whether a pid or a process group is alive is a signal-0 kill: no signal
 *   is sent, no file or process is touched.
 */
import { spawn } from "child_process";
import { constants, lstat, open, readdir } from "fs/promises";
import { join } from "path";
import { parseGateFilename } from "../parsers/gates.js";

export interface CommandOutput {
  /** Exit code; -1 when the command could not start, was aborted or timed out */
  code: number;
  stdout: string;
  stderr: string;
  /** The deadline ended it: a failure */
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs a command from an argv array. Never through a shell. */
export interface CommandRunner {
  run(argv: string[], options: RunOptions): Promise<CommandOutput>;
}

export interface Clock {
  /** Milliseconds since the epoch */
  now(): number;
}

export interface InfraProbes {
  runner: CommandRunner;
  clock: Clock;
}

/** The most stdout or stderr kept from one command */
export const MAX_OUTPUT_CHARS = 64 * 1024;

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * The real runner: spawn without a shell, detached into its own process
 * group so a timeout kills the probe and everything it started (an ssh
 * helper holding the pipe would otherwise keep it open forever). The
 * promise settles at the deadline even if the pipes never close.
 */
export class SpawnRunner implements CommandRunner {
  run(argv: string[], options: RunOptions): Promise<CommandOutput> {
    const [file, ...args] = argv;
    if (!file) return Promise.resolve({ code: -1, stdout: "", stderr: "empty command", timedOut: false });
    if (options.signal?.aborted) return Promise.resolve({ code: -1, stdout: "", stderr: "aborted", timedOut: false });
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        resolve({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false });
        return;
      }
      const finish = (out: CommandOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(out);
      };
      const onAbort = () => {
        killGroup(child.pid);
        finish({ code: -1, stdout, stderr: "aborted", timedOut: false });
      };
      const timer = setTimeout(() => {
        killGroup(child.pid);
        finish({
          code: -1,
          stdout,
          stderr: `timed out after ${options.timeoutMs} ms${stderr ? `: ${stderr}` : ""}`,
          timedOut: true,
        });
      }, options.timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout = (stdout + d.toString("utf-8")).slice(0, MAX_OUTPUT_CHARS);
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr = (stderr + d.toString("utf-8")).slice(0, MAX_OUTPUT_CHARS);
      });
      child.on("error", (e) => {
        killGroup(child.pid);
        finish({ code: -1, stdout, stderr: e.message, timedOut: false });
      });
      child.on("close", (code, signal) => {
        finish({ code: code ?? -1, stdout, stderr: stderr || (signal ? `ended by ${signal}` : ""), timedOut: false });
      });
    });
  }
}

export const systemClock: Clock = { now: () => Date.now() };

export function systemInfraProbes(): InfraProbes {
  return { runner: new SpawnRunner(), clock: systemClock };
}

// ============ PROCESSES ============

/**
 * Is this pid alive? Signal 0 sends nothing. EPERM: it exists under another
 * user. pid 0 and 1 are never asked (0 is "my group", 1 is always alive).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is a process group alive? Never asks group 0 or 1 (-1 would mean every process). */
export function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid < 2) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The first number of a pid or pgid file, or null. */
export function parsePid(content: string | null): number | null {
  if (content === null) return null;
  const m = /^\s*(\d{1,10})\s*(?:\n|$)/.exec(content);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 2 ? n : null;
}

// ============ FILES ============

/** At most this many queue directory entries are looked at */
export const MAX_QUEUE_ENTRIES = 5000;
/** Stats run in batches of this many */
const BATCH = 64;

/**
 * The first `maxBytes` of a regular file, or null (missing, not a regular
 * file, a symbolic link, unreadable). Opened without following a link and
 * without blocking (a FIFO planted in its place can't hang the server).
 */
export async function readHead(path: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const st = await handle.stat();
    if (!st.isFile()) return null;
    const length = Math.max(0, Math.min(st.size, maxBytes));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface QueueEntry {
  id: string;
  lane: string;
  status: "queued" | "running";
  /** The request file's name */
  name: string;
  /** ctime: a runner's claim (rename) time for a running request */
  ctimeMs: number;
  mtimeMs: number;
  /** For a running request: the process group in <name without .req.run>.pgid, or null */
  pgid: number | null;
}

/**
 * The queued and running requests of the given lanes, from
 * `<gatesDir>/queue`. Throws when the directory can't be listed: a queue the
 * monitor can't read is not a healthy queue.
 */
export async function readQueue(gatesDir: string, lanes: ReadonlySet<string>): Promise<QueueEntry[]> {
  const dir = join(gatesDir, "queue");
  const names = (await readdir(dir)).slice(0, MAX_QUEUE_ENTRIES);
  const wanted: { name: string; id: string; lane: string; status: "queued" | "running" }[] = [];
  for (const name of names) {
    const gate = parseGateFilename(name);
    if (!gate || !lanes.has(gate.lane)) continue;
    // Only a request with no status suffix is queued and .req.run is running; any other suffix is neither
    const status = gate.status === "queued" ? "queued" : gate.status === "running" ? "running" : null;
    if (status === null) continue;
    wanted.push({ name, id: gate.id, lane: gate.lane, status });
  }
  const out: QueueEntry[] = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = await Promise.all(
      wanted.slice(i, i + BATCH).map(async (w): Promise<QueueEntry | null> => {
        const st = await lstat(join(dir, w.name)).catch(() => null);
        if (!st || !st.isFile()) return null;
        let pgid: number | null = null;
        if (w.status === "running") {
          pgid = parsePid(await readHead(join(dir, `${w.name.slice(0, -".req.run".length)}.pgid`), 32));
        }
        return { ...w, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs, pgid };
      }),
    );
    for (const entry of batch) if (entry) out.push(entry);
  }
  return out;
}

/** The pid in each of a lane's runner pid files (in gatesDir), null when a file is missing or holds no pid. */
export async function readRunnerPids(gatesDir: string, files: readonly string[]): Promise<{ file: string; pid: number | null }[]> {
  return Promise.all(files.map(async (file) => ({ file, pid: parsePid(await readHead(join(gatesDir, file), 32)) })));
}
