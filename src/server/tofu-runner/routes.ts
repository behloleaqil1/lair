/**
 * OpenTofu runner routes. All are the owner's: a plan shows resource names and
 * an apply changes the cloud, which an agent must not do from here.
 *
 *   GET  /api/tofu-runner/status?project=
 *   GET  /api/tofu-runner/plans?project=
 *   POST /api/tofu-runner/plan?project=&root=&env=
 *   POST /api/tofu-runner/apply?project=&plan=&hash=
 *
 * `root` must be one of the project's `infra_policy.roots` and `env` one of
 * `tofu_runner.environments`. A project without `tofu_runner.enabled` answers 404.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { TofuRunnerManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const Query = z.object({
  project: z.string().optional(),
  root: z.string().min(1).max(4096).optional(),
  env: z.string().min(1).max(32).optional(),
  plan: z.string().min(1).max(64).optional(),
  hash: z.string().min(1).max(128).optional(),
});

export async function registerTofuRunnerRoutes(
  fastify: FastifyInstance,
  manager: TofuRunnerManager,
  defaultProject: () => string,
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", projectQueryGuard({ optional: true }));
    app.addHook("onRequest", auth.requireOwner());

    app.get("/api/tofu-runner/status", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      return respond(manager.status(query.data.project ?? defaultProject()));
    });

    app.get("/api/tofu-runner/plans", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const runner = manager.get(query.data.project ?? defaultProject());
      if (!runner) return fail(reply, 404, "tofu_runner is not enabled for this project");
      return respond(await runner.plans());
    });

    app.post("/api/tofu-runner/plan", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success || !query.data.root || !query.data.env) return fail(reply, 400, "Invalid query");
      const runner = manager.get(query.data.project ?? defaultProject());
      if (!runner) return fail(reply, 404, "tofu_runner is not enabled for this project");
      try {
        return respond(await runner.plan(query.data.root, query.data.env));
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("not a configured root")) return fail(reply, 400, "Unknown root");
        if (e instanceof Error && e.message.startsWith("not a configured environment")) return fail(reply, 400, "Unknown environment");
        throw e;
      }
    });

    app.post("/api/tofu-runner/apply", async (request, reply) => {
      const query = Query.safeParse(request.query ?? {});
      if (!query.success || !query.data.plan || !query.data.hash) return fail(reply, 400, "Invalid query");
      const runner = manager.get(query.data.project ?? defaultProject());
      if (!runner) return fail(reply, 404, "tofu_runner is not enabled for this project");
      return respond(await runner.apply(query.data.plan, query.data.hash));
    });
  });
}
