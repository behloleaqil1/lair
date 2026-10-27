/**
 * Review routes. `?project=` is validated by the root guards
 * (src/server/root-guards.ts); without it the default project is used.
 *
 *   GET  /api/review/status                     enabled, config errors, repo, read-only
 *   GET  /api/review/prs                        open PRs with their last verdict
 *   GET  /api/review/prs/:number                tier, required vs present reviews, findings, gate, conditions, plan
 *   POST /api/review/prs/:number/reviews        an agent's review {reviewer, head_sha, verdict, summary, findings[], assignment_token}
 *   POST /api/review/prs/:number/owner-review   owner: a human review {reviewer, head_sha, verdict, summary, findings[]}
 *   POST /api/review/prs/:number/request-reviews owner: ask for the missing reviews at the head
 *   POST /api/review/prs/:number/merge          owner: {confirm: true, head_sha, by?}
 *   POST /api/review/findings/:id/resolve       owner: {by, status?, note}
 *   GET  /api/review/holds
 *   POST /api/review/holds                      {reason, pr?, by} (anyone may hold)
 *   POST /api/review/holds/:id/release          owner: {by}
 *   POST /api/review/gate-results               a signed gate result: refused (403) unless node_keys verify it; the first per id stays
 *   GET  /api/review/merges
 *
 * "owner" routes need the owner's browser session (src/server/human-auth/),
 * checked before the body is read; /api/review is in OWNER_ONLY_PREFIXES, so
 * no CORS is granted for it. Agents can review only under an assignment.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import { HostError } from "./host.js";
import { ReviewError, type ReviewManager, type ReviewService } from "./service.js";
import type { SignedGateResult } from "../../shared/policy-types.js";
import type { ClientInfo } from "../../shared/review-types.js";

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
/**
 * Who a request names (a reviewer, a merger, a holder). Names starting with
 * `lair:` are Lair's own (lair:test-integrity, lair:policy for automatic
 * merges): no caller may record anything under one.
 */
const ActorId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, "letters, digits, '.', '_', ':' and '-'")
  .refine((name) => !name.toLowerCase().startsWith("lair:"), "names starting with lair: are Lair's own");

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
    /** For an agent's review: the token of its assignment (from request-reviews, via the assigner) */
    assignment_token: z.string().min(16).max(200).optional(),
  })
  .strict();

const MergeBody = z
  .object({
    confirm: z.literal(true, { errorMap: () => ({ message: "send confirm: true to merge" }) }),
    head_sha: FullSha,
    // Never lair:policy (an automatic merge, review.merge.auto): ActorId refuses Lair's own names
    by: ActorId.default("dashboard"),
  })
  .strict();

const OwnerReviewBody = z
  .object({
    /** The name to record the review under */
    reviewer: ActorId,
    head_sha: FullSha,
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().max(10_000).default(""),
    findings: z.array(Finding).max(200).default([]),
  })
  .strict();

const ResolveBody = z
  .object({
    by: ActorId,
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

/** Where a request came from, recorded with what it did. */
function clientOf(request: FastifyRequest, auth?: HumanAuth): ClientInfo {
  const agent = request.headers["user-agent"];
  const client: ClientInfo = {
    address: request.ip ?? null,
    userAgent: typeof agent === "string" ? agent.slice(0, 300) : null,
  };
  const session = auth?.sessionOf(request);
  if (session) client.ownerSession = session.id;
  return client;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join(".") || "body"}: ${issue.message}`;
}

export async function registerReviewRoutes(
  fastify: FastifyInstance,
  manager: ReviewManager,
  defaultProject: () => string,
  /** The owner's credential: merges, human reviews, resolutions and hold releases need its session */
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const owner = { onRequest: auth.requireOwner("Only the owner can do this, from the dashboard signed in as the owner") };

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
      if (body.data.reviewer.kind === "human") {
        return fail(reply, 403, "A human reviews from the dashboard, signed in as the owner (POST ./owner-review)");
      }
      return withService(request.query, reply, (service) =>
        service.submitReview(
          n,
          {
            reviewer: body.data.reviewer,
            headSha: body.data.head_sha.toLowerCase(),
            verdict: body.data.verdict,
            summary: body.data.summary,
            findings: body.data.findings,
          },
          { assignmentToken: body.data.assignment_token ?? null, client: clientOf(request) },
        ),
      );
    });

    app.post("/api/review/prs/:number/owner-review", owner, async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      const body = OwnerReviewBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid review: ${firstIssue(body.error)}`);
      return withService(request.query, reply, (service) =>
        service.submitReview(
          n,
          {
            reviewer: { id: body.data.reviewer, kind: "human" },
            headSha: body.data.head_sha.toLowerCase(),
            verdict: body.data.verdict,
            summary: body.data.summary,
            findings: body.data.findings,
          },
          { assignmentToken: null, client: clientOf(request, auth), owner: true },
        ),
      );
    });

    // Asking can start reviewer runs (spend): the owner's only; reviews by agents also ask in-process
    app.post("/api/review/prs/:number/request-reviews", owner, async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      return withService(request.query, reply, (service) => service.requestReviews(n, "owner"));
    });

    app.post("/api/review/prs/:number/merge", owner, async (request, reply) => {
      const n = prNumber(request.params);
      if (n === null) return fail(reply, 400, "Invalid PR number");
      const body = MergeBody.safeParse(request.body ?? {});
      if (!body.success) return fail(reply, 400, `Invalid merge request: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => {
        const result = await service.merge(n, {
          confirm: body.data.confirm,
          headSha: body.data.head_sha.toLowerCase(),
          by: body.data.by,
          client: clientOf(request, auth),
        });
        if (!result.merged) {
          return fail(reply, 409, `Merge refused: ${result.reasons.join(" | ")}`, result);
        }
        return result;
      });
    });

    app.post("/api/review/findings/:id/resolve", owner, async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, "Invalid finding id");
      const body = ResolveBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid resolution: ${firstIssue(body.error)}`);
      return withService(request.query, reply, (service) =>
        service.resolveFinding(
          params.data.id,
          { id: body.data.by, kind: "human" },
          body.data.status,
          body.data.note,
          clientOf(request, auth),
        ),
      );
    });

    app.get("/api/review/holds", async (request, reply) =>
      withService(request.query, reply, async (service) => service.listHolds()),
    );

    app.post("/api/review/holds", async (request, reply) => {
      const body = HoldBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid hold: ${firstIssue(body.error)}`);
      // Anyone may hold; only a hold from the owner's signed-in browser asks for their answer (`by` is the caller's word)
      const byOwner = auth.verifyRequest(request.headers, { method: request.method }).ok;
      return withService(request.query, reply, async (service) =>
        service.addHold(body.data.pr, body.data.reason, body.data.by, byOwner),
      );
    });

    app.post("/api/review/holds/:id/release", owner, async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, "Invalid hold id");
      const body = ReleaseBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid release: ${firstIssue(body.error)}`);
      return withService(request.query, reply, async (service) => service.releaseHold(params.data.id, body.data.by));
    });

    app.post("/api/review/gate-results", async (request, reply) => {
      const body = SignedGateBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, `Invalid gate result: ${firstIssue(body.error)}`);
      // Any local process can post here: the service refuses (403) a result its node_keys don't verify
      return withService(request.query, reply, async (service) => {
        const stored = service.addGateResult(body.data as SignedGateResult);
        // stored: false when a result with this id was already kept (the first one stays)
        return { id: body.data.result.id, stored };
      });
    });

    app.get("/api/review/merges", async (request, reply) =>
      withService(request.query, reply, async (service) => service.listMerges()),
    );
  });
}
