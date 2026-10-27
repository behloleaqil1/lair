/**
 * The machine test of the Settings view (owner only). Reading and saving a
 * project's settings moved to src/server/settings/ (the Settings API, every
 * route the owner's, reads included); the old open GET /api/settings and its
 * unvalidated POST rewrite are gone.
 */
import type { FastifyInstance } from "fastify";
import { loadProjectConfig } from "../config.js";
import { projectQueryGuard } from "./project-guard.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { ApiResponse } from "../../shared/types.js";

function respond<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function respondError(error: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
}

export async function registerSettingsRoutes(
  fastify: FastifyInstance,
  /** Testing a machine needs the owner's session */
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the project guard applies only to these routes
  await fastify.register((app) => settingsRoutes(app, auth));
}

async function settingsRoutes(fastify: FastifyInstance, auth: HumanAuth): Promise<void> {
  // Refuse cross-site browser requests (CSRF, DNS rebinding) before anything else
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", projectQueryGuard());
  fastify.addHook("onRequest", auth.requireOwnerForChanges());

  // POST /api/settings/test-machine - Test machine connection
  fastify.post<{
    Body: { machineId: string };
    Querystring: { project: string };
  }>("/api/settings/test-machine", async (request) => {
    try {
      const projectName = request.query.project;
      const { machineId } = request.body;
      const config = loadProjectConfig(projectName);

      const machine = config.machines?.[machineId];
      if (!machine) {
        return respondError(`Machine not found: ${machineId}`);
      }

      if (machine.type === "local") {
        return respond({
          machineId,
          up: true,
          message: "Local machine is always available",
        });
      }

      // Import health checker dynamically to avoid circular deps
      const { MachineHealthChecker } = await import("../machines/health.js");
      const checker = new MachineHealthChecker(0); // No caching for test
      const result = await checker.check(machineId, machine, true);

      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
