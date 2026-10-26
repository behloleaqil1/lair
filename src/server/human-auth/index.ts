/**
 * The owner's credential, shared by every route only the human may use
 * (the Decision Inbox's answers today). See human-auth.ts for the model:
 *
 *   const auth = HumanAuth.open({ tokenPath, dbPath });
 *   await registerOwnerRoutes(fastify, auth);           // sign in, list, revoke
 *   app.post("/api/...", { onRequest: auth.requireOwner() }, handler);
 *
 * and add the route's prefix to OWNER_ONLY_PREFIXES so no CORS is granted.
 */
export {
  HumanAuth,
  OWNER_SESSION_HEADER,
  dashboardRequestProblem,
  dashboardUrlFor,
} from "./human-auth.js";
export type { HumanAuthOptions, OwnerCheck, OwnerSession, RequestCheckOptions } from "./human-auth.js";
export { registerOwnerRoutes } from "./routes.js";
export { OWNER_ONLY_PREFIXES, corsOptionsWithout, isUnder } from "./cors.js";
