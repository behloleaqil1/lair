/**
 * Checks routes: the HTTP API for the checks module.
 *
 * Routes:
 * - POST /api/checks           Request a check (requires bus token)
 * - GET  /api/checks/:id       Get check result (long-poll with ?wait=)
 * - GET  /api/checks           List checks (for UI)
 * - GET  /api/checks/stats     Stats for Health view
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import { hashBusToken, isBusTokenFormat, redactBusToken } from "../bus/index.js";
import type { BusStore } from "../bus/store.js";
import type { ChecksService, CheckError } from "./service.js";

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

function errorCode(error: CheckError): number {
  switch (error.code) {
    case "unauthorized": return 401;
    case "forbidden": return 403;
    case "not_found": return 404;
    case "rate_limit": return 429;
    case "guard": return 403;
    case "disabled": return 404;
    default: return 400;
  }
}

function extractToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

const RequestBody = z.object({
  kind: z.string().min(1).max(64),
  sha: z.string().regex(/^[a-f0-9]{40}$/, "sha must be a 40-char hex string"),
  branch: z.string().max(200).optional(),
  tests: z.array(z.string().min(1).max(500)).min(1).max(100),
});

const ListQuery = z.object({
  project: z.string().optional(),
  kind: z.string().optional(),
  agent: z.string().optional(),
  sha: z.string().optional(),
  status: z.enum(["queued", "running", "pass", "fail", "infrastructure", "timeout", "guard", "refused"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const GetQuery = z.object({
  project: z.string().optional(),
  wait: z.coerce.number().int().min(0).max(600).optional(),
});

export interface ChecksRoutesOptions {
  service: ChecksService;
  busStore: BusStore;
  defaultProject: () => string;
}

export async function registerChecksRoutes(
  fastify: FastifyInstance,
  options: ChecksRoutesOptions,
): Promise<void> {
  const { service, busStore, defaultProject } = options;

  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // Project is optional for checks routes - POST derives it from the token binding,
    // GET/list routes use the default project when not specified.
    app.addHook("onRequest", projectQueryGuard({ optional: true }));

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    // POST /api/checks - Request a check
    app.post<{ Body: unknown; Querystring: { project?: string } }>("/api/checks", async (request, reply) => {
      const project = projectOf(request.query);

      // Check if module is enabled
      if (!service.isEnabled()) {
        return fail(reply, 404, "Checks module is not configured for this project");
      }

      // Extract and validate token
      const token = extractToken(request.headers.authorization);
      if (!token || !isBusTokenFormat(token)) {
        return fail(reply, 401, "Missing or invalid bus token");
      }

      // Validate token
      const binding = busStore.validateToken(hashBusToken(token));
      if (!binding) {
        return fail(reply, 401, "Invalid or expired bus token");
      }

      // Verify project matches
      if (binding.project !== project) {
        return fail(reply, 403, "Token is for a different project");
      }

      // Parse body
      const body = RequestBody.safeParse(request.body ?? {});
      if (!body.success) {
        const issue = body.error.issues[0];
        return fail(reply, 400, `Invalid request: ${issue.path.join(".") || "body"}: ${issue.message}`);
      }

      // Request the check
      const result = await service.requestCheck(binding, body.data.kind, body.data.sha, body.data.branch, body.data.tests);

      if (!result.ok) {
        const safeMessage = redactBusToken(result.error.message, token);
        return fail(reply, errorCode(result.error), safeMessage);
      }

      reply.code(201);
      return respond(result.data);
    });

    // GET /api/checks/:id - Get check result
    app.get<{ Params: { id: string }; Querystring: { project?: string; wait?: string } }>("/api/checks/:id", async (request, reply) => {
      const query = GetQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return fail(reply, 400, `Invalid query: ${query.error.issues[0].message}`);
      }

      const waitMs = query.data.wait ? query.data.wait * 1000 : undefined;
      const result = await service.getCheck(request.params.id, waitMs);

      if (!result.ok) {
        return fail(reply, errorCode(result.error), result.error.message);
      }

      return respond(result.data);
    });

    // GET /api/checks - List checks
    app.get<{ Querystring: unknown }>("/api/checks", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return fail(reply, 400, `Invalid query: ${query.error.issues[0].message}`);
      }

      const checks = service.listChecks({
        kind: query.data.kind,
        agent: query.data.agent,
        sha: query.data.sha,
        status: query.data.status,
        limit: query.data.limit,
      });

      return respond({
        checks: checks.map((c) => ({
          id: c.id,
          kind: c.kind,
          agent: c.agent,
          sha: c.sha,
          status: c.status,
          createdAt: new Date(c.createdAt).toISOString(),
          durationMs: c.durationMs,
        })),
      });
    });

    // GET /api/checks/stats - Stats for Health view
    app.get("/api/checks/stats", async () => {
      return respond(service.getStats());
    });
  });
}
