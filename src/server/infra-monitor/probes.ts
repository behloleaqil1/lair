/**
 * Probes for the infra monitor: machine reachability, runner processes, queue state.
 */
import { join } from "path";

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<CommandOutput>;
}

export interface Clock {
  now(): number;
}

export interface FileEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
  ctimeMs: number;
}

export interface FileSystem {
  stat(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number; ctimeMs: number } | null;
  readdir(dir: string): FileEntry[];
  read(path: string, maxBytes?: number): string | null;
}

export interface InfraMonitorProbes {
  runner: CommandRunner;
  clock: Clock;
  fs: FileSystem;
}

/**
 * Parse a gate request filename: lane.priority.gateId.req(.run)?
 * Returns null if not a valid gate request.
 */
export function parseGateRequest(filename: string): {
  lane: string;
  priority: number;
  gateId: string;
  status: "queued" | "running";
} | null {
  // lane.priority.gateId.req or lane.priority.gateId.req.run
  const match = filename.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\.(0|[1-9]\d?)\.([0-9T-]+[a-zA-Z0-9-]+)\.req(\.run)?$/);
  if (!match) return null;
  return {
    lane: match[1],
    priority: parseInt(match[2], 10),
    gateId: match[3],
    status: match[4] === ".run" ? "running" : "queued",
  };
}

/**
 * Read the pid from a file (e.g., runner-heavy.pid or gate request file).
 */
export function parsePid(content: string | null): number | null {
  if (!content) return null;
  const match = content.trim().match(/^(\d+)/);
  if (!match) return null;
  const pid = parseInt(match[1], 10);
  return pid > 0 ? pid : null;
}

export interface QueuedGate {
  gateId: string;
  lane: string;
  priority: number;
  status: "queued" | "running";
  ctimeMs: number | null;
  mtimeMs: number;
  pid: number | null;
}

/**
 * Read the gate queue from the gates directory.
 */
export function readGateQueue(fs: FileSystem, gatesDir: string): QueuedGate[] {
  const queueDir = join(gatesDir, "queue");
  const entries = fs.readdir(queueDir);
  const gates: QueuedGate[] = [];

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const parsed = parseGateRequest(entry.name);
    if (!parsed) continue;

    const filePath = join(queueDir, entry.name);
    const content = fs.read(filePath, 256);
    const pid = parsePid(content);

    gates.push({
      gateId: parsed.gateId,
      lane: parsed.lane,
      priority: parsed.priority,
      status: parsed.status,
      ctimeMs: entry.ctimeMs,
      mtimeMs: entry.mtimeMs,
      pid,
    });
  }

  return gates;
}

/**
 * Get the runner pid for a lane from runner-<lane>.pid file.
 */
export function getRunnerPid(fs: FileSystem, gatesDir: string, lane: string): number | null {
  const pidFile = join(gatesDir, "queue", `runner-${lane}.pid`);
  const content = fs.read(pidFile, 32);
  return parsePid(content);
}

/**
 * Check for duplicate runner slots by counting runner pid files per lane.
 */
export function findDuplicateSlots(fs: FileSystem, gatesDir: string, lanes: string[]): { lane: string; count: number; pids: number[] }[] {
  const queueDir = join(gatesDir, "queue");
  const entries = fs.readdir(queueDir);
  const duplicates: { lane: string; count: number; pids: number[] }[] = [];

  for (const lane of lanes) {
    // Count runner-<lane>.pid and runner-<lane>-*.pid files
    const pidFiles = entries.filter(
      (e) => e.isFile && (e.name === `runner-${lane}.pid` || e.name.startsWith(`runner-${lane}-`) && e.name.endsWith(".pid"))
    );

    if (pidFiles.length > 1) {
      const pids: number[] = [];
      for (const pf of pidFiles) {
        const content = fs.read(join(queueDir, pf.name), 32);
        const pid = parsePid(content);
        if (pid !== null) pids.push(pid);
      }
      if (pids.length > 1) {
        duplicates.push({ lane, count: pids.length, pids });
      }
    }
  }

  return duplicates;
}

/**
 * Node filesystem implementation.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";

export class NodeFileSystem implements FileSystem {
  stat(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number; ctimeMs: number } | null {
    try {
      const st = statSync(path);
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      };
    } catch {
      return null;
    }
  }

  readdir(dir: string): FileEntry[] {
    try {
      const names = readdirSync(dir);
      const entries: FileEntry[] = [];
      for (const name of names) {
        const path = join(dir, name);
        const st = this.stat(path);
        if (st) {
          entries.push({ name, ...st });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  read(path: string, maxBytes = 65536): string | null {
    try {
      if (!existsSync(path)) return null;
      const buffer = Buffer.alloc(maxBytes);
      const fd = openSync(path, "r");
      try {
        const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.slice(0, bytesRead).toString("utf-8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }
}

/**
 * System probes with real implementations.
 */
export function systemInfraProbes(_timeoutMs: number): InfraMonitorProbes {
  return {
    runner: {
      async run(argv, options) {
        const { spawn } = await import("child_process");
        return new Promise((resolve) => {
          const proc = spawn(argv[0], argv.slice(1), {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: options.timeoutMs,
          });
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d) => (stdout += d.toString().slice(0, 65536)));
          proc.stderr.on("data", (d) => (stderr += d.toString().slice(0, 65536)));
          const cleanup = () => {
            proc.kill("SIGKILL");
            resolve({ code: -1, stdout, stderr: stderr || "aborted" });
          };
          options.signal?.addEventListener("abort", cleanup, { once: true });
          proc.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
          proc.on("close", (code) => {
            options.signal?.removeEventListener("abort", cleanup);
            resolve({ code: code ?? -1, stdout, stderr });
          });
        });
      },
    },
    clock: { now: () => Date.now() },
    fs: new NodeFileSystem(),
  };
}
