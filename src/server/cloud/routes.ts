/**
 * Cloud routes: the owner's, reads included (the status names the account's
 * instances, regions and spend). /api/cloud is in OWNER_ONLY_PREFIXES, so no
 * CORS is granted under it either. Machines, the budget and the guard are
 * configured in the project YAML (cloud:), or in Settings.
 *
 *   GET  /api/cloud/status?project=      each machine's power state, the
 *                                         spend (provider reading and meter)
 *                                         and the guard's verdict and trip
 *   POST /api/cloud/trip/clear?project=  {trippedAt, note?}: the owner clears
 *                                         the trip that stands (the only way
 *                                         a trip ends); recorded with the
 *                                         owner session and emitted
 *
 * No route starts or stops a machine. `?project=` is validated by the root
 * guards (src/server/root-guards.ts); without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { CloudTripCleared } from "../../shared/cloud-types.js";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import { CloudError, tripView, type CloudManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const ProjectQuery = z.object({ project: z.string().optional() });

const ClearBody = z
  .object({
    /** When the trip that stands tripped (ISO), as the status shows it: a newer trip is never cleared by mistake */
    trippedAt: z.string().datetime(),
    /** Why, for the record */
    note: z.string().max(500).optional(),
  })
  .strict();

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
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(manager.status(query.data.project ?? defaultProject()));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    app.post("/api/cloud/trip/clear", { bodyLimit: 4096 }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const body = ClearBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, "Invalid body: {trippedAt} is the trip's time (ISO), as the status shows it");
      const session = auth.sessionOf(request);
      if (!session) return fail(reply, 403, "Only the owner can clear the money guard's trip");
      // Control characters never reach the log or the record
      // eslint-disable-next-line no-control-regex
      const note = body.data.note?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null;
      try {
        const cleared = await manager.clearTrip(query.data.project ?? defaultProject(), Date.parse(body.data.trippedAt), session.id, note);
        const answer: CloudTripCleared = { cleared: tripView(cleared), by: session.id };
        return respond(answer);
      } catch (e) {
        if (e instanceof CloudError) return fail(reply, e.statusCode, e.message);
        throw e;
      }
    });
  });
}
