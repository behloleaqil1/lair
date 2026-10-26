/**
 * Lair Server - Fastify API (and, after `npm run build`, the web UI)
 * Binds to localhost only (127.0.0.1:4777) unless LAIR_HOST is set
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  loadProjectConfig,
  getDefaultProject,
  listProjects,
} from "./config.js";
import { DataService, isSafeGateId } from "./services/data.js";
import { isValidDragonId } from "./parsers/dragon-config.js";
import { registerRootGuards, requireValidIdParam } from "./root-guards.js";
import { registerControlRoutes } from "./routes/controls.js";
import { registerBusRoutes } from "./routes/bus.js";
import { registerProcessRoutes } from "./routes/processes.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { getSupervisor } from "./services/supervisor.js";
import { LairWebSocketServer } from "./websocket.js";
import { createFileWatcher, FileWatcherService } from "./services/file-watcher.js";
import { getStore, closeStore } from "./store/store.js";
import { initNodeManager, closeNodeManager } from "./nodes/node-manager.js";
import { getScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerFleetRoutes } from "./routes/fleet.js";
import { getHealer, stopHealer } from "./fleet/healer.js";
import { stopMachineManager } from "./fleet/machine-manager.js";
import { registerClientStatic, resolveClientDir } from "./static.js";
import { getEventBus } from "./core/event-bus.js";
import { WatchdogManager, registerWatchdogRoutes } from "./watchdog/index.js";
import { DeliveryManager, registerDeliveryRoutes } from "./delivery/index.js";
import { join } from "path";
import type { ApiResponse } from "../shared/types.js";

const PORT = 4777;
const HOST = process.env.LAIR_HOST || "127.0.0.1";

const fastify = Fastify({
  logger: true,
});

// Enable CORS for the client
await fastify.register(cors, {
  origin: [`http://${HOST}:5173`, `http://localhost:5173`], // Vite dev server
});

// Refuse cross-site browser requests and foreign Host headers (403) on every
// route, and unsafe or unknown ?project= names on API routes (400)
registerRootGuards(fastify);

// Path ids are matched against files on disk: refuse unsafe ones with 400
const dragonIdGuard = requireValidIdParam(isValidDragonId, "dragon");
const gateIdGuard = requireValidIdParam(isSafeGateId, "gate");

// Wrap response in standard format
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

// Get data service for project (cached per request cycle)
const dataServices = new Map<string, DataService>();

function getDataService(project?: string): DataService {
  const projectName = project || getDefaultProject();

  if (!dataServices.has(projectName)) {
    const config = loadProjectConfig(projectName);
    dataServices.set(projectName, new DataService(config));
  }

  return dataServices.get(projectName)!;
}

// WebSocket server and file watchers (initialized after server starts)
let wsServer: LairWebSocketServer | null = null;
const fileWatchers = new Map<string, FileWatcherService>();

// ============ ROUTES ============

// Health check
fastify.get("/api/health", async () => {
  return respond({
    status: "ok",
    projects: listProjects(),
    wsClients: wsServer?.getClientCount() ?? 0,
  });
});

// List projects
fastify.get("/api/projects", async () => {
  return respond(listProjects());
});

// The default project (LAIR_PROJECT, else "example", else the first one)
fastify.get("/api/projects/default", async () => {
  try {
    return respond(getDefaultProject());
  } catch (e) {
    return respondError(e instanceof Error ? e.message : "Unknown error");
  }
});

// Overview
fastify.get<{ Querystring: { project?: string } }>(
  "/api/overview",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      return respond(service.getOverview());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Dragons
fastify.get<{ Querystring: { project?: string } }>(
  "/api/dragons",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      return respond(service.getDragons());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

fastify.get<{ Params: { id: string }; Querystring: { project?: string } }>(
  "/api/dragons/:id",
  { preHandler: dragonIdGuard },
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      const dragon = service.getDragonById(request.params.id);
      if (!dragon) {
        return respondError(`Dragon not found: ${request.params.id}`);
      }
      return respond(dragon);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

fastify.get<{
  Params: { id: string };
  Querystring: { project?: string; lines?: string };
}>("/api/dragons/:id/log", { preHandler: dragonIdGuard }, async (request) => {
  try {
    const service = getDataService(request.query.project);
    const lines = request.query.lines ? parseInt(request.query.lines, 10) : 50;
    const log = service.getDragonLogTail(request.params.id, lines);
    return respond({ id: request.params.id, log });
  } catch (e) {
    return respondError(e instanceof Error ? e.message : "Unknown error");
  }
});

fastify.get<{ Params: { id: string }; Querystring: { project?: string } }>(
  "/api/dragons/:id/queue",
  { preHandler: dragonIdGuard },
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      const lines = service.getQueueLinesByAgent(request.params.id);
      return respond(lines);
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Gates
fastify.get<{ Querystring: { project?: string } }>(
  "/api/gates",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      const queue = service.getGateQueue();
      const results = service.getRecentGateResults(24);
      return respond({ queue, results });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

fastify.get<{ Querystring: { project?: string; status?: string } }>(
  "/api/gates/queue",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      if (request.query.status) {
        return respond(service.getGatesByStatus(request.query.status));
      }
      return respond(service.getGateQueue());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

fastify.get<{ Querystring: { project?: string; hours?: string } }>(
  "/api/gates/results",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      const hours = request.query.hours
        ? parseInt(request.query.hours, 10)
        : 24;
      return respond(service.getRecentGateResults(hours));
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

fastify.get<{ Params: { id: string }; Querystring: { project?: string } }>(
  "/api/gates/:id/log",
  { preHandler: gateIdGuard },
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      const log = service.getGateLog(request.params.id);
      return respond({ id: request.params.id, log });
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Queue
fastify.get<{ Querystring: { project?: string; types?: string } }>(
  "/api/queue",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      if (request.query.types) {
        const types = request.query.types.split(",");
        return respond(service.getQueueLinesByType(types));
      }
      return respond(service.getQueueLines());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// PRs
fastify.get<{ Querystring: { project?: string } }>(
  "/api/prs",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      return respond(service.getPullRequests());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Machines
fastify.get<{ Querystring: { project?: string } }>(
  "/api/machines",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      return respond(service.getMachineStatuses());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Orchestrator
fastify.get<{ Querystring: { project?: string } }>(
  "/api/orchestrator",
  async (request) => {
    try {
      const service = getDataService(request.query.project);
      return respond(service.getOrchestratorStatus());
    } catch (e) {
      return respondError(e instanceof Error ? e.message : "Unknown error");
    }
  },
);

// Register Phase 2 control routes
await registerControlRoutes(fastify);

// Register Phase 3 bus routes
await registerBusRoutes(fastify);

// Register process manager routes
await registerProcessRoutes(fastify);

// Register settings routes
await registerSettingsRoutes(fastify);

// Register M1 scheduler and node routes
await registerSchedulerRoutes(fastify);

// Register M3 fleet management routes
await registerFleetRoutes(fastify);

const projectEntries = listProjects().map((name) => {
  try {
    return { name, config: loadProjectConfig(name) };
  } catch (e) {
    return { name, error: e instanceof Error ? e.message : String(e) };
  }
});

// Delivery: one per project with `delivery.enabled: true` (off by default).
// Its environments are docker compose projects that the routes bring up and
// down, and that it deploys to after a merge when `deploy.auto` is set.
const delivery = new DeliveryManager({
  dbPath: join(process.cwd(), "data", "delivery.db"),
  events: getEventBus(),
});
delivery.load(projectEntries);
await registerDeliveryRoutes(fastify, delivery, () => getDefaultProject());

// Progress watchdog: one per project with `watchdog.enabled: true` (off by
// default). Its routes are read-only and answer for every project. It reads
// delivery's crash loops and holds (the crash_loop detector and act guard).
const watchdogs = new WatchdogManager({
  dbPath: join(process.cwd(), "data", "watchdog.db"),
  events: getEventBus(),
  services: delivery,
});
watchdogs.load(projectEntries);
await registerWatchdogRoutes(fastify, watchdogs, () => getDefaultProject());

// Serve the built web UI (dist/client) with an SPA fallback, when it exists.
// In development the UI comes from the Vite dev server on port 5173 instead.
const clientDir = resolveClientDir();
const servingClient = await registerClientStatic(fastify, clientDir);

// Initialize process supervisor
const initSupervisor = async () => {
  try {
    const defaultProject = getDefaultProject();
    const supervisor = getSupervisor();
    supervisor.loadConfig(defaultProject);
    await supervisor.initialize();
    console.log(
      `Process supervisor initialized for project: ${defaultProject}`,
    );
  } catch (err) {
    console.warn("Failed to initialize process supervisor:", err);
  }
};

// Graceful shutdown handler
const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down gracefully...`);

  // Stop watchdogs: wait for a tick in progress, then close their store
  await watchdogs.stop();

  // Stop delivery (after the watchdogs, which read it): a wait in progress
  // ends early and no further command starts; then close its store
  await delivery.stop();

  // Stop healer
  stopHealer();

  // Stop machine manager
  stopMachineManager();

  // Stop scheduler
  stopScheduler();

  // Close node manager
  closeNodeManager();

  // Close store
  closeStore();

  // Stop file watchers
  for (const watcher of fileWatchers.values()) {
    await watcher.stop();
  }
  fileWatchers.clear();

  // Close WebSocket server
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }

  // Stop all managed processes
  try {
    const supervisor = getSupervisor();
    await supervisor.shutdown(10000);
    console.log("All managed processes stopped");
  } catch (err) {
    console.error("Error during process shutdown:", err);
  }

  // Close fastify
  await fastify.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
const start = async () => {
  try {
    // Initialize supervisor before starting server
    await initSupervisor();

    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Lair server running at http://${HOST}:${PORT}`);
    if (servingClient) {
      console.log(`Serving web UI from ${clientDir}`);
    } else {
      console.log(
        "No built web UI found (run `npm run build`); in development use the Vite dev server on port 5173",
      );
    }

    // Initialize M1: Store (auto-initializes on first getStore() call)
    getStore();
    console.log("[M1] Store initialized");

    // Initialize WebSocket server after HTTP server is ready
    const httpServer = fastify.server;
    wsServer = new LairWebSocketServer(httpServer);

    // Initialize M1: Node manager WebSocket
    initNodeManager(httpServer);
    console.log("[M1] Node manager initialized");

    // Initialize M1: Scheduler
    const scheduler = getScheduler();
    scheduler.start();
    console.log("[M1] Scheduler started");

    // Initialize M3: Self-healing
    const healer = getHealer();
    healer.start();
    console.log("[M3] Self-healing healer started");

    // Start watchdogs
    const watched = watchdogs.start();
    console.log(
      watched.length > 0
        ? `[watchdog] Watching: ${watched.join(", ")}`
        : "[watchdog] Off (no project sets watchdog.enabled)",
    );

    // Start delivery
    const delivering = delivery.start();
    console.log(
      delivering.length > 0
        ? `[delivery] Environments of: ${delivering.join(", ")}`
        : "[delivery] Off (no project sets delivery.enabled)",
    );

    // Start file watchers for all projects
    const projects = listProjects();
    for (const projectName of projects) {
      try {
        const config = loadProjectConfig(projectName);
        const watcher = createFileWatcher(wsServer, config);
        fileWatchers.set(projectName, watcher);
      } catch (err) {
        console.warn(`Failed to start file watcher for ${projectName}:`, err);
      }
    }

    console.log(`WebSocket server ready at ws://${HOST}:${PORT}/ws`);
    console.log(`Node WebSocket ready at ws://${HOST}:${PORT}/ws/node`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
