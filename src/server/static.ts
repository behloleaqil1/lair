/**
 * Serve the built web UI (Vite output) from the API server.
 *
 * In production (`npm run build && npm start`) the client is built into
 * dist/client and served from the same origin as the API, on port 4777.
 * In development the directory has no index.html, nothing is registered,
 * and the UI is served by the Vite dev server on port 5173 instead.
 */
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Default location of the built client: dist/client, next to dist/server.
 * LAIR_CLIENT_DIR overrides it.
 */
export function resolveClientDir(): string {
  if (process.env.LAIR_CLIENT_DIR) {
    return resolve(process.env.LAIR_CLIENT_DIR);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "client");
}

/** True for paths owned by the API or the WebSocket endpoints. */
export function isBackendPath(url: string): boolean {
  const path = url.split("?")[0];
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/ws" ||
    path.startsWith("/ws/")
  );
}

/**
 * Register static serving of the built client with an SPA fallback:
 * any GET/HEAD request that is not an API or WebSocket path and does not
 * match a file gets index.html, so client-side routes survive a reload.
 *
 * Returns false (and registers nothing) when the build is missing.
 */
export async function registerClientStatic(
  fastify: FastifyInstance,
  clientDir: string,
): Promise<boolean> {
  if (!existsSync(join(clientDir, "index.html"))) {
    return false;
  }

  await fastify.register(fastifyStatic, {
    root: clientDir,
    prefix: "/",
  });

  fastify.setNotFoundHandler((request, reply) => {
    const method = request.method;
    if ((method === "GET" || method === "HEAD") && !isBackendPath(request.url)) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({
      success: false,
      error: `Route ${method} ${request.url.split("?")[0]} not found`,
      timestamp: new Date().toISOString(),
    });
  });

  return true;
}
