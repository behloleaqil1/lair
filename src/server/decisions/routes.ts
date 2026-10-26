/**
 * Decision Inbox routes.
 *
 *   GET  /api/decisions?project=&status=open|answered|expired|withdrawn|closed|all&limit=
 *        open first by urgency; without ?project=, every project's decisions
 *   GET  /api/decisions/summary?project=      {open, overdue, secretStore}, for the nav badge
 *   GET  /api/decisions/session               {answering}: is answering unlocked in this browser?
 *   POST /api/decisions/session               {token}: unlock answering (sets the session cookie)
 *   GET  /api/decisions/:id                    one decision with its audit trail
 *   POST /api/decisions?project=               raise (the body is a RaiseDecisionInput without project;
 *                                              the project is ?project=, else the default project)
 *   POST /api/decisions/:id/answer             {optionId, note?, confirm?, secret?}
 *
 * Answering is for the human in the Decisions view only: POST
 * /api/decisions/session and /answer need a same-origin browser request
 * from the dashboard, and /answer also the answer session cookie (see
 * answer-auth.ts). Anything else gets 403 and the decision stays open.
 * There is no HTTP withdraw: HTTP callers have no identity yet, so only
 * producers inside the server withdraw (DecisionProducer.withdraw).
 *
 * Every route also passes the cross-site guard; `?project=` is validated by
 * the root guards (src/server/root-guards.ts), and `:id` must be a decision
 * id (400). Expiry belongs to the inbox's sweep, not to reads. No response or
 * error carries a secret value.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import { dashboardRequestProblem, type AnswerCredential } from "./answer-auth.js";
import type { DecisionInbox } from "./service.js";
import type { AnswerInput, RaiseDecisionInput } from "./types.js";
import { DecisionError, isDecisionId } from "./validate.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

function failWith(reply: FastifyReply, e: unknown) {
  if (e instanceof DecisionError) return fail(reply, e.statusCode, e.message);
  return fail(reply, 500, e instanceof Error ? e.message : "Unknown error");
}

const ListQuery = z.object({
  project: z.string().optional(),
  status: z.enum(["open", "answered", "expired", "withdrawn", "closed", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const ProjectQuery = z.object({ project: z.string().optional() });
const SessionBody = z.object({ token: z.string().min(1).max(200) }).strict();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_UNLOCKED =
  "Answering is only possible from the Decisions view with answering unlocked " +
  "(the token in data/decisions.answer-token)";

export async function registerDecisionRoutes(
  fastify: FastifyInstance,
  inbox: DecisionInbox,
  defaultProject: () => string,
  credential: AnswerCredential,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const idGuard = requireValidIdParam(isDecisionId, "decision");

    /** Only the dashboard, in a browser, with the answer session. */
    const answerGuard = async (request: FastifyRequest, reply: FastifyReply) => {
      const problem = credential.answerProblem(request.headers);
      if (problem) return fail(reply, 403, `${NOT_UNLOCKED}: ${problem}`);
    };

    app.get("/api/decisions", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond(inbox.list(query.data));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/decisions/summary", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        return respond({ ...inbox.counts(query.data.project), secretStore: inbox.secretStoreDescription });
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/decisions/session", async (request) => {
      const cookie = typeof request.headers.cookie === "string" ? request.headers.cookie : undefined;
      return respond({ answering: credential.hasSession(cookie) });
    });

    app.post("/api/decisions/session", async (request, reply) => {
      const problem = dashboardRequestProblem(request.headers);
      if (problem) return fail(reply, 403, `Answering can only be unlocked from the Decisions view: ${problem}`);
      const body = SessionBody.safeParse(request.body ?? {});
      if (!body.success || !credential.matchesToken(body.data.token)) {
        return fail(reply, 403, "That is not the answer token in data/decisions.answer-token");
      }
      reply.header("set-cookie", credential.sessionCookie());
      return respond({ answering: true });
    });

    app.get<{ Params: { id: string } }>("/api/decisions/:id", { preHandler: idGuard }, async (request, reply) => {
      try {
        const decision = inbox.get(request.params.id);
        return decision ? respond(decision) : fail(reply, 404, "Decision not found");
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.post("/api/decisions", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      const body = request.body;
      if (!isObject(body)) return fail(reply, 400, "Invalid decision: the body must be a JSON object");
      if ("project" in body) {
        return fail(reply, 400, "Invalid decision: pass the project as ?project=, not in the body");
      }
      try {
        const project = query.data.project ?? defaultProject();
        const result = await inbox.raise({ ...body, project } as unknown as RaiseDecisionInput);
        return reply.code(result.created ? 201 : 200).send(respond(result));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.post<{ Params: { id: string } }>(
      "/api/decisions/:id/answer",
      { preHandler: [answerGuard, idGuard] },
      async (request, reply) => {
        try {
          const userAgent = request.headers["user-agent"];
          const decision = await inbox.answer(request.params.id, (request.body ?? {}) as AnswerInput, {
            remoteAddress: request.ip,
            userAgent: typeof userAgent === "string" ? userAgent : undefined,
          });
          return respond(decision);
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );
  });
}
