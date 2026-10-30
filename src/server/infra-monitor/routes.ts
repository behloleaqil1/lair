/**
 * Infrastructure monitor routes: read-only. The infra monitor is configured
 * in the project YAML (infra_monitor:), so there are no mutation routes.
 *
 *   GET /api/infra-monitor/status?project=    Status, machines, jobs, notices
 *   GET /api/infra-monitor/jobs?project=      Running jobs being monitored
 *   GET /api/infra-monitor/machines?project=  Machine states and reachability
 *   GET /api/infra-monitor/notices?project=   Active infrastructure notices
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { InfraMonitorManager } from "./service.js";

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
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    // GET /api/infra-monitor/status - Full status including machines, jobs, notices
    app.get("/api/infra-monitor/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(manager.status(projectOf(query.data)));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    // GET /api/infra-monitor/jobs - Running jobs being monitored
    app.get("/api/infra-monitor/jobs", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const status = manager.status(projectOf(query.data));
        return respond(status.monitoredJobs);
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    // GET /api/infra-monitor/machines - Machine states
    app.get("/api/infra-monitor/machines", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const status = manager.status(projectOf(query.data));
        return respond(status.machineStates);
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    // GET /api/infra-monitor/notices - Active infrastructure notices
    app.get("/api/infra-monitor/notices", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const status = manager.status(projectOf(query.data));
        return respond(status.activeNotices);
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });
  });
}
