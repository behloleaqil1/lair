/**
 * Process management API routes
 *
 * Endpoints:
 * - GET  /api/processes         - list all processes with status
 * - GET  /api/processes/:id     - single process details
 * - POST /api/processes/:id/start   - start a process
 * - POST /api/processes/:id/stop    - stop a process
 * - POST /api/processes/:id/restart - restart a process
 * - GET  /api/processes/:id/logs    - get recent logs
 */
import type { FastifyInstance } from "fastify";
import { getSupervisor } from "../services/supervisor.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { ApiResponse } from "../../shared/types.js";
import type {
  ProcessState,
  ProcessListResponse,
  ProcessLogsResponse,
} from "../../shared/process-types.js";

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

export async function registerProcessRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes
  await fastify.register(processRoutes);
}

async function processRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Refuse cross-site browser requests (CSRF, DNS rebinding)
  fastify.addHook("onRequest", rejectCrossSiteRequests);

  const supervisor = getSupervisor();

  // ============ LIST ALL PROCESSES ============

  fastify.get<{ Querystring: { project: string } }>(
    "/api/processes",
    async (_request) => {
      try {
        const response = supervisor.getAll();
        return respond<ProcessListResponse>(response);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ GET SINGLE PROCESS ============

  fastify.get<{
    Params: { id: string };
    Querystring: { project: string };
  }>("/api/processes/:id", async (request) => {
    try {
      const state = supervisor.get(request.params.id);
      if (!state) {
        return respondError(`Process not found: ${request.params.id}`);
      }
      return respond<ProcessState>(state);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ START PROCESS ============

  fastify.post<{
    Params: { id: string };
    Querystring: { project: string };
  }>("/api/processes/:id/start", async (request) => {
    try {
      // Check read-only mode
      if (supervisor.isReadOnly()) {
        return respondError(
          "Project is in read-only mode. Cannot start processes.",
        );
      }

      if (!supervisor.has(request.params.id)) {
        return respondError(`Process not found: ${request.params.id}`);
      }

      await supervisor.start(request.params.id);
      const state = supervisor.get(request.params.id);
      return respond<ProcessState>(state!);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ STOP PROCESS ============

  fastify.post<{
    Params: { id: string };
    Body: { gracePeriodMs?: number };
    Querystring: { project: string };
  }>("/api/processes/:id/stop", async (request) => {
    try {
      // Check read-only mode
      if (supervisor.isReadOnly()) {
        return respondError(
          "Project is in read-only mode. Cannot stop processes.",
        );
      }

      if (!supervisor.has(request.params.id)) {
        return respondError(`Process not found: ${request.params.id}`);
      }

      const gracePeriodMs = request.body?.gracePeriodMs;
      await supervisor.stop(request.params.id, gracePeriodMs);
      const state = supervisor.get(request.params.id);
      return respond<ProcessState>(state!);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ RESTART PROCESS ============

  fastify.post<{
    Params: { id: string };
    Querystring: { project: string };
  }>("/api/processes/:id/restart", async (request) => {
    try {
      // Check read-only mode
      if (supervisor.isReadOnly()) {
        return respondError(
          "Project is in read-only mode. Cannot restart processes.",
        );
      }

      if (!supervisor.has(request.params.id)) {
        return respondError(`Process not found: ${request.params.id}`);
      }

      await supervisor.restart(request.params.id);
      const state = supervisor.get(request.params.id);
      return respond<ProcessState>(state!);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ GET PROCESS LOGS ============

  fastify.get<{
    Params: { id: string };
    Querystring: { project: string; tail?: string };
  }>("/api/processes/:id/logs", async (request) => {
    try {
      if (!supervisor.has(request.params.id)) {
        return respondError(`Process not found: ${request.params.id}`);
      }

      const tail = request.query.tail ? parseInt(request.query.tail, 10) : 100;
      const logs = supervisor.getLogs(request.params.id, tail);

      const response: ProcessLogsResponse = {
        id: request.params.id,
        logs,
        hasMore: logs.length === tail,
      };

      return respond<ProcessLogsResponse>(response);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
