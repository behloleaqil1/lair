/**
 * Host services API routes.
 *
 * Reads are public (under /api/host-services): states, exit codes, times and
 * lane names only, never a probe's output or a command's arguments. The one
 * route that changes anything, the tick (it runs start commands in act
 * mode), is owner-only, under /api/host-services/owner (no CORS there).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { HostServicesManager, HostServicesProjectStatus } from "./service.js";
import { isSafeProjectName } from "../config.js";
import type { HumanAuth } from "../human-auth/human-auth.js";

/** Prefix for routes that require the owner session (gets no CORS: see human-auth/cors.ts). */
export const OWNER_PREFIX = "/api/host-services/owner";

interface RouteParams {
  project?: string;
  machine?: string;
}

interface HoldCheckQuery {
  lane?: string;
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.status(400).send({ success: false, error, timestamp: new Date().toISOString() });
}

/** A project name of the safe shape, or null. Projects without host services read as not enabled. */
function projectOf(params: RouteParams): string | null {
  const project = params.project;
  return typeof project === "string" && isSafeProjectName(project) ? project : null;
}

export function registerHostServicesRoutes(app: FastifyInstance, manager: HostServicesManager, auth: HumanAuth): void {
  /** GET /api/host-services/:project: the module's status for a project. */
  app.get<{ Params: RouteParams }>("/api/host-services/:project", async (request, reply) => {
    const project = projectOf(request.params);
    if (!project) return badRequest(reply, "Invalid project name");
    return reply.send({ success: true, data: serializeStatus(manager.status(project)), timestamp: new Date().toISOString() });
  });

  /** GET /api/host-services/:project/machines/:machine: one machine's services. */
  app.get<{ Params: RouteParams }>("/api/host-services/:project/machines/:machine", async (request, reply) => {
    const project = projectOf(request.params);
    if (!project) return badRequest(reply, "Invalid project name");
    const machine = request.params.machine ?? "";
    const services = manager.get(project)?.getServiceStatuses(machine) ?? [];
    return reply.send({ success: true, data: { machine, services }, timestamp: new Date().toISOString() });
  });

  /** GET /api/host-services/:project/holds: the lanes held now, and whether that is enforced. */
  app.get<{ Params: RouteParams }>("/api/host-services/:project/holds", async (request, reply) => {
    const project = projectOf(request.params);
    if (!project) return badRequest(reply, "Invalid project name");
    const holds = manager.get(project)?.getHeldLanes() ?? [];
    return reply.send({ success: true, data: { holds }, timestamp: new Date().toISOString() });
  });

  /** GET /api/host-services/:project/holds/check?lane=: whether one lane is held. */
  app.get<{ Params: RouteParams; Querystring: HoldCheckQuery }>(
    "/api/host-services/:project/holds/check",
    async (request, reply) => {
      const project = projectOf(request.params);
      if (!project) return badRequest(reply, "Invalid project name");
      const lane = request.query.lane;
      if (!lane) return badRequest(reply, "Missing lane query parameter");
      return reply.send({
        success: true,
        data: { lane, ...manager.isLaneHeld(project, lane) },
        timestamp: new Date().toISOString(),
      });
    },
  );

  /** POST /api/host-services/owner/:project/tick: probe now (and, in act mode, start what is down). Owner only. */
  const ownerOnly = auth.requireOwner("Only the owner can run a host services tick");
  app.post<{ Params: RouteParams }>(`${OWNER_PREFIX}/:project/tick`, { onRequest: ownerOnly }, async (request, reply) => {
    const project = projectOf(request.params);
    if (!project) return badRequest(reply, "Invalid project name");
    const service = manager.get(project);
    if (!service) {
      return reply.status(404).send({
        success: false,
        error: "Host services are not enabled for this project",
        timestamp: new Date().toISOString(),
      });
    }
    const ticks = await service.tick();
    return reply.send({ success: true, data: { ticks }, timestamp: new Date().toISOString() });
  });
}

function serializeStatus(status: HostServicesProjectStatus): Record<string, unknown> {
  return {
    project: status.project,
    enabled: status.enabled,
    running: status.running,
    mode: status.mode,
    actBlocked: status.actBlocked,
    holdsEnforced: status.holdsEnforced,
    errors: status.errors,
    intervalSeconds: status.intervalSeconds,
    lastTicks: status.lastTicks,
    lastError: status.lastError,
    services: Object.fromEntries(status.services),
    heldLanes: status.heldLanes,
  };
}
