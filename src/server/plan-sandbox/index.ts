/**
 * Plan sandbox: `tofu plan` in an isolated runner with the read-only plan role
 * (docs/design/deploy-aws.md §2.2). Off unless a project sets
 * `plan_sandbox.enabled: true`.
 */
export { parsePlanSandboxConfig, PLAN_ROLE_SECONDS } from "./config.js";
export type { PlanSandboxSettings } from "./config.js";
export { BlockedPlanSandbox, PlanSandbox, PlanSandboxManager, sandboxEnv } from "./service.js";
export type { PlanOutcome, PlanSandboxDeps } from "./service.js";
export { AwsCliIssuer, DockerSpawner, dockerArgs } from "./spawners.js";
export type { PlanCredentialIssuer, PlanCredentials, SandboxResult, SandboxSpawner, SandboxSpec } from "./types.js";
export { registerPlanSandboxRoutes } from "./routes.js";
