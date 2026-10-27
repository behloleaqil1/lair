/**
 * The owner's Restart (restart.ts). Both routes need the owner's session
 * (src/server/human-auth/), and /api/owner is an OWNER_ONLY prefix, so no
 * CORS is granted for them:
 *
 *   GET  /api/owner/restart    RestartStatusView: the state, the update's output, the service manager
 *   POST /api/owner/restart    {update?: boolean} -> 202 RestartStatusView: restart (after server.update_cmd
 *                              when update is true); the server then shuts down and exits with code 0
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { RestartController } from "./restart.js";

const RestartBody = z.object({ update: z.boolean().optional() }).strict();

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

export async function registerRestartRoutes(
  fastify: FastifyInstance,
  auth: HumanAuth,
  controller: RestartController,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = auth.requireOwner("Only a browser signed in as the owner can restart Lair");

    app.get("/api/owner/restart", { onRequest: owner }, async (_request, reply) => {
      return reply.header("cache-control", "no-store").send(respond(controller.status()));
    });

    app.post("/api/owner/restart", { onRequest: owner, bodyLimit: 1024 }, async (request, reply) => {
      const body = RestartBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, "Send {} to restart, or {\"update\": true} to update first");
      const result = controller.request({ update: body.data.update === true });
      if (!result.ok) return fail(reply, result.code, result.error);
      return reply.code(202).send(respond(result.status));
    });
  });
}
