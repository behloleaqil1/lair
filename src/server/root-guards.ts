/**
 * Request guards registered on the root Fastify instance (src/server/index.ts).
 *
 * The route modules in routes/ register the same checks inside their own
 * encapsulated plugins; these root hooks cover the read-only routes defined
 * directly in index.ts and the static UI.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectCrossSiteRequests } from "./origin.js";
import { projectQueryGuard } from "./routes/project-guard.js";
import { isBackendPath } from "./static.js";

/**
 * Add the root hooks:
 * - refuse cross-site browser requests and foreign Host headers (403), for
 *   every route including the static UI;
 * - validate `?project=` on API routes (400 for an unsafe or unknown name; a
 *   missing project is allowed and means the default project). Non-API paths
 *   (the UI and its client-side routes) are not checked.
 */
export function registerRootGuards(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", rejectCrossSiteRequests);

  const guardProject = projectQueryGuard({ optional: true });
  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isBackendPath(request.url)) {
        return;
      }
      return guardProject(request, reply);
    },
  );
}

/**
 * Route preHandler: refuse a `:id` path parameter that fails `isValid` with 400.
 */
export function requireValidIdParam(
  isValid: (id: string) => boolean,
  what: string,
) {
  return async function rejectInvalidId(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isValid(id)) {
      return reply.code(400).send({
        success: false,
        error: `Invalid ${what} id`,
        timestamp: new Date().toISOString(),
      });
    }
  };
}
