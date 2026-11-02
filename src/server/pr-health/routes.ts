/**
 * PR health's route: read-only. PR health is configured in the project YAML
 * (pr_health:), so no route starts, stops or changes anything.
 *
 *   GET /api/pr-health/status?project=   repositories, findings with owners, and what act mode would do
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { PrHealthManager } from "./service.js";

const ProjectQuery = z.object({ project: z.string().optional() });

const at = () => new Date().toISOString();

export async function registerPrHealthRoutes(fastify: FastifyInstance, manager: PrHealthManager, defaultProject: () => string): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    // Written out (app.get("/api/...")) so the route-ownership scan sees it
    app.get("/api/pr-health/status", async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return reply.code(400).send({ success: false, error: `Invalid query: ${query.error.issues[0].path.join(".")}`, timestamp: at() });
      return { success: true, data: manager.status(query.data.project ?? defaultProject()), timestamp: at() };
    });
  });
}
