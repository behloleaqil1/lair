/**
 * Shared `?project=` validation for HTTP routes.
 *
 * The project name is joined into file paths (projects/<name>.yaml,
 * data/<name>.db), so it must be a safe name AND a project that exists.
 * Invalid or unknown names are rejected with HTTP 400 before any handler runs.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { projectNameError } from "../config.js";

export interface ProjectGuardOptions {
  /** Allow requests without a `project` parameter (it is still validated when present). */
  optional?: boolean;
}

/** Route config flag: set `config: { projectOptional: true }` on a route to allow a missing project. */
export interface ProjectRouteConfig {
  projectOptional?: boolean;
}

/**
 * Build an onRequest hook that validates `request.query.project`.
 */
export function projectQueryGuard(options: ProjectGuardOptions = {}) {
  return async function requireValidProject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const query = (request.query ?? {}) as { project?: unknown };
    const project = query.project;
    const routeConfig = request.routeOptions?.config as ProjectRouteConfig | undefined;
    const optional = options.optional === true || routeConfig?.projectOptional === true;

    if (project === undefined && optional) {
      return;
    }

    const error = projectNameError(project);
    if (error) {
      return reply.code(400).send({
        success: false,
        error,
        timestamp: new Date().toISOString(),
      });
    }
  };
}
