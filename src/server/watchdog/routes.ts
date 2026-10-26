/**
 * Watchdog routes: read-only. The watchdog is configured in the project YAML
 * (watchdog:), so there are no mutation routes.
 *
 *   GET /api/watchdog/status?project=       SLO status per detector, mode, playbooks
 *   GET /api/watchdog/breaches?project=&status=open|resolved|all&limit=
 *   GET /api/watchdog/runs?project=&limit=
 *   GET /api/watchdog/escalations?project=&limit=
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { WatchdogManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const limit = z.coerce.number().int().min(1).max(500).default(100);
const ListQuery = z.object({ project: z.string().optional(), limit });
const BreachQuery = ListQuery.extend({
  status: z.enum(["open", "resolved", "all"]).default("all"),
});

export async function registerWatchdogRoutes(
  fastify: FastifyInstance,
  manager: WatchdogManager,
  defaultProject: () => string,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    app.get("/api/watchdog/status", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(manager.status(projectOf(query.data)));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    app.get("/api/watchdog/breaches", async (request, reply) => {
      const query = BreachQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const store = manager.getStore();
        const project = projectOf(query.data);
        return respond(
          store ? store.listBreaches(project, { status: query.data.status, limit: query.data.limit }) : [],
        );
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    app.get("/api/watchdog/runs", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const store = manager.getStore();
        const project = projectOf(query.data);
        return respond(store ? store.listRuns(project, { limit: query.data.limit }) : []);
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    app.get("/api/watchdog/escalations", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const store = manager.getStore();
        const project = projectOf(query.data);
        return respond(store ? store.listEscalations(project, { limit: query.data.limit }) : []);
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });
  });
}
