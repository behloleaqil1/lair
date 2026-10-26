/**
 * Settings routes - manage project configuration from UI
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadProjectConfig, getConfigPath } from "../config.js";
import { projectQueryGuard } from "./project-guard.js";
import { rejectCrossSiteRequests } from "../origin.js";
import { getBuiltInAdapters } from "../services/adapters.js";
import type {
  ApiResponse,
  ProjectConfig,
  DragonConfig,
  AIModel,
  MachineConfig,
} from "../../shared/types.js";

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

interface SettingsData {
  config: ProjectConfig;
  configPath: string;
  availableAdapters: ReturnType<typeof getBuiltInAdapters>;
}

interface SettingsUpdate {
  read_only?: boolean;
  dragons?: Record<string, Omit<DragonConfig, "id">>;
  available_models?: AIModel[];
  machines?: Record<string, MachineConfig>;
  default_instructions?: string;
}

export async function registerSettingsRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // Encapsulated so the project guard applies only to these routes
  await fastify.register(settingsRoutes);
}

async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  // Every settings route reads (or rewrites) projects/<project>.yaml
  // Refuse cross-site browser requests (CSRF, DNS rebinding) before anything else
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", projectQueryGuard());

  // GET /api/settings - Get current settings
  fastify.get<{ Querystring: { project: string } }>(
    "/api/settings",
    async (request) => {
      try {
        const projectName = request.query.project;
        const config = loadProjectConfig(projectName);
        const configPath = getConfigPath(projectName);
        const availableAdapters = getBuiltInAdapters();

        const data: SettingsData = {
          config,
          configPath,
          availableAdapters,
        };

        return respond(data);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // POST /api/settings - Update settings
  fastify.post<{ Body: SettingsUpdate; Querystring: { project: string } }>(
    "/api/settings",
    async (request) => {
      try {
        const projectName = request.query.project;
        const configPath = getConfigPath(projectName);
        const updates = request.body;

        if (!existsSync(configPath)) {
          return respondError(`Config file not found: ${configPath}`);
        }

        // Read current YAML
        const currentYaml = readFileSync(configPath, "utf-8");
        const currentConfig = parseYaml(currentYaml) as Record<string, unknown>;

        // Create backup
        const backupPath = `${configPath}.backup-${Date.now()}`;
        copyFileSync(configPath, backupPath);

        // Apply updates
        if (updates.read_only !== undefined) {
          currentConfig.read_only = updates.read_only;
        }

        if (updates.dragons !== undefined) {
          currentConfig.dragons = updates.dragons;
        }

        if (updates.available_models !== undefined) {
          currentConfig.available_models = updates.available_models;
        }

        if (updates.machines !== undefined) {
          // Merge machine updates (preserve fields not in the update)
          const existingMachines = (currentConfig.machines as Record<string, MachineConfig>) || {};
          for (const [id, update] of Object.entries(updates.machines)) {
            existingMachines[id] = {
              ...existingMachines[id],
              ...update,
            };
          }
          currentConfig.machines = existingMachines;
        }

        if (updates.default_instructions !== undefined) {
          currentConfig.default_instructions = updates.default_instructions;
        }

        // Write back
        const newYaml = stringifyYaml(currentConfig, {
          lineWidth: 120,
          singleQuote: true,
        });
        writeFileSync(configPath, newYaml, "utf-8");

        // Reload config to verify
        const newConfig = loadProjectConfig(projectName);

        return respond({
          success: true,
          config: newConfig,
          backupPath,
        });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    }
  );

  // POST /api/settings/test-machine - Test machine connection
  fastify.post<{
    Body: { machineId: string };
    Querystring: { project: string };
  }>("/api/settings/test-machine", async (request) => {
    try {
      const projectName = request.query.project;
      const { machineId } = request.body;
      const config = loadProjectConfig(projectName);

      const machine = config.machines?.[machineId];
      if (!machine) {
        return respondError(`Machine not found: ${machineId}`);
      }

      if (machine.type === "local") {
        return respond({
          machineId,
          up: true,
          message: "Local machine is always available",
        });
      }

      // Import health checker dynamically to avoid circular deps
      const { MachineHealthChecker } = await import("../machines/health.js");
      const checker = new MachineHealthChecker(0); // No caching for test
      const result = await checker.check(machineId, machine, true);

      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
