/**
 * File watcher service for real-time updates.
 * Watches a project's folders and broadcasts changes via WebSocket.
 *
 * It watches four folders, never their files (see dir-watch.ts): agents_dir
 * (dragon logs, dragons.txt, `<id>.running` folders), the gate queue and
 * results folders, and the folder of the queue file. Each costs one watch
 * whatever number of files it holds; subfolders (archives, prompts, older
 * logs) and names the dashboard doesn't use cost nothing.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { basename, dirname, join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { parseGateFilename } from "../parsers/gates.js";
import { readRegularFile } from "../read-file.js";
import { DirWatch, type DirEntryEvent, type WatchFn } from "./dir-watch.js";
import type {
  LairWebSocketServer,
  DragonUpdateData,
  GateUpdateData,
} from "../websocket.js";

/**
 * Dragon ID from a log file name: "<id>-20261025T123456Z.log" or "<id>.log".
 * The ID part is lazy so the timestamp suffix isn't swallowed into it.
 * Returns null for other files.
 */
export function dragonIdFromLogFile(filename: string): string | null {
  const match = filename.match(
    /^([A-Za-z](?:[A-Za-z0-9_-]{0,62}?[A-Za-z0-9])?)(?:-\d{8}T\d{6}Z)?\.log$/,
  );
  return match ? match[1] : null;
}

/** The agents_dir entries the dashboard is told about */
function isAgentEntry(name: string): boolean {
  return name === "dragons.txt" || name.endsWith(".running") || dragonIdFromLogFile(name) !== null;
}

/** At most this much of a log is read per change: its newest bytes */
const MAX_LOG_READ = 64 * 1024;
/** Logs whose read position is kept (the most recently changed) */
const MAX_LOG_TAILS = 1000;
/** A gate's .rc holds a number */
const MAX_RC_BYTES = 1024;

/**
 * Read what was appended to a log since `from` (at most its last
 * MAX_LOG_READ bytes), on one descriptor closed before returning. Null when
 * the file can't be read or isn't a regular file (symbolic links included).
 */
function readAppended(path: string, from: number): { size: number; mtime: Date; text: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const size = st.size;
    // Smaller than before: it was truncated, read it from the start
    const base = size < from ? 0 : from;
    const start = Math.max(base, size - MAX_LOG_READ);
    const length = size - start;
    if (length <= 0) return { size, mtime: st.mtime, text: "" };
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buffer, done, length - done, start + done);
      if (n === 0) break;
      done += n;
    }
    let text = buffer.subarray(0, done).toString("utf-8");
    // A read that skipped ahead starts inside a line: drop that part
    if (start > base) text = text.slice(text.indexOf("\n") + 1);
    return { size: start + done, mtime: st.mtime, text };
  } catch {
    // Removed, or unreadable
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface FileWatcherOptions {
  /** fs.watch (tests count the watches) */
  watch?: WatchFn;
  /** Quiet time per file before it is looked at (default 100 ms) */
  debounceMs?: number;
  /** Polling interval for a folder that can't be watched (default 5 s) */
  pollMs?: number;
}

/**
 * File watcher service.
 * Monitors dragons, gates, and logs directories for changes.
 */
export class FileWatcherService {
  private dirs: DirWatch[] = [];
  private wsServer: LairWebSocketServer;
  private config: ProjectConfig;
  private options: FileWatcherOptions;
  private logTails = new Map<string, number>(); // Track log file read positions

  constructor(wsServer: LairWebSocketServer, config: ProjectConfig, options: FileWatcherOptions = {}) {
    this.wsServer = wsServer;
    this.config = config;
    this.options = options;
  }

  /** The folders watched, and how (tests and diagnostics) */
  watched(): { dir: string; state: DirWatch["state"] }[] {
    return this.dirs.map((d) => ({ dir: d.dir, state: d.state }));
  }

  /**
   * Start watching the project's folders. A folder that doesn't exist yet is
   * polled until it does.
   */
  start(): void {
    if (this.dirs.length > 0) return;
    const add = (
      dir: string | undefined,
      accept: (name: string) => boolean,
      onEvent: (event: DirEntryEvent, path: string, name: string) => void,
    ) => {
      if (!dir) return;
      this.dirs.push(
        new DirWatch(dir, {
          accept,
          onEvent,
          watch: this.options.watch,
          debounceMs: this.options.debounceMs,
          pollMs: this.options.pollMs,
          onError: (text) => console.warn(`[FileWatcher] ${text}`),
        }),
      );
    };

    add(this.config.agents_dir, isAgentEntry, (event, path, name) => this.handleAgentEntry(path, name, event));
    if (this.config.gates_dir) {
      add(
        join(this.config.gates_dir, "queue"),
        (name) => parseGateFilename(name) !== null,
        (event, _path, name) => this.handleGateQueueEntry(name, event),
      );
      add(
        join(this.config.gates_dir, "results"),
        (name) => name.endsWith(".rc"),
        (event, path, name) => this.handleGateResult(path, name, event),
      );
    }
    const queueFile = this.config.queue_file;
    if (queueFile) {
      const name = basename(queueFile);
      add(dirname(queueFile), (entry) => entry === name, (event) => this.handleQueueFileChange(event));
    }

    for (const dir of this.dirs) dir.start();
    const polled = this.dirs.filter((d) => d.state === "polling").length;
    console.log(
      `[FileWatcher] Watching ${this.dirs.length - polled} folder(s)${polled ? `, polling ${polled} (missing or not watchable)` : ""} for project: ${this.config.name}`,
    );
  }

  /**
   * Stop watching files.
   */
  async stop(): Promise<void> {
    if (this.dirs.length > 0) {
      for (const dir of this.dirs) dir.stop();
      this.dirs = [];
      console.log("[FileWatcher] Stopped");
    }
    this.logTails.clear();
  }

  /**
   * An entry of agents_dir: a dragon log, dragons.txt, or a dragon's
   * `<id>.running` folder.
   */
  private handleAgentEntry(path: string, filename: string, event: DirEntryEvent): void {
    if (event === "addDir" || event === "unlinkDir") {
      this.handleDirChange(filename, event === "addDir" ? "add" : "unlink");
      return;
    }

    // Dragon log files: <dragon-id>-20261025T123456Z.log or <dragon-id>.log
    const dragonId = dragonIdFromLogFile(filename);
    if (dragonId) {
      if (event === "unlink") this.logTails.delete(path);
      else this.handleLogFileChange(path, dragonId);
    }

    // dragons.txt changes
    if (filename === "dragons.txt") {
      console.log("[FileWatcher] dragons.txt changed");
      // Broadcast a general dragons update - client will refetch
      this.wsServer.broadcastDragonUpdate(
        {
          id: "all",
          event: "status_change",
        },
        this.config.name,
      );
    }
  }

  /**
   * Handle directory change (add/remove).
   */
  private handleDirChange(name: string, event: "add" | "unlink"): void {
    // Dragon running directories: kiro-A.running, etc.
    if (name.endsWith(".running")) {
      const dragonId = name.replace(".running", "");
      const running = event === "add";

      console.log(
        `[FileWatcher] Dragon ${dragonId} ${running ? "started" : "stopped"}`,
      );

      const update: DragonUpdateData = {
        id: dragonId,
        event: "status_change",
        running,
      };

      this.wsServer.broadcastDragonUpdate(update, this.config.name);
    }
  }

  /** Remember where a log was read up to (the most recently changed logs only). */
  private rememberTail(path: string, position: number): void {
    this.logTails.delete(path);
    this.logTails.set(path, position);
    if (this.logTails.size > MAX_LOG_TAILS) {
      const oldest = this.logTails.keys().next().value;
      if (oldest !== undefined) this.logTails.delete(oldest);
    }
  }

  /**
   * Handle log file changes - stream new lines to subscribers.
   */
  private handleLogFileChange(path: string, dragonId: string): void {
    const previousPosition = this.logTails.get(path) ?? 0;
    const read = readAppended(path, previousPosition);
    if (!read) return;
    if (read.size !== previousPosition) this.rememberTail(path, read.size);
    if (read.text === "") return; // No new content

    // Split into lines and broadcast each
    const lines = read.text.split("\n").filter((line) => line.trim());

    if (lines.length > 0) {
      // Broadcast last line as dragon update
      const lastLine = lines[lines.length - 1];
      const update: DragonUpdateData = {
        id: dragonId,
        event: "log_line",
        lastLogLine: lastLine.slice(0, 200), // Truncate for the summary
        // The log's mtime, as GET /api/dragons reports it
        lastLogTime: read.mtime.toISOString(),
      };
      this.wsServer.broadcastDragonUpdate(update, this.config.name);

      // Broadcast full lines to log channel subscribers
      for (const line of lines) {
        this.wsServer.broadcastLogLine(dragonId, line, this.config.name);
      }
    }
  }

  /**
   * Gate queue files: <lane>.<priority>.<gate-id>.req (queued), .req.run (running), ...
   */
  private handleGateQueueEntry(filename: string, event: DirEntryEvent): void {
    if (event !== "add") return;
    const gate = parseGateFilename(filename);
    if (gate && (gate.status === "queued" || gate.status === "running")) {
      const queued = gate.status === "queued";
      console.log(`[FileWatcher] Gate ${queued ? "queued" : "started"}: ${gate.id} (${gate.lane})`);
      const update: GateUpdateData = {
        id: gate.id,
        event: queued ? "queued" : "started",
        lane: gate.lane,
      };
      this.wsServer.broadcastGateUpdate(update, this.config.name);
    }
  }

  /**
   * Gate result files: <gate-id>.rc
   */
  private handleGateResult(path: string, filename: string, event: DirEntryEvent): void {
    if (event !== "add" && event !== "change") return;
    const gateId = filename.replace(".rc", "");
    const rc = this.readGateRc(path);

    console.log(`[FileWatcher] Gate completed: ${gateId} (rc=${rc})`);
    const update: GateUpdateData = {
      id: gateId,
      event: "completed",
      rc: rc ?? undefined,
    };
    this.wsServer.broadcastGateUpdate(update, this.config.name);
  }

  /**
   * Handle queue file changes.
   */
  private handleQueueFileChange(event: DirEntryEvent): void {
    if (event === "add" || event === "change") {
      console.log("[FileWatcher] Queue file changed");
      // Could parse and broadcast specific queue entries, but for now
      // just signal an orchestrator update
      this.wsServer.broadcastOrchestratorTick(
        { event: "queue_change" },
        this.config.name,
      );
    }
  }

  /**
   * Read gate return code from .rc file.
   */
  private readGateRc(path: string): number | null {
    try {
      const content = readRegularFile(path, { maxBytes: MAX_RC_BYTES, noFollow: true }).trim();
      const rc = parseInt(content, 10);
      return isNaN(rc) ? null : rc;
    } catch {
      return null;
    }
  }
}

/**
 * Create and start a file watcher for a project.
 */
export function createFileWatcher(
  wsServer: LairWebSocketServer,
  config: ProjectConfig,
  options: FileWatcherOptions = {},
): FileWatcherService {
  const watcher = new FileWatcherService(wsServer, config, options);
  watcher.start();
  return watcher;
}
