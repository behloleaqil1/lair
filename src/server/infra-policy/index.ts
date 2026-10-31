/**
 * Infrastructure policy scan: a static check of infrastructure code before
 * any plan (docs/design/deploy-aws.md §2.1). Off unless a project sets
 * `infra_policy.enabled: true`.
 */
export { parseInfraPolicyConfig } from "./config.js";
export type { InfraPolicySettings } from "./config.js";
export { scanRoot, agentMessage, normalizeProviderSource } from "./scan.js";
export type { Rule, ScanOptions, ScanResult, Violation } from "./scan.js";
export { BlockedInfraPolicy, InfraPolicy, InfraPolicyManager } from "./service.js";
export type { GuardResult, PolicyGate } from "./service.js";
export { registerInfraPolicyRoutes } from "./routes.js";
