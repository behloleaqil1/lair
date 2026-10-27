/**
 * The planner (docs/design/planner.md): Lair keeps agents.fill's tasks file
 * itself, from the project's plans, backlog, owner messages and queue lines,
 * with a supervised planner agent for the judgment calls. Off unless a
 * project sets `planner.enabled: true`.
 *
 * mountPlanner() is what src/server/index.ts calls: it loads every project's
 * `planner:` block and registers the routes, with the owner credential
 * guarding all but the text-free status. The server then connects the
 * Decision Inbox (useDecisions) and starts it.
 */
import type { FastifyInstance } from "fastify";
import type { HumanAuth } from "../human-auth/index.js";
import { PlannerManager, type PlannerManagerOptions, type ProjectEntry } from "./manager.js";
import { registerPlannerRoutes } from "./routes.js";

export { PlannerManager } from "./manager.js";
export type { PlannerManagerOptions, ProjectEntry } from "./manager.js";
export { PlannerService, PlannerError, DECISION_MODULE } from "./service.js";
export { plannerAgentsFrom } from "./agents.js";
export type { PlannerAgents } from "./agents.js";
export { parsePlannerConfig } from "./config.js";
export type { PlannerSettings } from "./config.js";
export { PlannerStore } from "./store.js";
export { registerPlannerRoutes } from "./routes.js";

export interface MountPlannerOptions extends PlannerManagerOptions {
  projects: ProjectEntry[];
  defaultProject: () => string;
  humanAuth: HumanAuth;
}

export async function mountPlanner(fastify: FastifyInstance, options: MountPlannerOptions): Promise<PlannerManager> {
  const manager = new PlannerManager(options);
  manager.load(options.projects);
  await registerPlannerRoutes(fastify, manager, options.defaultProject, options.humanAuth);
  return manager;
}
