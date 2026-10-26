/**
 * Watchdog API routes
 */
import type { FastifyInstance } from "fastify";
import type { WatchdogService } from "./service.js";

/**
 * Register watchdog routes
 */
export function registerWatchdogRoutes(
  app: FastifyInstance,
  watchdog: WatchdogService
): void {
  // GET /api/health - Health summary
  app.get("/api/health", async () => {
    return watchdog.getHealthSummary();
  });

  // GET /api/slos - List all SLO definitions
  app.get("/api/slos", async () => {
    return watchdog.getSLODefinitions();
  });

  // GET /api/slos/:id - Get specific SLO
  app.get<{ Params: { id: string } }>("/api/slos/:id", async (req) => {
    const definition = watchdog.getSLODefinitions().find(s => s.id === req.params.id);
    if (!definition) {
      throw { statusCode: 404, message: "SLO not found" };
    }
    const state = watchdog.getSLOState(req.params.id);
    const breaches = watchdog.getBreachHistory(req.params.id);
    return { definition, state, breaches };
  });

  // PUT /api/slos/:id - Update SLO definition
  app.put<{ Params: { id: string }; Body: { enabled?: boolean; threshold?: number } }>(
    "/api/slos/:id",
    async (req) => {
      const existing = watchdog.getSLODefinitions().find(s => s.id === req.params.id);
      if (!existing) {
        throw { statusCode: 404, message: "SLO not found" };
      }
      const updated = {
        ...existing,
        enabled: req.body.enabled ?? existing.enabled,
        threshold: req.body.threshold ?? existing.threshold,
      };
      watchdog.updateSLODefinition(updated);
      return updated;
    }
  );

  // GET /api/slo-states - Get all SLO states
  app.get("/api/slo-states", async () => {
    return watchdog.getAllSLOStates();
  });

  // GET /api/playbook-runs/:id - Get playbook run details
  app.get<{ Params: { id: string } }>("/api/playbook-runs/:id", async (req) => {
    const run = watchdog.getPlaybookRun(req.params.id);
    if (!run) {
      throw { statusCode: 404, message: "Playbook run not found" };
    }
    return run;
  });
}
