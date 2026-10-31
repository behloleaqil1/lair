/**
 * Host services API routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HostServicesManager, HostServicesProjectStatus } from "./service.js";
import { assertValidProject } from "../config.js";

interface RouteParams {
  project?: string;
  machine?: string;
}

interface HoldCheckQuery {
  lane?: string;
}

export function registerHostServicesRoutes(app: FastifyInstance, manager: HostServicesManager): void {
  /**
   * GET /api/host-services/:project
   * Get host services status for a project.
   */
  app.get<{ Params: RouteParams }>(
    "/api/host-services/:project",
    async (request: FastifyRequest<{ Params: RouteParams }>, reply: FastifyReply) => {
      const project = assertValidProject(request.params.project);
      const status = manager.status(project);
      return reply.send({
        success: true,
        data: serializeStatus(status),
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /api/host-services/:project/machines/:machine
   * Get service statuses for a specific machine.
   */
  app.get<{ Params: RouteParams }>(
    "/api/host-services/:project/machines/:machine",
    async (request: FastifyRequest<{ Params: RouteParams }>, reply: FastifyReply) => {
      const project = assertValidProject(request.params.project);
      const machine = request.params.machine;
      if (!machine) {
        return reply.status(400).send({
          success: false,
          error: "Missing machine parameter",
          timestamp: new Date().toISOString(),
        });
      }
      const service = manager.get(project);
      if (!service) {
        return reply.send({
          success: true,
          data: { machine, services: [] },
          timestamp: new Date().toISOString(),
        });
      }
      const statuses = service.getServiceStatuses(machine);
      return reply.send({
        success: true,
        data: { machine, services: statuses },
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /api/host-services/:project/holds
   * Get all lanes currently held by down services.
   */
  app.get<{ Params: RouteParams }>(
    "/api/host-services/:project/holds",
    async (request: FastifyRequest<{ Params: RouteParams }>, reply: FastifyReply) => {
      const project = assertValidProject(request.params.project);
      const service = manager.get(project);
      const holds = service?.getHeldLanes() ?? [];
      return reply.send({
        success: true,
        data: { holds },
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /api/host-services/:project/holds/check
   * Check if a specific lane is held.
   */
  app.get<{ Params: RouteParams; Querystring: HoldCheckQuery }>(
    "/api/host-services/:project/holds/check",
    async (request: FastifyRequest<{ Params: RouteParams; Querystring: HoldCheckQuery }>, reply: FastifyReply) => {
      const project = assertValidProject(request.params.project);
      const lane = request.query.lane;
      if (!lane) {
        return reply.status(400).send({
          success: false,
          error: "Missing lane query parameter",
          timestamp: new Date().toISOString(),
        });
      }
      const result = manager.isLaneHeld(project, lane);
      return reply.send({
        success: true,
        data: { lane, ...result },
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * POST /api/host-services/:project/tick
   * Trigger an immediate tick (owner-only).
   */
  app.post<{ Params: RouteParams }>(
    "/api/host-services/:project/tick",
    async (request: FastifyRequest<{ Params: RouteParams }>, reply: FastifyReply) => {
      const project = assertValidProject(request.params.project);
      const service = manager.get(project);
      if (!service) {
        return reply.status(404).send({
          success: false,
          error: "Host services not enabled for this project",
          timestamp: new Date().toISOString(),
        });
      }
      const ticks = await service.tick();
      return reply.send({
        success: true,
        data: { ticks },
        timestamp: new Date().toISOString(),
      });
    },
  );
}

function serializeStatus(status: HostServicesProjectStatus): Record<string, unknown> {
  return {
    project: status.project,
    enabled: status.enabled,
    running: status.running,
    mode: status.mode,
    actBlocked: status.actBlocked,
    errors: status.errors,
    intervalSeconds: status.intervalSeconds,
    lastTicks: status.lastTicks,
    lastError: status.lastError,
    services: Object.fromEntries(status.services),
    heldLanes: status.heldLanes,
  };
}
