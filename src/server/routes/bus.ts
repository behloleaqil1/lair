/**
 * Bus routes - Phase 3 fleet bus API
 *
 * The bus store is server-owned (better-sqlite3 in WAL mode). Agents talk to
 * the bus through POST /api/bus/call with their per-run bus token, which the
 * agents module mints and puts in LAIR_BUS_TOKEN.
 *
 * Routes:
 * - POST /api/bus/call: Agent API (requires bus token in Authorization header)
 * - GET  /api/bus/board: Board state for the UI (open)
 * - GET  /api/bus/events: SSE feed for the UI (open)
 * - POST /api/bus/send: Owner sends a message (requires owner session)
 * - GET  /api/bus/messages/:agentId: Message list for the UI (open)
 *
 * Claims have ONE source of truth: the agents module's claims. The bus does
 * not keep its own claim table.
 */
import type { FastifyInstance } from "fastify";
import { projectQueryGuard } from "./project-guard.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { AgentsManager } from "../agents/index.js";
import type { EventBus } from "../core/event-bus.js";
import {
  BusService,
  BusStore,
  getBusStore,
  hashBusToken,
  isBusTokenFormat,
  redactBusToken,
  type BusConsumeMode,
  type BusConsumerHealth,
  type BusMirrorConfig,
  type BusServiceOptions,
} from "../bus/index.js";
import type { ApiResponse, BoardOutput, TaskStatus } from "../../shared/types.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { ReportKind } from "../../bus/types.js";
import type { AgentRun } from "../agents/types.js";
import { isPlainName } from "../agents/config.js";
import { z } from "zod";

function respond<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function respondError(error: string, statusCode = 400): ApiResponse<never> & { statusCode: number } {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
    statusCode,
  };
}

// ============ Token extraction ============

function extractToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

// ============ Tool schemas ============

const ReportKindSchema = z.enum(["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"]);

/** A commit id: 7 to 64 hex digits (the consumers refuse a report whose sha isn't hex) */
const SHA = /^[0-9a-f]{7,64}$/i;

const toolSchemas = {
  whoami: z.object({}),
  // A report the consumers would refuse is refused here (400), never stored or mirrored: its wake-up would be lost
  report: z.object({
    kind: ReportKindSchema,
    task: z.string().min(1).max(200),
    summary: z.string().min(1).max(10000),
    // What a WAITING run waits on, as fill looks it up: one plain name (no '/', no '..', no leading '-')
    gate_id: z
      .string()
      .max(200)
      .refine(isPlainName, "a plain name: letters, digits, '.', '_' and '-', starting with a letter or digit, no '..'")
      .optional(),
    pr: z.number().int().positive().optional(),
    sha: z.string().regex(SHA, "a commit id: 7 to 64 hex digits").optional(),
  }),
  inbox: z.object({}),
  ack: z.object({
    message_id: z.string().min(1).max(20),
    note: z.string().max(1000).optional(),
  }),
  send: z.object({
    to: z.enum(["orchestrator", "owner"]),
    text: z.string().min(1).max(10000),
    priority: z.number().int().min(1).max(10).optional(),
  }),
  board: z.object({}),
} as const;

type ToolName = keyof typeof toolSchemas;

/** POST /api/bus/call: a tool call with the run's bus token; the project is the token's when not named */
interface CallRoute {
  Body: { tool: string; args: Record<string, unknown> };
  Querystring: { project?: string };
}

// ============ Service management ============

const busServices = new Map<string, { service: BusService; store: BusStore }>();

export interface BusRoutesOptions {
  /** The agents module (for claims and run validation) */
  agents: AgentsManager;
  /** Server event bus */
  events?: EventBus;
  /** Data directory for bus databases */
  dataDir: string;
  /** Get project config (returns ProjectConfig plus optional bus fields) */
  getConfig: (project: string) => ProjectConfig & {
    /** Directory for per-agent mailbox files (optional bus feature) */
    mail_dir?: string;
    /** File to touch when dragons should wake (optional bus feature) */
    wake_file?: string;
  };
  /**
   * The project's bus.consume (src/server/bus/consumers.ts). While it is off
   * every bus route but /api/bus/consumers answers 404 for the project, as
   * without the bus, and no run of it has a bus token.
   */
  mode: (project: string) => BusConsumeMode;
  /** The projects whose bus.consume isn't off (a token is looked up in their stores) */
  enabled: () => string[];
  /** The bus consumers' state for Home → Health */
  health: (project: string) => BusConsumerHealth;
}

/**
 * A project's bus store (<dataDir>/bus/<project>.db): the routes, the consumers, the token minting and the
 * checks (src/server/checks/) all read this one.
 */
export function busStoreFor(project: string, dataDir: string): BusStore {
  return getBusStore(project, dataDir);
}

/** Drop a project's bus service (its config changed): the next request builds it from the new config. */
export function forgetBusService(project: string): void {
  busServices.delete(project);
}

/**
 * A run of the project by its id, looked up in the agents store (however many runs came after it), or null: none
 * with that id, another project's, or the project's agents module is off (it has no runs).
 */
function projectRun(options: BusRoutesOptions, project: string, runId: string): AgentRun | null {
  if (!options.agents.get(project)) return null;
  const run = options.agents.getStore()?.getRun(runId) ?? null;
  return run !== null && run.project === project ? run : null;
}

function getBusService(
  project: string,
  options: BusRoutesOptions,
): { service: BusService; store: BusStore } {
  let entry = busServices.get(project);
  if (!entry) {
    const store = busStoreFor(project, options.dataDir);
    const config = options.getConfig(project);

    // Mirror config from project settings
    const mirrorConfig: BusMirrorConfig = {
      queueFile: config.queue_file,
      mailDir: config.mail_dir,
      inboxFile: config.inbox_file,
    };

    const serviceOptions: BusServiceOptions = {
      store,
      // The run's task (whichever run it is: never only among the latest runs)
      getClaimedTask: (runId: string) => projectRun(options, project, runId)?.task ?? null,
      getAllClaims: () => {
        const agentService = options.agents.get(project);
        if (!agentService) return [];
        // Get claims from the agents store
        const agentsStore = options.agents.getStore();
        if (!agentsStore) return [];
        return agentsStore.listClaims(project).map((c) => ({ task: c.task, agent: c.agent }));
      },
      getKnownAgents: () => {
        const agentService = options.agents.get(project);
        if (!agentService) return [];
        const agentsStore = options.agents.getStore();
        if (!agentsStore) return [];
        return agentsStore.runAgents(project);
      },
      mirrorConfig,
      events: options.events,
      wakeFile: config.wake_file,
    };

    const service = new BusService(serviceOptions);
    entry = { service, store };
    busServices.set(project, entry);
  }
  return entry;
}

// ============ Routes ============

export async function registerBusRoutes(
  fastify: FastifyInstance,
  /** Messages sent as the owner need the owner's session */
  auth: HumanAuth,
  /** Bus routes options */
  options?: BusRoutesOptions,
): Promise<void> {
  // If no options provided, skip registration (backwards compatibility during transition)
  if (!options) {
    console.warn("[bus] registerBusRoutes called without options; bus routes disabled");
    return;
  }

  // Encapsulated so the project guard applies only to these routes
  await fastify.register((app) => busRoutes(app, auth, options));
}

async function busRoutes(
  fastify: FastifyInstance,
  auth: HumanAuth,
  options: BusRoutesOptions,
): Promise<void> {
  // Refuse cross-site browser requests (CSRF, DNS rebinding) before anything else
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", projectQueryGuard());
  // A project whose bus.consume is off has no bus: its routes answer as without one (the consumers' status excepted)
  fastify.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions?.url === "/api/bus/consumers") return;
    const project = (request.query as { project?: unknown }).project;
    if (typeof project !== "string") return; // /api/bus/call without one: the token's project, checked there
    if (options.mode(project) !== "off") return;
    const err = respondError(`the bus is off for ${project}: set bus.consume to observe or on (docs/configuration.md#fleet-bus)`, 404);
    return reply.code(err.statusCode).send(err);
  });

  // ============ GET /api/bus/consumers - The bus consumers' state (open, read-only) ============

  fastify.get<{ Querystring: { project: string } }>("/api/bus/consumers", async (request) => respond(options.health(request.query.project)));

  // ============ POST /api/bus/call - Agent API ============

  fastify.post<CallRoute>("/api/bus/call", { config: { projectOptional: true } }, async (request, reply) => {
    // Extract and validate token
    const token = extractToken(request.headers.authorization);
    if (!token || !isBusTokenFormat(token)) {
      const err = respondError("Missing or invalid bus token", 401);
      return reply.code(err.statusCode).send(err);
    }
    const hash = hashBusToken(token);

    // The token's project: the one named, else the project whose bus store issued it (`lair bus` names none)
    const project =
      request.query.project ?? options.enabled().find((name) => busStoreFor(name, options.dataDir).validateToken(hash) !== null);
    if (project === undefined || options.mode(project) === "off") {
      const err = respondError("Invalid or expired bus token", 401);
      return reply.code(err.statusCode).send(err);
    }

    // Get the bus service
    const { service, store } = getBusService(project, options);

    // Validate token in store
    const binding = store.validateToken(hash);
    if (!binding) {
      const err = respondError("Invalid or expired bus token", 401);
      return reply.code(err.statusCode).send(err);
    }

    // Verify the run is still active (a project whose agents module is off has no active run)
    const run = projectRun(options, project, binding.runId);
    if (!run || !["queued", "waiting_lock", "running"].includes(run.state)) {
      const err = respondError("Run is no longer active", 401);
      return reply.code(err.statusCode).send(err);
    }

    // Parse request
    const { tool, args } = request.body ?? {};
    if (typeof tool !== "string" || !(tool in toolSchemas)) {
      const err = respondError(`Unknown tool: ${String(tool).slice(0, 50)}`);
      return reply.code(err.statusCode).send(err);
    }

    // Validate args
    const schema = toolSchemas[tool as ToolName];
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "args"}: ${i.message}`);
      const err = respondError(issues.join("; "));
      return reply.code(err.statusCode).send(err);
    }

    // Execute tool
    let result;

    switch (tool as ToolName) {
      case "whoami":
        result = service.whoami(binding);
        break;

      case "report": {
        const reportArgs = parsed.data as z.infer<typeof toolSchemas.report>;
        result = await service.report(
          binding,
          reportArgs.kind as ReportKind,
          reportArgs.task,
          reportArgs.summary,
          reportArgs.gate_id,
          reportArgs.pr,
          reportArgs.sha,
        );
        break;
      }

      case "inbox":
        result = service.inbox(binding);
        break;

      case "ack": {
        const ackArgs = parsed.data as z.infer<typeof toolSchemas.ack>;
        result = service.ack(binding, ackArgs.message_id, ackArgs.note);
        break;
      }

      case "send": {
        const sendArgs = parsed.data as z.infer<typeof toolSchemas.send>;
        result = await service.send(binding, sendArgs.to, sendArgs.text, sendArgs.priority);
        break;
      }

      case "board":
        result = service.board();
        break;
    }

    if (!result.ok) {
      const statusCode = result.error.code === "unauthorized" ? 401 : result.error.code === "forbidden" ? 403 : 400;
      // Never include the token in error messages
      const safeMessage = redactBusToken(result.error.message, token);
      const err = respondError(safeMessage, statusCode);
      return reply.code(err.statusCode).send(err);
    }

    return respond(result.data);
  });

  // ============ GET /api/bus/board - Board state (open) ============

  fastify.get<{ Querystring: { project: string } }>("/api/bus/board", async (request) => {
    const { service } = getBusService(request.query.project, options);
    const result = service.board();
    if (!result.ok) {
      return respondError(result.error.message);
    }

    // Convert to the shared type format
    const tasks: TaskStatus[] = result.data.tasks.map((t) => ({
      task: t.task,
      owner: t.owner,
      last_report: t.lastReport
        ? {
            kind: t.lastReport.kind,
            summary: t.lastReport.summary,
            time: t.lastReport.time,
            gate_id: t.lastReport.gateId,
            pr: t.lastReport.pr,
            sha: t.lastReport.sha,
          }
        : null,
    }));

    const output: BoardOutput = {
      tasks,
      agents: result.data.agents.map((a) => ({
        id: a.id,
        display_name: null,
        claims: a.claims,
        last_seen: new Date().toISOString(),
      })),
    };

    return respond(output);
  });

  // ============ GET /api/bus/events - SSE feed (open) ============

  fastify.get<{ Querystring: { project: string } }>("/api/bus/events", async (request, reply) => {
    const project = request.query.project;

    // Copy headers that hooks set (CORS)
    const hookHeaders: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) hookHeaders[name] = value;
    }
    reply.raw.writeHead(200, {
      ...hookHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send initial board state
    try {
      const { service } = getBusService(project, options);
      const result = service.board();
      if (result.ok) {
        const tasks: TaskStatus[] = result.data.tasks.map((t) => ({
          task: t.task,
          owner: t.owner,
          last_report: t.lastReport
            ? {
                kind: t.lastReport.kind,
                summary: t.lastReport.summary,
                time: t.lastReport.time,
                gate_id: t.lastReport.gateId,
                pr: t.lastReport.pr,
                sha: t.lastReport.sha,
              }
            : null,
        }));
        const output: BoardOutput = {
          tasks,
          agents: result.data.agents.map((a) => ({
            id: a.id,
            display_name: null,
            claims: a.claims,
            last_seen: new Date().toISOString(),
          })),
        };
        reply.raw.write(`event: board\ndata: ${JSON.stringify(output)}\n\n`);
      }
    } catch (e) {
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" })}\n\n`,
      );
    }

    // Poll for changes every 2 seconds
    const pollInterval = setInterval(() => {
      try {
        const { service } = getBusService(project, options);
        const result = service.board();
        if (result.ok) {
          const tasks: TaskStatus[] = result.data.tasks.map((t) => ({
            task: t.task,
            owner: t.owner,
            last_report: t.lastReport
              ? {
                  kind: t.lastReport.kind,
                  summary: t.lastReport.summary,
                  time: t.lastReport.time,
                  gate_id: t.lastReport.gateId,
                  pr: t.lastReport.pr,
                  sha: t.lastReport.sha,
                }
              : null,
          }));
          const output: BoardOutput = {
            tasks,
            agents: result.data.agents.map((a) => ({
              id: a.id,
              display_name: null,
              claims: a.claims,
              last_seen: new Date().toISOString(),
            })),
          };
          reply.raw.write(`event: board\ndata: ${JSON.stringify(output)}\n\n`);
        }
      } catch {
        // Ignore polling errors
      }
    }, 2000);

    // Cleanup on close
    request.raw.on("close", () => {
      clearInterval(pollInterval);
    });

    return reply;
  });

  // ============ POST /api/bus/send - Owner sends (requires session) ============

  fastify.post<{
    Body: { to: string; text: string; priority?: number };
    Querystring: { project: string };
  }>(
    "/api/bus/send",
    {
      preHandler: auth.requireOwnerForChanges(),
    },
    async (request, reply) => {
      const project = request.query.project;
      const { to, text, priority } = request.body ?? {};

      if (typeof to !== "string" || to.length === 0) {
        const err = respondError("to is required");
        return reply.code(err.statusCode).send(err);
      }
      if (typeof text !== "string" || text.length === 0) {
        const err = respondError("text is required");
        return reply.code(err.statusCode).send(err);
      }
      if (text.length > 10000) {
        const err = respondError("text is too long (max 10000)");
        return reply.code(err.statusCode).send(err);
      }
      if (priority !== undefined && (typeof priority !== "number" || priority < 1 || priority > 10)) {
        const err = respondError("priority must be 1-10");
        return reply.code(err.statusCode).send(err);
      }

      const { service } = getBusService(project, options);
      const result = await service.sendFromOwner(to, text, priority);
      if (!result.ok) {
        const err = respondError(result.error.message);
        return reply.code(err.statusCode).send(err);
      }

      return respond({
        success: true,
        message_id: result.data.messageId,
        to: result.data.to,
      });
    },
  );

  // ============ GET /api/bus/messages/:agentId - Agent messages (for UI) ============

  fastify.get<{
    Params: { agentId: string };
    Querystring: { project: string; direction?: "sent" | "received"; limit?: string };
  }>("/api/bus/messages/:agentId", async (request) => {
    const { agentId } = request.params;
    const project = request.query.project;
    const direction = request.query.direction;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;

    const { service } = getBusService(project, options);
    const messages = service.listMessages(agentId, { direction, limit });

    return respond({
      messages: messages.map((m) => ({
        id: m.id,
        from: m.fromId,
        to: m.toId,
        text: m.text,
        priority: m.priority,
        createdAt: new Date(m.createdAt).toISOString(),
        readAt: m.readAt ? new Date(m.readAt).toISOString() : null,
        ackAt: m.ackAt ? new Date(m.ackAt).toISOString() : null,
        ackNote: m.ackNote,
      })),
      unread: service.countUnread(agentId),
    });
  });
}
