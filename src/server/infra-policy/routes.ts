/**
 * Policy scan routes. Both are the owner's: a scan answer names the file,
 * line, address and content hash of every violation, which an agent must not
 * be able to read (it sees only the rule names, from guardPlan).
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
import type { HumanAuth } from "../human-auth/index.js";
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
  /** Every route is the owner's, reads included */
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", projectQueryGuard({ optional: true }));
    app.addHook("onRequest", auth.requireOwner());

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
      if (policy.status().blocked) return fail(reply, 409, "infra_policy is invalid for this project: see /api/infra-policy/status");
      const roots = query.data.root === undefined ? policy.roots : [query.data.root];
      if (roots.some((r) => !policy.roots.includes(r))) return fail(reply, 400, "Unknown root");
      const scanned = [];
      for (const root of roots) scanned.push({ root, ...(await policy.scan(root)) });
      return respond({ roots: scanned });
    });
  });
}
