/**
 * Job manager for lair-server.
 * Handles task creation, job lifecycle, and result processing.
 */
import { getStore } from "../store/store.js";
import { getEventBus } from "../core/event-bus.js";
import type {
  Task,
  Job,
  CreateTaskRequest,
  TaskStatus,
  JobStatus,
} from "../../shared/server-types.js";

/**
 * Job manager - high-level operations on tasks and jobs.
 */
export class JobManager {
  /**
   * Create a new task and queue it for scheduling.
   */
  async createTask(request: CreateTaskRequest): Promise<Task> {
    const store = getStore();
    const eventBus = getEventBus();

    const task = store.createTask(request);

    await eventBus.emit("task.created", {
      taskId: task.id,
      type: task.type,
      priority: task.priority,
      title: task.title,
    });

    console.log(`[JobManager] Task created: ${task.id} - ${task.title}`);
    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | null {
    return getStore().getTask(taskId);
  }

  /**
   * List tasks with optional filtering.
   */
  listTasks(options?: { status?: TaskStatus; limit?: number; offset?: number }): Task[] {
    return getStore().listTasks(options);
  }

  /**
   * Cancel a task.
   * If the task has a running job, it will be cancelled on the node.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const store = getStore();
    const eventBus = getEventBus();

    const task = store.getTask(taskId);
    if (!task) {
      return false;
    }

    // Can only cancel queued or assigned tasks
    if (task.status !== "queued" && task.status !== "assigned" && task.status !== "running") {
      return false;
    }

    // If running, need to cancel the job on the node
    if (task.jobId && (task.status === "assigned" || task.status === "running")) {
      const job = store.getJob(task.jobId);
      if (job) {
        // Import node manager dynamically to avoid circular dependency
        const { getNodeManager } = await import("../nodes/node-manager.js");
        const nodeManager = getNodeManager();
        nodeManager.cancelJob(job.nodeId, job.id);
        store.updateJobStatus(job.id, "cancelled");
      }
    }

    store.updateTaskStatus(taskId, "cancelled", {
      completedAt: new Date().toISOString(),
    });

    await eventBus.emit("task.failed", { taskId, reason: "cancelled" });

    console.log(`[JobManager] Task cancelled: ${taskId}`);
    return true;
  }

  /**
   * Retry a failed task.
   */
  async retryTask(taskId: string): Promise<Task | null> {
    const store = getStore();
    const task = store.getTask(taskId);

    if (!task || task.status !== "failed") {
      return null;
    }

    // Reset task to queued
    store.updateTaskStatus(taskId, "queued", {
      assignedNode: undefined,
      assignedAgent: undefined,
      jobId: undefined,
      startedAt: undefined,
      completedAt: undefined,
      result: undefined,
    });

    console.log(`[JobManager] Task retry: ${taskId}`);
    return store.getTask(taskId);
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): Job | null {
    return getStore().getJob(jobId);
  }

  /**
   * List jobs with optional filtering.
   */
  listJobs(options?: { status?: JobStatus; nodeId?: string; limit?: number }): Job[] {
    return getStore().listJobs(options);
  }

  /**
   * Get task and job statistics.
   */
  getStats(): {
    tasks: { queued: number; running: number; completed: number; failed: number; total: number };
    jobs: { pending: number; running: number; completed: number; failed: number; total: number };
  } {
    const store = getStore();
    return {
      tasks: {
        queued: store.countTasks("queued"),
        running: store.countTasks("running"),
        completed: store.countTasks("completed"),
        failed: store.countTasks("failed"),
        total: store.countTasks(),
      },
      jobs: {
        pending: store.countJobs("pending"),
        running: store.countJobs("running"),
        completed: store.countJobs("completed"),
        failed: store.countJobs("failed"),
        total: store.countJobs(),
      },
    };
  }
}

// Global singleton
let globalJobManager: JobManager | null = null;

/**
 * Get the global job manager.
 */
export function getJobManager(): JobManager {
  if (!globalJobManager) {
    globalJobManager = new JobManager();
  }
  return globalJobManager;
}
