/**
 * CORS for the dashboard's dev server, never for owner-only routes.
 *
 * The owner session travels in a custom header, so a page on any other
 * origin needs a CORS preflight to send it. These options grant none for
 * the paths under `ownerOnly`: the preflight gets no Access-Control-Allow-*
 * headers and the browser never sends the request.
 */
import type { FastifyRequest } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";

/** Paths that take the owner session (src/server/index.ts passes these to corsOptionsWithout). */
export const OWNER_ONLY_PREFIXES: readonly string[] = ["/api/owner", "/api/decisions"];

export function isUnder(url: string, prefixes: readonly string[]): boolean {
  const path = url.split("?")[0];
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** @fastify/cors options: `origins` may call the API, except the paths under `ownerOnly`. */
export function corsOptionsWithout(origins: string[], ownerOnly: readonly string[] = OWNER_ONLY_PREFIXES): FastifyCorsOptions {
  return {
    delegator: (
      request: FastifyRequest,
      callback: (error: Error | null, corsOptions?: FastifyCorsOptions) => void,
    ) => {
      callback(null, { origin: isUnder(request.url, ownerOnly) ? false : origins });
    },
  };
}
