/**
 * Job Runner for lair-node
 *
 * Receives jobs from the server, spawns them in a sandbox (container or process),
 * streams stdout/stderr back to server, and reports completion with a signed result.
 */
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import type {
  Job,
  JobResult,
  JobLogLine,
  JobStatus,
} from "../shared/node-types.js";
import { signData } from "./registration.js";

/** Running job state */
interface RunningJob {
  job: Job;
  process: ChildProcess | null;
  status: JobStatus;
  startedAt: Date;
  pid?: number;
  exitCode?: number;
  error?: string;
}

/**
 * Events emitted by the JobRunner.
 */
export interface JobRunnerEvents {
  job_started: (jobId: string, pid: number) => void;
  job_log: (log: JobLogLine) => void;
  job_completed: (result: JobResult) => void;
  job_failed: (jobId: string, error: string, exitCode?: number) => void;
}

/**
 * JobRunner manages job execution on the node.
 */
export class JobRunner extends EventEmitter {
  private nodeId: string;
  private privateKey: string;
  private runningJobs = new Map<string, RunningJob>();
  private maxConcurrentJobs: number;

  constructor(nodeId: string, privateKey: string, maxConcurrentJobs = 4) {
    super();
    this.nodeId = nodeId;
    this.privateKey = privateKey;
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  /**
   * Get the number of currently running jobs.
   */
  getRunningJobCount(): number {
    return this.runningJobs.size;
  }

  /**
   * Get list of running jobs.
   */
  getRunningJobs(): Array<{ id: string; type: string; startedAt: string }> {
    return Array.from(this.runningJobs.entries()).map(([id, job]) => ({
      id,
      type: job.job.type,
      startedAt: job.startedAt.toISOString(),
    }));
  }

  /**
   * Check if the runner can accept more jobs.
   */
  canAcceptJob(): boolean {
    return this.runningJobs.size < this.maxConcurrentJobs;
  }

  /**
   * Accept and start a job.
   */
  async startJob(job: Job): Promise<boolean> {
    if (!this.canAcceptJob()) {
      console.error(`Cannot accept job ${job.id}: at capacity`);
      return false;
    }

    if (this.runningJobs.has(job.id)) {
      console.error(`Job ${job.id} already running`);
      return false;
    }

    const runningJob: RunningJob = {
      job,
      process: null,
      status: "assigned",
      startedAt: new Date(),
    };

    this.runningJobs.set(job.id, runningJob);

    // Start the job (process mode for M1, container mode later)
    try {
      if (job.sandbox) {
        await this.startContainerJob(job, runningJob);
      } else {
        await this.startProcessJob(job, runningJob);
      }
      return true;
    } catch (error) {
      this.runningJobs.delete(job.id);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.emit("job_failed", job.id, errorMsg);
      return false;
    }
  }

  /**
   * Start a job in process mode (no container).
   */
  private async startProcessJob(job: Job, runningJob: RunningJob): Promise<void> {
    const [cmd, ...args] = job.command;

    const child = spawn(cmd, args, {
      cwd: job.cwd,
      env: { ...process.env, ...job.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    runningJob.process = child;
    runningJob.pid = child.pid;
    runningJob.status = "running";

    this.emit("job_started", job.id, child.pid!);

    // Stream stdout
    child.stdout?.on("data", (data: Buffer) => {
      this.handleOutput(job.id, "stdout", data.toString());
    });

    // Stream stderr
    child.stderr?.on("data", (data: Buffer) => {
      this.handleOutput(job.id, "stderr", data.toString());
    });

    // Handle completion
    child.on("exit", (code, signal) => {
      this.handleJobExit(job.id, code, signal);
    });

    child.on("error", (error) => {
      this.handleJobError(job.id, error);
    });

    // Set up timeout
    if (job.timeout > 0) {
      setTimeout(() => {
        if (this.runningJobs.has(job.id)) {
          this.cancelJob(job.id, "Timeout exceeded");
        }
      }, job.timeout);
    }
  }

  /**
   * Start a job in container mode.
   * NOTE: For M1, this is a simplified implementation using Docker.
   */
  private async startContainerJob(job: Job, runningJob: RunningJob): Promise<void> {
    const image = job.image || "node:22-alpine";

    // Build docker run command
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--workdir",
      job.cwd,
    ];

    // Add resource limits if specified
    if (job.limits?.memoryMb) {
      dockerArgs.push("--memory", `${job.limits.memoryMb}m`);
    }
    if (job.limits?.cpuCores) {
      dockerArgs.push("--cpus", job.limits.cpuCores.toString());
    }

    // Add environment variables
    for (const [key, value] of Object.entries(job.env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    // Mount the working directory
    dockerArgs.push("-v", `${job.cwd}:${job.cwd}`);

    // Add image and command
    dockerArgs.push(image, ...job.command);

    const child = spawn("docker", dockerArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    runningJob.process = child;
    runningJob.pid = child.pid;
    runningJob.status = "running";

    this.emit("job_started", job.id, child.pid!);

    // Stream stdout
    child.stdout?.on("data", (data: Buffer) => {
      this.handleOutput(job.id, "stdout", data.toString());
    });

    // Stream stderr
    child.stderr?.on("data", (data: Buffer) => {
      this.handleOutput(job.id, "stderr", data.toString());
    });

    // Handle completion
    child.on("exit", (code, signal) => {
      this.handleJobExit(job.id, code, signal);
    });

    child.on("error", (error) => {
      this.handleJobError(job.id, error);
    });

    // Set up timeout
    if (job.timeout > 0) {
      setTimeout(() => {
        if (this.runningJobs.has(job.id)) {
          this.cancelJob(job.id, "Timeout exceeded");
        }
      }, job.timeout);
    }
  }

  /**
   * Handle output from a job (stdout or stderr).
   */
  private handleOutput(jobId: string, stream: "stdout" | "stderr", text: string): void {
    // Split by newlines and emit each line
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const logLine: JobLogLine = {
        jobId,
        nodeId: this.nodeId,
        timestamp: new Date().toISOString(),
        stream,
        text: line,
      };
      this.emit("job_log", logLine);
    }
  }

  /**
   * Handle job exit.
   */
  private handleJobExit(
    jobId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const runningJob = this.runningJobs.get(jobId);
    if (!runningJob) {
      return;
    }

    const exitCode = code ?? (signal ? 128 : 1);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - runningJob.startedAt.getTime();

    // Create the result
    const result: JobResult = {
      jobId,
      nodeId: this.nodeId,
      exitCode,
      startedAt: runningJob.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      signature: this.signResult(jobId, exitCode, completedAt.toISOString()),
    };

    // Clean up
    this.runningJobs.delete(jobId);

    // Emit completion
    if (exitCode === 0) {
      this.emit("job_completed", result);
    } else {
      result.error = signal ? `Killed by signal ${signal}` : `Exit code ${exitCode}`;
      this.emit("job_completed", result);
    }
  }

  /**
   * Handle job error.
   */
  private handleJobError(jobId: string, error: Error): void {
    const runningJob = this.runningJobs.get(jobId);
    if (!runningJob) {
      return;
    }

    this.runningJobs.delete(jobId);
    this.emit("job_failed", jobId, error.message);
  }

  /**
   * Cancel a running job.
   */
  cancelJob(jobId: string, reason: string): boolean {
    const runningJob = this.runningJobs.get(jobId);
    if (!runningJob || !runningJob.process) {
      return false;
    }

    console.log(`Cancelling job ${jobId}: ${reason}`);

    // Try graceful termination first
    runningJob.process.kill("SIGTERM");

    // Force kill after 5 seconds
    setTimeout(() => {
      if (this.runningJobs.has(jobId) && runningJob.process) {
        runningJob.process.kill("SIGKILL");
      }
    }, 5000);

    return true;
  }

  /**
   * Sign a job result.
   */
  private signResult(jobId: string, exitCode: number, completedAt: string): string {
    const data = JSON.stringify({ jobId, nodeId: this.nodeId, exitCode, completedAt });
    return signData(data, this.privateKey);
  }

  /**
   * Stop all running jobs (for shutdown).
   */
  async stopAll(): Promise<void> {
    const jobIds = Array.from(this.runningJobs.keys());
    for (const jobId of jobIds) {
      this.cancelJob(jobId, "Node shutting down");
    }

    // Wait a moment for processes to exit
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
