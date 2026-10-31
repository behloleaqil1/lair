/**
 * Checks routes: the HTTP API for the checks module.
 *
 * Routes:
 * - POST /api/checks?project=         Request a check (requires bus token)
 * - GET  /api/checks/:id?project=     Get check result (token-bound or owner)
 * - GET  /api/checks?project=         List checks (owner only)
 * - GET  /api/checks/stats?project=   Stats for Health view (owner only)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { projectQueryGuard } from "../routes/project-guard.js";
import { hashBusToken, isBusTokenFormat, redactBusToken, getBusStore } from "../bus/index.js";
import type { BusTokenBinding } from "../bus/tokens.js";
import type { ChecksManager } from "./manager.js";
import type { CheckError } from "./service.js";
import type { HumanAuth } from "../human-auth/index.js";
import { join } from "path";

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

const ProjectQuery = z.object({
  project: z.string().optional(),
});

const ListQuery = ProjectQuery.extend({
  kind: z.string().optional(),
  agent: z.string().optional(),
  sha: z.string().optional(),
  status: z.enum(["queued", "running", "pass", "fail", "infrastructure", "timeout", "guard", "refused"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const GetQuery = ProjectQuery.extend({
  wait: z.coerce.number().int().min(0).max(600).optional(),
});

export interface ChecksRoutesOptions {
  manager: ChecksManager;
  defaultProject: () => string;
  /** Owner auth for list/stats routes. When null, those routes are disabled. */
  ownerAuth?: HumanAuth;
  /** Data directory for bus stores */
  dataDir: string;
}

export async function registerChecksRoutes(
  fastify: FastifyInstance,
  options: ChecksRoutesOptions,
): Promise<void> {
  const { manager, defaultProject, ownerAuth, dataDir } = options;

  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // Project is optional for checks routes - POST derives it from the token binding,
    // GET/list routes use the default project when not specified.
    app.addHook("onRequest", projectQueryGuard({ optional: true }));

    const projectOf = (query: { project?: string }) => query.project ?? defaultProject();

    /** Extract and validate token, returning binding or null */
    const getTokenBinding = (request: FastifyRequest, project: string): BusTokenBinding | null => {
      const token = extractToken(request.headers.authorization);
      if (!token || !isBusTokenFormat(token)) return null;
      const busStore = getBusStore(project, dataDir);
      return busStore.validateToken(hashBusToken(token));
    };

    /** Check if this is an owner session request */
    const isOwnerSession = (request: FastifyRequest): boolean => {
      if (!ownerAuth) return false;
      const check = ownerAuth.verifyRequest(request.headers, { method: request.method });
      return check.ok;
    };

    // POST /api/checks - Request a check
    app.post<{ Body: unknown; Querystring: { project?: string } }>("/api/checks", async (request, reply) => {
      const projectQuery = ProjectQuery.safeParse(request.query ?? {});
      if (!projectQuery.success) {
        return fail(reply, 400, `Invalid query: ${projectQuery.error.issues[0].message}`);
      }

      // Extract and validate token first (to get project from binding)
      const rawToken = extractToken(request.headers.authorization);
      if (!rawToken || !isBusTokenFormat(rawToken)) {
        return fail(reply, 401, "Missing or invalid bus token");
      }

      // Try to validate against the queried project or default
      const project = projectOf(projectQuery.data);
      const busStore = getBusStore(project, dataDir);
      const binding = busStore.validateToken(hashBusToken(rawToken));
      if (!binding) {
        return fail(reply, 401, "Invalid or expired bus token");
      }

      // Verify project matches
      if (binding.project !== project) {
        return fail(reply, 403, "Token is for a different project");
      }

      // Get the service for this project
      const service = manager.get(project);
      if (!service || !service.isEnabled()) {
        return fail(reply, 404, "Checks module is not configured for this project");
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
        const safeMessage = redactBusToken(result.error.message, rawToken);
        return fail(reply, errorCode(result.error), safeMessage);
      }

      reply.code(201);
      return respond(result.data);
    });

    // GET /api/checks/:id - Get check result (token-bound or owner)
    app.get<{ Params: { id: string }; Querystring: { project?: string; wait?: string } }>("/api/checks/:id", async (request, reply) => {
      const query = GetQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return fail(reply, 400, `Invalid query: ${query.error.issues[0].message}`);
      }

      const project = projectOf(query.data);
      const service = manager.get(project);

      // Check if module is enabled
      if (!service || !service.isEnabled()) {
        return fail(reply, 404, "Checks module is not configured for this project");
      }

      // Check auth: either token binding or owner session
      const tokenBinding = getTokenBinding(request, project);
      const ownerSession = isOwnerSession(request);

      // If neither token nor owner session, require token
      if (!tokenBinding && !ownerSession) {
        return fail(reply, 401, "Authentication required: bus token or owner session");
      }

      const waitMs = query.data.wait ? query.data.wait * 1000 : undefined;
      const result = await service.getCheck(request.params.id, ownerSession ? null : tokenBinding, waitMs);

      if (!result.ok) {
        return fail(reply, errorCode(result.error), result.error.message);
      }

      return respond(result.data);
    });

    // GET /api/checks - List checks (owner only)
    app.get<{ Querystring: unknown }>("/api/checks", async (request, reply) => {
      const query = ListQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return fail(reply, 400, `Invalid query: ${query.error.issues[0].message}`);
      }

      const project = projectOf(query.data);
      const service = manager.get(project);

      // Check if module is enabled
      if (!service || !service.isEnabled()) {
        return fail(reply, 404, "Checks module is not configured for this project");
      }

      // Owner only
      const ownerSession = isOwnerSession(request);
      if (!ownerSession) {
        return fail(reply, 401, "Owner session required");
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

    // GET /api/checks/stats - Stats for Health view (owner only)
    app.get<{ Querystring: { project?: string } }>("/api/checks/stats", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) {
        return fail(reply, 400, `Invalid query: ${query.error.issues[0].message}`);
      }

      const project = projectOf(query.data);
      const service = manager.get(project);

      // Check if module is enabled
      if (!service || !service.isEnabled()) {
        return fail(reply, 404, "Checks module is not configured for this project");
      }

      // Owner only
      const ownerSession = isOwnerSession(request);
      if (!ownerSession) {
        return fail(reply, 401, "Owner session required");
      }

      return respond(service.getStats());
    });
  });
}
