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
import type { FastifyInstance, FastifyReply } from "fastify";
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
  type BusMirrorConfig,
  type BusServiceOptions,
} from "../bus/index.js";
import type { ApiResponse, BoardOutput, TaskStatus } from "../../shared/types.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { ReportKind } from "../../bus/types.js";
import { z } from "zod";
import { join } from "path";

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

const toolSchemas = {
  whoami: z.object({}),
  report: z.object({
    kind: ReportKindSchema,
    task: z.string().min(1).max(200),
    summary: z.string().min(1).max(10000),
    gate_id: z.string().max(200).optional(),
    pr: z.number().int().positive().optional(),
    sha: z.string().max(64).optional(),
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

// ============ Service management ============

const busServices = new Map<string, { service: BusService; store: BusStore }>();

export interface BusRoutesOptions {
  /** The agents module (for claims and run validation) */
  agents: AgentsManager;
  /** Server event bus */
  events?: EventBus;
  /** Data directory for bus databases */
  dataDir: string;
  /** Get project config */
  getConfig: (project: string) => ProjectConfig;
}

function getBusService(
  project: string,
  options: BusRoutesOptions,
): { service: BusService; store: BusStore } {
  let entry = busServices.get(project);
  if (!entry) {
    const store = getBusStore(project, join(options.dataDir, "bus"));
    const config = options.getConfig(project);

    // Mirror config from project settings
    const mirrorConfig: BusMirrorConfig = {
      queueFile: config.queue_file,
      mailDir: config.mail_dir,
      inboxFile: config.inbox_file,
    };

    const serviceOptions: BusServiceOptions = {
      store,
      getClaimedTask: (runId: string) => {
        const agentService = options.agents.get(project);
        if (!agentService) return null;
        // Find the run and get its claimed task
        const runs = agentService.runs(100);
        const run = runs.find((r) => r.id === runId);
        return run?.task ?? null;
      },
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

  // ============ POST /api/bus/call - Agent API ============

  fastify.post<{
    Body: { tool: string; args: Record<string, unknown> };
    Querystring: { project: string };
  }>("/api/bus/call", async (request, reply) => {
    const project = request.query.project;

    // Extract and validate token
    const token = extractToken(request.headers.authorization);
    if (!token || !isBusTokenFormat(token)) {
      const err = respondError("Missing or invalid bus token", 401);
      return reply.code(err.statusCode).send(err);
    }

    // Get the bus service
    const { service, store } = getBusService(project, options);

    // Validate token in store
    const binding = store.validateToken(hashBusToken(token));
    if (!binding) {
      const err = respondError("Invalid or expired bus token", 401);
      return reply.code(err.statusCode).send(err);
    }

    // Verify the run is still active
    const agentService = options.agents.get(project);
    if (agentService) {
      const runs = agentService.runs(100);
      const run = runs.find((r) => r.id === binding.runId);
      if (!run || !["queued", "waiting_lock", "running"].includes(run.state)) {
        const err = respondError("Run is no longer active", 401);
        return reply.code(err.statusCode).send(err);
      }
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
    const toolArgs = parsed.data;
    let result;

    switch (tool as ToolName) {
      case "whoami":
        result = service.whoami(binding);
        break;

      case "report":
        result = service.report(
          binding,
          toolArgs.kind as ReportKind,
          toolArgs.task,
          toolArgs.summary,
          toolArgs.gate_id,
          toolArgs.pr,
          toolArgs.sha,
        );
        break;

      case "inbox":
        result = service.inbox(binding);
        break;

      case "ack":
        result = service.ack(binding, toolArgs.message_id, toolArgs.note);
        break;

      case "send":
        result = service.send(binding, toolArgs.to, toolArgs.text, toolArgs.priority);
        break;

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
      const result = service.sendFromOwner(to, text, priority);
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
