/**
 * The Settings API (docs/design/settings-ui.md). Every route is the owner's,
 * reads included: a project's config reveals paths and commands. The prefix
 * /api/settings is in OWNER_ONLY_PREFIXES, so no CORS is granted either.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HumanAuth } from "../human-auth/index.js";
import { MAX_CONFIG_BYTES } from "../config.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { CreateProjectRequest, SaveRequest } from "../../shared/settings-types.js";
import type { SettingsService } from "./service.js";

/** A request carries at most a whole file (as JSON, escaped) and a little more */
export const SETTINGS_BODY_LIMIT = 2 * MAX_CONFIG_BYTES + 64 * 1024;

interface Refusal {
  statusCode: number;
  message: string;
  code?: string;
  data?: unknown;
}

function isRefusal(e: unknown): e is Refusal {
  return (
    e instanceof Error &&
    typeof (e as unknown as { statusCode?: unknown }).statusCode === "number" &&
    (e as unknown as { statusCode: number }).statusCode >= 400 &&
    (e as unknown as { statusCode: number }).statusCode < 500
  );
}

function ok<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function body<T>(request: FastifyRequest): Partial<T> {
  const value = request.body;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Partial<T>) : {};
}

export interface SettingsRoutesOptions {
  service: SettingsService;
  auth: HumanAuth;
}

export async function registerSettingsUiRoutes(fastify: FastifyInstance, options: SettingsRoutesOptions): Promise<void> {
  await fastify.register((app) => settingsUiRoutes(app, options));
}

async function settingsUiRoutes(fastify: FastifyInstance, { service, auth }: SettingsRoutesOptions): Promise<void> {
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  // Before the body is read: only the owner, for every route here
  fastify.addHook("onRequest", auth.requireOwner());

  const by = (request: FastifyRequest) => auth.sessionOf(request)?.id ?? null;

  async function handle<T>(reply: FastifyReply, run: () => T | Promise<T>, status = 200) {
    try {
      const data = await run();
      return reply.code(status).send(ok(data));
    } catch (e) {
      if (isRefusal(e)) {
        return reply.code(e.statusCode).send({
          success: false,
          error: e.message,
          code: e.code,
          data: e.data,
          timestamp: new Date().toISOString(),
        });
      }
      throw e;
    }
  }

  const limit = { bodyLimit: SETTINGS_BODY_LIMIT };
  type IdParams = { Params: { id: string } };
  type VersionParams = { Params: { id: string; version: string } };

  fastify.get("/api/settings/modules", async (_request, reply) => handle(reply, () => ({ sections: service.modules() })));

  fastify.get("/api/settings/projects", async (_request, reply) => handle(reply, () => ({ projects: service.listProjects() })));

  fastify.get<IdParams>("/api/settings/projects/:id", async (request, reply) =>
    handle(reply, () => service.view(request.params.id)),
  );

  fastify.put<IdParams>("/api/settings/projects/:id", limit, async (request, reply) =>
    handle(reply, () => service.save(request.params.id, body<SaveRequest>(request), by(request))),
  );

  // A dry run: the same checks as a save (or a create, with `create`), nothing written
  fastify.post("/api/settings/validate", limit, async (request, reply) =>
    handle(reply, async () => {
      const b = body<SaveRequest & { project: string; create: CreateProjectRequest; restore: string }>(request);
      if (b.create !== undefined) {
        return (await service.createCheck(typeof b.create === "object" && b.create !== null ? b.create : {})).check;
      }
      if (typeof b.restore === "string") return service.restoreDryRun(String(b.project), b.restore, b);
      return service.dryRun(String(b.project), b);
    }),
  );

  fastify.post("/api/settings/projects", limit, async (request, reply) =>
    handle(reply, () => service.create(body<CreateProjectRequest>(request), by(request)), 201),
  );

  fastify.post("/api/settings/repo", { bodyLimit: 16 * 1024 }, async (request, reply) =>
    handle(reply, () => service.checkRepo(body<{ path: string }>(request).path)),
  );

  fastify.get<IdParams>("/api/settings/projects/:id/history", async (request, reply) =>
    handle(reply, () => ({ versions: service.versions(request.params.id) })),
  );

  fastify.get<VersionParams>("/api/settings/projects/:id/history/:version", async (request, reply) =>
    handle(reply, () => service.version(request.params.id, request.params.version)),
  );

  fastify.post<VersionParams>("/api/settings/projects/:id/history/:version/restore", limit, async (request, reply) =>
    handle(reply, () =>
      service.restore(request.params.id, request.params.version, body<SaveRequest>(request), by(request)),
    ),
  );
}
