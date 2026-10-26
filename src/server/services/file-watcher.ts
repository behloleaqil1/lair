/**
 * File watcher service for real-time updates.
 * Watches key project files and broadcasts changes via WebSocket.
 */
import { watch, FSWatcher } from "chokidar";
import { readFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import type { ProjectConfig } from "../../shared/types.js";
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

/**
 * Tracks file modification times to detect actual changes.
 */
interface FileState {
  mtime: number;
  size: number;
}

/**
 * File watcher service.
 * Monitors dragons, gates, and logs directories for changes.
 */
export class FileWatcherService {
  private watcher: FSWatcher | null = null;
  private wsServer: LairWebSocketServer;
  private config: ProjectConfig;
  private fileStates = new Map<string, FileState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private logTails = new Map<string, number>(); // Track log file read positions

  // Debounce delay for file changes (ms)
  private static readonly DEBOUNCE_DELAY = 100;

  constructor(wsServer: LairWebSocketServer, config: ProjectConfig) {
    this.wsServer = wsServer;
    this.config = config;
  }

  /**
   * Start watching project files.
   */
  start(): void {
    const watchPaths: string[] = [];

    // Watch agents directory for dragons
    if (existsSync(this.config.agents_dir)) {
      watchPaths.push(this.config.agents_dir);
    }

    // Watch gates directory
    if (existsSync(this.config.gates_dir)) {
      watchPaths.push(join(this.config.gates_dir, "queue"));
      watchPaths.push(join(this.config.gates_dir, "results"));
    }

    // Watch queue file
    if (existsSync(this.config.queue_file)) {
      watchPaths.push(this.config.queue_file);
    }

    if (watchPaths.length === 0) {
      console.warn("[FileWatcher] No paths to watch");
      return;
    }

    this.watcher = watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 1, // Only watch immediate children
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("add", (path) => this.handleFileChange(path, "add"));
    this.watcher.on("change", (path) => this.handleFileChange(path, "change"));
    this.watcher.on("unlink", (path) => this.handleFileChange(path, "unlink"));
    this.watcher.on("addDir", (path) => this.handleDirChange(path, "add"));
    this.watcher.on("unlinkDir", (path) =>
      this.handleDirChange(path, "unlink"),
    );

    this.watcher.on("error", (error) => {
      console.error("[FileWatcher] Error:", error);
    });

    this.watcher.on("ready", () => {
      console.log(
        `[FileWatcher] Started watching ${watchPaths.length} path(s) for project: ${this.config.name}`,
      );
    });
  }

  /**
   * Stop watching files.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      console.log("[FileWatcher] Stopped");
    }

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Handle file change event with debouncing.
   */
  private handleFileChange(
    path: string,
    event: "add" | "change" | "unlink",
  ): void {
    // Debounce rapid changes to the same file
    const existing = this.debounceTimers.get(path);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        this.processFileChange(path, event);
      }, FileWatcherService.DEBOUNCE_DELAY),
    );
  }

  /**
   * Process a file change event.
   */
  private processFileChange(
    path: string,
    event: "add" | "change" | "unlink",
  ): void {
    const filename = basename(path);

    // Check if file actually changed (for change events)
    if (event === "change") {
      const currentState = this.getFileState(path);
      const previousState = this.fileStates.get(path);

      if (
        previousState &&
        currentState &&
        previousState.mtime === currentState.mtime &&
        previousState.size === currentState.size
      ) {
        return; // No actual change
      }

      if (currentState) {
        this.fileStates.set(path, currentState);
      }
    } else if (event === "unlink") {
      this.fileStates.delete(path);
    }

    // Route to appropriate handler
    if (path.includes(this.config.agents_dir)) {
      this.handleAgentFileChange(path, filename, event);
    } else if (path.includes(this.config.gates_dir)) {
      this.handleGateFileChange(path, filename, event);
    } else if (path === this.config.queue_file) {
      this.handleQueueFileChange(event);
    }
  }

  /**
   * Handle directory change (add/remove).
   */
  private handleDirChange(path: string, event: "add" | "unlink"): void {
    const dirname = basename(path);

    // Dragon running directories: kiro-A.running, etc.
    if (dirname.endsWith(".running")) {
      const dragonId = dirname.replace(".running", "");
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

  /**
   * Handle changes in the agents directory.
   */
  private handleAgentFileChange(
    path: string,
    filename: string,
    event: "add" | "change" | "unlink",
  ): void {
    // Dragon log files: <dragon-id>-20261025T123456Z.log or <dragon-id>.log
    if (event !== "unlink") {
      const dragonId = dragonIdFromLogFile(filename);
      if (dragonId) {
        this.handleLogFileChange(path, dragonId);
      }
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
   * Handle log file changes - stream new lines to subscribers.
   */
  private handleLogFileChange(path: string, dragonId: string): void {
    try {
      const stats = statSync(path);
      const previousPosition = this.logTails.get(path) || 0;

      // If file is smaller than previous position, it was truncated
      const startPosition =
        stats.size < previousPosition ? 0 : previousPosition;

      if (stats.size <= startPosition) {
        return; // No new content
      }

      // Read new content
      const fd = readFileSync(path, "utf-8");
      const newContent = fd.slice(startPosition);
      this.logTails.set(path, stats.size);

      // Split into lines and broadcast each
      const lines = newContent.split("\n").filter((line) => line.trim());

      if (lines.length > 0) {
        // Broadcast last line as dragon update
        const lastLine = lines[lines.length - 1];
        const update: DragonUpdateData = {
          id: dragonId,
          event: "log_line",
          lastLogLine: lastLine.slice(0, 200), // Truncate for the summary
          lastLogTime: new Date().toISOString(),
        };
        this.wsServer.broadcastDragonUpdate(update, this.config.name);

        // Broadcast full lines to log channel subscribers
        for (const line of lines) {
          this.wsServer.broadcastLogLine(dragonId, line, this.config.name);
        }
      }
    } catch {
      // File might have been deleted or inaccessible
    }
  }

  /**
   * Handle changes in the gates directory.
   */
  private handleGateFileChange(
    path: string,
    filename: string,
    event: "add" | "change" | "unlink",
  ): void {
    // Gate queue files: *.req, *.req.running, etc.
    if (path.includes("/queue/")) {
      if (filename.endsWith(".req") && event === "add") {
        // New gate queued
        const gateId = this.parseGateId(filename);
        if (gateId) {
          console.log(`[FileWatcher] Gate queued: ${gateId}`);
          const update: GateUpdateData = {
            id: gateId,
            event: "queued",
          };
          this.wsServer.broadcastGateUpdate(update, this.config.name);
        }
      } else if (filename.includes(".req.running") && event === "add") {
        // Gate started running
        const gateId = this.parseGateId(filename);
        if (gateId) {
          console.log(`[FileWatcher] Gate started: ${gateId}`);
          const update: GateUpdateData = {
            id: gateId,
            event: "started",
          };
          this.wsServer.broadcastGateUpdate(update, this.config.name);
        }
      }
    }

    // Gate result files: *.rc
    if (path.includes("/results/") && filename.endsWith(".rc")) {
      if (event === "add" || event === "change") {
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
    }
  }

  /**
   * Handle queue file changes.
   */
  private handleQueueFileChange(event: "add" | "change" | "unlink"): void {
    if (event !== "unlink") {
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
   * Parse gate ID from filename.
   * Format: heavy.0.20260101T000000Z-example-track.req
   */
  private parseGateId(filename: string): string | null {
    // Remove extensions
    const base = filename.replace(/\.(req|running|log|rc).*$/, "");
    // Extract the timestamp-based ID part
    const parts = base.split(".");
    if (parts.length >= 3) {
      return parts.slice(2).join(".");
    }
    return base;
  }

  /**
   * Read gate return code from .rc file.
   */
  private readGateRc(path: string): number | null {
    try {
      const content = readFileSync(path, "utf-8").trim();
      const rc = parseInt(content, 10);
      return isNaN(rc) ? null : rc;
    } catch {
      return null;
    }
  }

  /**
   * Get file state for change detection.
   */
  private getFileState(path: string): FileState | null {
    try {
      const stats = statSync(path);
      return {
        mtime: stats.mtimeMs,
        size: stats.size,
      };
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
): FileWatcherService {
  const watcher = new FileWatcherService(wsServer, config);
  watcher.start();
  return watcher;
}
