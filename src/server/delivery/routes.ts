/**
 * Delivery routes.
 *
 *   GET  /api/delivery/status?project=
 *   GET  /api/delivery/operations?project=&environment=&limit=
 *   GET  /api/delivery/operations/:id?project=
 *   POST /api/delivery/environments/:environment/(up|down|restart|deploy)?project=
 *   POST /api/delivery/environments/:environment/services/:service/(up|down|restart|deploy|release)?project=
 *
 * POST bodies (JSON): `confirm: true` for down, restart and deploy; a
 * `reason` for down (a Down holds what it stops); `services` for an
 * environment deploy (default: every service with build: true). Mutations
 * answer 202 with the operation, which runs in the background: poll
 * GET /api/delivery/operations/:id. A read_only project answers 403.
 *
 * Every route passes the cross-site guard and the ?project= guard (without
 * it the default project is used). Environment and service names in the
 * path must be configured ones: a request only selects a configured value,
 * and nothing from it is passed to a command.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import { ENVIRONMENT_NAME, SERVICE_NAME } from "./config.js";
import type { OperationRequest } from "./environment.js";
import type { DeliveryManager } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ProjectQuery = z.object({ project: z.string().optional() });
const OperationsQuery = ProjectQuery.extend({
  environment: z.string().regex(ENVIRONMENT_NAME).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const EnvironmentParams = z.object({
  environment: z.string().regex(ENVIRONMENT_NAME),
  action: z.enum(["up", "down", "restart", "deploy"]),
});
const ServiceParams = z.object({
  environment: z.string().regex(ENVIRONMENT_NAME),
  service: z.string().regex(SERVICE_NAME),
  action: z.enum(["up", "down", "restart", "deploy", "release"]),
});

const ActionBody = z
  .object({
    confirm: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    services: z.array(z.string().regex(SERVICE_NAME)).min(1).max(64).optional(),
  })
  .strict();

/** Down, Restart and Deploy stop or replace running services: the request must say it means it. */
const NEEDS_CONFIRM = new Set(["down", "restart", "deploy"]);

export async function registerDeliveryRoutes(
  fastify: FastifyInstance,
  manager: DeliveryManager,
  defaultProject: () => string,
): Promise<void> {
  // Encapsulated so the guards apply to these routes
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", projectQueryGuard({ optional: true }));

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    app.get("/api/delivery/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      try {
        return respond(await manager.status(projectOf(query.data)));
      } catch (e) {
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    });

    app.get("/api/delivery/operations", async (request, reply) => {
      const query = OperationsQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const store = manager.getStore();
      const project = projectOf(query.data);
      return respond(
        store && manager.get(project)
          ? store.listOperations(project, { environment: query.data.environment, limit: query.data.limit })
          : [],
      );
    });

    app.get<{ Params: { id: string } }>("/api/delivery/operations/:id", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success || !OPERATION_ID.test(request.params.id)) return fail(reply, 400, "Invalid operation id");
      const operation = manager.getStore()?.getOperation(request.params.id);
      if (!operation || operation.project !== projectOf(query.data)) {
        return fail(reply, 404, "No such operation");
      }
      return respond(operation);
    });

    const act = async (
      reply: FastifyReply,
      project: string,
      environment: string,
      action: OperationRequest["kind"],
      service: string | undefined,
      rawBody: unknown,
    ) => {
      const body = ActionBody.safeParse(rawBody ?? {});
      if (!body.success) return fail(reply, 400, `Invalid body: ${body.error.issues[0].path.join(".") || body.error.issues[0].message}`);
      const delivery = manager.get(project);
      if (!delivery) return fail(reply, 404, `Delivery is not enabled for project ${project}`);
      const env = delivery.environment(environment);
      if (!env) return fail(reply, 404, `No environment ${environment} in project ${project}`);
      if (NEEDS_CONFIRM.has(action) && body.data.confirm !== true) {
        return fail(reply, 400, `${action} needs "confirm": true`);
      }
      if (body.data.services && (service !== undefined || action !== "deploy")) {
        return fail(reply, 400, "services is only for an environment deploy");
      }
      const result = env.request({
        kind: action,
        service,
        services: body.data.services,
        by: "human",
        reason: body.data.reason,
      });
      if (!result.ok) return fail(reply, result.code, result.error);
      return reply.code(action === "release" ? 200 : 202).send(respond(result.operation));
    };

    app.post("/api/delivery/environments/:environment/:action", async (request, reply) => {
      const params = EnvironmentParams.safeParse(request.params);
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!params.success || !query.success) return fail(reply, 400, "Invalid environment or action");
      return act(reply, projectOf(query.data), params.data.environment, params.data.action, undefined, request.body);
    });

    app.post("/api/delivery/environments/:environment/services/:service/:action", async (request, reply) => {
      const params = ServiceParams.safeParse(request.params);
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!params.success || !query.success) return fail(reply, 400, "Invalid environment, service or action");
      return act(
        reply,
        projectOf(query.data),
        params.data.environment,
        params.data.action,
        params.data.service,
        request.body,
      );
    });
  });
}
