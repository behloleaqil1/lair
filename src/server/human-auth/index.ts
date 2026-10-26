/**
 * The owner's credential, shared by every route only the human may use
 * (Decision Inbox answers; review merges, human reviews, finding resolutions
 * and hold releases). See human-auth.ts for the model:
 *
 *   const auth = HumanAuth.open({ tokenPath, dbPath });
 *   await registerOwnerRoutes(fastify, auth);           // sign in, list, revoke
 *   app.post("/api/...", { onRequest: auth.requireOwner() }, handler);
 *
 * and add the route's prefix to OWNER_ONLY_PREFIXES so no CORS is granted.
 *
 * requireDashboard() only says a request looks like the dashboard's own (an
 * Origin and Sec-Fetch-Site a browser sets); it proves nothing about who
 * sent it, and on a GET or HEAD, where a same-origin browser sends no
 * Origin, it rests on Sec-Fetch-Site alone, which any non-browser client can
 * set. Use requireOwner() for anything sensitive.
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
