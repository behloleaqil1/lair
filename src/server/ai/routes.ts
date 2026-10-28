/**
 * The AI tools API (docs/configuration.md, "AI tools, profiles and roles").
 * Every route is the owner's, reads included: they run the tools' own
 * commands on the project's machines and show where the tools are and who is
 * signed in. The prefix /api/ai is in OWNER_ONLY_PREFIXES, so no CORS is
 * granted either.
 *
 *   GET  /api/ai/tools?project=<name>                      every tool, per machine
 *   GET  /api/ai/models?tool=<id>&project=<name>&machine=<id>
 *   POST /api/ai/models/refresh  {tool, project?, machine?}  the list read again now
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectConfig } from "../../shared/types.js";
import { projectNameError } from "../config.js";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import { AiError, type AiToolsService } from "./tools.js";

export interface AiRoutesOptions {
  service: AiToolsService;
  auth: HumanAuth;
  defaultProject: () => string;
  /** A project's config, read now */
  config: (project: string) => ProjectConfig;
  /** For tests: where projects are (projectNameError's projectsDir) */
  projectsDir?: string;
}

const ok = <T>(data: T) => ({ success: true, data, timestamp: new Date().toISOString() });

function refuse(reply: FastifyReply, statusCode: number, error: string) {
  return reply.code(statusCode).send({ success: false, error, timestamp: new Date().toISOString() });
}

export async function registerAiRoutes(fastify: FastifyInstance, options: AiRoutesOptions): Promise<void> {
  await fastify.register((app) => aiRoutes(app, options));
}

async function aiRoutes(app: FastifyInstance, options: AiRoutesOptions): Promise<void> {
  const { service, auth } = options;
  app.addHook("onRequest", rejectCrossSiteRequests);
  // Before anything else, reads included: only the owner
  app.addHook("onRequest", auth.requireOwner());

  /** The named project (or the default one) and its config. */
  const projectOf = (name: unknown): { project: string; config: ProjectConfig } => {
    const project = name === undefined || name === "" ? options.defaultProject() : name;
    const problem = projectNameError(project, options.projectsDir);
    if (problem) throw new AiError(400, problem);
    try {
      return { project: project as string, config: options.config(project as string) };
    } catch (e) {
      throw new AiError(400, `The project's config can't be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  async function handle<T>(reply: FastifyReply, run: () => Promise<T>) {
    try {
      return reply.send(ok(await run()));
    } catch (e) {
      if (e instanceof AiError) return refuse(reply, e.statusCode, e.message);
      throw e;
    }
  }

  type Query = { Querystring: Record<string, string | undefined> };
  const body = (request: FastifyRequest): Record<string, unknown> => {
    const value = request.body;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  };

  app.get<Query>("/api/ai/tools", async (request, reply) =>
    handle(reply, async () => {
      const { project, config } = projectOf(request.query.project);
      return service.tools(project, config);
    }),
  );

  app.get<Query>("/api/ai/models", async (request, reply) =>
    handle(reply, async () => {
      const { config } = projectOf(request.query.project);
      return service.models(config, request.query.tool, request.query.machine);
    }),
  );

  app.post("/api/ai/models/refresh", { bodyLimit: 4096 }, async (request, reply) =>
    handle(reply, async () => {
      const input = body(request);
      const { config } = projectOf(input.project);
      return service.models(config, input.tool, input.machine, true);
    }),
  );
}
