/**
 * Self-healing service for fleet management.
 * Monitors nodes, detects failures, reschedules jobs automatically.
 */
import { getStore } from "../store/store.js";
import { getEventBus } from "../core/event-bus.js";
import { getNodeManager } from "../nodes/node-manager.js";
import { getScheduler } from "../scheduler/scheduler.js";
import type {
  HealingConfig,
  HealingEvent,
  HealingEventType,
} from "../../shared/fleet-types.js";
import type { Job, Node } from "../../shared/server-types.js";

const DEFAULT_CONFIG: HealingConfig = {
  enabled: true,
  heartbeatTimeoutMs: 30000, // 30 seconds
  stuckJobTimeoutMs: 300000, // 5 minutes
  maxRetries: 3,
  autoReschedule: true,
  autoRecover: true,
};

/**
 * Self-healing service.
 */
export class Healer {
  private config: HealingConfig;
  private healingEvents: HealingEvent[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  // taskId -> retry count. Keyed by TASK: every reschedule creates a new job
  // with a new id, so a per-job count would never reach maxRetries.
  private taskRetries = new Map<string, number>();

  constructor(config?: Partial<HealingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the healer.
   */
  start(): void {
    if (!this.config.enabled) {
      console.log("[Healer] Self-healing is disabled");
      return;
    }

    // Check every 10 seconds
    this.checkInterval = setInterval(() => {
      this.check();
    }, 10000);

    // Subscribe to events
    const eventBus = getEventBus();
    eventBus.on("node.offline", async (event) => {
      await this.handleNodeOffline(event.data.nodeId as string);
    });
    eventBus.on("node.online", async (event) => {
      await this.handleNodeOnline(event.data.nodeId as string);
    });
    eventBus.on("job.failed", async (event) => {
      await this.handleJobFailed(event.data.jobId as string, event.data.error as string);
    });

    console.log("[Healer] Self-healing started");
  }

  /**
   * Stop the healer.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[Healer] Self-healing stopped");
  }

  /**
   * Periodic health check.
   */
  private async check(): Promise<void> {
    const store = getStore();
    getNodeManager(); // Initialize node manager if needed

    // Check for nodes with missed heartbeats
    const nodes = store.listNodes();
    const now = Date.now();

    for (const node of nodes) {
      if (node.status === "offline") {
        continue;
      }

      const lastHeartbeat = new Date(node.lastHeartbeat).getTime();
      const timeSinceHeartbeat = now - lastHeartbeat;

      if (timeSinceHeartbeat > this.config.heartbeatTimeoutMs) {
        // Node has missed heartbeat
        if (node.status === "online") {
          await this.handleHeartbeatTimeout(node);
        }
      }
    }

    // Check for stuck jobs
    const runningJobs = store.listJobs({ status: "running" });
    for (const job of runningJobs) {
      if (!job.startedAt) continue;

      const startTime = new Date(job.startedAt).getTime();
      const runTime = now - startTime;

      if (runTime > this.config.stuckJobTimeoutMs) {
        await this.handleStuckJob(job);
      }
    }
  }

  /**
   * Handle node going offline.
   */
  private async handleNodeOffline(nodeId: string): Promise<void> {
    const store = getStore();
    const node = store.getNode(nodeId);

    if (!node) return;

    // Record healing event
    this.recordEvent("node_offline", {
      nodeId,
      message: `Node ${node.name} went offline`,
    });

    // Mark node as offline
    store.markNodeOffline(nodeId);

    // Reschedule any running jobs on this node
    if (this.config.autoReschedule) {
      const runningJobs = store.listJobs({ status: "running", nodeId });
      for (const job of runningJobs) {
        await this.rescheduleJob(job, "node_offline");
      }
    }
  }

  /**
   * Handle node coming back online.
   */
  private async handleNodeOnline(nodeId: string): Promise<void> {
    const store = getStore();
    const node = store.getNode(nodeId);

    if (!node) return;

    // Record healing event
    this.recordEvent("node_recovered", {
      nodeId,
      message: `Node ${node.name} recovered`,
    });

    // Resolve any outstanding node_offline events for this node
    for (const event of this.healingEvents) {
      if (event.nodeId === nodeId && !event.resolved) {
        event.resolved = true;
        event.resolvedAt = new Date().toISOString();
      }
    }

    console.log(`[Healer] Node ${node.name} recovered and ready for work`);
  }

  /**
   * Handle heartbeat timeout.
   */
  private async handleHeartbeatTimeout(node: Node): Promise<void> {
    const store = getStore();

    // Record healing event
    this.recordEvent("heartbeat_timeout", {
      nodeId: node.id,
      message: `Node ${node.name} heartbeat timeout (${this.config.heartbeatTimeoutMs}ms)`,
      action: "Marking node offline",
    });

    // Mark node as offline
    store.markNodeOffline(node.id);

    // Emit event
    const eventBus = getEventBus();
    await eventBus.emit("node.offline", { nodeId: node.id });

    console.log(`[Healer] Node ${node.name} marked offline due to heartbeat timeout`);
  }

  /**
   * Handle stuck job.
   */
  private async handleStuckJob(job: Job): Promise<void> {
    const store = getStore();
    const nodeManager = getNodeManager();

    // Record healing event
    this.recordEvent("job_stuck", {
      jobId: job.id,
      nodeId: job.nodeId,
      taskId: job.taskId,
      message: `Job ${job.id} stuck for more than ${this.config.stuckJobTimeoutMs}ms`,
      action: this.config.autoReschedule ? "Cancelling and rescheduling" : "Manual intervention required",
    });

    // Cancel the job on the node
    nodeManager.cancelJob(job.nodeId, job.id);

    // Mark job as failed
    store.updateJobStatus(job.id, "failed", {
      completedAt: new Date().toISOString(),
      error: "Job stuck timeout",
    });

    // Reschedule if enabled
    if (this.config.autoReschedule) {
      await this.rescheduleJob(job, "job_stuck");
    }
  }

  /**
   * Handle job failure.
   */
  private async handleJobFailed(jobId: string, error?: string): Promise<void> {
    const store = getStore();
    const job = store.getJob(jobId);

    if (!job) return;

    // Check retry count for the task (not the job: retries get new job ids)
    const retries = this.taskRetries.get(job.taskId) ?? 0;

    if (retries >= this.config.maxRetries) {
      // Max retries exceeded
      this.recordEvent("job_failed", {
        jobId,
        nodeId: job.nodeId,
        taskId: job.taskId,
        message: `Job ${jobId} failed after ${retries} retries: ${error}`,
        action: "No more retries",
      });
      return;
    }

    // Reschedule if enabled
    if (this.config.autoReschedule) {
      this.taskRetries.set(job.taskId, retries + 1);
      await this.rescheduleJob(job, "job_failed");
    }
  }

  /**
   * Number of automatic retries recorded for a task.
   */
  getTaskRetryCount(taskId: string): number {
    return this.taskRetries.get(taskId) ?? 0;
  }

  /**
   * Reschedule a job.
   */
  private async rescheduleJob(job: Job, reason: HealingEventType): Promise<void> {
    const store = getStore();
    const task = store.getTask(job.taskId);

    if (!task) {
      console.warn(`[Healer] Cannot reschedule job ${job.id}: task ${job.taskId} not found`);
      return;
    }

    // Record healing event
    this.recordEvent("job_rescheduled", {
      jobId: job.id,
      taskId: job.taskId,
      message: `Job ${job.id} rescheduled due to ${reason}`,
    });

    // Reset task to queued status
    store.updateTaskStatus(task.id, "queued", {
      assignedNode: undefined,
      jobId: undefined,
    });

    console.log(`[Healer] Job ${job.id} rescheduled for task ${task.title}`);

    // Trigger scheduler tick
    const scheduler = getScheduler();
    await scheduler.tick();
  }

  /**
   * Record a healing event.
   */
  private recordEvent(
    type: HealingEventType,
    data: {
      nodeId?: string;
      machineId?: string;
      jobId?: string;
      taskId?: string;
      message: string;
      action?: string;
    }
  ): void {
    const event: HealingEvent = {
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      nodeId: data.nodeId,
      machineId: data.machineId,
      jobId: data.jobId,
      taskId: data.taskId,
      message: data.message,
      action: data.action,
      resolved: false,
    };

    this.healingEvents.push(event);

    // Keep only last 100 events
    if (this.healingEvents.length > 100) {
      this.healingEvents.shift();
    }

    console.log(`[Healer] Event: ${type} - ${data.message}`);
  }

  /**
   * Get recent healing events.
   */
  getEvents(limit = 50): HealingEvent[] {
    return this.healingEvents.slice(-limit);
  }

  /**
   * Get unresolved events.
   */
  getUnresolvedEvents(): HealingEvent[] {
    return this.healingEvents.filter((e) => !e.resolved);
  }

  /**
   * Get current config.
   */
  getConfig(): HealingConfig {
    return { ...this.config };
  }

  /**
   * Update config.
   */
  updateConfig(updates: Partial<HealingConfig>): void {
    this.config = { ...this.config, ...updates };

    if (!this.config.enabled && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    } else if (this.config.enabled && !this.checkInterval) {
      this.start();
    }
  }
}

// Global singleton
let globalHealer: Healer | null = null;

/**
 * Get or create the global healer.
 */
export function getHealer(config?: Partial<HealingConfig>): Healer {
  if (!globalHealer) {
    globalHealer = new Healer(config);
  }
  return globalHealer;
}

/**
 * Stop the healer.
 */
export function stopHealer(): void {
  globalHealer?.stop();
  globalHealer = null;
}
