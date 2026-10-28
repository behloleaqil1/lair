/**
 * AI profiles, roles and tools (docs/design/ai-roles.md, part A6-1):
 * - profiles.ts: profiles and roles as the other modules read them (the
 *   dragon registry, the agents module's failover, the review pools);
 * - config.ts: the `ai:` block's schema and its validation at load;
 * - tools.ts: each tool's installed state, version, sign-in state and models
 *   per machine; the agents module asks it before each start;
 * - routes.ts: the owner's API. src/server/index.ts wires it:
 *
 *   const aiTools = new AiToolsService();
 *   const agents = new AgentsManager({ ..., tools: aiTools });
 *   await registerAiRoutes(fastify, { service: aiTools, auth: humanAuth, defaultProject, config });
 */
export { AiSchema, validateAiConfig, commandArgvProblem } from "./config.js";
export {
  ROLE_PATHS,
  aiProfiles,
  agentRole,
  dragonAi,
  resolvePool,
  roleAgents,
  roleFallbacks,
  roleIsSet,
  roleProfiles,
} from "./profiles.js";
export type { AiProfile, RolePath } from "./profiles.js";
export { parseKiroModels, parseLineModels, parseModels } from "./parsers.js";
export { AiError, AiToolsService, LOCAL_MACHINE, SIGNED_OUT_PATTERN, findOnPath, signInFrom } from "./tools.js";
export type { AiToolsOptions } from "./tools.js";
export { SpawnToolRunner } from "./runner.js";
export type { ToolRunner, ToolRunOptions, ToolRunOutput } from "./runner.js";
export { registerAiRoutes } from "./routes.js";
export type { AiRoutesOptions } from "./routes.js";
export type { SignInRefusal, ToolReadiness } from "./types.js";
