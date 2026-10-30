/**
 * Policy scan routes.
 *
 *   GET /api/infra-policy/status?project=
 *   GET /api/infra-policy/scan?project=&root=
 *
 * `root` must be one of the project's configured roots; nothing else is
 * read. The scan reads files and runs nothing. A project without
 * `infra_policy.enabled` answers 404 on /scan.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import type { InfraPolicyManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const Query = z.object({ project: z.string().optional(), root: z.string().max(4096).optional() });

export async function registerInfraPolicyRoutes(
  fastify: FastifyInstance,
  manager: InfraPolicyManager,
  defaultProject: () => string,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", projectQueryGuard({ optional: true }));

    app.get("/api/infra-policy/status", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      return respond(manager.status(query.data.project ?? defaultProject()));
    });

    app.get("/api/infra-policy/scan", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const policy = manager.get(query.data.project ?? defaultProject());
      if (!policy) return fail(reply, 404, "infra_policy is not enabled for this project");
      const roots = query.data.root === undefined ? policy.settings.roots : [query.data.root];
      if (roots.some((r) => !policy.settings.roots.includes(r))) return fail(reply, 400, "Unknown root");
      return respond({ roots: roots.map((root) => ({ root, ...policy.scan(root) })) });
    });
  });
}
