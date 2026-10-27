/**
 * The dashboard's own read routes (routes.ts): the nav's module flags, a
 * gate's detail, and the owner-only log tails and test output.
 */
export { registerDashboardRoutes, LOOKUP_LIMIT, type DashboardSources } from "./routes.js";
export { moduleFlags, NO_MODULES } from "./modules.js";
