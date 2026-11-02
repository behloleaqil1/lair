/**
 * Plan sandbox routes. Both are the owner's: a plan shows resource names and
 * the answer of the cloud, which an agent must not read from here.
 *
 *   GET  /api/plan-sandbox/status?project=
 *   POST /api/plan-sandbox/plan?project=&root=
 *
 * `root` must be one of the project's `infra_policy.roots`. A project without
 * `plan_sandbox.enabled` answers 404 on /plan.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { PlanSandboxManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const Query = z.object({ project: z.string().optional(), root: z.string().min(1).max(4096).optional() });

export async function registerPlanSandboxRoutes(
  fastify: FastifyInstance,
  manager: PlanSandboxManager,
  defaultProject: () => string,
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", projectQueryGuard({ optional: true }));
    app.addHook("onRequest", auth.requireOwner());

    app.get("/api/plan-sandbox/status", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      return respond(manager.status(query.data.project ?? defaultProject()));
    });

    app.post("/api/plan-sandbox/plan", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success || !query.data.root) return fail(reply, 400, "Invalid query");
      const sandbox = manager.get(query.data.project ?? defaultProject());
      if (!sandbox) return fail(reply, 404, "plan_sandbox is not enabled for this project");
      try {
        return respond(await sandbox.plan(query.data.root));
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("not a configured root")) return fail(reply, 400, "Unknown root");
        throw e;
      }
    });
  });
}
