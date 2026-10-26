/**
 * Failure triage, bisect and revert (docs/design/autonomy.md §3).
 *
 * mountTriage() is what src/server/index.ts calls: it loads every project's
 * `triage:` block, listens for `gate.completed` events and registers the
 * routes. Off unless a project sets `triage.enabled: true`.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import { TriageManager, type ProjectEntry, type TriageManagerOptions } from "./manager.js";
import { parseIngestBody, registerTriageRoutes } from "./routes.js";

export { TriageManager } from "./manager.js";
export type { ProjectEntry, TriageManagerOptions } from "./manager.js";
export { TriageService, TriageConflictError, TriageInputError, TriageNotFoundError } from "./service.js";
export type { IngestContext, IngestInput, IngestOutcome, TriageProbes } from "./service.js";
export { registerTriageRoutes, parseIngestBody } from "./routes.js";
export { parseTriageConfig, DEFAULT_INFRA_PATTERNS, DEFAULT_CONTEXT_PATTERNS } from "./config.js";
export type { TriageSettings } from "./config.js";
export { TriageStore } from "./store.js";
export { GitCli } from "./git.js";
export type { GitProbe, CommitInfo } from "./git.js";
export { BUILTIN_PARSERS, parseGateEvidence } from "./parsers/index.js";
export type { EvidenceParser, ReportInput } from "./parsers/index.js";
export type {
  AgentRouter,
  CapacityProbe,
  DecisionRaiser,
  RecheckExecutor,
  RevertOpener,
  TaskSink,
  TriageAdapters,
} from "./adapters.js";

export interface MountTriageOptions extends TriageManagerOptions {
  projects: ProjectEntry[];
  defaultProject: () => string;
}

/**
 * Create the manager, load the projects, ingest `gate.completed` events
 * ({project, result, reports?, context?}, the body of POST
 * /api/triage/results plus the project) and register the routes.
 */
export async function mountTriage(fastify: FastifyInstance, options: MountTriageOptions): Promise<TriageManager> {
  const manager = new TriageManager(options);
  manager.load(options.projects);
  if (options.events) subscribeGateResults(options.events, manager);
  await registerTriageRoutes(fastify, manager, options.defaultProject);
  return manager;
}

function subscribeGateResults(events: EventBus, manager: TriageManager): void {
  events.on("gate.completed", async (event) => {
    const project = typeof event.data.project === "string" ? event.data.project : null;
    if (!project || !manager.get(project)) return;
    const body = parseIngestBody(project, event.data);
    if (!body.ok) {
      console.warn(`[triage] ${project}: ignored a gate.completed event: ${body.error}`);
      return;
    }
    try {
      await manager.ingest(project, body.input);
    } catch (e) {
      console.warn(`[triage] ${project}: could not triage a gate.completed event:`, e);
    }
  });
}
