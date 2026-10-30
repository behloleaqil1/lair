/**
 * Cloud routes: the owner's, reads included (the status names the account's
 * instances, regions and spend). /api/cloud is in OWNER_ONLY_PREFIXES, so no
 * CORS is granted under it either. Machines, the budget and the guard are
 * configured in the project YAML (cloud:), or in Settings.
 *
 *   GET /api/cloud/status?project=   each machine's power state, the spend
 *                                     (provider reading and meter) and the
 *                                     guard's verdict and trip
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { CloudManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const StatusQuery = z.object({ project: z.string().optional() });

export async function registerCloudRoutes(
  fastify: FastifyInstance,
  manager: CloudManager,
  defaultProject: () => string,
  /** Every route is the owner's, reads included */
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the cross-site guard and the owner check apply to these routes only
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", auth.requireOwner("Only the owner can see cloud machines and their spend, from the dashboard"));

    app.get("/api/cloud/status", async (request, reply) => {
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
