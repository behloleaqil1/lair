/**
 * Bus routes - Phase 3 fleet bus API
 *
 * Exposes the bus storage via HTTP for the Lair dashboard.
 * The actual MCP bus runs as a separate stdio process per agent.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { join } from "path";
import { existsSync } from "fs";
import { loadProjectConfig } from "../config.js";
import { BusStorage } from "../../bus/storage.js";
import { projectQueryGuard } from "./project-guard.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { ApiResponse, BoardOutput, TaskStatus } from "../../shared/types.js";

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

// Cache for bus storage instances
const busStorages = new Map<string, BusStorage>();

async function getBusStorage(projectName: string): Promise<BusStorage> {
  if (!busStorages.has(projectName)) {
    const dataDir = join(process.cwd(), "data");
    const storage = new BusStorage(projectName, dataDir);
    await storage.init();
    busStorages.set(projectName, storage);
  }
  return busStorages.get(projectName)!;
}

// Track SSE connections for cleanup
const sseConnections = new Map<string, Set<FastifyReply>>();

export async function registerBusRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Encapsulated so the project guard applies only to these routes
  await fastify.register(busRoutes);
}

async function busRoutes(fastify: FastifyInstance): Promise<void> {
  // The project name becomes data/<project>.db, so validate it first
  // Refuse cross-site browser requests (CSRF, DNS rebinding) before anything else
  fastify.addHook("onRequest", rejectCrossSiteRequests);
  fastify.addHook("onRequest", projectQueryGuard());

  // ============ BOARD ============

  fastify.get<{ Querystring: { project: string } }>(
    "/api/bus/board",
    async (request) => {
      try {
        const storage = await getBusStorage(request.query.project);

        const claims = storage.getAllActiveClaims();
        const reports = storage.getLatestReportsByTask();
        const agents = storage.getAllAgents();

        // Build task list with owners and last reports
        const taskSet = new Set<string>();
        claims.forEach((c) => taskSet.add(c.task));
        reports.forEach((_, task) => taskSet.add(task));

        const tasks: TaskStatus[] = Array.from(taskSet).map((task) => {
          const claim = claims.find((c) => c.task === task);
          const report = reports.get(task);

          return {
            task,
            owner: claim?.owner_id ?? null,
            last_report: report
              ? {
                  kind: report.kind,
                  summary: report.summary,
                  time: report.created_at,
                  gate_id: report.gate_id ?? undefined,
                  pr: report.pr ?? undefined,
                  sha: report.sha ?? undefined,
                }
              : null,
          };
        });

        // Build agent list with claims
        const agentList = agents.map((a) => ({
          id: a.id,
          display_name: a.display_name,
          claims: claims.filter((c) => c.owner_id === a.id).map((c) => c.task),
          last_seen: a.last_seen,
        }));

        const output: BoardOutput = {
          tasks,
          agents: agentList,
        };

        return respond(output);
      } catch (e) {
        return respondError(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

  // ============ SSE FEED ============

  fastify.get<{ Querystring: { project: string } }>(
    "/api/bus/events",
    async (request, reply) => {
      const projectName = request.query.project;

      // Set SSE headers. Writing to reply.raw bypasses Fastify's header
      // handling, so copy the headers hooks already set (the app's CORS
      // plugin adds Access-Control-Allow-Origin only for allowed origins).
      // Never send a wildcard origin: it would let any web page read the feed.
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

      // Track this connection
      if (!sseConnections.has(projectName)) {
        sseConnections.set(projectName, new Set());
      }
      sseConnections.get(projectName)!.add(reply);

      // Send initial board state
      try {
        const storage = await getBusStorage(projectName);
        const claims = storage.getAllActiveClaims();
        const reports = storage.getLatestReportsByTask();
        const agents = storage.getAllAgents();

        const taskSet = new Set<string>();
        claims.forEach((c) => taskSet.add(c.task));
        reports.forEach((_, task) => taskSet.add(task));

        const tasks: TaskStatus[] = Array.from(taskSet).map((task) => {
          const claim = claims.find((c) => c.task === task);
          const report = reports.get(task);
          return {
            task,
            owner: claim?.owner_id ?? null,
            last_report: report
              ? {
                  kind: report.kind,
                  summary: report.summary,
                  time: report.created_at,
                  gate_id: report.gate_id ?? undefined,
                  pr: report.pr ?? undefined,
                  sha: report.sha ?? undefined,
                }
              : null,
          };
        });

        const agentList = agents.map((a) => ({
          id: a.id,
          display_name: a.display_name,
          claims: claims.filter((c) => c.owner_id === a.id).map((c) => c.task),
          last_seen: a.last_seen,
        }));

        const board: BoardOutput = { tasks, agents: agentList };
        reply.raw.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);
      } catch (e) {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" })}\n\n`,
        );
      }

      // Poll for changes every 2 seconds
      const pollInterval = setInterval(async () => {
        try {
          // Check if the database file was modified
          const config = loadProjectConfig(projectName);
          const dbPath = join(process.cwd(), "data", `${config.name}.db`);

          if (existsSync(dbPath)) {
            const storage = await getBusStorage(projectName);
            const claims = storage.getAllActiveClaims();
            const reports = storage.getLatestReportsByTask();
            const agents = storage.getAllAgents();

            const taskSet = new Set<string>();
            claims.forEach((c) => taskSet.add(c.task));
            reports.forEach((_, task) => taskSet.add(task));

            const tasks: TaskStatus[] = Array.from(taskSet).map((task) => {
              const claim = claims.find((c) => c.task === task);
              const report = reports.get(task);
              return {
                task,
                owner: claim?.owner_id ?? null,
                last_report: report
                  ? {
                      kind: report.kind,
                      summary: report.summary,
                      time: report.created_at,
                      gate_id: report.gate_id ?? undefined,
                      pr: report.pr ?? undefined,
                      sha: report.sha ?? undefined,
                    }
                  : null,
              };
            });

            const agentList = agents.map((a) => ({
              id: a.id,
              display_name: a.display_name,
              claims: claims.filter((c) => c.owner_id === a.id).map((c) => c.task),
              last_seen: a.last_seen,
            }));

            const board: BoardOutput = { tasks, agents: agentList };
            reply.raw.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);
          }
        } catch {
          // Ignore polling errors
        }
      }, 2000);

      // Cleanup on close
      request.raw.on("close", () => {
        clearInterval(pollInterval);
        sseConnections.get(projectName)?.delete(reply);
      });

      // Keep the connection open
      return reply;
    },
  );

  // ============ SEND MESSAGE (from UI) ============

  fastify.post<{
    Body: { to: string; text: string; priority?: number };
    Querystring: { project: string };
  }>("/api/bus/send", async (request) => {
    try {
      const storage = await getBusStorage(request.query.project);
      const { to, text, priority } = request.body;

      // UI sends as "owner"
      const messageId = storage.sendMessage("owner", to, text, priority ?? 5);

      return respond({
        success: true,
        message_id: messageId,
        to,
      });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  });
}
