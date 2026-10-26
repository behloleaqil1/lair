/**
 * Decision Inbox routes.
 *
 *   GET  /api/decisions?project=&status=open|answered|expired|withdrawn|closed|all&limit=
 *        open first by urgency; without ?project=, every project's decisions
 *   GET  /api/decisions/summary?project=      {open, overdue, secretStore}, for the nav badge
 *   GET  /api/decisions/:id                    one decision with its audit trail
 *   POST /api/decisions?project=               raise (the body is a RaiseDecisionInput without project;
 *                                              the project is ?project=, else the default project)
 *   POST /api/decisions/:id/answer             {optionId, note?, confirm?, secret?, by?}
 *   POST /api/decisions/:id/withdraw           {module, reason}: only the module that raised it
 *
 * Cross-site browser requests and foreign Host headers are refused (403) by
 * the hook below, `?project=` is validated by the root guards
 * (src/server/root-guards.ts), and `:id` must be a decision id (400).
 * No response or error carries a secret value.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import type { DecisionInbox } from "./service.js";
import type { AnswerInput, RaiseDecisionInput, WithdrawInput } from "./types.js";
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
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes too
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const idGuard = requireValidIdParam(isDecisionId, "decision");

    app.get("/api/decisions", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        await inbox.expireDue();
        return respond(inbox.list(query.data));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.get("/api/decisions/summary", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, `Invalid query: ${query.error.issues[0].path.join(".")}`);
      try {
        await inbox.expireDue();
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
        const result = await inbox.raise({ ...body, project } as unknown as RaiseDecisionInput);
        return reply.code(result.created ? 201 : 200).send(respond(result));
      } catch (e) {
        return failWith(reply, e);
      }
    });

    app.post<{ Params: { id: string } }>(
      "/api/decisions/:id/answer",
      { preHandler: idGuard },
      async (request, reply) => {
        try {
          return respond(await inbox.answer(request.params.id, (request.body ?? {}) as AnswerInput));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/decisions/:id/withdraw",
      { preHandler: idGuard },
      async (request, reply) => {
        try {
          return respond(await inbox.withdraw(request.params.id, (request.body ?? {}) as WithdrawInput));
        } catch (e) {
          return failWith(reply, e);
        }
      },
    );
  });
}
