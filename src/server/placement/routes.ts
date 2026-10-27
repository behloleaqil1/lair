/**
 * Placement routes: read-only. Placement is configured in the project YAML
 * (placement:), act mode included, so there are no mutation routes.
 *
 *   GET /api/placement/status?project=   machines, lanes, every job's expected
 *                                         start and finish and its advice, the
 *                                         latest moves, the learned durations
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { PlacementManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const StatusQuery = z.object({ project: z.string().optional() });

export async function registerPlacementRoutes(
  fastify: FastifyInstance,
  manager: PlacementManager,
  defaultProject: () => string,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    app.get("/api/placement/status", async (request, reply) => {
      const query = StatusQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(manager.status(query.data.project ?? defaultProject()));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });
  });
}
