/**
 * Owner session routes (see human-auth.ts).
 *
 *   GET  /api/owner/session                 {signedIn, session}: is the X-Lair-Owner-Session header a live session?
 *   POST /api/owner/sessions                {token} -> 201 {session, info}: sign this browser in. The
 *                                           value is in this response only; the dashboard keeps it in
 *                                           its origin's localStorage. Dashboard requests only.
 *   GET  /api/owner/sessions                the signed-in browsers (owner only), `current` marks this one
 *   POST /api/owner/sessions/:id/revoke     sign a browser out (owner only)
 *
 * The checks run as route `onRequest` hooks, so a refused request is
 * refused before its body is read. No route sets a cookie, and no CORS is
 * granted for /api/owner (cors.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { OWNER_SESSION_HEADER, type HumanAuth } from "./human-auth.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SignIn = z.object({ token: z.string().min(1).max(200) }).strict();

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

/** Register the owner session routes. fastify.close() closes the session store. */
export async function registerOwnerRoutes(fastify: FastifyInstance, auth: HumanAuth): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    const ownerOnly = auth.requireOwner("Only a browser signed in as the owner can do this");

    app.get("/api/owner/session", async (request) => {
      const session = auth.findSession(request.headers[OWNER_SESSION_HEADER]);
      return respond({ signedIn: session !== null, session });
    });

    app.post(
      "/api/owner/sessions",
      { onRequest: auth.requireDashboard("Only the dashboard can sign a browser in") },
      async (request, reply) => {
        const body = SignIn.safeParse(request.body ?? {});
        const userAgent = request.headers["user-agent"];
        const created = body.success
          ? auth.createSession(body.data.token, typeof userAgent === "string" ? userAgent : undefined)
          : null;
        if (!created) return fail(reply, 403, `That is not the owner token in ${auth.tokenPath}`);
        return reply.code(201).header("cache-control", "no-store").send(respond(created));
      },
    );

    app.get("/api/owner/sessions", { onRequest: ownerOnly }, async (request) => {
      const current = auth.sessionOf(request)?.id;
      return respond(auth.listSessions().map((s) => ({ ...s, current: s.id === current })));
    });

    app.post<{ Params: { id: string } }>(
      "/api/owner/sessions/:id/revoke",
      { onRequest: ownerOnly },
      async (request, reply) => {
        const id = request.params.id;
        if (!SESSION_ID.test(id)) return fail(reply, 400, "Invalid session id");
        if (!auth.revoke(id)) return fail(reply, 404, "No such session");
        return respond({ revoked: id, current: auth.sessionOf(request)?.id === id });
      },
    );
  });
  fastify.addHook("onClose", async () => auth.close());
}
