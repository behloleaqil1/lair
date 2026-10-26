/**
 * Control routes - Phase 2 command bar and buttons
 */
import type { FastifyInstance } from "fastify";
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, resolve } from "path";
import { loadProjectConfig } from "../config.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { knownDragonIds } from "../services/dragon-registry.js";
import { projectQueryGuard, type ProjectRouteConfig } from "./project-guard.js";
import { rejectCrossSiteRequests } from "../origin.js";
import { CommandService, getAuditLog } from "../services/command.js";
import { parseInboxFile, formatInboxEntry } from "../parsers/inbox.js";
import type {
  ApiResponse,
  ControlsStatus,
  InboxItem,
  ProjectConfig,
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

// Cache for command services
const commandServices = new Map<string, CommandService>();

function getCommandService(projectName: string): CommandService {
  if (!commandServices.has(projectName)) {
    const config = loadProjectConfig(projectName);
    commandServices.set(projectName, new CommandService(config));
  }
  return commandServices.get(projectName)!;
}

/**
 * Write prompt content to a file for dragon_start_cmd
 * Returns the path to the prompt file
 */
async function writePromptFile(
  config: ProjectConfig,
  dragonId: string,
  task: string,
  prompt: string,
  extraInstructions?: string,
): Promise<string> {
  // Build the prompt content (project instructions + extra instructions + main prompt)
  const parts: string[] = [];

  // Get dragon management config for default instructions
  const dmConfig = config as ProjectConfig & { default_instructions?: string };
  if (dmConfig.default_instructions) {
    parts.push(dmConfig.default_instructions.trim());
  }

  if (extraInstructions) {
    parts.push(extraInstructions.trim());
  }

  parts.push(prompt.trim());

  const content = parts.join("\n\n");

  const promptsDir = getPromptsDir(config);

  if (!existsSync(promptsDir)) {
    mkdirSync(promptsDir, { recursive: true });
  }

  // Generate filename: task-dragonId.txt. dragonId was already checked
  // against the configured dragons; sanitise both parts anyway so the file
  // can never land outside promptsDir.
  const safeTask = task.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeDragon = dragonId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const filename = `${safeTask}-${safeDragon}.txt`;
  const filepath = join(promptsDir, filename);

  writeFileSync(filepath, content, "utf-8");

  return filepath;
}

/** Default directory for prompt files, relative to the Lair working directory. */
export const DEFAULT_PROMPTS_DIR = join("data", "prompts");

/**
 * Directory where dashboard-started dragons get their prompt files.
 * Set `prompts_dir` in the project config to change it; a relative path
 * resolves against the Lair working directory, like the other path keys.
 */
export function getPromptsDir(config: ProjectConfig): string {
  return resolve(config.prompts_dir || DEFAULT_PROMPTS_DIR);
}

// The registry lives in services/dragon-registry.ts; re-exported for callers of this module
export { knownDragonIds };

/**
 * Check a dragon id from a request against the project's dragons (the YAML
 * `dragons:` map plus dragons.txt, see services/dragon-registry.ts).
 * Returns an error message, or null if the id is known.
 */
export function dragonIdError(config: ProjectConfig, dragonId: unknown): string | null {
  if (typeof dragonId !== "string" || dragonId.length === 0) {
    return "Missing dragonId";
  }
  if (!isValidDragonId(dragonId)) {
    return "Invalid dragonId";
  }
  if (!knownDragonIds(config).has(dragonId)) {
    return `Unknown dragon: ${dragonId}`;
  }
  return null;
}

export async function registerControlRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Encapsulated so the project guard applies only to these routes
  await fastify.register(controlRoutes);
}

async function controlRoutes(fastify: FastifyInstance): Promise<void> {
  // Every control route loads projects/<project>.yaml; validate the name first
  // Refuse cross-site browser requests (CSRF, DNS rebinding) before anything else
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", projectQueryGuard());

  // ============ CONTROLS STATUS ============

  fastify.get<{ Querystring: { project: string } }>(
    "/api/controls/status",
    async (request) => {
      try {
        const config = loadProjectConfig(request.query.project);
        const cmdService = getCommandService(request.query.project);

        // Check if orchestrator is paused (STOP file exists)
        let orchestratorPaused = false;
        if (config.pause_cmd && config.agents_dir) {
          // Try to detect STOP file from pause_cmd pattern
          const stopPath = config.pause_cmd.find((arg) => arg.includes("STOP"));
          if (stopPath) {
            orchestratorPaused = existsSync(stopPath);
          }
        }

        const status: ControlsStatus = {
          readOnly: cmdService.isReadOnly(),
          orchestratorPaused,
          tickRunning: false, // TODO: track this properly
        };

        return respond(status);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ ASK (read-only question) ============

  fastify.post<{ Body: { text: string }; Querystring: { project: string } }>(
    "/api/controls/ask",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.ask(request.body.text);
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ INBOX/OUTBOX ============

  fastify.get<{ Querystring: { project: string } }>(
    "/api/controls/inbox",
    async (request) => {
      try {
        const config = loadProjectConfig(request.query.project);

        if (!config.inbox_file || !config.outbox_file) {
          return respond<InboxItem[]>([]);
        }

        const inboxContent = existsSync(config.inbox_file)
          ? readFileSync(config.inbox_file, "utf-8")
          : "";
        const outboxContent = existsSync(config.outbox_file)
          ? readFileSync(config.outbox_file, "utf-8")
          : "";

        const items = parseInboxFile(inboxContent, outboxContent);
        return respond(items);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  fastify.post<{ Body: { text: string }; Querystring: { project: string } }>(
    "/api/controls/instruct",
    async (request) => {
      try {
        const config = loadProjectConfig(request.query.project);
        const cmdService = getCommandService(request.query.project);

        if (cmdService.isReadOnly()) {
          return respondError("Project is in read-only mode");
        }

        if (!config.inbox_file) {
          return respondError("inbox_file not configured");
        }

        const { line, id } = formatInboxEntry(request.body.text);
        appendFileSync(config.inbox_file, line + "\n");

        return respond({ id, line });
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ ORCHESTRATOR CONTROLS ============

  fastify.post<{ Querystring: { project: string } }>(
    "/api/controls/tick",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.tickNow();
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  fastify.post<{ Querystring: { project: string } }>(
    "/api/controls/pause",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.pause();
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  fastify.post<{ Querystring: { project: string } }>(
    "/api/controls/resume",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.resume();
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ AGENT CONTROLS ============

  fastify.post<{ Body: { task: string }; Querystring: { project: string } }>(
    "/api/controls/agent/run",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.agentRun(request.body.task);
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  fastify.post<{
    Body: { agentId: string };
    Querystring: { project: string };
  }>("/api/controls/agent/stop", async (request) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const result = await cmdService.agentStop(request.body.agentId);
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  fastify.post<{
    Body: { agentId: string };
    Querystring: { project: string };
  }>("/api/controls/agent/release", async (request) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const result = await cmdService.agentRelease(request.body.agentId);
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ GATE CONTROLS ============

  fastify.post<{
    Body: { track: string; lane?: string; priority?: number; scope?: string };
    Querystring: { project: string };
  }>("/api/controls/gate/submit", async (request) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const result = await cmdService.gateSubmit(request.body.track, {
        lane: request.body.lane,
        priority: request.body.priority,
        scope: request.body.scope,
      });
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  fastify.post<{ Body: { gateId: string }; Querystring: { project: string } }>(
    "/api/controls/gate/stuck",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const result = await cmdService.gateStuck(request.body.gateId);
        return respond(result);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ MERGE ============

  fastify.post<{
    Body: { prNumber: number; headSha: string };
    Querystring: { project: string };
  }>("/api/controls/merge", async (request) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const result = await cmdService.merge(
        request.body.prNumber,
        request.body.headSha,
      );
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // ============ AUDIT LOG ============

  fastify.get<{ Querystring: { project?: string; limit?: string } }>(
    "/api/controls/audit",
    // The audit log is global; a project is accepted (and validated) but not required
    { config: { projectOptional: true } satisfies ProjectRouteConfig },
    async (request) => {
      try {
        const limit = request.query.limit
          ? parseInt(request.query.limit, 10)
          : 50;
        const entries = getAuditLog(limit);
        return respond(entries);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ DRAGON START / STOP (Phase 4) ============

  // Get dragon management config (dragons list, available models, etc.)
  fastify.get<{ Querystring: { project: string } }>(
    "/api/controls/dragon/config",
    async (request) => {
      try {
        const cmdService = getCommandService(request.query.project);
        const config = cmdService.getDragonManagementConfig();
        return respond(config);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // Start a dragon
  fastify.post<{
    Body: {
      dragonId: string;
      task: string;
      prompt: string;
      model?: string;
      extraInstructions?: string;
    };
    Querystring: { project: string };
  }>("/api/controls/dragon/start", async (request, reply) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const config = loadProjectConfig(request.query.project);

      const { dragonId, task, prompt, model, extraInstructions } =
        request.body ?? ({} as Partial<typeof request.body>);

      // Validate the dragon before anything touches the filesystem
      const dragonError = dragonIdError(config, dragonId);
      if (dragonError) {
        reply.code(400);
        return respondError(dragonError);
      }
      if (typeof task !== "string" || typeof prompt !== "string") {
        reply.code(400);
        return respondError("task and prompt must be strings");
      }

      // Write prompt to a temp file (the dragon_start_cmd expects a file path)
      const promptFile = await writePromptFile(
        config,
        dragonId,
        task,
        prompt,
        extraInstructions,
      );

      const result = await cmdService.dragonStart(dragonId, task, promptFile, {
        model,
        extraInstructions,
      });
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });

  // Stop a dragon
  fastify.post<{
    Body: { dragonId: string };
    Querystring: { project: string };
  }>("/api/controls/dragon/stop", async (request, reply) => {
    try {
      const cmdService = getCommandService(request.query.project);
      const config = loadProjectConfig(request.query.project);
      const dragonId = request.body?.dragonId;
      const dragonError = dragonIdError(config, dragonId);
      if (dragonError) {
        reply.code(400);
        return respondError(dragonError);
      }
      const result = await cmdService.dragonStop(dragonId);
      return respond(result);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
