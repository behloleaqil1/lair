/**
 * Triage routes. `?project=` is validated by the root guards
 * (src/server/root-guards.ts); without it the default project is used.
 *
 * Every local process can reach this server, including the agents whose
 * work triage judges. So a result over HTTP must be a SignedGateResult from
 * a node in triage.trusted_nodes (the gates module hands its results over
 * in-process instead), and the routes that change what may be reverted need
 * the owner's credential (src/server/human-auth/).
 *
 *   POST   /api/triage/results                 {signed, reports?, recheckId?}: a signed gate result -> its triage
 *                                              (recheckId: a Lair re-check's id, or the id of the result a gate system re-checks)
 *   GET    /api/triage/status                  mode, counts, the incident, commands, trusted nodes
 *   GET    /api/triage/failures?verdict=&blocking=&sha=&limit=
 *   GET    /api/triage/failures/:id            causes, verdicts, evidence, actions, re-checks
 *   GET    /api/triage/rechecks?limit=
 *   GET    /api/triage/gate-rechecks?limit=    re-checks in the project's own gate system (triage.recheck.mode)
 *   GET    /api/triage/incidents?status=&limit=
 *   GET    /api/triage/incidents/:id           bisect state, actions and probes
 *   GET    /api/triage/tasks?status=
 *   GET    /api/triage/flaky
 *   GET    /api/triage/protected
 *
 * Owner only (under OWNER_PREFIX, which gets no CORS):
 *   POST   /api/triage/owner/incidents/:id/revert   {sha?, acknowledgeUnproven?}
 *   POST   /api/triage/owner/protected              {sha, note?}: never revert this merge automatically
 *   DELETE /api/triage/owner/protected/:sha
 *   DELETE /api/triage/owner/flaky/:key            release a quarantined test
 */
import { createHash } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import type { GateResult } from "../../shared/policy-types.js";
import { TRIAGE_CLASSES } from "../../shared/triage-types.js";
import { FULL_SHA, SHA_PATTERN } from "./config.js";
import { NO_OWNER, type OwnerGuard } from "./adapters.js";
import type { ReportInput } from "./parsers/index.js";
import type { TriageManager } from "./manager.js";
import {
  TriageConflictError,
  TriageForbiddenError,
  TriageInputError,
  TriageNotFoundError,
  type IngestInput,
} from "./service.js";

/** The owner-only routes' prefix: the server adds it to OWNER_ONLY_PREFIXES */
export const OWNER_PREFIX = "/api/triage/owner";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

function failWith(reply: FastifyReply, e: unknown) {
  if (e instanceof TriageInputError) return fail(reply, 400, e.message);
  if (e instanceof TriageForbiddenError) return fail(reply, 403, e.message);
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

const fullSha = z.string().regex(FULL_SHA, "not a full commit sha");

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

const DigestSchema = z.object({
  name: z.string().min(1).max(500),
  step: z.string().max(200).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "not a hex SHA-256"),
});

const ReportsSchema = z
  .array(
    z.object({
      name: z.string().max(500).optional(),
      format: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
      step: z.string().max(200).optional(),
      content: z.string().max(MAX_TEXT),
    }),
  )
  .max(50)
  .default([]);

/** A trusted, in-process result (src/shared/policy-types.ts GateResult); only what triage needs is required. */
const TrustedResultSchema = z.object({
  id: z.string().regex(GATE_ID, "gate ids use letters, digits, '.', '_', ':' and '-'"),
  commitSha: fullSha,
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
  reports: z.array(DigestSchema).max(50).optional(),
});

/** A signed result: a complete GateResult, exactly as the node signed it. */
const SignedResultSchema = z.object({
  id: z.string().regex(GATE_ID, "gate ids use letters, digits, '.', '_', ':' and '-'"),
  pipelineId: z.string().max(200),
  commitSha: fullSha,
  branch: z.string().regex(BRANCH, "not a branch name"),
  projectId: z.string().max(200),
  nodeId: z.string().max(200),
  status: z.enum(["passed", "failed", "error"]),
  steps: z.array(StepSchema).max(200),
  selectedSteps: z.array(z.string().max(200)).max(200),
  durationMs: z.number().min(0),
  startedAt: z.string().max(64),
  completedAt: z.string().max(64),
  pipelineVersion: z.string().max(200),
  reports: z.array(DigestSchema).max(50).optional(),
});

const TrustedBody = z.object({
  result: TrustedResultSchema,
  reports: ReportsSchema,
  context: z
    .object({
      baseSha: fullSha.optional(),
      changedFiles: z.array(z.string().min(1).max(1000)).max(10_000).optional(),
      agent: z.string().regex(AGENT, "not an agent id").optional(),
      pr: z.number().int().positive().optional(),
      recheckId: z.string().regex(UUID, "not a re-check id").optional(),
      runId: z.string().min(1).max(300).optional(),
      loadPerCore: z.number().min(0).optional(),
    })
    .default({}),
});

const SignedBody = z.object({
  signed: z.object({
    result: z.record(z.unknown()),
    signature: z.string().min(1).max(1000),
    nodePublicKey: z.string().max(10_000).default(""),
  }),
  reports: ReportsSchema,
  // A Lair re-check's id (a UUID), or the id of the result a gate system re-checks (gate-recheck.ts)
  recheckId: z.string().regex(GATE_ID, "not a re-check id or a gate result id").optional(),
});

/** Validate a trusted, in-process result (the gate.completed event's payload). */
export function parseIngestBody(project: string, body: unknown): { ok: true; input: IngestInput } | { ok: false; error: string } {
  const parsed = TrustedBody.safeParse(body);
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
  return { ok: true, input: { result: gateResult, reports, context, trust: "trusted" } };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const limit = z.coerce.number().int().min(1).max(500).default(100);
const ProjectQuery = z.object({ project: z.string().optional() });
const ListQuery = ProjectQuery.extend({ limit });
const FailuresQuery = ListQuery.extend({
  verdict: z.enum(TRIAGE_CLASSES).optional(),
  blocking: z.enum(["true", "false"]).optional(),
  sha: z.string().regex(SHA_PATTERN).optional(),
});
const IncidentsQuery = ListQuery.extend({ status: z.enum(["open", "resolved", "all"]).default("all") });
const TasksQuery = ProjectQuery.extend({ status: z.enum(["open", "resolved", "all"]).default("all") });
const RevertBody = z
  .object({ sha: fullSha.optional(), acknowledgeUnproven: z.boolean().optional() })
  .strict()
  .default({});
const ProtectBody = z.object({ sha: fullSha, note: z.string().max(500).default("") }).strict();
/** A test key as the store has it: printable, at most 1100 characters */
function isTestKey(key: string): boolean {
  return key.length > 0 && key.length <= 1100 && ![...key].some((ch) => ch < " ");
}

const idGuard = requireValidIdParam((id) => UUID.test(id), "triage");

export async function registerTriageRoutes(
  fastify: FastifyInstance,
  manager: TriageManager,
  defaultProject: () => string,
  owner: OwnerGuard = NO_OWNER,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();
    const ownerOnly = owner.requireOwner("Only the owner can do this, from the dashboard");
    const actorOf = (request: FastifyRequest) => {
      const session = owner.sessionOf(request);
      return session ? `owner session ${session.id}` : undefined;
    };

    app.post("/api/triage/results", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const project = projectOf(query.data);
      const raw = request.body;
      if (!raw || typeof raw !== "object" || !("signed" in raw)) {
        return fail(
          reply,
          403,
          "A result over HTTP must be signed: send {signed: SignedGateResult} from a node in triage.trusted_nodes",
        );
      }
      const body = SignedBody.safeParse(raw);
      if (!body.success) return fail(reply, 400, invalid(body.error));
      try {
        // Verify the result exactly as it was signed, before anything reads it
        manager.verify(project, body.data.signed);
        const result = SignedResultSchema.safeParse(body.data.signed.result);
        if (!result.success) return fail(reply, 400, invalid(result.error));
        if (result.data.projectId !== project) {
          return fail(reply, 403, `The result was signed for project ${result.data.projectId}, not ${project}`);
        }
        // Reports are covered by the signature through their digests
        const digests = result.data.reports ?? [];
        const reports: ReportInput[] = [];
        for (const report of body.data.reports) {
          const digest = sha256(report.content);
          const entry = digests.find((d) => d.sha256 === digest);
          if (!entry) {
            return fail(reply, 400, `Report ${report.name ?? "(unnamed)"} is not covered by the signed result (its SHA-256 is not in result.reports)`);
          }
          reports.push({ name: entry.name, step: entry.step, format: report.format, content: report.content });
        }
        return respond(
          // The record at once: its re-checks, messages and tasks run in the background
          await manager.ingest(
            project,
            { result: result.data, reports, context: { recheckId: body.data.recheckId }, trust: "signed" },
            { background: true },
          ),
        );
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
        gateRechecks: store.gateRechecks.related(record.id),
      });
    });

    app.get("/api/triage/rechecks", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      return respond(store ? store.listRechecks(projectOf(query.data), query.data.limit) : []);
    });

    app.get("/api/triage/gate-rechecks", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const store = manager.getStore();
      return respond(store ? store.gateRechecks.list(projectOf(query.data), query.data.limit) : []);
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

    // ============ OWNER ONLY ============

    app.post<{ Params: { id: string } }>(
      `${OWNER_PREFIX}/incidents/:id/revert`,
      { onRequest: ownerOnly, preHandler: idGuard },
      async (request, reply) => {
        const query = ProjectQuery.safeParse(request.query ?? {});
        if (!query.success) return fail(reply, 400, invalid(query.error));
        const body = RevertBody.safeParse(request.body ?? {});
        if (!body.success) return fail(reply, 400, invalid(body.error));
        try {
          const service = manager.require(projectOf(query.data));
          return respond(await service.requestRevert(request.params.id, { ...body.data, actor: actorOf(request) }));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );

    app.post(`${OWNER_PREFIX}/protected`, { onRequest: ownerOnly }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      const body = ProtectBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, invalid(body.error));
      try {
        const project = projectOf(query.data);
        manager.require(project).protect(body.data.sha, body.data.note, actorOf(request));
        return respond(manager.getStore()!.listProtected(project));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.delete<{ Params: { sha: string } }>(`${OWNER_PREFIX}/protected/:sha`, { onRequest: ownerOnly }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      if (!FULL_SHA.test(request.params.sha)) return fail(reply, 400, "Invalid sha: a full commit sha");
      try {
        const project = projectOf(query.data);
        if (!manager.require(project).unprotect(request.params.sha, actorOf(request))) {
          return fail(reply, 404, `${request.params.sha} is not protected`);
        }
        return respond(manager.getStore()!.listProtected(project));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.delete<{ Params: { key: string } }>(`${OWNER_PREFIX}/flaky/:key`, { onRequest: ownerOnly }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, invalid(query.error));
      if (!isTestKey(request.params.key)) return fail(reply, 400, "Invalid test key");
      try {
        const project = projectOf(query.data);
        if (!manager.require(project).liftQuarantine(request.params.key, actorOf(request))) {
          return fail(reply, 404, `${request.params.key} is not quarantined`);
        }
        return respond(manager.getStore()!.listFlaky(project));
      } catch (e) {
        return failWith(reply, e);
      }
    });
  });
}
