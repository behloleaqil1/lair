/**
 * Gate runner service (optional)
 *
 * Polls the gate queue directory and assigns gates to machines.
 * Only active when gate_runner.enabled is true in project config.
 */
import {
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type { GateLane, MachineConfig } from "../../shared/types.js";
import {
  GateDistributor,
  type SelectionStrategy,
} from "./gate-distribution.js";
import {
  executeGate,
  type RemoteGateResult,
  type GateProcess,
} from "./remote-gate.js";
import { MachineHealthChecker, checkAllMachines } from "../machines/health.js";
import { validateEnvVars } from "../machines/ssh.js";

/**
 * Gate runner configuration
 */
export interface GateRunnerConfig {
  /** Whether gate runner is enabled */
  enabled: boolean;
  /** Seconds between queue checks (default: 5) */
  pollInterval?: number;
  /** Selection strategy (default: round-robin) */
  strategy?: SelectionStrategy;
  /** Default gate script path */
  gateScript?: string;
  /** Config path to pass to gates */
  configPath?: string;
}

/**
 * A gate request file parsed from the queue
 */
export interface GateRequest {
  id: string;
  lane: GateLane;
  priority: number;
  worktree: string;
  branch?: string;
  envVars?: Record<string, string>;
  requestFile: string;
}

/**
 * Running gate tracking
 */
interface RunningGate {
  request: GateRequest;
  machineId: string;
  process: GateProcess;
  startTime: number;
}

/**
 * Gate runner manages gate queue polling and distribution
 */
export class GateRunner {
  private config: GateRunnerConfig;
  private queueDir: string;
  private resultsDir: string;
  private machines: Record<string, MachineConfig>;
  private distributor: GateDistributor;
  private healthChecker: MachineHealthChecker;
  private runningGates: Map<string, RunningGate> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Callbacks for events
  private onGateStart?: (gate: GateRequest, machineId: string) => void;
  private onGateComplete?: (
    gate: GateRequest,
    machineId: string,
    result: RemoteGateResult,
  ) => void;
  private onError?: (error: Error, gate?: GateRequest) => void;

  constructor(
    config: GateRunnerConfig,
    queueDir: string,
    resultsDir: string,
    machines: Record<string, MachineConfig>,
  ) {
    this.config = config;
    this.queueDir = queueDir;
    this.resultsDir = resultsDir;
    this.machines = machines;
    this.distributor = new GateDistributor(config.strategy ?? "round-robin");
    this.healthChecker = new MachineHealthChecker();
  }

  /**
   * Set event callbacks
   */
  setCallbacks(callbacks: {
    onGateStart?: (gate: GateRequest, machineId: string) => void;
    onGateComplete?: (
      gate: GateRequest,
      machineId: string,
      result: RemoteGateResult,
    ) => void;
    onError?: (error: Error, gate?: GateRequest) => void;
  }): void {
    this.onGateStart = callbacks.onGateStart;
    this.onGateComplete = callbacks.onGateComplete;
    this.onError = callbacks.onError;
  }

  /**
   * Start the gate runner polling loop
   */
  start(): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.poll();
  }

  /**
   * Stop the gate runner
   */
  stop(): void {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll the queue and process gates
   */
  private async poll(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.processQueue();
    } catch (err) {
      if (this.onError) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Schedule next poll
    const interval = (this.config.pollInterval ?? 5) * 1000;
    this.pollTimer = setTimeout(() => this.poll(), interval);
  }

  /**
   * Process the gate queue
   */
  private async processQueue(): Promise<void> {
    // Get current health status
    const healthResults = await checkAllMachines(
      this.machines,
      this.healthChecker,
    );

    // Read queued gate requests
    const requests = this.readQueuedRequests();

    // Sort by priority (higher priority first) then by ID (older first)
    requests.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.id.localeCompare(b.id);
    });

    // Process each request
    for (const request of requests) {
      // Skip if already running
      if (this.runningGates.has(request.id)) {
        continue;
      }

      // Try to assign to a machine
      const machineId = this.distributor.selectMachineForLane(
        request.lane,
        this.machines,
        healthResults,
      );

      if (!machineId) {
        // No machine available for this lane, skip
        continue;
      }

      // Check if machine has capacity (one gate per runner)
      const runningOnMachine = this.getRunningGatesOnMachine(machineId);
      const machine = this.machines[machineId];
      const capacity = machine.runners?.length ?? 1;

      if (runningOnMachine >= capacity) {
        // Machine at capacity, skip
        continue;
      }

      // Start the gate
      await this.startGate(request, machineId);
    }
  }

  /**
   * Read gate request files from queue directory
   */
  readQueuedRequests(): GateRequest[] {
    if (!existsSync(this.queueDir)) {
      return [];
    }

    const requests: GateRequest[] = [];
    const files = readdirSync(this.queueDir);

    for (const file of files) {
      // Gate request files are named: <lane>.<priority>.<id>.req
      const match = file.match(/^(heavy|light|remote)\.(\d+)\.([^.]+)\.req$/);
      if (!match) {
        continue;
      }

      const [, lane, priorityStr, id] = match;
      const requestFile = join(this.queueDir, file);

      try {
        const content = readFileSync(requestFile, "utf-8");
        const data = JSON.parse(content);

        // Request files are written by agents: reject anything malformed,
        // including env var names that are not plain identifiers
        if (!data || typeof data !== "object") continue;
        if (data.worktree !== undefined && typeof data.worktree !== "string") continue;
        if (data.branch !== undefined && typeof data.branch !== "string") continue;
        const envErrors = validateEnvVars(data.envVars);
        if (envErrors.length > 0) {
          console.warn(
            `[GateRunner] Skipping ${file}: ${envErrors.join("; ")}`,
          );
          continue;
        }

        requests.push({
          id,
          lane: lane as GateLane,
          priority: parseInt(priorityStr, 10),
          worktree: data.worktree ?? "",
          branch: data.branch,
          envVars: data.envVars,
          requestFile,
        });
      } catch {
        // Skip malformed request files
      }
    }

    return requests;
  }

  /**
   * Start a gate on a machine
   */
  private async startGate(
    request: GateRequest,
    machineId: string,
  ): Promise<void> {
    const machine = this.machines[machineId];
    if (!machine) {
      return;
    }

    const gateScript =
      machine.gate_script ?? this.config.gateScript ?? "work/bin/gate.sh";
    const configPath = this.config.configPath ?? "config.yaml";

    // Record gate start
    this.distributor.recordGateStart(machineId, request.lane);

    // Notify callback
    if (this.onGateStart) {
      this.onGateStart(request, machineId);
    }

    // Execute gate
    const gateProcess = executeGate(
      machine,
      gateScript,
      configPath,
      request.worktree,
      {
        envVars: request.envVars,
        onStdout: (_data) => {
          // Could stream to a log file here
        },
        onStderr: (_data) => {
          // Could stream to a log file here
        },
      },
    );

    // Track running gate
    this.runningGates.set(request.id, {
      request,
      machineId,
      process: gateProcess,
      startTime: Date.now(),
    });

    // Handle completion
    gateProcess.promise
      .then((result) => {
        this.handleGateComplete(request, machineId, result);
      })
      .catch((err) => {
        if (this.onError) {
          this.onError(
            err instanceof Error ? err : new Error(String(err)),
            request,
          );
        }
        this.runningGates.delete(request.id);
        this.distributor.recordGateEnd(machineId, request.lane);
      });
  }

  /**
   * Handle gate completion
   */
  private handleGateComplete(
    request: GateRequest,
    machineId: string,
    result: RemoteGateResult,
  ): void {
    // Remove from running
    this.runningGates.delete(request.id);

    // Record gate end
    this.distributor.recordGateEnd(machineId, request.lane);

    // Write result file
    this.writeGateResult(request, result);

    // Remove request file
    try {
      unlinkSync(request.requestFile);
    } catch {
      // Ignore errors removing request file
    }

    // Notify callback
    if (this.onGateComplete) {
      this.onGateComplete(request, machineId, result);
    }
  }

  /**
   * Write gate result to results directory
   */
  private writeGateResult(
    request: GateRequest,
    result: RemoteGateResult,
  ): void {
    const resultFile = join(this.resultsDir, `${request.id}.json`);
    const resultData = {
      id: request.id,
      lane: request.lane,
      branch: request.branch,
      rc: result.exitCode,
      success: result.success,
      duration: result.duration,
      timedOut: result.timedOut,
      error: result.error,
      completedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(resultFile, JSON.stringify(resultData, null, 2));
    } catch {
      // Ignore errors writing result
    }

    // Write log file
    const logFile = join(this.resultsDir, `${request.id}.log`);
    try {
      writeFileSync(logFile, result.stdout + result.stderr);
    } catch {
      // Ignore errors writing log
    }
  }

  /**
   * Get number of gates running on a machine
   */
  getRunningGatesOnMachine(machineId: string): number {
    let count = 0;
    for (const running of this.runningGates.values()) {
      if (running.machineId === machineId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all currently running gates
   */
  getRunningGates(): Array<{
    id: string;
    lane: GateLane;
    machineId: string;
    duration: number;
  }> {
    const now = Date.now();
    const result: Array<{
      id: string;
      lane: GateLane;
      machineId: string;
      duration: number;
    }> = [];

    for (const running of this.runningGates.values()) {
      result.push({
        id: running.request.id,
        lane: running.request.lane,
        machineId: running.machineId,
        duration: now - running.startTime,
      });
    }

    return result;
  }

  /**
   * Cancel a running gate
   */
  cancelGate(gateId: string): boolean {
    const running = this.runningGates.get(gateId);
    if (!running) {
      return false;
    }

    running.process.kill();
    return true;
  }

  /**
   * Check if the runner is currently active
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Update machine configuration
   */
  updateMachines(machines: Record<string, MachineConfig>): void {
    this.machines = machines;
    // Invalidate health cache to re-check new machines
    this.healthChecker.invalidateAll();
  }
}

/**
 * Create a gate runner from project config
 */
export function createGateRunner(
  config: GateRunnerConfig,
  queueDir: string,
  resultsDir: string,
  machines: Record<string, MachineConfig>,
): GateRunner | null {
  if (!config.enabled) {
    return null;
  }

  return new GateRunner(config, queueDir, resultsDir, machines);
}
