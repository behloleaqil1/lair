/**
 * Planner routes. `?project=` is validated by the root guards
 * (src/server/root-guards.ts); without it the default project is used.
 *
 * Every route is the owner's: each shows plan or task text, or paths on this
 * machine (the status's errors and warnings), or changes something.
 *   GET  /api/planner/status                     enabled, mode, counts, errors and warnings
 *   GET  /api/planner/overview                   sources, open tasks, the tasks file, triggers, blocked tasks
 *   GET  /api/planner/proposals?status=&limit=
 *   GET  /api/planner/runs?limit=
 *   GET  /api/planner/history?limit=             changes with their diffs
 *   POST /api/planner/check                      run a cycle now
 *   POST /api/planner/proposals/:id/approve      {confirm: true}
 *   POST /api/planner/proposals/:id/reject       {confirm: true}
 *   POST /api/planner/runs/:id/approve           {confirm: true}: every proposal of the run that waits
 *   POST /api/planner/runs/:id/reject            {confirm: true}
 *   POST /api/planner/resume                     {confirm: true}: planner runs again after a pause
 *
 * /api/planner is in OWNER_ONLY_PREFIXES (no CORS). An owner-only route
 * checks the session before the body is read. The planner agent, like any
 * local process, gets 403: it proposes only through its proposal file.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { PlannerManager } from "./manager.js";
import { PlannerError, type PlannerService } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ProjectQuery = z.object({ project: z.string().optional() });
const ListQuery = ProjectQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const ProposalQuery = ListQuery.extend({ status: z.enum(["pending", "applied", "rejected", "declined"]).optional() });
const ConfirmBody = z.object({ confirm: z.boolean().optional() }).strict();
const CONFIRM = "Send confirm: true (the Planner view asks first)";

export async function registerPlannerRoutes(
  fastify: FastifyInstance,
  manager: PlannerManager,
  defaultProject: () => string,
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const ownerOnly = { onRequest: auth.requireOwner("Only the owner can do this, from the dashboard") };
    const idGuard = requireValidIdParam((id) => UUID.test(id), "planner");
    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    const serviceOf = (reply: FastifyReply, project: string): PlannerService | null => {
      const service = manager.get(project);
      if (!service) {
        const errors = manager.errors(project);
        void fail(
          reply,
          404,
          errors.length > 0
            ? `The planner is not running for ${project}: ${errors.join("; ")}`
            : `The planner is off for ${project}: set planner.enabled: true`,
        );
        return null;
      }
      return service;
    };

    const handle = (reply: FastifyReply, e: unknown) =>
      e instanceof PlannerError ? fail(reply, e.statusCode, e.message) : fail(reply, 500, e instanceof Error ? e.message : "Unknown error");

    app.get("/api/planner/status", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      return respond(manager.status(projectOf(query.data)));
    });

    app.get("/api/planner/overview", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      return respond(service.overview());
    });

    app.get("/api/planner/proposals", ownerOnly, async (request, reply) => {
      const query = ProposalQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      return respond(service.proposals({ status: query.data.status, limit: query.data.limit }));
    });

    app.get("/api/planner/runs", ownerOnly, async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      return respond(service.runs(query.data.limit));
    });

    app.get("/api/planner/history", ownerOnly, async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      return respond(service.history(query.data.limit));
    });

    app.post("/api/planner/check", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      try {
        return respond(await service.checkNow());
      } catch (e) {
        return handle(reply, e);
      }
    });

    /** An owner action that needs `confirm: true`. */
    const confirmed = (
      path: string,
      action: (service: PlannerService, id: string) => Promise<unknown>,
      options: { id: boolean },
    ) => {
      app.post<{ Params: { id?: string } }>(
        path,
        { onRequest: ownerOnly.onRequest, ...(options.id ? { preHandler: idGuard } : {}) },
        async (request, reply) => {
          const query = ProjectQuery.safeParse(request.query ?? {});
          if (!query.success) return fail(reply, 400, "Invalid query");
          const body = ConfirmBody.safeParse(request.body ?? {});
          if (!body.success) return fail(reply, 400, "Invalid body: {confirm: true}");
          if (body.data.confirm !== true) return fail(reply, 400, CONFIRM);
          const service = serviceOf(reply, projectOf(query.data));
          if (!service) return reply;
          try {
            return respond(await action(service, request.params.id ?? ""));
          } catch (e) {
            return handle(reply, e);
          }
        },
      );
    };
    confirmed("/api/planner/proposals/:id/approve", (s, id) => s.approveProposal(id), { id: true });
    confirmed("/api/planner/proposals/:id/reject", (s, id) => s.rejectProposal(id), { id: true });
    confirmed("/api/planner/runs/:id/approve", (s, id) => s.approveRun(id), { id: true });
    confirmed("/api/planner/runs/:id/reject", (s, id) => s.rejectRun(id), { id: true });
    confirmed("/api/planner/resume", (s) => s.resume(), { id: false });
  });
}
