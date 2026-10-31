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

/**
 * Paths that take the owner session: no CORS is ever granted under them.
 *
 * A module that registers a route with `requireOwner()` adds its prefix
 * here, in this list, at build time. src/server/index.ts passes the list to
 * corsOptionsWithout() once, when it registers @fastify/cors, so a prefix
 * added at runtime would not take effect; there is deliberately no helper
 * to add one. Prefer a module's whole prefix (e.g. /api/review) over single
 * routes, so a new owner-only route under it can't be forgotten here.
 *
 * route-ownership.test.ts fails for any registered route that is neither
 * under a prefix here nor on its short public list (with a reason each).
 */
export const OWNER_ONLY_PREFIXES: readonly string[] = [
  "/api/owner",
  "/api/decisions",
  "/api/review",
  "/api/agents",
  "/api/triage/owner",
  // Every planner route needs the owner: its reads show plan text and paths on this machine
  "/api/planner",
  // The dashboard's own reads: its log tails and test output are the owner's
  "/api/dashboard",
  // AI tools: every route, reads included, runs the tools' own commands and shows who is signed in
  "/api/ai",
  // The infrastructure policy scan: every route is the owner's (a scan answer names files, lines and addresses)
  "/api/infra-policy",
  // The plan sandbox: a plan shows resource names and the cloud's answers (every route the owner's)
  "/api/plan-sandbox",
  // The OpenTofu runner: plan answers name resources, and apply changes the cloud (every route the owner's)
  "/api/tofu-runner",
  // Cloud machines: the status names the account's instances and spend, and the trip is cleared here (every route the owner's)
  "/api/cloud",
  // The supervisor: Lair's diagnostics, and the ops tokens and their audit (every route the owner's)
  "/api/health/diagnostics",
  "/api/supervisor",
  // The ops API takes an ops token, not the owner session; no browser page may call it either
  "/api/ops",
  // Modules whose writes need the owner (requireOwnerForChanges); their reads stay open but get no CORS either
  "/api/delivery",
  "/api/controls",
  "/api/processes",
  "/api/settings",
  "/api/scheduler",
  "/api/tasks",
  "/api/fleet",
  "/api/pipelines",
  // Only the owner's message route of the bus: its board and event stream keep their CORS
  "/api/bus/send",
  // The bus's agent API takes a run's bus token, not the owner session; no browser page may call it either
  "/api/bus/call",
  // Checks: POST takes a bus token, GET /:id takes a token or owner, list and stats are owner-only
  "/api/checks",
];

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
