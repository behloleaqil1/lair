/**
 * Agents routes.
 *
 *   GET  /api/agents/status?project=             per agent: state, run, claims, recoveries, budget; locks
 *   GET  /api/agents/runs?project=&limit=
 *   GET  /api/agents/recoveries?project=&limit=  claim releases, lock breaks, restarts, failovers, ...
 *   POST /api/agents/runs?project=               {agent, task, prompt, model?}: claim the task, start on the next tick
 *   POST /api/agents/claims/release?project=     {task, confirm: true}: the run holding it stops itself
 *   POST /api/agents/runs/:id/fresh-session?project=  {confirm: true}
 *   POST /api/agents/tick?project=               check now
 *
 * Starting a run, releasing a claim and starting a fresh session are the
 * owner's: they need an owner session (src/server/human-auth/, the
 * X-Lair-Owner-Session header from the dashboard), so an agent, or any other
 * local process, can't put a prompt into a task or stop a peer's run.
 * /api/agents is in OWNER_ONLY_PREFIXES (no CORS). Modules that start runs do
 * it in-process (AgentsManager.requestRun), not over HTTP. The two actions
 * that stop work also need `confirm: true` (the Agents view asks first).
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import { AgentsError, isValidTaskId, type AgentsManager, type AgentsService } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const limit = z.coerce.number().int().min(1).max(500).default(100);
const ProjectQuery = z.object({ project: z.string().optional() });
const ListQuery = ProjectQuery.extend({ limit });
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RunBody = z
  .object({
    agent: z.string(),
    task: z.string(),
    prompt: z.string(),
    model: z.string().optional(),
  })
  .strict();
const ReleaseBody = z.object({ task: z.string(), confirm: z.boolean().optional() }).strict();
const ConfirmBody = z.object({ confirm: z.boolean().optional() }).strict();

const CONFIRM_RELEASE =
  "Releasing a claim stops the run that holds it: send confirm: true to release it";
const CONFIRM_FRESH =
  "A fresh session stops the run and moves its session aside: send confirm: true to start one";

export async function registerAgentsRoutes(
  fastify: FastifyInstance,
  manager: AgentsManager,
  defaultProject: () => string,
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // Before the body is read: a refused request is never parsed
    const ownerOnly = { onRequest: auth.requireOwner("Only the owner can do this, from the dashboard") };

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    const handleError = (reply: FastifyReply, e: unknown) =>
      e instanceof AgentsError
        ? fail(reply, e.statusCode, e.message)
        : fail(reply, 500, e instanceof Error ? e.message : "Unknown error");

    /** The project's service, or a 404 when the module is off for it. */
    const serviceOf = (reply: FastifyReply, project: string): AgentsService | null => {
      const service = manager.get(project);
      if (!service) {
        const errors = manager.status(project).errors;
        void fail(
          reply,
          404,
          errors.length > 0
            ? `The agents module is not running for ${project}: ${errors.join("; ")}`
            : `The agents module is off for ${project}: set agents.enabled: true`,
        );
        return null;
      }
      return service;
    };

    app.get("/api/agents/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(manager.status(projectOf(query.data)));
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.get("/api/agents/runs", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const service = manager.get(projectOf(query.data));
        return respond(service ? service.runs(query.data.limit) : []);
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.get("/api/agents/recoveries", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        const service = manager.get(projectOf(query.data));
        return respond(service ? service.recoveries(query.data.limit) : []);
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.post("/api/agents/runs", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const body = RunBody.safeParse(request.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        return fail(reply, 400, `Invalid body: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      try {
        const run = await service.requestRun(body.data);
        reply.code(201);
        return respond(run);
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.post("/api/agents/claims/release", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const body = ReleaseBody.safeParse(request.body ?? {});
      if (!body.success || !isValidTaskId(body.data.task)) return fail(reply, 400, "Invalid body: {task, confirm: true}");
      if (body.data.confirm !== true) return fail(reply, 400, CONFIRM_RELEASE);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      try {
        return respond(await service.releaseClaim(body.data.task));
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.post<{ Params: { id: string } }>("/api/agents/runs/:id/fresh-session", ownerOnly, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      if (!RUN_ID.test(request.params.id)) return fail(reply, 400, "Invalid run id");
      const body = ConfirmBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, "Invalid body: {confirm: true}");
      if (body.data.confirm !== true) return fail(reply, 400, CONFIRM_FRESH);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      try {
        return respond(await service.freshSession(request.params.id));
      } catch (e) {
        return handleError(reply, e);
      }
    });

    app.post("/api/agents/tick", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const service = serviceOf(reply, projectOf(query.data));
      if (!service) return reply;
      try {
        return respond(await service.tick());
      } catch (e) {
        return handleError(reply, e);
      }
    });
  });
}
