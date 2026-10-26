/**
 * Review routes. `?project=` is validated by the root guards
 * (src/server/root-guards.ts); without it the default project is used.
 *
 *   GET  /api/review/status                     enabled, config errors, repo, read-only
 *   GET  /api/review/prs                        open PRs with their last verdict
 *   GET  /api/review/prs/:number                tier, required vs present reviews, findings, gate, conditions, plan
 *   POST /api/review/prs/:number/reviews        {reviewer, head_sha, verdict, summary, findings[]}
 *   POST /api/review/prs/:number/author         {id, kind, model?}
 *   POST /api/review/prs/:number/request-reviews
 *   POST /api/review/prs/:number/merge          {confirm: true, head_sha, by?}
 *   POST /api/review/findings/:id/resolve       {by: {id, kind}, status?, note}
 *   GET  /api/review/holds
 *   POST /api/review/holds                      {reason, pr?, by}
 *   POST /api/review/holds/:id/release          {by}
 *   POST /api/review/gate-results               a signed gate result
 *   GET  /api/review/merges
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { HostError } from "./host.js";
import { ReviewError, type ReviewManager, type ReviewService } from "./service.js";
import type { SignedGateResult } from "../../shared/policy-types.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string, data?: unknown) {
  return reply
    .code(code)
    .send({ success: false, error, ...(data !== undefined ? { data } : {}), timestamp: new Date().toISOString() });
}

const ProjectQuery = z.object({ project: z.string().optional() });
const PrParams = z.object({ number: z.string().regex(/^[1-9]\d{0,9}$/) });
const IdParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
/** The full commit sha: an approval binds to exactly one commit */
const FullSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "the full head commit sha");
const ActorId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, "letters, digits, '.', '_', ':' and '-'");

const Reviewer = z
  .object({
    id: ActorId,
    kind: z.enum(["human", "agent"]),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();

const Finding = z
  .object({
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    file: z.string().min(1).max(500).nullable().default(null),
    line: z.number().int().positive().nullable().default(null),
    text: z.string().min(1).max(4000),
    blocking: z.boolean(),
  })
  .strict();

const ReviewBody = z
  .object({
    reviewer: Reviewer,
    head_sha: FullSha,
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().max(10_000).default(""),
    findings: z.array(Finding).max(200).default([]),
  })
  .strict();

const MergeBody = z
  .object({
    confirm: z.literal(true, { errorMap: () => ({ message: "send confirm: true to merge" }) }),
    head_sha: FullSha,
    by: ActorId.default("dashboard"),
  })
  .strict();

const ResolveBody = z
  .object({
    by: Reviewer,
    status: z.enum(["resolved", "dismissed"]).default("resolved"),
    note: z.string().min(1).max(4000),
  })
  .strict();

const HoldBody = z
  .object({
    reason: z.string().min(1).max(1000),
    pr: z.number().int().positive().nullable().default(null),
    by: ActorId,
  })
  .strict();

const ReleaseBody = z.object({ by: ActorId }).strict();

const GateStep = z
  .object({
    name: z.string(),
    status: z.enum(["passed", "failed", "skipped", "timed_out"]),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  .strict();

const SignedGateBody = z
  .object({
    result: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        pipelineId: z.string().min(1),
        commitSha: FullSha,
        branch: z.string(),
        projectId: z.string().min(1),
        nodeId: z.string().min(1),
        status: z.enum(["passed", "failed", "error"]),
        steps: z.array(GateStep),
        selectedSteps: z.array(z.string()),
        durationMs: z.number(),
        startedAt: z.string(),
        completedAt: z.string(),
        pipelineVersion: z.string(),
      })
      .strict(),
    signature: z.string().min(1),
    nodePublicKey: z.string().min(1),
  })
  .strict();

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join(".") || "body"}: ${issue.message}`;
}

export async function registerReviewRoutes(
  fastify: FastifyInstance,
  manager: ReviewManager,
  defaultProject: () => string,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);

    const projectOf = (query: unknown): string | null => {
      const parsed = ProjectQuery.safeParse(query ?? {});
      if (!parsed.success) return null;
      return parsed.data.project ?? defaultProject();
    };

    /** Run `handler` with the project's review service, mapping errors to HTTP codes. */
    const withService = async (
      query: unknown,
      reply: FastifyReply,
      handler: (service: ReviewService) => Promise<unknown>,
    ) => {
      const project = projectOf(query);
      if (project === null) return fail(reply, 400, "Invalid project parameter");
      const service = manager.get(project);
      if (!service) {
        const info = manager.info(project);
        return fail(
          reply,
          404,
          info.errors.length > 0
            ? `Reviews are off for ${project}: ${info.errors.join("; ")}`
            : `Reviews are off for ${project} (set review.enabled: true)`,
        );
      }
      try {
        const data = await handler(service);
        if (reply.sent) return reply;
        return respond(data);
      } catch (e) {
        if (e instanceof ReviewError) return fail(reply, e.statusCode, e.message);
        if (e instanceof HostError) return fail(reply, 502, `Git host: ${e.message}`);
        return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
      }
    };

    const prNumber = (params: unknown): number | null => {
      const parsed = PrParams.safeParse(params);
      return parsed.success ? Number(parsed.data.number) : null;
    };

    app.get("/api/review/status", async (request, reply) => {
      const project = projectOf(request.query);
      if (project === null) return fail(reply, 400, "Invalid project parameter");
      return respond(manager.info(project));
    });

    app.get("/api/review/prs", async (request, reply) =>
      withService(request.query, reply, (service) => service.list()),
    );

    app.get("/api/review/prs/:number", async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      return withService(request.query, reply, (service) => service.status(n));
    });

    app.post("/api/review/prs/:number/reviews", async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      const body = ReviewBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid review: ${firstIssue(body.error)}`);
      return withService(request.query, reply, (service) =>
        service.submitReview(n, {
          reviewer: body.data.reviewer,
          headSha: body.data.head_sha.toLowerCase(),
          verdict: body.data.verdict,
          summary: body.data.summary,
          findings: body.data.findings,
        }),
      );
    });

    app.post("/api/review/prs/:number/author", async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      const body = Reviewer.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid author: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => service.setAuthor(n, body.data));
    });

    app.post("/api/review/prs/:number/request-reviews", async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      return withService(request.query, reply, (service) => service.requestReviews(n));
    });

    app.post("/api/review/prs/:number/merge", async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      const body = MergeBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, `Invalid merge request: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => {
        const result = await service.merge(n, {
          confirm: body.data.confirm,
          headSha: body.data.head_sha.toLowerCase(),
          by: body.data.by,
        });
        if (!result.merged) {
          return fail(reply, 409, `Merge refused: ${result.reasons.join(" | ")}`, result);
        }
        return result;
      });
    });

    app.post("/api/review/findings/:id/resolve", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, "Invalid finding id");
      const body = ResolveBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid resolution: ${firstIssue(body.error)}`);
      return withService(request.query, reply, (service) =>
        service.resolveFinding(params.data.id, body.data.by, body.data.status, body.data.note),
      );
    });

    app.get("/api/review/holds", async (request, reply) =>
      withService(request.query, reply, async (service) => service.listHolds()),
    );

    app.post("/api/review/holds", async (request, reply) => {
      const body = HoldBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid hold: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) =>
        service.addHold(body.data.pr, body.data.reason, body.data.by),
      );
    });

    app.post("/api/review/holds/:id/release", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, "Invalid hold id");
      const body = ReleaseBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid release: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => service.releaseHold(params.data.id, body.data.by));
    });

    app.post("/api/review/gate-results", async (request, reply) => {
      const body = SignedGateBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid gate result: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => {
        service.addGateResult(body.data as SignedGateResult);
        return { stored: body.data.result.id };
      });
    });

    app.get("/api/review/merges", async (request, reply) =>
      withService(request.query, reply, async (service) => service.listMerges()),
    );
  });
}
