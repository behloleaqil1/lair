/**
 * Tracker routes: the owner's, reads included (the status shows task text,
 * repositories and the audit). /api/tracker is in OWNER_ONLY_PREFIXES, so no
 * CORS is granted under it either. The tracker is configured in the project
 * YAML (tracker:) or in Settings, both the owner's.
 *
 *   GET  /api/tracker/status?project=     the repositories and boards, the
 *                                          token's scopes, the links, the
 *                                          pending creates, the sync state
 *                                          and the latest writes
 *   POST /api/tracker/reconcile?project=  queue a reconcile now; recorded in
 *                                          the audit with the owner session
 *   POST /api/tracker/links?project=      accept a proposed link {task, repo,
 *                                          issue}: queued (202), made in a job
 *                                          and audited with the owner session
 *
 * `?project=` is validated by the root guards (src/server/root-guards.ts);
 * without it the default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { TrackerManager } from "./manager.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

const ProjectQuery = z.object({ project: z.string().optional() });

const AcceptLinkBody = z
  .object({
    task: z.string().min(1).max(128),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name"),
    issue: z.number().int().min(1),
  })
  .strict();

export async function registerTrackerRoutes(
  fastify: FastifyInstance,
  manager: TrackerManager,
  defaultProject: () => string,
  /** Every route is the owner's, reads included */
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", auth.requireOwner("Only the owner can see and run the tracker, from the dashboard"));

    app.get("/api/tracker/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      return respond(manager.status(query.data.project ?? defaultProject()));
    });

    app.post("/api/tracker/reconcile", { bodyLimit: 1024 }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const project = query.data.project ?? defaultProject();
      const session = auth.sessionOf(request);
      if (!session) return fail(reply, 403, "Only the owner can run the tracker");
      const service = manager.get(project);
      if (!service) return fail(reply, 404, `The tracker is off for ${project} (tracker.enabled)`);
      if (!service.requestReconcile(session.id)) return fail(reply, 503, "The tracker's queue is full or it is stopping: try again shortly");
      return reply.code(202).send(respond({ queued: true, mode: service.settings.mode }));
    });

    app.post("/api/tracker/links", { bodyLimit: 2048 }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const project = query.data.project ?? defaultProject();
      const session = auth.sessionOf(request);
      if (!session) return fail(reply, 403, "Only the owner can link tasks to issues");
      const body = AcceptLinkBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, `Invalid body: ${body.error.issues[0].path.join(".") || "(root)"}: ${body.error.issues[0].message}`);
      const service = manager.get(project);
      if (!service) return fail(reply, 404, `The tracker is off for ${project} (tracker.enabled)`);
      const accepted = service.acceptLink(body.data.task, body.data.repo, body.data.issue, session.id);
      if (!accepted.ok) return fail(reply, accepted.code, accepted.error);
      return reply.code(202).send(respond({ queued: true, mode: service.settings.mode }));
    });
  });
}
