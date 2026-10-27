/**
 * GET /api/config/status: the project files whose latest version is not
 * what runs (the dashboard's banner) and the latest reloads. Read-only.
 */
import type { FastifyInstance } from "fastify";
import type { ConfigReloader } from "./reloader.js";

export async function registerReloadRoutes(fastify: FastifyInstance, reloader: ConfigReloader): Promise<void> {
  fastify.get("/api/config/status", async () => ({
    success: true,
    data: reloader.status(),
    timestamp: new Date().toISOString(),
  }));
}
