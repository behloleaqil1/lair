/**
 * Triage routes. `?project=` is validated by the root guards
 * (src/server/root-guards.ts); without it the default project is used.
 *
 *   POST   /api/triage/results                 a gate result (+ reports, context) -> its triage
 *   GET    /api/triage/status                  mode, counts, the incident, configured commands
 *   GET    /api/triage/failures?verdict=&blocking=&sha=&limit=
 *   GET    /api/triage/failures/:id            causes, verdicts, evidence, actions, re-checks
 *   GET    /api/triage/rechecks?limit=
 *   GET    /api/triage/incidents?status=&limit=
 *   GET    /api/triage/incidents/:id           bisect state, actions and probes
 *   POST   /api/triage/incidents/:id/revert    {sha?}: a human asks for the revert
 *   GET    /api/triage/tasks?status=
 *   GET    /api/triage/flaky
 *   GET    /api/triage/protected
 *   POST   /api/triage/protected               {sha, note?}: never revert this merge automatically
 *   DELETE /api/triage/protected/:sha
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import type { GateResult } from "../../shared/policy-types.js";
import { TRIAGE_CLASSES } from "../../shared/triage-types.js";
import { SHA_PATTERN } from "./config.js";
import type { TriageManager } from "./manager.js";
import { TriageConflictError, TriageInputError, TriageNotFoundError, type IngestInput } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

function failWith(reply: FastifyReply, e: unknown) {
  if (e instanceof TriageInputError) return fail(reply, 400, e.message);
  if (e instanceof TriageNotFoundError) return fail(reply, 404, e.message);
  if (e instanceof TriageConflictError) return fail(reply, 409, e.message);
  return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
}

function invalid(error: z.ZodError): string {
  const issue = error.issues[0];
  return `Invalid ${issue.path.join(".") || "input"}: ${issue.message}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const AGENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_TEXT = 8 * 1024 * 1024;
const BODY_LIMIT = 32 * 1024 * 1024;

const sha = z.string().regex(SHA_PATTERN, "not a commit sha");

const StepSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["passed", "failed", "skipped", "timed_out"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().min(0).optional(),
  output: z.string().max(MAX_TEXT).optional(),
  error: z.string().max(10_000).optional(),
  startedAt: z.string().max(64).optional(),
  completedAt: z.string().max(64).optional(),
});

/** A GateResult (src/shared/policy-types.ts); only the fields triage needs are required. */
const ResultSchema = z.object({
  id: z.string().regex(GATE_ID, "gate ids use letters, digits, '.', '_', ':' and '-'"),
  commitSha: sha,
  branch: z.string().regex(BRANCH, "not a branch name"),
  status: z.enum(["passed", "failed", "error"]),
  steps: z.array(StepSchema).max(200).default([]),
  pipelineId: z.string().max(200).default(""),
  projectId: z.string().max(200).optional(),
  nodeId: z.string().max(200).default(""),
  selectedSteps: z.array(z.string().max(200)).max(200).optional(),
  durationMs: z.number().min(0).default(0),
  startedAt: z.string().max(64).optional(),
  completedAt: z.string().max(64).optional(),
  pipelineVersion: z.string().max(200).default(""),
});

const IngestBody = z.object({
  result: ResultSchema,
  reports: z
    .array(
      z.object({
        name: z.string().max(500).optional(),
        format: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
        step: z.string().max(200).optional(),
        content: z.string().max(MAX_TEXT),
      }),
    )
    .max(50)
    .default([]),
  context: z
    .object({
      baseSha: sha.optional(),
      changedFiles: z.array(z.string().min(1).max(1000)).max(10_000).optional(),
      agent: z.string().regex(AGENT, "not an agent id").optional(),
      pr: z.number().int().positive().optional(),
      recheckId: z.string().regex(UUID, "not a re-check id").optional(),
      loadPerCore: z.number().min(0).optional(),
    })
    .default({}),
});

export type IngestBodyInput = z.input<typeof IngestBody>;

/** Validate a gate result body (the route and the gate.completed event share it). */
export function parseIngestBody(project: string, body: unknown): { ok: true; input: IngestInput } | { ok: false; error: string } {
  const parsed = IngestBody.safeParse(body);
  if (!parsed.success) return { ok: false, error: invalid(parsed.error) };
  const { result, reports, context } = parsed.data;
  const now = new Date().toISOString();
  const gateResult: GateResult = {
    ...result,
    projectId: result.projectId ?? project,
    selectedSteps: result.selectedSteps ?? result.steps.map((s) => s.name),
    startedAt: result.startedAt ?? now,
    completedAt: result.completedAt ?? now,
  };
  return { ok: true, input: { result: gateResult, reports, context } };
}

const limit = z.coerce.number().int().min(1).max(500).default(100);
const ProjectQuery = z.object({ project: z.string().optional() });
const ListQuery = ProjectQuery.extend({ limit });
const FailuresQuery = ListQuery.extend({
  verdict: z.enum(TRIAGE_CLASSES).optional(),
  blocking: z.enum(["true", "false"]).optional(),
  sha: sha.optional(),
});
const IncidentsQuery = ListQuery.extend({ status: z.enum(["open", "resolved", "all"]).default("all") });
const TasksQuery = ProjectQuery.extend({ status: z.enum(["open", "resolved", "all"]).default("all") });
const RevertBody = z.object({ sha: sha.optional() }).default({});
const ProtectBody = z.object({ sha, note: z.string().max(500).default("") });

const idGuard = requireValidIdParam((id) => UUID.test(id), "triage");

export async function registerTriageRoutes(
  fastify: FastifyInstance,
  manager: TriageManager,
  defaultProject: () => string,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    app.post("/api/triage/results", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const project = projectOf(query.data);
      const body = parseIngestBody(project, request.body);
      if (!body.ok) return fail(reply, 400, body.error);
      try {
        return respond(await manager.ingest(project, body.input));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/triage/status", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      try {
        return respond(manager.status(projectOf(query.data)));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/triage/failures", async (request, reply) => {
      const query = FailuresQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      const q = query.data;
      return respond(
        store
          ? store.listRecords(projectOf(q), {
              limit: q.limit,
              failedOnly: true,
              verdict: q.verdict,
              blocking: q.blocking === undefined ? undefined : q.blocking === "true",
              sha: q.sha,
            })
          : [],
      );
    });

    app.get<{ Params: { id: string } }>("/api/triage/failures/:id", { preHandler: idGuard }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      const record = store?.getRecord(request.params.id);
      if (!store || !record || record.project !== projectOf(query.data)) {
        return fail(reply, 404, `No triage record ${request.params.id}`);
      }
      return respond({
        record,
        actions: store.actionsFor({ recordId: record.id }),
        rechecks: store.rechecksFor({ recordId: record.originId ?? record.id }),
      });
    });

    app.get("/api/triage/rechecks", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      return respond(store ? store.listRechecks(projectOf(query.data), query.data.limit) : []);
    });

    app.get("/api/triage/incidents", async (request, reply) => {
      const query = IncidentsQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      const status = query.data.status === "all" ? undefined : query.data.status;
      return respond(store ? store.listIncidents(projectOf(query.data), { status, limit: query.data.limit }) : []);
    });

    app.get<{ Params: { id: string } }>("/api/triage/incidents/:id", { preHandler: idGuard }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      const incident = store?.getIncident(request.params.id);
      if (!store || !incident || incident.project !== projectOf(query.data)) {
        return fail(reply, 404, `No incident ${request.params.id}`);
      }
      return respond({
        incident,
        actions: store.actionsFor({ incidentId: incident.id }),
        rechecks: store.rechecksFor({ incidentId: incident.id }),
      });
    });

    app.post<{ Params: { id: string } }>(
      "/api/triage/incidents/:id/revert",
      { preHandler: idGuard },
      async (request, reply) => {
        const query = ProjectQuery.safeParse(request.query ?? {});
        if (!query.success) return fail(reply, 400, invalid(query.error));
        const body = RevertBody.safeParse(request.body ?? {});
        if (!body.success) return fail(reply, 400, invalid(body.error));
        try {
          const service = manager.require(projectOf(query.data));
          return respond(await service.requestRevert(request.params.id, body.data.sha));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );

    app.get("/api/triage/tasks", async (request, reply) => {
      const query = TasksQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      const status = query.data.status === "all" ? undefined : query.data.status;
      return respond(store ? store.listTasks(projectOf(query.data), status) : []);
    });

    app.get("/api/triage/flaky", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      return respond(store ? store.listFlaky(projectOf(query.data)) : []);
    });

    app.get("/api/triage/protected", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      return respond(store ? store.listProtected(projectOf(query.data)) : []);
    });

    app.post("/api/triage/protected", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const body = ProtectBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, invalid(body.error));
      try {
        const project = projectOf(query.data);
        manager.require(project).protect(body.data.sha, body.data.note);
        return respond(manager.getStore()!.listProtected(project));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.delete<{ Params: { sha: string } }>("/api/triage/protected/:sha", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      if (!SHA_PATTERN.test(request.params.sha)) return fail(reply, 400, "Invalid sha");
      try {
        const project = projectOf(query.data);
        if (!manager.require(project).unprotect(request.params.sha)) {
          return fail(reply, 404, `${request.params.sha} is not protected`);
        }
        return respond(manager.getStore()!.listProtected(project));
      } catch (e) {
        return failWith(reply, e);
      }
    });
  });
}
