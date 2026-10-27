/**
 * Pipeline routes (docs/configuration.md#pipeline-api).
 *
 *   GET  /api/pipelines/status?project=          executors, availability, minutes, decisions
 *   GET  /api/pipelines/workflow?project=        the workflow file to commit, with setup steps
 *   GET  /api/pipelines/runs?project=&limit=
 *   GET  /api/pipelines/runs/:id?project=
 *   POST /api/pipelines/runs?project=            { pipeline, sha?, branch? }: start a run (202)
 *   POST /api/pipelines/runs/:id/cancel?project=
 *
 * A job's log tail and its steps' output can hold anything a step printed,
 * so only the owner's session gets them; other callers get the runs
 * without them.
 *
 * Starting and cancelling runs are controls: they need the owner's session
 * (src/server/human-auth/), and are refused for a read_only project. Code
 * inside the server starts runs with PipelineManager.startRun, not over
 * HTTP. `?project=` is validated by the root guards; without it the default
 * project is used.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PipelineRun } from "../../shared/pipeline-types.js";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import { requireValidIdParam } from "../root-guards.js";
import { PIPELINE_NAME } from "./project-pipelines.js";
import { SHA_PATTERN } from "./executors/github-workflow.js";
import { PipelineRequestError, RUN_ID, type PipelineManager } from "./pipeline-service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

function failWith(reply: FastifyReply, e: unknown) {
  if (e instanceof PipelineRequestError) return fail(reply, e.statusCode, e.message);
  return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
}

const ProjectQuery = z.object({ project: z.string().optional() });
const ListQuery = ProjectQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(50) });

/** A git branch or ref name: no option-like or traversal forms */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/;

const StartBody = z
  .object({
    pipeline: z.string().regex(PIPELINE_NAME),
    sha: z.string().regex(SHA_PATTERN, "sha must be 40 lowercase hex characters").optional(),
    branch: z.string().regex(BRANCH, "invalid branch name").optional(),
  })
  .strict();

const runIdGuard = requireValidIdParam((id) => RUN_ID.test(id), "run");

/** A run as callers other than the owner see it: without its jobs' log tails and step output. */
function withoutLogs(run: PipelineRun): PipelineRun {
  return {
    ...run,
    jobs: run.jobs.map((job) => ({
      ...job,
      log: undefined,
      result: job.result ? { ...job.result, steps: job.result.steps.map((step) => ({ ...step, output: undefined })) } : job.result,
    })),
  };
}

export async function registerPipelineRoutes(
  fastify: FastifyInstance,
  manager: PipelineManager,
  defaultProject: () => string,
  /** Starting and cancelling runs need the owner's session */
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    app.addHook("onRequest", auth.requireOwnerForChanges());

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();
    // A job's log tail can hold anything a step printed: the owner's only
    const isOwner = (request: FastifyRequest) => auth.verifyRequest(request.headers, { method: request.method }).ok;
    const badQuery = (reply: FastifyReply, error: z.ZodError) =>
      fail(reply, 400, `Invalid query: ${error.issues[0].path.join(".")}`);

    app.get("/api/pipelines/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return badQuery(reply, query.error);
      try {
        return respond(await manager.status(projectOf(query.data)));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/pipelines/workflow", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return badQuery(reply, query.error);
      try {
        return respond(await manager.workflow(projectOf(query.data)));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/pipelines/runs", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return badQuery(reply, query.error);
      try {
        const runs = manager.listRuns(projectOf(query.data), query.data.limit);
        return respond(isOwner(request) ? runs : runs.map(withoutLogs));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get<{ Params: { id: string } }>(
      "/api/pipelines/runs/:id",
      { preHandler: runIdGuard },
      async (request, reply) => {
        const query = ProjectQuery.safeParse(request.query ?? {});
        if (!query.success) return badQuery(reply, query.error);
        try {
          const run = manager.getRun(projectOf(query.data), request.params.id);
          return respond(isOwner(request) ? run : withoutLogs(run));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );

    app.post("/api/pipelines/runs", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return badQuery(reply, query.error);
      const body = StartBody.safeParse(request.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        return fail(reply, 400, `Invalid body: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      try {
        const run = await manager.startRun(projectOf(query.data), body.data);
        return reply.code(202).send(respond(run));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.post<{ Params: { id: string } }>(
      "/api/pipelines/runs/:id/cancel",
      { preHandler: runIdGuard },
      async (request, reply) => {
        const query = ProjectQuery.safeParse(request.query ?? {});
        if (!query.success) return badQuery(reply, query.error);
        try {
          return respond(await manager.cancelRun(projectOf(query.data), request.params.id));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );
  });
}
