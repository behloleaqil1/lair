/**
 * Infrastructure monitor routes: read-only. The monitor is configured in the
 * project YAML (infra_monitor:), act mode included, so no route starts,
 * stops or changes anything.
 *
 *   GET /api/infra-monitor/status?project=    machines, jobs, findings, planned and past re-queues
 *   GET /api/infra-monitor/machines?project=  machine states from the probes
 *   GET /api/infra-monitor/jobs?project=      running jobs being watched
 *   GET /api/infra-monitor/findings?project=  current findings
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { InfraMonitorManager } from "./service.js";
import type { InfraMonitorStatus } from "./types.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const ProjectQuery = z.object({ project: z.string().optional() });

export async function registerInfraMonitorRoutes(
  fastify: FastifyInstance,
  manager: InfraMonitorManager,
  defaultProject: () => string,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    // Each route is written out (app.get("/api/...")) so the route-ownership scan sees it
    const read = (pick: (status: InfraMonitorStatus) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(pick(manager.status(query.data.project ?? defaultProject())));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    };

    app.get("/api/infra-monitor/status", read((s) => s));
    app.get("/api/infra-monitor/machines", read((s) => s.machines));
    app.get("/api/infra-monitor/jobs", read((s) => s.jobs));
    app.get("/api/infra-monitor/findings", read((s) => s.findings));
  });
}
