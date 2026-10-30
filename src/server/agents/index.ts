/**
 * Agents: budgets, failover and session recovery (docs/design/autonomy.md
 * §6). Started and stopped by src/server/index.ts; off unless a project sets
 * `agents.enabled: true`.
 */
export { AgentsManager, AgentsService, AgentsError } from "./service.js";
export type { AgentRuns, AgentsManagerOptions, AgentsServiceOptions, RunRequest } from "./service.js";
export { registerAgentsRoutes } from "./routes.js";
export { parseAgentsConfig } from "./config.js";
export type { AgentsSettings } from "./config.js";
export { AgentsStore } from "./store.js";
export { InboxFileDecisions } from "./decisions.js";
export type { DecisionInbox, DecisionRequest, DecisionKind, DecisionOption } from "./decisions.js";
export type { FleetBudget } from "./budgets.js";
export { systemAgentProbes, systemAgentProbesWithCache, ChildProcessSpawner, ProcessSnapshot, agentEnvironment, BASE_ENV, NodeSystemInfo } from "./probes.js";
export type { AgentProbes, ProcessSpawner, ProcessOwner, SpawnOptions, SystemInfo } from "./probes.js";
export { reconcileActiveRuns, signalActiveRuns, commandFingerprint } from "./reconcile.js";
export type { ReconcileResult, ReconcileOutcome } from "./reconcile.js";
