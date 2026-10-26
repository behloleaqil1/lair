/**
 * ManagedProcess - Spawns and manages a single child process
 *
 * Features:
 * - Spawn child process with command array (no shell)
 * - Capture stdout/stderr into RingBuffer
 * - Restart logic with exponential backoff
 * - Health checks (file_modified, http, tcp, command)
 * - Graceful shutdown (SIGTERM, wait, SIGKILL)
 */
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync, statSync } from "fs";
import { Socket } from "net";
import { RingBuffer } from "./ring-buffer.js";
import type {
  ProcessConfig,
  ProcessState,
  ProcessStatus,
  ProcessMetrics,
  LogLine,
  HealthCheckConfig,
} from "../../shared/process-types.js";

const DEFAULT_GRACE_PERIOD_MS = 10000; // 10 seconds
const KILL_TIMEOUT_MS = 5000; // 5 seconds after SIGKILL before giving up

/** True once the child has exited (`child.killed` only means a signal was sent). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export interface ManagedProcessEvents {
  start: (state: ProcessState) => void;
  stop: (state: ProcessState) => void;
  restart: (state: ProcessState, reason: string) => void;
  healthy: (state: ProcessState) => void;
  unhealthy: (state: ProcessState, reason: string) => void;
  log: (id: string, line: LogLine) => void;
  statusChange: (state: ProcessState) => void;
}

export class ManagedProcess extends EventEmitter {
  private config: ProcessConfig;
  private child: ChildProcess | null = null;
  private status: ProcessStatus = "stopped";
  private pid?: number;
  private startedAt?: Date;
  private stoppedAt?: Date;
  private exitCode?: number;
  private exitSignal?: string;
  private healthy: boolean = true;
  private restartCount: number = 0;
  private lastRestartReason?: string;
  private currentBackoff: number;
  private logs: RingBuffer<LogLine>;
  private metrics: ProcessMetrics;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping: boolean = false;

  constructor(config: ProcessConfig) {
    super();
    this.config = config;
    this.currentBackoff = config.restartDelay;
    this.logs = new RingBuffer<LogLine>(config.logMaxLines);
    this.metrics = {
      startCount: 0,
      restartCount: 0,
      healthCheckFailures: 0,
      uptimeMs: 0,
    };
  }

  /**
   * Get current process state
   */
  getState(): ProcessState {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt?.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString(),
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      healthy: this.healthy,
      restartCount: this.restartCount,
      lastRestartReason: this.lastRestartReason,
      metrics: this.getMetrics(),
      config: this.config,
    };
  }

  /**
   * Get current metrics
   */
  private getMetrics(): ProcessMetrics {
    return {
      ...this.metrics,
      uptimeMs:
        this.startedAt && this.status === "running"
          ? Date.now() - this.startedAt.getTime()
          : this.metrics.uptimeMs,
    };
  }

  /**
   * Start the process
   */
  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") {
      return;
    }

    this.stopping = false;
    this.setStatus("starting");

    try {
      const [cmd, ...args] = this.config.command;

      this.child = spawn(cmd, args, {
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.pid = this.child.pid;
      this.startedAt = new Date();
      this.exitCode = undefined;
      this.exitSignal = undefined;
      this.metrics.startCount++;
      this.metrics.lastStarted = this.startedAt.toISOString();

      // Capture stdout
      this.child.stdout?.on("data", (data: Buffer) => {
        this.appendLog("stdout", data.toString());
      });

      // Capture stderr
      this.child.stderr?.on("data", (data: Buffer) => {
        this.appendLog("stderr", data.toString());
      });

      // Handle process exit
      this.child.on("exit", (code, signal) => {
        this.handleExit(code, signal);
      });

      this.child.on("error", (err) => {
        this.appendLog("stderr", `Process error: ${err.message}`);
        this.handleExit(1, null);
      });

      this.setStatus("running");
      this.healthy = true;
      this.currentBackoff = this.config.restartDelay; // Reset backoff on successful start
      this.emit("start", this.getState());

      // Start health checks if configured
      this.startHealthChecks();
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      this.appendLog("stderr", `Failed to start process: ${error}`);
      this.setStatus("failed");
      this.emit("statusChange", this.getState());
    }
  }

  /**
   * Stop the process gracefully
   */
  async stop(gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.stopping = true;
    this.setStatus("stopping");
    this.stopHealthChecks();
    this.clearRestartTimer();

    if (!this.child || !this.pid) {
      this.setStatus("stopped");
      this.stoppedAt = new Date();
      this.metrics.lastStopped = this.stoppedAt.toISOString();
      return;
    }

    // Keep a handle on THIS child: handleExit() clears this.child, and a
    // restart may replace it before the timers below fire.
    const child = this.child;

    // Wait for graceful exit
    const exitPromise = new Promise<void>((resolve) => {
      if (hasExited(child)) {
        resolve();
        return;
      }

      // Force kill after grace period. `child.killed` is already true once
      // SIGTERM was delivered, so check whether the child has actually exited.
      const killTimer = setTimeout(() => {
        if (!hasExited(child)) {
          this.appendLog("stderr", `Grace period expired, sending SIGKILL...`);
          child.kill("SIGKILL");
        }
      }, gracePeriodMs);

      // Absolute timeout
      const absoluteTimer = setTimeout(
        () => done(),
        gracePeriodMs + KILL_TIMEOUT_MS,
      );

      const done = () => {
        clearTimeout(killTimer);
        clearTimeout(absoluteTimer);
        resolve();
      };
      child.once("exit", done);

      // Send SIGTERM
      child.kill("SIGTERM");
      this.appendLog("stderr", "Sent SIGTERM, waiting for graceful shutdown...");
    });

    await exitPromise;
  }

  /**
   * Restart the process
   */
  async restart(): Promise<void> {
    this.lastRestartReason = "manual restart";
    await this.stop();
    await this.start();
  }

  /**
   * Get recent log lines
   */
  getLogs(tail: number = 100): LogLine[] {
    return this.logs.tail_n(tail);
  }

  /**
   * Get all logs
   */
  getAllLogs(): LogLine[] {
    return this.logs.toArray();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopHealthChecks();
    this.clearRestartTimer();
    if (this.child && !hasExited(this.child)) {
      this.child.kill("SIGKILL");
    }
  }

  // ============ Private Methods ============

  private setStatus(status: ProcessStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("statusChange", this.getState());
    }
  }

  private appendLog(stream: "stdout" | "stderr", text: string): void {
    // Split by newlines and create log entries
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const logLine: LogLine = {
        timestamp: new Date().toISOString(),
        stream,
        text: line,
      };
      this.logs.push(logLine);
      this.emit("log", this.config.id, logLine);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code ?? undefined;
    this.exitSignal = signal ?? undefined;
    this.stoppedAt = new Date();
    this.metrics.lastStopped = this.stoppedAt.toISOString();

    // Calculate uptime
    if (this.startedAt) {
      this.metrics.uptimeMs =
        this.stoppedAt.getTime() - this.startedAt.getTime();
    }

    this.child = null;
    this.pid = undefined;
    this.stopHealthChecks();

    const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    this.appendLog("stderr", `Process exited with ${exitInfo}`);

    // Don't restart if we're intentionally stopping
    if (this.stopping) {
      this.setStatus("stopped");
      this.emit("stop", this.getState());
      return;
    }

    // Determine if we should restart
    const shouldRestart = this.shouldRestart(code);

    if (shouldRestart) {
      this.scheduleRestart(exitInfo);
    } else {
      this.setStatus(code === 0 ? "stopped" : "failed");
      this.emit("stop", this.getState());
    }
  }

  private shouldRestart(exitCode: number | null): boolean {
    const { restart, maxRestarts } = this.config;

    // Check max restarts (unless unlimited)
    if (maxRestarts !== -1 && this.restartCount >= maxRestarts) {
      this.appendLog(
        "stderr",
        `Max restarts (${maxRestarts}) reached, not restarting`,
      );
      return false;
    }

    switch (restart) {
      case "always":
        return true;
      case "on-failure":
        return exitCode !== 0;
      case "never":
        return false;
      default:
        return false;
    }
  }

  private scheduleRestart(reason: string): void {
    this.lastRestartReason = reason;
    this.restartCount++;
    this.metrics.restartCount++;

    const delay = Math.min(this.currentBackoff, this.config.maxBackoff);
    this.appendLog(
      "stderr",
      `Scheduling restart in ${delay}ms (attempt ${this.restartCount})`,
    );

    this.setStatus("stopped");

    this.restartTimer = setTimeout(async () => {
      this.emit("restart", this.getState(), reason);
      await this.start();
    }, delay);

    // Apply exponential backoff for next restart
    this.currentBackoff = Math.min(
      this.currentBackoff * this.config.backoffMultiplier,
      this.config.maxBackoff,
    );
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  // ============ Health Checks ============

  private startHealthChecks(): void {
    const healthCheck = this.config.healthCheck;
    if (!healthCheck || healthCheck.type === "none") {
      return;
    }

    this.healthCheckTimer = setInterval(async () => {
      await this.runHealthCheck();
    }, healthCheck.interval);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private async runHealthCheck(): Promise<void> {
    const healthCheck = this.config.healthCheck;
    if (!healthCheck || this.status !== "running") {
      return;
    }

    let isHealthy = false;
    let reason = "";

    try {
      switch (healthCheck.type) {
        case "file_modified":
          ({ isHealthy, reason } = this.checkFileModified(healthCheck));
          break;
        case "http":
          ({ isHealthy, reason } = await this.checkHttp(healthCheck));
          break;
        case "tcp":
          ({ isHealthy, reason } = await this.checkTcp(healthCheck));
          break;
        case "command":
          ({ isHealthy, reason } = await this.checkCommand(healthCheck));
          break;
        default:
          isHealthy = true;
      }
    } catch (err) {
      isHealthy = false;
      reason = err instanceof Error ? err.message : "Health check error";
    }

    this.metrics.lastHealthCheck = new Date().toISOString();

    if (!isHealthy) {
      this.metrics.healthCheckFailures++;
      const retries = healthCheck.retries ?? 3;

      if (this.metrics.healthCheckFailures >= retries) {
        this.healthy = false;
        this.emit("unhealthy", this.getState(), reason);
        this.setStatus("unhealthy");

        // Take action
        if (healthCheck.action === "restart" && !this.stopping) {
          this.appendLog(
            "stderr",
            `Health check failed: ${reason}. Restarting...`,
          );
          this.lastRestartReason = `unhealthy: ${reason}`;
          await this.stop();
          await this.start();
        }
      }
    } else {
      if (!this.healthy) {
        this.healthy = true;
        this.emit("healthy", this.getState());
        // Cast needed: TS narrows status to "running" after early return,
        // but setStatus calls in the unhealthy branch can change it
        if ((this.status as ProcessStatus) === "unhealthy") {
          this.setStatus("running");
        }
      }
      this.metrics.healthCheckFailures = 0;
    }
  }

  private checkFileModified(config: HealthCheckConfig): {
    isHealthy: boolean;
    reason: string;
  } {
    if (!config.path) {
      return {
        isHealthy: false,
        reason: "No path configured for file_modified check",
      };
    }

    if (!existsSync(config.path)) {
      return { isHealthy: false, reason: `File not found: ${config.path}` };
    }

    const stats = statSync(config.path);
    const mtime = stats.mtime.getTime();
    const age = Date.now() - mtime;

    if (age > config.timeout) {
      return {
        isHealthy: false,
        reason: `File not modified in ${Math.round(age / 1000)}s (timeout: ${config.timeout / 1000}s)`,
      };
    }

    return { isHealthy: true, reason: "" };
  }

  private async checkHttp(
    config: HealthCheckConfig,
  ): Promise<{ isHealthy: boolean; reason: string }> {
    if (!config.url) {
      return { isHealthy: false, reason: "No URL configured for http check" };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);

      const response = await fetch(config.url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { isHealthy: true, reason: "" };
      }
      return { isHealthy: false, reason: `HTTP ${response.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { isHealthy: false, reason: `HTTP check failed: ${message}` };
    }
  }

  private async checkTcp(
    config: HealthCheckConfig,
  ): Promise<{ isHealthy: boolean; reason: string }> {
    const { host, port } = config;
    if (!host || !port) {
      return {
        isHealthy: false,
        reason: "No host/port configured for tcp check",
      };
    }

    return new Promise((resolve) => {
      const socket = new Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({
          isHealthy: false,
          reason: `TCP timeout connecting to ${config.host}:${config.port}`,
        });
      }, config.timeout);

      socket.connect(port, host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ isHealthy: true, reason: "" });
      });

      socket.on("error", (err: Error) => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ isHealthy: false, reason: `TCP error: ${err.message}` });
      });
    });
  }

  private async checkCommand(
    config: HealthCheckConfig,
  ): Promise<{ isHealthy: boolean; reason: string }> {
    if (!config.command || config.command.length === 0) {
      return {
        isHealthy: false,
        reason: "No command configured for command check",
      };
    }

    return new Promise((resolve) => {
      const [cmd, ...args] = config.command!;
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.timeout,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, config.timeout);

      child.on("exit", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            isHealthy: false,
            reason: "Command health check timed out",
          });
        } else if (code === 0) {
          resolve({ isHealthy: true, reason: "" });
        } else {
          resolve({
            isHealthy: false,
            reason: `Command exited with code ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ isHealthy: false, reason: `Command error: ${err.message}` });
      });
    });
  }
}
