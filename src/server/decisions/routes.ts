/**
 * Decision Inbox routes.
 *
 *   GET  /api/decisions?project=&status=open|answered|expired|withdrawn|closed|all&limit=
 *        open first by urgency; without ?project=, every project's decisions
 *   GET  /api/decisions/summary?project=      {open, overdue, secretStore}, for the nav badge
 *   GET  /api/decisions/:id                    one decision with its audit trail
 *   POST /api/decisions?project=               raise (the body is a RaiseDecisionInput without project;
 *                                              the project is ?project=, else the default project)
 *   POST /api/decisions/:id/answer             {optionId, note?, confirm?, secret?}, owner only
 *
 * Answering is for the owner in the Decisions view only: the request must
 * carry a live owner session in X-Lair-Owner-Session, from the dashboard's
 * origin, as a same-origin browser request (src/server/human-auth/). The
 * check is a route onRequest hook, so anything else gets 403 before its body
 * is read, and the decision stays open. Signing in, listing and signing out
 * browsers are /api/owner/* (human-auth/routes.ts).
 *
 * There is no HTTP withdraw: HTTP callers have no identity yet, so only
 * producers inside the server withdraw (DecisionProducer.withdraw). HTTP
 * raises share one cap per project (raiseFromHttp).
 *
 * Every route also passes the cross-site guard; `?project=` is validated by
 * the root guards (src/server/root-guards.ts), and `:id` must be a decision
 * id (400). Expiry belongs to the inbox's sweep, not to reads. No response or
 * error carries a secret value, and no CORS is granted (human-auth/cors.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function registerDecisionRoutes(
  fastify: FastifyInstance,
  inbox: DecisionInbox,
  defaultProject: () => string,
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const idGuard = requireValidIdParam(isDecisionId, "decision");
    const ownerOnly = auth.requireOwner(
      "Only you answer decisions, from the Decisions view in a browser signed in as the owner",
    );

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
        const result = await inbox.raiseFromHttp({ ...body, project } as unknown as RaiseDecisionInput);
        return reply.code(result.created ? 201 : 200).send(respond(result));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.post<{ Params: { id: string } }>(
      "/api/decisions/:id/answer",
      { onRequest: ownerOnly, preHandler: idGuard },
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
