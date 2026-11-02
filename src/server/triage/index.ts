/**
 * Failure triage, bisect and revert (docs/design/autonomy.md §3).
 *
 * mountTriage() is what src/server/index.ts calls: it loads every project's
 * `triage:` block, takes the gates module's results from `gate.completed`
 * events, and registers the routes, with the owner credential guarding the
 * human-only ones. The server then connects the Decision Inbox
 * (useDecisions, through mountDecisions' producers). Off unless a project
 * sets `triage.enabled: true`.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { OwnerGuard } from "./adapters.js";
import { TriageManager, type ProjectEntry, type TriageManagerOptions } from "./manager.js";
import { parseIngestBody, registerTriageRoutes } from "./routes.js";

export { TriageManager } from "./manager.js";
export type { ProjectEntry, TriageManagerOptions, SignedResultSink } from "./manager.js";
export {
  TriageService,
  TriageConflictError,
  TriageForbiddenError,
  TriageInputError,
  TriageNotFoundError,
} from "./service.js";
export type { IngestContext, IngestInput, IngestOutcome, SignedInput, TriageProbes } from "./service.js";
export { registerTriageRoutes, parseIngestBody, OWNER_PREFIX } from "./routes.js";
export { parseTriageConfig, DEFAULT_INFRA_PATTERNS, DEFAULT_CONTEXT_PATTERNS } from "./config.js";
export type { TriageSettings } from "./config.js";
export { TriageStore } from "./store.js";
export { GitCli } from "./git.js";
export type { GitProbe, CommitInfo } from "./git.js";
export { BUILTIN_PARSERS, parseGateEvidence, parseGateEvidenceAsync } from "./parsers/index.js";
export type { EvidenceParser, AsyncEvidenceParser, ReportInput } from "./parsers/index.js";
export { isAsyncParser } from "./parsers/index.js";
export { NO_OWNER, InboxDecisions } from "./adapters.js";
export type {
  AgentRouter,
  CapacityProbe,
  DecisionRaiser,
  OwnerGuard,
  RecheckExecutor,
  RevertOpener,
  TaskSink,
  TriageAdapters,
} from "./adapters.js";

export interface MountTriageOptions extends TriageManagerOptions {
  projects: ProjectEntry[];
  defaultProject: () => string;
  /** The owner credential (HumanAuth); without it the owner-only routes refuse everyone */
  owner?: OwnerGuard;
}

/**
 * Create the manager, load the projects, take `gate.completed` events
 * ({project, result, reports?, context?}: trusted, they come from a server
 * module) and register the routes.
 */
export async function mountTriage(fastify: FastifyInstance, options: MountTriageOptions): Promise<TriageManager> {
  const manager = new TriageManager(options);
  manager.load(options.projects);
  if (options.events) subscribeGateResults(options.events, manager);
  await registerTriageRoutes(fastify, manager, options.defaultProject, options.owner);
  return manager;
}

function subscribeGateResults(events: EventBus, manager: TriageManager): void {
  events.on("gate.completed", (event) => {
    const project = typeof event.data.project === "string" ? event.data.project : null;
    if (!project || !manager.get(project)) return;
    const body = parseIngestBody(project, event.data);
    if (!body.ok) {
      console.warn(`[triage] ${project}: ignored a gate.completed event: ${body.error}`);
      return;
    }
    // Not awaited: the module that emitted it goes on; manager.idle() waits for it
    manager.track(
      manager.ingest(project, body.input).catch((e) => {
        console.warn(`[triage] ${project}: could not triage a gate.completed event: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
  });
}
