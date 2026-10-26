/**
 * Watchdog module - SLO monitoring and recovery playbooks (SPEC-autonomy §2)
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import { registerModule, type ModuleRegistration, type Detector, type Playbook, type ViewRegistration } from "../modules.js";
import { WatchdogService } from "./service.js";
import { registerWatchdogRoutes } from "./routes.js";
import { builtInPlaybooks } from "./playbooks.js";
import type { Store } from "../store/store.js";

// Export types
export * from "./types.js";
export { WatchdogService } from "./service.js";
export { WatchdogStore } from "./store.js";
export { builtInPlaybooks } from "./playbooks.js";
export { detectorRegistry, runDetector } from "./detectors.js";
export { PlaybookEngine, registerStepExecutor } from "./playbook-engine.js";

// Module-level service instance
let watchdogService: WatchdogService | null = null;

/**
 * Get the watchdog service instance
 */
export function getWatchdogService(): WatchdogService | null {
  return watchdogService;
}

/**
 * Create detectors for the module registry
 */
function createDetectors(): Detector[] {
  return [
    {
      id: "slo-monitor",
      name: "SLO Monitor",
      description: "Monitors all configured SLOs and triggers playbooks on breaches",
      enabledByDefault: true,
      start: (eventBus: EventBus) => {
        // The actual monitoring is done by the WatchdogService
        // This detector just ensures the service is started
        if (watchdogService) {
          watchdogService.start(60000); // Check every minute
        }
        return () => {
          if (watchdogService) {
            watchdogService.stop();
          }
        };
      },
    },
  ];
}

/**
 * Create playbook registrations for the module registry
 */
function createPlaybookRegistrations(): Playbook[] {
  return builtInPlaybooks.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    forPatterns: p.forSLOTypes,
    requiresApproval: p.requiresApproval,
    maxAttempts: p.maxAttempts,
    cooldownSeconds: p.cooldownSeconds,
  }));
}

/**
 * Watchdog module registration
 */
const watchdogModule: ModuleRegistration = {
  id: "watchdog",
  name: "Progress Watchdog",
  description: "SLO monitoring and recovery playbooks (SPEC-autonomy §2)",
  dependencies: [],

  emitsEvents: [
    "slo.breached",
    "slo.recovered",
    "playbook.started",
    "playbook.step.completed",
    "playbook.succeeded",
    "playbook.failed",
    "escalation.created",
    "agent.restart.requested",
    "job.requeue.requested",
    "job.move.requested",
    "task.start.requested",
    "node.gc.requested",
    "node.runtime.restart.requested",
    "notification.sent",
  ],

  subscribesToEvents: [
    "node.heartbeat",
    "task.completed",
    "job.completed",
    "decision.answered",
  ],

  detectors: createDetectors(),
  playbooks: createPlaybookRegistrations(),

  views: [
    {
      id: "health",
      name: "Health",
      icon: "Activity",
      order: 5,
      showByDefault: true,
    },
  ],

  registerRoutes: async (app: FastifyInstance) => {
    // Routes are registered when the service is initialized
    // This is called before initialize()
  },

  initialize: async (eventBus: EventBus) => {
    // The service needs the Store and DB, which we'll get from context
    // For now, we'll create a placeholder and initialize it properly
    // when the server passes us the actual dependencies
    console.log("[Watchdog] Module initialized, waiting for service setup");
  },

  cleanup: async () => {
    if (watchdogService) {
      watchdogService.stop();
      watchdogService = null;
    }
  },
};

/**
 * Initialize the watchdog service with dependencies
 * Called by the server after module registration
 */
export function initializeWatchdogService(
  app: FastifyInstance,
  eventBus: EventBus,
  store: Store,
  db: any
): WatchdogService {
  watchdogService = new WatchdogService(eventBus, store, db);
  watchdogService.initialize();
  registerWatchdogRoutes(app, watchdogService);
  return watchdogService;
}

/**
 * Register the watchdog module
 */
export function register(): void {
  registerModule(watchdogModule);
}

// Auto-register when imported
register();
