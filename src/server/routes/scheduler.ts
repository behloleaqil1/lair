/**
 * Scheduler and node API routes for M1 Core.
 */
import type { FastifyInstance } from "fastify";
import { getStore } from "../store/store.js";
import { getScheduler } from "../scheduler/scheduler.js";
import { getJobManager } from "../jobs/job-manager.js";
import { getNodeManager } from "../nodes/node-manager.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type {
  CreateTaskRequest,
  TaskStatus,
  JobStatus,
  ListNodesResponse,
  ListJobsResponse,
  ListTasksResponse,
} from "../../shared/server-types.js";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

function respond<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function respondError(error: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Register scheduler and node routes.
 */
export async function registerSchedulerRoutes(fastify: FastifyInstance): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes
  await fastify.register(schedulerRoutes);
}

async function schedulerRoutes(fastify: FastifyInstance): Promise<void> {
  // Refuse cross-site browser requests (CSRF, DNS rebinding)
  fastify.addHook("onRequest", rejectCrossSiteRequests);

  // ============ NODES ============

  /**
   * List all nodes with their capacity and status.
   */
  fastify.get("/api/nodes", async (): Promise<ApiResponse<ListNodesResponse>> => {
    try {
      const store = getStore();
      const scheduler = getScheduler();

      const nodes = store.listNodes();
      const state = scheduler.getState();

      return respond({ nodes, scheduler: state });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Get a specific node.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/nodes/:id",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const store = getStore();
        const nodeManager = getNodeManager();

        const node = store.getNode(request.params.id);
        if (!node) {
          return respondError(`Node not found: ${request.params.id}`);
        }

        return respond({
          ...node,
          connected: nodeManager.isNodeConnected(node.id),
        });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // ============ SCHEDULER ============

  /**
   * Get scheduler status.
   */
  fastify.get("/api/scheduler/status", async (): Promise<ApiResponse<unknown>> => {
    try {
      const scheduler = getScheduler();
      const state = scheduler.getState();
      const config = scheduler.getConfig();

      return respond({ state, config });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Start the scheduler.
   */
  fastify.post("/api/scheduler/start", async (): Promise<ApiResponse<unknown>> => {
    try {
      const scheduler = getScheduler();
      scheduler.start();
      return respond({ started: true });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Stop the scheduler.
   */
  fastify.post("/api/scheduler/stop", async (): Promise<ApiResponse<unknown>> => {
    try {
      const scheduler = getScheduler();
      scheduler.stop();
      return respond({ stopped: true });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Trigger a scheduler tick manually.
   */
  fastify.post("/api/scheduler/tick", async (): Promise<ApiResponse<unknown>> => {
    try {
      const scheduler = getScheduler();
      await scheduler.tick();
      return respond({ ticked: true, state: scheduler.getState() });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ TASKS ============

  /**
   * List tasks.
   */
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/api/tasks", async (request): Promise<ApiResponse<ListTasksResponse>> => {
    try {
      const jobManager = getJobManager();
      const store = getStore();

      const options: { status?: TaskStatus; limit?: number; offset?: number } = {};
      if (request.query.status) {
        options.status = request.query.status as TaskStatus;
      }
      if (request.query.limit) {
        options.limit = parseInt(request.query.limit, 10);
      }
      if (request.query.offset) {
        options.offset = parseInt(request.query.offset, 10);
      }

      const tasks = jobManager.listTasks(options);
      const total = store.countTasks(options.status);

      return respond({ tasks, total });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Get a specific task.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const jobManager = getJobManager();
        const task = jobManager.getTask(request.params.id);

        if (!task) {
          return respondError(`Task not found: ${request.params.id}`);
        }

        return respond(task);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Create a new task.
   */
  fastify.post<{ Body: CreateTaskRequest }>(
    "/api/tasks",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const jobManager = getJobManager();

        // Validate request
        if (!request.body.type || !request.body.title) {
          return respondError("Missing required fields: type, title");
        }

        const task = await jobManager.createTask(request.body);
        return respond(task);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Cancel a task.
   */
  fastify.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const jobManager = getJobManager();
        const success = await jobManager.cancelTask(request.params.id);

        if (!success) {
          return respondError(`Cannot cancel task: ${request.params.id}`);
        }

        return respond({ cancelled: true });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Retry a failed task.
   */
  fastify.post<{ Params: { id: string } }>(
    "/api/tasks/:id/retry",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const jobManager = getJobManager();
        const task = await jobManager.retryTask(request.params.id);

        if (!task) {
          return respondError(`Cannot retry task: ${request.params.id}`);
        }

        return respond(task);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // ============ JOBS ============

  /**
   * List jobs.
   */
  fastify.get<{
    Querystring: { status?: string; nodeId?: string; limit?: string };
  }>("/api/jobs", async (request): Promise<ApiResponse<ListJobsResponse>> => {
    try {
      const jobManager = getJobManager();
      const store = getStore();

      const options: { status?: JobStatus; nodeId?: string; limit?: number } = {};
      if (request.query.status) {
        options.status = request.query.status as JobStatus;
      }
      if (request.query.nodeId) {
        options.nodeId = request.query.nodeId;
      }
      if (request.query.limit) {
        options.limit = parseInt(request.query.limit, 10);
      }

      const jobs = jobManager.listJobs(options);
      const total = store.countJobs(options.status);

      return respond({ jobs, total });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Get a specific job.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/jobs/:id",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const jobManager = getJobManager();
        const job = jobManager.getJob(request.params.id);

        if (!job) {
          return respondError(`Job not found: ${request.params.id}`);
        }

        return respond(job);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // ============ STATS ============

  /**
   * Get task and job statistics.
   */
  fastify.get("/api/stats", async (): Promise<ApiResponse<unknown>> => {
    try {
      const jobManager = getJobManager();
      const scheduler = getScheduler();

      return respond({
        ...jobManager.getStats(),
        scheduler: scheduler.getState(),
      });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
