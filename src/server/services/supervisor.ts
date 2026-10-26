/**
 * Supervisor - Singleton process manager for Lair
 *
 * Features:
 * - Loads process configs from project YAML
 * - Manages Map<string, ManagedProcess>
 * - start(id), stop(id), restart(id), getAll(), get(id)
 * - Auto-start processes with autostart: true
 * - Event emitter for status changes
 * - Graceful shutdown of all processes
 */
import { EventEmitter } from "events";
import { ManagedProcess } from "./managed-process.js";
import { loadProjectConfig } from "../config.js";
import type {
  ProcessConfig,
  ProcessState,
  ProcessListResponse,
  LogLine,
  HealthCheckConfig,
} from "../../shared/process-types.js";
import type { ProjectConfig } from "../../shared/types.js";

// Re-export defaults for config merging
const DEFAULTS: Partial<ProcessConfig> = {
  restart: "on-failure",
  restartDelay: 1000,
  maxRestarts: 10,
  backoffMultiplier: 2,
  maxBackoff: 300000,
  logMaxLines: 10000,
  autostart: false,
};

export interface SupervisorEvents {
  start: (state: ProcessState) => void;
  stop: (state: ProcessState) => void;
  restart: (state: ProcessState, reason: string) => void;
  healthy: (state: ProcessState) => void;
  unhealthy: (state: ProcessState, reason: string) => void;
  log: (processId: string, line: LogLine) => void;
  statusChange: (state: ProcessState) => void;
}

export class Supervisor extends EventEmitter {
  private static instance: Supervisor | null = null;
  private processes = new Map<string, ManagedProcess>();
  private configs = new Map<string, ProcessConfig>();
  private projectName: string | null = null;
  private projectConfig: ProjectConfig | null = null;
  private shuttingDown = false;

  private constructor() {
    super();
  }

  /**
   * Get the supervisor singleton instance
   */
  static getInstance(): Supervisor {
    if (!Supervisor.instance) {
      Supervisor.instance = new Supervisor();
    }
    return Supervisor.instance;
  }

  /**
   * Reset the singleton (for testing)
   */
  static reset(): void {
    if (Supervisor.instance) {
      Supervisor.instance.destroy();
      Supervisor.instance = null;
    }
  }

  /**
   * Load process configurations from a project
   */
  loadConfig(projectName: string): void {
    this.projectName = projectName;
    this.projectConfig = loadProjectConfig(projectName);

    // Type assertion for processes field (YAML uses snake_case)
    const processesConfig = (
      this.projectConfig as ProjectConfig & {
        processes?: Record<string, Record<string, unknown>>;
      }
    ).processes;

    if (!processesConfig) {
      return;
    }

    // Parse and store configs
    for (const [id, rawConfig] of Object.entries(processesConfig)) {
      const config = this.parseProcessConfig(id, rawConfig);
      this.configs.set(id, config);
    }
  }

  /**
   * Initialize supervisor and auto-start processes
   */
  async initialize(): Promise<void> {
    if (!this.projectConfig) {
      throw new Error("No project config loaded. Call loadConfig() first.");
    }

    // Create ManagedProcess instances for each config
    for (const [id, config] of this.configs) {
      this.createManagedProcess(id, config);
    }

    // Auto-start processes that have autostart: true
    const autostartProcesses = Array.from(this.configs.entries())
      .filter(([_, config]) => config.autostart)
      .sort((a, b) => {
        // Sort by dependencies (simple topological sort)
        const aDeps = a[1].dependsOn || [];
        const bDeps = b[1].dependsOn || [];
        if (aDeps.includes(b[0])) return 1;
        if (bDeps.includes(a[0])) return -1;
        return 0;
      });

    for (const [id] of autostartProcesses) {
      await this.start(id);
    }
  }

  /**
   * Start a process by ID
   */
  async start(processId: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error("Supervisor is shutting down");
    }

    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process not found: ${processId}`);
    }

    // Check dependencies
    const config = this.configs.get(processId);
    if (config?.dependsOn) {
      for (const depId of config.dependsOn) {
        const depProcess = this.processes.get(depId);
        if (!depProcess || depProcess.getState().status !== "running") {
          throw new Error(`Dependency not running: ${depId}`);
        }
      }
    }

    await process.start();
  }

  /**
   * Stop a process by ID
   */
  async stop(processId: string, gracePeriodMs?: number): Promise<void> {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process not found: ${processId}`);
    }

    await process.stop(gracePeriodMs);
  }

  /**
   * Restart a process by ID
   */
  async restart(processId: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error("Supervisor is shutting down");
    }

    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process not found: ${processId}`);
    }

    await process.restart();
  }

  /**
   * Get all process states
   */
  getAll(): ProcessListResponse {
    const processes: ProcessState[] = [];
    for (const [, process] of this.processes) {
      processes.push(process.getState());
    }
    return {
      processes,
      supervisorRunning: !this.shuttingDown,
    };
  }

  /**
   * Get a single process state
   */
  get(processId: string): ProcessState | null {
    const process = this.processes.get(processId);
    return process ? process.getState() : null;
  }

  /**
   * Get process logs
   */
  getLogs(processId: string, tail: number = 100): LogLine[] {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process not found: ${processId}`);
    }
    return process.getLogs(tail);
  }

  /**
   * Check if a process exists
   */
  has(processId: string): boolean {
    return this.processes.has(processId);
  }

  /**
   * Get list of process IDs
   */
  getProcessIds(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Check if project is read-only
   */
  isReadOnly(): boolean {
    return this.projectConfig?.read_only === true;
  }

  /**
   * Graceful shutdown of all processes
   */
  async shutdown(gracePeriodMs: number = 10000): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    // Stop all processes in parallel
    const stopPromises: Promise<void>[] = [];
    for (const [, process] of this.processes) {
      const state = process.getState();
      if (state.status === "running" || state.status === "starting") {
        stopPromises.push(process.stop(gracePeriodMs));
      }
    }

    await Promise.all(stopPromises);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    for (const [, process] of this.processes) {
      process.destroy();
    }
    this.processes.clear();
    this.configs.clear();
    this.projectName = null;
    this.projectConfig = null;
    this.shuttingDown = false;
    this.removeAllListeners();
  }

  // ============ Private Methods ============

  private parseProcessConfig(
    id: string,
    raw: Record<string, unknown>,
  ): ProcessConfig {
    // YAML uses snake_case, convert to camelCase
    const config: ProcessConfig = {
      id,
      name: (raw.name as string) || id,
      command: (raw.command as string[]) || [],
      cwd: raw.cwd as string | undefined,
      env: raw.env as Record<string, string> | undefined,
      restart: (raw.restart as ProcessConfig["restart"]) || DEFAULTS.restart!,
      restartDelay:
        (raw.restart_delay as number) ?? DEFAULTS.restartDelay!,
      maxRestarts: (raw.max_restarts as number) ?? DEFAULTS.maxRestarts!,
      backoffMultiplier:
        (raw.backoff_multiplier as number) ?? DEFAULTS.backoffMultiplier!,
      maxBackoff: (raw.max_backoff as number) ?? DEFAULTS.maxBackoff!,
      logMaxLines: (raw.log_max_lines as number) ?? DEFAULTS.logMaxLines!,
      logFile: raw.log_file as string | undefined,
      autostart: (raw.autostart as boolean) ?? DEFAULTS.autostart!,
      dependsOn: raw.depends_on as string[] | undefined,
    };

    // Parse health check if present (YAML uses health_check with snake_case fields)
    const healthCheck = raw.health_check as Record<string, unknown> | undefined;
    if (healthCheck) {
      config.healthCheck = {
        type: (healthCheck.type as HealthCheckConfig["type"]) || "none",
        path: healthCheck.path as string | undefined,
        url: healthCheck.url as string | undefined,
        host: healthCheck.host as string | undefined,
        port: healthCheck.port as number | undefined,
        command: healthCheck.command as string[] | undefined,
        interval: (healthCheck.interval as number) ?? 30000,
        timeout: (healthCheck.timeout as number) ?? 60000,
        action: (healthCheck.action as HealthCheckConfig["action"]) ?? "alert",
        retries: (healthCheck.retries as number) ?? 3,
      };
    }

    return config;
  }

  private createManagedProcess(id: string, config: ProcessConfig): void {
    const process = new ManagedProcess(config);

    // Forward events
    process.on("start", (state) => this.emit("start", state));
    process.on("stop", (state) => this.emit("stop", state));
    process.on("restart", (state, reason) =>
      this.emit("restart", state, reason),
    );
    process.on("healthy", (state) => this.emit("healthy", state));
    process.on("unhealthy", (state, reason) =>
      this.emit("unhealthy", state, reason),
    );
    process.on("log", (processId, line) => this.emit("log", processId, line));
    process.on("statusChange", (state) => this.emit("statusChange", state));

    this.processes.set(id, process);
  }
}

/**
 * Get the global supervisor instance
 */
export function getSupervisor(): Supervisor {
  return Supervisor.getInstance();
}
