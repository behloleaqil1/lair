/**
 * Scheduler for lair-server.
 * Matches ready tasks to available node capacity.
 */
import { getStore } from "../store/store.js";
import { getNodeManager } from "../nodes/node-manager.js";
import { getEventBus } from "../core/event-bus.js";
import type {
  SchedulerState,
  SchedulerConfig,
  Task,
  Node,
  JobAssignment,
} from "../../shared/server-types.js";

const DEFAULT_CONFIG: SchedulerConfig = {
  tickIntervalMs: 2000, // Check every 2 seconds
  nodeTimeoutMs: 30000, // 30 seconds without heartbeat = offline
  defaultTaskCores: 1, // Default cores per task
  defaultTaskRamMb: 512, // Default RAM per task (MB)
  maxAgentsPerNode: 8, // Max agents per node
};

/**
 * Scheduler that matches tasks to nodes.
 */
export class Scheduler {
  private config: SchedulerConfig;
  private running = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private lastTickAt: string | null = null;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the scheduler loop.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.tickInterval = setInterval(() => {
      this.tick();
    }, this.config.tickIntervalMs);

    console.log(`[Scheduler] Started (tick every ${this.config.tickIntervalMs}ms)`);

    // Run first tick immediately
    this.tick();
  }

  /**
   * Stop the scheduler loop.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    console.log("[Scheduler] Stopped");
  }

  /**
   * Run one scheduler tick.
   */
  async tick(): Promise<void> {
    const store = getStore();
    const nodeManager = getNodeManager();
    const eventBus = getEventBus();

    this.lastTickAt = new Date().toISOString();

    // Get queued tasks
    const queuedTasks = store.getQueuedTasks();
    if (queuedTasks.length === 0) {
      return; // Nothing to schedule
    }

    // Get available nodes
    const availableNodes = store.listAvailableNodes().filter((node) => {
      // Only consider connected nodes
      return nodeManager.isNodeConnected(node.id);
    });

    if (availableNodes.length === 0) {
      return; // No capacity
    }

    // Match tasks to nodes
    let assignedCount = 0;
    for (const task of queuedTasks) {
      const node = this.findBestNode(task, availableNodes);
      if (!node) {
        continue; // No suitable node for this task
      }

      // Calculate resource allocation
      const cores = task.requirements?.minCores ?? this.config.defaultTaskCores;
      const ramMb = task.requirements?.minRamMb ?? this.config.defaultTaskRamMb;

      // Create job
      const job = store.createJob(task.id, node.id, cores, ramMb);

      // Update task
      store.updateTaskStatus(task.id, "assigned", {
        assignedNode: node.id,
        jobId: job.id,
      });

      // Update node's used capacity (optimistically)
      node.usedCapacity.cores += cores;
      node.usedCapacity.ramMb += ramMb;
      node.activeJobs += 1;

      // Send job to node
      const assignment: JobAssignment = {
        jobId: job.id,
        taskId: task.id,
        task,
        allocatedCores: cores,
        allocatedRamMb: ramMb,
      };

      const sent = nodeManager.assignJob(node.id, assignment);
      if (!sent) {
        // Failed to send, revert
        store.updateJobStatus(job.id, "failed", { error: "Failed to send to node" });
        store.updateTaskStatus(task.id, "queued", { assignedNode: undefined, jobId: undefined });
        continue;
      }

      // Emit events
      await eventBus.emit("task.assigned", { taskId: task.id, nodeId: node.id, jobId: job.id });
      await eventBus.emit("job.created", { jobId: job.id, taskId: task.id, nodeId: node.id });

      assignedCount++;
      console.log(`[Scheduler] Assigned task ${task.id} to node ${node.id} (job ${job.id})`);
    }

    if (assignedCount > 0) {
      await eventBus.emit("scheduler.tick", { assigned: assignedCount, queued: queuedTasks.length });
    }
  }

  /**
   * Find the best node for a task.
   */
  private findBestNode(task: Task, nodes: Node[]): Node | null {
    const requirements = task.requirements;

    // Filter nodes by requirements
    const eligible = nodes.filter((node) => {
      // Check if pinned to specific node
      if (requirements?.nodeId && node.id !== requirements.nodeId) {
        return false;
      }

      // Check container runtime
      if (requirements?.containerRuntime && requirements.containerRuntime !== "any") {
        if (node.capacity.containerRuntime !== requirements.containerRuntime) {
          return false;
        }
      }

      // Check GPU requirement
      if (requirements?.gpu && node.capacity.gpuCount === 0) {
        return false;
      }

      // Check available capacity
      const requiredCores = requirements?.minCores ?? this.config.defaultTaskCores;
      const requiredRamMb = requirements?.minRamMb ?? this.config.defaultTaskRamMb;

      const availableCores = node.capacity.cores - node.usedCapacity.cores;
      const availableRamMb = node.capacity.ramMb - node.usedCapacity.ramMb;

      if (availableCores < requiredCores || availableRamMb < requiredRamMb) {
        return false;
      }

      // Check max agents per node
      if (node.activeJobs >= this.config.maxAgentsPerNode) {
        return false;
      }

      return true;
    });

    if (eligible.length === 0) {
      return null;
    }

    // Sort by available capacity (prefer nodes with more free resources)
    eligible.sort((a, b) => {
      const aFree = (a.capacity.cores - a.usedCapacity.cores) + (a.capacity.ramMb - a.usedCapacity.ramMb) / 1000;
      const bFree = (b.capacity.cores - b.usedCapacity.cores) + (b.capacity.ramMb - b.usedCapacity.ramMb) / 1000;
      return bFree - aFree;
    });

    return eligible[0];
  }

  /**
   * Get current scheduler state.
   */
  getState(): SchedulerState {
    const store = getStore();
    const nodes = store.listNodes();
    const onlineNodes = nodes.filter((n) => n.status === "online");

    const totalCapacity = { cores: 0, ramMb: 0 };
    const usedCapacity = { cores: 0, ramMb: 0 };

    for (const node of onlineNodes) {
      totalCapacity.cores += node.capacity.cores;
      totalCapacity.ramMb += node.capacity.ramMb;
      usedCapacity.cores += node.usedCapacity.cores;
      usedCapacity.ramMb += node.usedCapacity.ramMb;
    }

    // Compute max agents based on capacity
    const maxAgents = Math.min(
      Math.floor(totalCapacity.cores / this.config.defaultTaskCores),
      Math.floor(totalCapacity.ramMb / this.config.defaultTaskRamMb),
      onlineNodes.length * this.config.maxAgentsPerNode
    );

    return {
      running: this.running,
      totalCapacity,
      usedCapacity,
      queuedTasks: store.countTasks("queued"),
      runningJobs: store.countJobs("running"),
      activeAgents: store.countRunningAgents(),
      maxAgents: Math.max(maxAgents, 0),
      nodesOnline: onlineNodes.length,
      nodesTotal: nodes.length,
      lastTickAt: this.lastTickAt ?? undefined,
    };
  }

  /**
   * Get scheduler config.
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * Update scheduler config.
   */
  updateConfig(updates: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart tick interval if changed
    if (updates.tickIntervalMs && this.running && this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = setInterval(() => {
        this.tick();
      }, this.config.tickIntervalMs);
    }
  }
}

// Global singleton
let globalScheduler: Scheduler | null = null;

/**
 * Get or create the global scheduler.
 */
export function getScheduler(config?: Partial<SchedulerConfig>): Scheduler {
  if (!globalScheduler) {
    globalScheduler = new Scheduler(config);
  }
  return globalScheduler;
}

/**
 * Stop and clear the global scheduler.
 */
export function stopScheduler(): void {
  globalScheduler?.stop();
  globalScheduler = null;
}
