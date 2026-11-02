/**
 * Work store routes (docs/design/work-store.md §4.2): every one is the owner's, reads included (task text and file
 * paths are the owner's). /api/work is in OWNER_ONLY_PREFIXES, so no CORS is granted under it either; agents never
 * call it (they report through the bus). The owner check runs on the request, before any body is read.
 *
 *   GET  /api/work/status?project=            the mode (also when off), the store's schema version, tasks by state,
 *                                              the last import, the follower and a comparison with fill's view
 *   GET  /api/work/tasks?project=&state=&agent=&limit=   tasks with the state their claim gives them (§1.5)
 *   GET  /api/work/task?project=&id=          one task and its newest events (ids may hold "/" and "#")
 *   POST /api/work/import?project=            import the configured files one way; body {dry_run}, default true:
 *                                              a dry run reports and writes nothing; the owner's session is the actor
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts); without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { WorkResult, WorkStoreManager } from "./manager.js";
import { TASK_STATES, type TaskState } from "./store.js";

const respond = <T>(data: T) => ({ success: true, data, timestamp: new Date().toISOString() });

const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });

const send = <T>(reply: FastifyReply, result: WorkResult<T>) => (result.ok ? respond(result.data) : fail(reply, result.code, result.error));

const ProjectQuery = z.object({ project: z.string().optional() });

const TasksQuery = ProjectQuery.extend({
  state: z.enum(TASK_STATES as [TaskState, ...TaskState[]]).optional(),
  agent: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const TaskQuery = ProjectQuery.extend({ id: z.string().min(1).max(128) });

const ImportBody = z.object({ dry_run: z.boolean().default(true) }).strict();

const invalid = (reply: FastifyReply, what: string, error: z.ZodError) =>
  fail(reply, 400, `Invalid ${what}: ${error.issues[0].path.join(".") || "(root)"}: ${error.issues[0].message}`);

export async function registerWorkRoutes(fastify: FastifyInstance, manager: WorkStoreManager, defaultProject: () => string, auth: HumanAuth): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", auth.requireOwner("Only the owner can see and import the work store, from the dashboard"));

    app.get("/api/work/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return invalid(reply, "query", query.error);
      return respond(await manager.status(query.data.project ?? defaultProject()));
    });

    app.get("/api/work/tasks", async (request, reply) => {
      const query = TasksQuery.safeParse(request.query ?? {});
      if (!query.success) return invalid(reply, "query", query.error);
      const { project, ...rest } = query.data;
      return send(reply, await manager.tasks(project ?? defaultProject(), rest));
    });

    app.get("/api/work/task", async (request, reply) => {
      const query = TaskQuery.safeParse(request.query ?? {});
      if (!query.success) return invalid(reply, "query", query.error);
      return send(reply, await manager.task(query.data.project ?? defaultProject(), query.data.id));
    });

    app.post("/api/work/import", { bodyLimit: 1024 }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return invalid(reply, "query", query.error);
      const body = ImportBody.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, "body", body.error);
      // The session requireOwner verified above is the actor. Kept as a guard, as the other owner routes do: if the
      // hooks ever change, an import with no verified session is refused, never written with a made-up actor
      const session = auth.sessionOf(request);
      if (!session) return fail(reply, 403, "Only the owner can import into the work store");
      const project = query.data.project ?? defaultProject();
      return send(reply, await manager.import(project, { dryRun: body.data.dry_run, actor: { kind: "owner", id: session.id } }));
    });
  });
}
