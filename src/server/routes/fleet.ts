/**
 * Fleet management API routes for M3.
 * Add machines, manage self-healing, control budgets.
 *
 * Every change (machines added, removed, tested or installed; healing and
 * budget settings; provider budgets and unpausing) needs the owner's session
 * (src/server/human-auth/); the GETs stay open. The healer and the scheduler
 * use the managers inside the server, not these routes.
 */
import type { FastifyInstance } from "fastify";
import { getMachineManager } from "../fleet/machine-manager.js";
import { getHealer } from "../fleet/healer.js";
import { getBudgetManager } from "../fleet/budget.js";
import { getScheduler } from "../scheduler/scheduler.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type {
  AddMachineRequest,
  ProviderBudget,
  HealingConfig,
  BudgetConfig,
  FleetOverview,
} from "../../shared/fleet-types.js";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

function respond<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function respondError(error: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Register fleet management routes.
 */
export async function registerFleetRoutes(
  fastify: FastifyInstance,
  /** Every fleet change needs the owner's session */
  auth: HumanAuth,
): Promise<void> {
  // Encapsulated so the cross-site guard applies to these routes
  await fastify.register((app) => fleetRoutes(app, auth));
}

async function fleetRoutes(fastify: FastifyInstance, auth: HumanAuth): Promise<void> {
  // Refuse cross-site browser requests (CSRF, DNS rebinding)
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", auth.requireOwnerForChanges());

  // ============ OVERVIEW ============

  /**
   * Get fleet overview: machines, capacity, healing events, budget.
   */
  fastify.get("/api/fleet", async (): Promise<ApiResponse<FleetOverview>> => {
    try {
      const machineManager = getMachineManager();
      const healer = getHealer();
      const budgetManager = getBudgetManager();
      const scheduler = getScheduler();

      const machines = machineManager.listMachines();
      const state = scheduler.getState();

      return respond({
        machines,
        totalMachines: machines.length,
        onlineMachines: machines.filter((m) => m.status === "online").length,
        totalCapacity: state.totalCapacity,
        usedCapacity: state.usedCapacity,
        healingEvents: healer.getEvents(20),
        budget: budgetManager.getStatus(),
      });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ MACHINES ============

  /**
   * List all machines.
   */
  fastify.get("/api/fleet/machines", async (): Promise<ApiResponse<unknown>> => {
    try {
      const machineManager = getMachineManager();
      return respond(machineManager.listMachines());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Get a specific machine.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/fleet/machines/:id",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const machineManager = getMachineManager();
        const machine = machineManager.getMachine(request.params.id);

        if (!machine) {
          return respondError(`Machine not found: ${request.params.id}`);
        }

        // Include installation status if provisioning
        const installStatus = machineManager.getInstallationStatus(request.params.id);

        return respond({
          ...machine,
          installStatus,
        });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Add a new machine to the fleet.
   */
  fastify.post<{ Body: AddMachineRequest }>(
    "/api/fleet/machines",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const machineManager = getMachineManager();

        // Validate request
        if (!request.body.name) {
          return respondError("Missing required field: name");
        }
        if (!request.body.type) {
          return respondError("Missing required field: type");
        }
        if (request.body.type === "ssh" && !request.body.ssh) {
          return respondError("SSH config required for ssh type machines");
        }
        if (request.body.ssh && (!request.body.ssh.host || !request.body.ssh.user || !request.body.ssh.key)) {
          return respondError("SSH config requires: host, user, key");
        }

        const machine = await machineManager.addMachine(request.body);
        return respond(machine);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Remove a machine from the fleet.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/api/fleet/machines/:id",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const machineManager = getMachineManager();
        const removed = await machineManager.removeMachine(request.params.id);

        if (!removed) {
          return respondError(`Machine not found: ${request.params.id}`);
        }

        return respond({ removed: true });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Test SSH connectivity to a machine.
   */
  fastify.post<{ Params: { id: string } }>(
    "/api/fleet/machines/:id/test",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const machineManager = getMachineManager();
        const machine = machineManager.getMachine(request.params.id);

        if (!machine) {
          return respondError(`Machine not found: ${request.params.id}`);
        }

        if (machine.type !== "ssh" || !machine.ssh) {
          return respond({ reachable: true, message: "Local machine is always reachable" });
        }

        const reachable = await machineManager.checkSSHConnectivity(machine.ssh);
        return respond({
          reachable,
          message: reachable ? "SSH connection successful" : "Cannot connect via SSH",
        });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Install lair-node on a machine.
   */
  fastify.post<{ Params: { id: string } }>(
    "/api/fleet/machines/:id/install",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const machineManager = getMachineManager();
        const machine = machineManager.getMachine(request.params.id);

        if (!machine) {
          return respondError(`Machine not found: ${request.params.id}`);
        }

        if (machine.type !== "ssh") {
          return respondError("Can only install on SSH machines");
        }

        // Start installation in background
        machineManager.installNode(machine).catch((err) => {
          console.error(`[Fleet] Installation failed for ${machine.name}:`, err);
        });

        return respond({
          installing: true,
          message: "Installation started. Check GET /api/fleet/machines/:id for progress.",
        });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // ============ SELF-HEALING ============

  /**
   * Get self-healing status and events.
   */
  fastify.get("/api/fleet/healing", async (): Promise<ApiResponse<unknown>> => {
    try {
      const healer = getHealer();
      return respond({
        config: healer.getConfig(),
        events: healer.getEvents(50),
        unresolvedCount: healer.getUnresolvedEvents().length,
      });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Get healing events.
   */
  fastify.get<{ Querystring: { limit?: string; unresolved?: string } }>(
    "/api/fleet/healing/events",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const healer = getHealer();
        const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;

        if (request.query.unresolved === "true") {
          return respond(healer.getUnresolvedEvents());
        }

        return respond(healer.getEvents(limit));
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Update self-healing config.
   */
  fastify.patch<{ Body: Partial<HealingConfig> }>(
    "/api/fleet/healing/config",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const healer = getHealer();
        healer.updateConfig(request.body);
        return respond(healer.getConfig());
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // ============ BUDGETS ============

  /**
   * Get budget status.
   */
  fastify.get("/api/fleet/budget", async (): Promise<ApiResponse<unknown>> => {
    try {
      const budgetManager = getBudgetManager();
      return respond({
        config: budgetManager.getConfig(),
        status: budgetManager.getStatus(),
      });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  /**
   * Update budget config.
   */
  fastify.patch<{ Body: Partial<BudgetConfig> }>(
    "/api/fleet/budget/config",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const budgetManager = getBudgetManager();
        budgetManager.updateConfig(request.body);
        return respond(budgetManager.getConfig());
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Get provider budget status.
   */
  fastify.get<{ Params: { provider: string } }>(
    "/api/fleet/budget/providers/:provider",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const budgetManager = getBudgetManager();
        const status = budgetManager.getProviderStatus(request.params.provider);

        if (!status) {
          return respondError(`Provider not found: ${request.params.provider}`);
        }

        return respond(status);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Set provider budget.
   */
  fastify.put<{ Body: ProviderBudget }>(
    "/api/fleet/budget/providers",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const budgetManager = getBudgetManager();

        if (!request.body.provider || !request.body.maxCostPerPeriod || !request.body.period) {
          return respondError("Missing required fields: provider, maxCostPerPeriod, period");
        }

        budgetManager.setProviderBudget(request.body);
        return respond(budgetManager.getProviderStatus(request.body.provider));
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Remove provider budget.
   */
  fastify.delete<{ Params: { provider: string } }>(
    "/api/fleet/budget/providers/:provider",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const budgetManager = getBudgetManager();
        budgetManager.removeProviderBudget(request.params.provider);
        return respond({ removed: true });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  /**
   * Unpause a provider (manual override).
   */
  fastify.post<{ Params: { provider: string } }>(
    "/api/fleet/budget/providers/:provider/unpause",
    async (request): Promise<ApiResponse<unknown>> => {
      try {
        const budgetManager = getBudgetManager();
        const success = budgetManager.unpauseProvider(request.params.provider);

        if (!success) {
          return respondError(`Provider not found: ${request.params.provider}`);
        }

        return respond({ unpaused: true });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // There is deliberately no HTTP route for recording cost events: any caller
  // could use one to exhaust a budget and pause every provider. Costs are
  // recorded in-process through BudgetManager.recordCost().
}
