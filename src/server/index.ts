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
import { DataService } from "./services/data.js";
import { QueueCacheManager } from "./services/queue-cache.js";
import { isValidDragonId } from "./parsers/dragon-config.js";
import { registerRootGuards, requireValidIdParam } from "./root-guards.js";
import { mountDecisions } from "./decisions/index.js";
import { mountLessonsWhenEnabled, parseLessonsConfig, defaultLessonsSettings } from "./lessons/index.js";
import { mountDecisionPolicies } from "./decisions/policies/index.js";
import { mountBrainTrainer } from "./brain-trainer/index.js";
import { mountOutcomeTracker } from "./outcomes/index.js";
import { loadNotificationConfig, mountNotifications } from "./notifications/index.js";
import { notificationsOn } from "./notifications/config.js";
import {
  HumanAuth,
  OWNER_ONLY_PREFIXES,
  corsOptionsWithout,
  dashboardUrlFor,
  registerOwnerRoutes,
} from "./human-auth/index.js";
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
import { InfraPolicyManager, registerInfraPolicyRoutes } from "./infra-policy/index.js";
import { registerTofuRunnerRoutes, TofuRunnerManager } from "./tofu-runner/index.js";
import { AwsCliIssuer, DockerSpawner, PlanSandboxManager, registerPlanSandboxRoutes, sweepLeftovers } from "./plan-sandbox/index.js";
import { PipelineManager, registerPipelineRoutes } from "./gates/index.js";
import { AgentsManager, registerAgentsRoutes, systemAgentProbesWithCache } from "./agents/index.js";
import { isActive } from "./agents/types.js";
import { AiToolsService, registerAiRoutes } from "./ai/index.js";
import { getBudgetManager } from "./fleet/budget.js";
import { ReviewManager, inboxDecisionSink, registerReviewRoutes } from "./review/index.js";
import { mountTriage } from "./triage/index.js";
import { PlacementManager, registerPlacementRoutes } from "./placement/index.js";
import { HostServicesManager, registerHostServicesRoutes } from "./host-services/index.js";
import { CloudManager, registerCloudRoutes } from "./cloud/index.js";
import { InfraMonitorManager, registerInfraMonitorRoutes } from "./infra-monitor/index.js";
import { ChecksManager, agentRunIsActive, registerChecksRoutes } from "./checks/index.js";
import { registerDashboardRoutes } from "./dashboard/index.js";
import type { DashboardSources } from "./dashboard/routes.js";
import { RequestLatency, mountSupervisor, registerLatencyHook } from "./supervisor/index.js";
import { moduleReports } from "./supervisor/modules.js";
import { ConfigReloader, registerReloadRoutes, serverModules } from "./reload/index.js";
import {
  RestartController,
  SHUTDOWN_DEADLINE_MS,
  configuredTokenEnvs,
  registerRestartRoutes,
  withDeadline,
} from "./restart/index.js";
import { SettingsService, registerSettingsUiRoutes } from "./settings/index.js";
import { mountPlanner, plannerAgentsFrom } from "./planner/index.js";
import { join } from "path";
import type { ApiResponse, ProjectConfig } from "../shared/types.js";
import { initProcessCache, disposeProcessCache, CachedProcessTable } from "./core/process-cache.js";
import { systemProbesWithCache } from "./watchdog/probes.js";
import { DataCacheManager, type CachedData } from "./services/data-cache.js";

const PORT = 4777;
const HOST = process.env.LAIR_HOST || "127.0.0.1";

const fastify = Fastify({
  logger: true,
});

// Enable CORS for the client (the Vite dev server), but never for the
// owner-only routes (src/server/human-auth/cors.ts)
await fastify.register(
  cors,
  corsOptionsWithout([`http://${HOST}:5173`, `http://localhost:5173`], OWNER_ONLY_PREFIXES),
);

// Refuse cross-site browser requests and foreign Host headers (403) on every
// route, and unsafe or unknown ?project= names on API routes (400)
registerRootGuards(fastify);

// Every request's duration, for the supervisor's request_latency check
// (src/server/supervisor/): before any route, so every route has it
const latency = new RequestLatency();
registerLatencyHook(fastify, latency);

// Path ids are matched against files on disk: refuse unsafe ones with 400
const dragonIdGuard = requireValidIdParam(isValidDragonId, "dragon");

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

/** Response with cache metadata for expensive routes */
function respondCached<T>(cached: CachedData<T>): ApiResponse<T> & { cache: { ageMs: number; stale: boolean; refreshedAt: string; error?: string } } {
  return {
    success: true,
    data: cached.value,
    timestamp: new Date().toISOString(),
    cache: {
      ageMs: cached.ageMs,
      stale: cached.stale,
      refreshedAt: cached.refreshedAt,
      ...(cached.error ? { error: cached.error } : {}),
    },
  };
}

// Get data service for project (cached per request cycle)
const dataServices = new Map<string, DataService>();
const queueCaches = new QueueCacheManager();
const queueReady = new Map<string, () => Promise<boolean>>();
/** The first read of the queue file is waited for this long; then requests get what the cache has */
const QUEUE_FIRST_READ_MS = 2_000;
const queueSlowLogged = new Set<string>();

// The agents module's runs, for the Dragons view: a dragon it runs is
// running, "managed by Lair". Set once the module is loaded, below.
let managedRuns: Pick<AgentsManager, "managedRuns"> | null = null;

function getDataService(project?: string): DataService {
  const projectName = project || getDefaultProject();

  if (!dataServices.has(projectName)) {
    const config = loadProjectConfig(projectName);
    // The queue file is parsed once per change, never on a request
    const queue = queueCaches.get(projectName, config.queue_file);
    queueReady.set(projectName, () => queue.readyWithin(QUEUE_FIRST_READ_MS));
    dataServices.set(
      projectName,
      new DataService(config, {
        managedRuns: () => managedRuns?.managedRuns(projectName) ?? new Map(),
        queue: () => queue.getLines(),
      }),
    );
  }

  return dataServices.get(projectName)!;
}

// A request waits for the first read of its project's queue file, then every
// handler reads the parsed lines from memory
fastify.addHook("preHandler", async (request) => {
  if (!request.url.startsWith("/api/")) return;
  const asked = (request.query as { project?: unknown } | undefined)?.project;
  try {
    const name = typeof asked === "string" && asked ? asked : getDefaultProject();
    getDataService(name);
    const ready = await queueReady.get(name)?.();
    if (ready === false && !queueSlowLogged.has(name)) {
      queueSlowLogged.add(name);
      console.warn(`The queue file of project ${name} is slow to read; serving what is cached`);
    }
  } catch {
    // An unknown project or an unreadable config: the handler reports it
  }
});

/** Get the data cache for a project (expensive operations use this). */
function getDataCache(project?: string) {
  const projectName = project || getDefaultProject();
  const config = loadProjectConfig(projectName);
  return dataCacheManager.getCache(config);
}

// WebSocket server and file watchers (initialized after server starts)
let wsServer: LairWebSocketServer | null = null;
const fileWatchers = new Map<string, FileWatcherService>();
/** Per project: the paths its file watcher watches */
const watchedPaths = new Map<string, string>();
const watchKey = (config: ProjectConfig) =>
  JSON.stringify([config.name, config.agents_dir, config.gates_dir, config.queue_file]);

/** After a config reload: watch the project's new paths, when they changed. */
function refreshFileWatcher(project: string, config: ProjectConfig): void {
  const paths = watchKey(config);
  if (!wsServer || watchedPaths.get(project) === paths) return;
  const old = fileWatchers.get(project);
  fileWatchers.set(project, createFileWatcher(wsServer, config));
  watchedPaths.set(project, paths);
  void old?.stop();
}

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

// A dragon's log tail is the owner's: GET /api/dashboard/agents/:id/log (src/server/dashboard/)

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

// A gate's detail is GET /api/dashboard/gates/:id, its log tail and failing
// tests the owner's GET /api/dashboard/gates/:id/output (src/server/dashboard/)

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

// PRs - uses async data cache to avoid blocking the event loop
fastify.get<{ Querystring: { project?: string } }>(
  "/api/prs",
  async (request) => {
    try {
      const cache = getDataCache(request.query.project);
      const cached = await cache.getPullRequests();
      return respondCached(cached);
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

// The owner's credential (src/server/human-auth/): the token in
// data/owner.token and the browser sessions signed in with it. Every route
// that changes something only the human may change needs one of those
// sessions: decisions, reviews, and the writes of controls, bus messages,
// processes, settings, scheduler, tasks, fleet, delivery and pipelines. The
// setup link is printed to this process's stdout at first start.
const humanAuth = HumanAuth.open({
  tokenPath: join(process.cwd(), "data", "owner.token"),
  dbPath: join(process.cwd(), "data", "owner-sessions.db"),
});
humanAuth.announce(dashboardUrlFor(HOST, PORT));
await registerOwnerRoutes(fastify, humanAuth);

// Register Phase 2 control routes (commands and dragon start/stop: owner only)
await registerControlRoutes(fastify, humanAuth);

// Register Phase 3 bus routes (messages sent as the owner: owner only)
await registerBusRoutes(fastify, humanAuth);

// Register process manager routes (start/stop/restart: owner only)
await registerProcessRoutes(fastify, humanAuth);

// Register the machine test of the settings (owner only); the Settings API is below
await registerSettingsRoutes(fastify, humanAuth);

// Register M1 scheduler and node routes (scheduler controls, task changes: owner only)
await registerSchedulerRoutes(fastify, humanAuth);

// Register M3 fleet management routes (every change: owner only)
await registerFleetRoutes(fastify, humanAuth);

// Lessons: what Lair has learned from incidents and operational experience
// (docs/design/autonomy.md §8). Built-in lessons (L1-L28) ship with Lair;
// project lessons are proposed by incidents and approved by the owner.
// Off by default: mounted only when some project sets `lessons.enabled: true`.
const lessonsEnabled = listProjects().some((name) => {
  try {
    const parsed = parseLessonsConfig(loadProjectConfig(name).lessons);
    return parsed.ok && parsed.settings.enabled;
  } catch {
    return false;
  }
});
const lessons = await mountLessonsWhenEnabled(fastify, {
  enabled: lessonsEnabled,
  dbPath: join(process.cwd(), "data", "lessons.db"),
  humanAuth,
  defaultProject: () => getDefaultProject(),
  settings: (project) => {
    try {
      const config = loadProjectConfig(project);
      const parsed = parseLessonsConfig(config.lessons);
      return parsed.ok ? parsed.settings : defaultLessonsSettings();
    } catch {
      return defaultLessonsSettings();
    }
  },
  projectsDir: join(process.cwd(), "projects"),
});
if (lessons && lessons.builtInLoaded > 0) {
  console.log(`Loaded ${lessons.builtInLoaded} built-in lessons`);
}

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
// Up, Down, Restart, Deploy and Release need the owner's session
await registerDeliveryRoutes(fastify, delivery, () => getDefaultProject(), humanAuth);

// Infrastructure policy scan: a static check of infrastructure code, one per
// project with `infra_policy.enabled: true` (off by default). It reads files
// and runs nothing; the plan step of a later change goes through its guard.
const infraPolicy = new InfraPolicyManager();
infraPolicy.load(projectEntries);
await registerInfraPolicyRoutes(fastify, infraPolicy, () => getDefaultProject(), humanAuth);

// Plan sandbox: `tofu plan` in an isolated container with the read-only plan
// role, only after the policy scan passes. One per project with
// `plan_sandbox.enabled: true` (off by default).
const planSandbox = new PlanSandboxManager({ spawner: new DockerSpawner(), issuer: new AwsCliIssuer(), infra: infraPolicy, sweep: () => sweepLeftovers() });
planSandbox.load(projectEntries);
await planSandbox.startupSweep();
await registerPlanSandboxRoutes(fastify, planSandbox, () => getDefaultProject(), humanAuth);

// OpenTofu runner: plan with the state in S3 and apply an approved plan file
// with the separate apply role, always through the policy scan and the plan
// sandbox. One per project with `tofu_runner.enabled: true` (off by default,
// and `observe` mode does not apply).
const tofuRunner = new TofuRunnerManager({ sandbox: planSandbox, events: getEventBus() });
tofuRunner.load(projectEntries);
await tofuRunner.reconcile();
await registerTofuRunnerRoutes(fastify, tofuRunner, () => getDefaultProject(), humanAuth);

// AI tools (src/server/ai/): per machine, whether each tool is installed and
// signed in, and the models it offers, from the tools' own commands (bounded,
// timed out, cached). Every route is the owner's, reads included.
const aiTools = new AiToolsService();
await registerAiRoutes(fastify, {
  service: aiTools,
  auth: humanAuth,
  defaultProject: () => getDefaultProject(),
  config: (project) => loadProjectConfig(project),
});

// Agent runs (claims, locks, recovery, failover, budgets): one service per
// project with `agents.enabled: true` (off by default). Costs reach its
// per-agent and per-project budgets through the fleet budget. A tool whose
// sign-in check says it is signed out on this machine starts no run here.
// Its routes are registered below, once the owner's credential exists.

// Shared process cache: one ps call per interval for all modules (agents,
// watchdog, health checks). Under load, each module calling ps itself piled
// up and timed out; now they all read from this cache. Started here, stopped
// in shutdown().
const processCache = initProcessCache({
  refreshIntervalMs: 5_000,
  maxAgeMs: 10_000,
  psTimeoutMs: 15_000,
});
processCache.start();

// The cached process table adapter for modules that need a ProcessTable
const cachedProcessTable = new CachedProcessTable(processCache);

// Cached data service for expensive dashboard operations (gh and git commands).
// Routes read from the cache immediately; refreshes happen in the background.
const dataCacheManager = new DataCacheManager();

const agents = new AgentsManager({
  dbPath: join(process.cwd(), "data", "agents.db"),
  events: getEventBus(),
  budget: getBudgetManager(),
  tools: aiTools,
  probes: systemAgentProbesWithCache(processCache),
});
agents.load(projectEntries);
managedRuns = agents;

// Progress watchdog: one per project with `watchdog.enabled: true` (off by
// default). Its routes are read-only and answer for every project. It reads
// delivery's crash loops and holds (the crash_loop detector and act guard),
// and leaves the agents the agents module supervises to it.
const watchdogs = new WatchdogManager({
  dbPath: join(process.cwd(), "data", "watchdog.db"),
  events: getEventBus(),
  services: delivery,
  agents,
  probes: systemProbesWithCache(cachedProcessTable),
});
watchdogs.load(projectEntries);
await registerWatchdogRoutes(fastify, watchdogs, () => getDefaultProject());

// Gate pipelines (`pipelines:` in a project config): each job runs on the
// repository's CI runners first and on this machine last (docs/design/runners.md)
const pipelines = new PipelineManager({
  dbPath: join(process.cwd(), "data", "pipelines.db"),
  events: getEventBus(),
  budget: getBudgetManager(),
});
pipelines.load(projectEntries);
// Starting and cancelling runs need the owner's session
await registerPipelineRoutes(fastify, pipelines, () => getDefaultProject(), humanAuth);

// Decision Inbox: the one place Lair asks the human (data/decisions.db). The
// watchdog's and the agents module's escalations (and the agents' spend decisions) become
// decisions, and their answers resume them.
// Closed by fastify.close() in shutdown().
const decisionInbox = await mountDecisions(fastify, {
  dbPath: join(process.cwd(), "data", "decisions.db"),
  humanAuth,
  defaultProject: () => getDefaultProject(),
  events: getEventBus(),
  producers: [watchdogs, agents],
});

// Decision policies (src/server/decisions/policies/): off unless data/server.yaml sets decision_policies.enabled.
// The table in data/policies.yaml (a built-in one without the file), rules C1-C4 and C11 in shadow. Each raised
// decision gets a proposal in the policy trace, compared with the answer a person gives; nothing here answers,
// withdraws or changes a decision. Only while it is on does the agents module update a raised decision's evidence
// (cause_cleared) for the rules.
await mountDecisionPolicies(fastify, {
  configPath: join(process.cwd(), "data", "server.yaml"),
  policiesPath: join(process.cwd(), "data", "policies.yaml"),
  inbox: decisionInbox,
  events: getEventBus(),
  humanAuth,
  evidenceProducers: [agents],
  log: (line) => console.warn(`[decisions] ${line}`),
});

// Notifications (src/server/notifications/): opt-in desktop and ntfy pushes when a new action item opens,
// batched (one a minute at most), with a daily reminder; configured in data/server.yaml. Owner-only routes under
// /api/owner. Notices are never notified
await mountNotifications(fastify, {
  configPath: join(process.cwd(), "data", "server.yaml"),
  statePath: join(process.cwd(), "data", "notifications-state.json"),
  events: getEventBus(),
  inbox: decisionInbox,
  humanAuth,
  dashboardUrl: dashboardUrlFor(HOST, PORT),
});

// Outcome tracker (src/server/outcomes/): off unless data/server.yaml sets outcome_tracker.enabled. Records whether each
// answered decision turned out good, bad or unknown (the labels the brain trainer reads). It listens to events and may
// only list answers waiting for a verdict and record it: it never answers, retries or reverts anything.
mountOutcomeTracker(fastify, {
  configPath: join(process.cwd(), "data", "server.yaml"),
  dbPath: join(process.cwd(), "data", "outcomes.db"),
  decisions: decisionInbox,
  events: getEventBus(),
});

// Brain trainer (src/server/brain-trainer/): off unless data/server.yaml sets brain_trainer.enabled. A nightly
// classifier trained in a container on the answered decisions, scored on the brain bench, versioned, and run in
// shadow mode only: it is given a read-only view of the inbox and nothing it produces answers a decision.
await mountBrainTrainer(fastify, {
  configPath: join(process.cwd(), "data", "server.yaml"),
  dataDir: join(process.cwd(), "data", "brain"),
  decisions: decisionInbox,
  events: getEventBus(),
  humanAuth,
});

// Reviews and policy merge: one per project with `review.enabled: true`;
// with review.prompt_file, reviews by agents the agents module starts.
// Its decisions (a human review, a refused merge, no agent review) go to the Decision Inbox
const reviews = new ReviewManager({
  dbPath: join(process.cwd(), "data", "review.db"),
  events: getEventBus(),
  agents,
  serverUrl: dashboardUrlFor(HOST, PORT),
  decisions: inboxDecisionSink(decisionInbox),
});
reviews.load(projectEntries);

// Host services: per-machine services with probe and start (duty D13).
// One per project with `host_services.enabled: true` (off by default).
// It probes services (a container engine, tunnel daemons) every interval and,
// in act mode, starts them when down (with a backoff kept in
// data/host-services/) and holds the pipeline lanes that need them
const hostServices = new HostServicesManager({ events: getEventBus(), dataDir: join(process.cwd(), "data") });
hostServices.load(projectEntries);
// A pipeline job whose lane needs a service that is not up waits (act mode only)
pipelines.useLaneHolds((project, names) => hostServices.holdFor(project, names));

// The ready guard (agents.fill.ready_guard) reads a project's PRs from its review module's git host
agents.useReadyFacts((project) => {
  const review = reviews.get(project);
  return review ? { facts: (pr) => review.readyFacts(pr) } : undefined;
});
// Every merge hold has one decision (only the owner releases a hold); answering it releases the hold
await reviews.useDecisions(decisionInbox);
// The same for delivery's held services: answering releases the service, as its Release button does
await delivery.useDecisions(decisionInbox);
// Host services decisions: a service that keeps failing raises one; recovering withdraws it
hostServices.useDecisions(decisionInbox);
// Merges, human reviews, finding resolutions and hold releases need the owner's session
await registerReviewRoutes(fastify, reviews, () => getDefaultProject(), humanAuth);

// The agents routes: starting a run, releasing a claim and a fresh session
// need an owner session; modules start runs in-process (agents.requestRun)
await registerAgentsRoutes(fastify, agents, () => getDefaultProject(), humanAuth);

// Failure triage, bisect and revert: one per project with `triage.enabled:
// true` (off by default). Results come in-process from the pipelines
// (gate.completed) or as signed results from trusted nodes; protect, revert
// and releasing a quarantine need the owner's session. Its revert and
// re-check questions go to the Decision Inbox, whose answers resume it.
// Each signed result it accepts is handed to reviews in-process, which keeps
// it for the merge gate when review.merge.gate.from_triage is on
const triage = await mountTriage(fastify, {
  dbPath: join(process.cwd(), "data", "triage.db"),
  events: getEventBus(),
  projects: projectEntries,
  defaultProject: () => getDefaultProject(),
  owner: humanAuth,
  review: reviews,
});
triage.useDecisions(decisionInbox);

// The planner: Lair keeps agents.fill's tasks file itself (docs/design/planner.md). One per project with
// `planner.enabled: true` (off by default). Its planner agent runs through the agents module, in-process; every
// route needs the owner's session; approvals and blocked tasks go to the Decision Inbox.
const planner = await mountPlanner(fastify, {
  dbPath: join(process.cwd(), "data", "planner.db"),
  agents: plannerAgentsFrom(agents),
  events: getEventBus(),
  projects: projectEntries,
  defaultProject: () => getDefaultProject(),
  humanAuth,
});
planner.useDecisions(decisionInbox);

// Placement: one per project with `placement.enabled: true` (off by
// default). It probes the project's machines, estimates when each queued
// job of the project's own gate queue finishes on each lane, and moves jobs
// that would finish sooner elsewhere through the project's move_cmd (act
// mode), or only says so (observe mode). Its route is read-only.
const placements = new PlacementManager({
  dbPath: join(process.cwd(), "data", "placement.db"),
  events: getEventBus(),
});
placements.load(projectEntries);
await registerPlacementRoutes(fastify, placements, () => getDefaultProject());

// Host services routes
registerHostServicesRoutes(fastify, hostServices, humanAuth);

// Cloud machines: one per project with `cloud.enabled: true` (off by
// default). It describes each machine's tagged instance through its
// provider (AWS EC2, credentials from a named profile only), meters the
// spend, reads the provider's cost, and runs the money guard that every
// start goes through. Its routes are the owner's, reads included.
const clouds = new CloudManager({
  dbPath: join(process.cwd(), "data", "cloud.db"),
  events: getEventBus(),
});
clouds.load(projectEntries);
await registerCloudRoutes(fastify, clouds, () => getDefaultProject(), humanAuth);

// Infrastructure monitor (src/server/infra-monitor/): the machines of the
// gate lanes and the jobs on them (machine down under work, job process gone,
// two runners in one slot, no live runner while jobs wait). Off unless a
// project sets `infra_monitor.enabled: true`; observe mode writes nothing.
// Act mode's re-queues are kept in data/infra-monitor-requeues.json.
const infraMonitor = new InfraMonitorManager({
  events: getEventBus(),
  ledgerPath: join(process.cwd(), "data", "infra-monitor-requeues.json"),
});
infraMonitor.load(projectEntries);
infraMonitor.useDecisions(decisionInbox);
await registerInfraMonitorRoutes(fastify, infraMonitor, () => getDefaultProject());

// Agent checks (src/server/checks/): agents test on a runner before they gate.
// One per project with `checks:` configured (off by default). A request needs
// the run's bus token and a run the agents module has running; a run tests the
// branch its first accepted check named, and the sha must be on that branch as
// pushed to the remote.
const checks = new ChecksManager({
  dbPath: join(process.cwd(), "data"),
  outputDir: join(process.cwd(), "data", "checks-output"),
  events: getEventBus(),
  isRunActive: (project, runId, agent) => agentRunIsActive(agents.getStore(), project, runId, agent),
});
checks.load(projectEntries);
// POST takes the run's bus token; GET /:id the token of the run that asked or the owner's session;
// the list and the stats the owner's session only
await registerChecksRoutes(fastify, {
  manager: checks,
  defaultProject: () => getDefaultProject(),
  ownerAuth: humanAuth,
  dataDir: join(process.cwd(), "data"),
});

// The dashboard's own reads (src/server/dashboard/): the nav's module flags,
// a gate's detail from the queue, the pipelines, triage and placement, and
// the owner-only log tails and failing tests
const dashboardSources: DashboardSources = {
  defaultProject: () => getDefaultProject(),
  config: (project) => loadProjectConfig(project),
  data: (project) => getDataService(project),
  agentRuns: (project, limit) => agents.get(project)?.runs(limit) ?? [],
  pipelineRuns: (project, limit) => pipelines.listRuns(project, limit),
  triageRecords: (project, limit) => triage.getStore()?.listRecords(project, { limit }) ?? [],
  placement: (project) => placements.status(project),
  nodeCount: () => getStore().listNodes().length,
};
await registerDashboardRoutes(fastify, dashboardSources, humanAuth);

// The supervisor (src/server/supervisor/): Lair's self-checks on a schedule,
// off the request path (GET /api/health/diagnostics and Home → Health, the
// owner's); a check failing for a while is one notice in the Decision Inbox;
// the read-only ops API an AI supervisor uses (POST /api/ops/call,
// `lair ops-mcp`, `lair ops call`), on scoped tokens kept in memory, every
// call audited in data/supervisor.db; and (off by default) the owner's
// questions and the daily digest, answered by supervisor runs the agents
// module starts in-process, each with a run token in its environment
const { supervisor: selfChecks, chat: supervisorChat } = await mountSupervisor(fastify, {
  dbPath: join(process.cwd(), "data", "supervisor.db"),
  humanAuth,
  defaultProject: () => getDefaultProject(),
  projects: projectEntries,
  latency,
  events: getEventBus(),
  decisions: decisionInbox,
  agents: {
    requestRun: (project, input) => agents.requestRun(project, input),
    getStore: () => agents.getStore(),
    releaseClaim: async (project, task, why) => agents.get(project)?.releaseClaim(task, why),
  },
  serverUrl: dashboardUrlFor(HOST, PORT),
  // The digest's notice is raised only with notifications on (read again each time, as the notifier does)
  notificationsOn: () => notificationsOn(loadNotificationConfig(join(process.cwd(), "data", "server.yaml")).settings),
  // A run token is accepted only while the agents module has its run active
  runActive: (runId) => {
    const run = agents.getStore()?.getRun(runId);
    return run !== null && run !== undefined && isActive(run.state);
  },
  checks: {
    dataDir: join(process.cwd(), "data"),
    config: (project) => loadProjectConfig(project),
    watchers: (project) => fileWatchers.get(project)?.watched() ?? null,
    modules: (project) => {
      let config: ProjectConfig | null = null;
      try {
        config = loadProjectConfig(project);
      } catch {
        config = null;
      }
      return moduleReports({ watchdogs, agents, triage, placements, hostServices, planner, reviews, delivery, pipelines }, project, config);
    },
    agentsStore: () => agents.getStore(),
    agentsOn: (project) => agents.get(project) !== undefined,
    agentDecisions: (project) => decisionInbox.openOf(project, "agents"),
    placement: (project) => placements.status(project),
  },
  ops: {
    config: (project) => loadProjectConfig(project),
    status: {
      watchdog: (project) => watchdogs.status(project),
      agents: (project) => agents.status(project),
      triage: (project) => triage.status(project),
      delivery: (project) => delivery.status(project),
      pipelines: (project) => pipelines.status(project),
      review: (project) => reviews.info(project),
      planner: (project) => planner.status(project),
    },
    agentsStore: () => agents.getStore(),
    serverEvents: () => getEventBus().getRecentEvents(undefined, 1000),
    decisions: (options) => decisionInbox.list(options),
    dashboard: dashboardSources,
    triageRecords: (project, limit) => triage.getStore()?.listRecords(project, { limit }) ?? [],
    placement: (project) => placements.status(project),
  },
});

// Live config reload (src/server/reload/): a changed project file reaches
// the modules whose part of it changed, without a restart; an invalid one
// keeps the previous config running and shows in the dashboard's banner
const reloader = new ConfigReloader({
  modules: serverModules({ delivery, watchdogs, pipelines, reviews, agents, triage, placements, hostServices, clouds, planner, supervisor: selfChecks, infraMonitor }),
  initial: projectEntries,
  events: getEventBus(),
  onAccepted: (project, config) => {
    dataServices.delete(project);
    refreshFileWatcher(project, config);
  },
});
await registerReloadRoutes(fastify, reloader);

// Settings (src/server/settings/): the owner reads and changes every project
// setting from the dashboard. A save is checked by the same parsers as the
// live reload, written atomically to the project file (with a history in
// data/config-history/), and applied by the reloader at once
const settings = new SettingsService({
  dataDir: join(process.cwd(), "data"),
  validate: (config) => reloader.validate(config),
  reload: (project) => reloader.apply(project),
  reloadProblem: (project) => reloader.problemOf(project),
});
await registerSettingsUiRoutes(fastify, { service: settings, auth: humanAuth });

// The owner's Restart and "Update and restart" (src/server/restart/): the
// graceful shutdown below, then exit code 0 for the service manager
const restart = new RestartController({
  configPath: join(process.cwd(), "data", "server.yaml"),
  shutdown: () => shutdown("a restart"),
  exit: (code) => process.exit(code),
  // A merge or a delivery operation running now: Restart answers 409
  busy: () => [...reviews.busy(), ...delivery.busy()],
  // The update gets no token the projects name
  secretEnv: () =>
    configuredTokenEnvs(
      listProjects().flatMap((name) => {
        try {
          return [loadProjectConfig(name)];
        } catch {
          return [];
        }
      }),
    ),
  events: getEventBus(),
});
await registerRestartRoutes(fastify, humanAuth, restart);

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

// Graceful shutdown, once (a signal and the owner's Restart share it); the
// caller exits after it
let stopping: Promise<void> | null = null;
const shutdown = (reason: string): Promise<void> => (stopping ??= stopServer(reason));

const stopServer = async (reason: string) => {
  console.log(`Shutting down gracefully (${reason})...`);

  // Stop watching the project files: no reload starts from now on
  await reloader.stop();

  // Stop the self-checks and the supervisor's runs first: they read the other modules (its store closes with fastify)
  await supervisorChat.stop();
  await selfChecks.stop();

  // Stop watchdogs: wait for a tick in progress, then close their store
  await watchdogs.stop();

  // Stop delivery (after the watchdogs, which read it): a wait in progress
  // ends early and no further command starts; then close its store
  await delivery.stop();

  // Stop pipeline jobs: in-flight attempts stay recorded and resume on restart
  await pipelines.stop();

  // Let a merge in progress finish and record itself, then close the review store
  await reviews.stop();

  // Stop the planner first: it requests runs from the agents module
  await planner.stop();

  // Stop agent supervision: the agents keep running for the next server to adopt, unless a project sets
  // agents.on_restart: stop (then their runs are stopped too, within a bounded wait)
  await agents.stop({ planned: true });
  // Stop triage: wait for calls in progress, then close its store
  await triage.stop();

  // Stop placement: a move in progress is cut short and found again on the next start
  await placements.stop();
  // Stop cloud checks: a check in progress finishes, then the store closes
  await clouds.stop();
  // Stop agent checks: running checks are marked interrupted, stores close
  await checks.stop();

  // Stop host services: probes in progress are cut short
  await hostServices.stop();
  // Stop infra monitor: any tick in progress is cut short
  await infraMonitor.stop();

  // Stop the shared process cache (all modules have stopped, so no one reads it)
  disposeProcessCache();

  // Stop the data cache manager
  dataCacheManager.stopAll();
  queueCaches.stopAll();

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
};

// A shutdown that hangs (a merge or a store that never ends) is given up on
// after SHUTDOWN_DEADLINE_MS, as the owner's Restart does
const exitOnSignal = (signal: string) => {
  void withDeadline(shutdown(`received ${signal}`), SHUTDOWN_DEADLINE_MS, (err) =>
    console.error("Error during shutdown:", err),
  ).then((finished) => {
    if (!finished) console.error(`Shutdown took more than ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting anyway`);
    process.exit(0);
  });
};
process.on("SIGTERM", () => exitOnSignal("SIGTERM"));
process.on("SIGINT", () => exitOnSignal("SIGINT"));

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
    const reviewed = reviews.enabled();
    console.log(
      reviewed.length > 0
        ? `[review] Reviews and policy merge for: ${reviewed.join(", ")}`
        : "[review] Off (no project sets review.enabled)",
    );

    // Start delivery
    const delivering = delivery.start();
    console.log(
      delivering.length > 0
        ? `[delivery] Environments of: ${delivering.join(", ")}`
        : "[delivery] Off (no project sets delivery.enabled)",
    );

    // Resume pipeline jobs that were in flight when the server stopped
    const piped = await pipelines.start();
    if (piped.length > 0) console.log(`[pipelines] Pipelines for: ${piped.join(", ")}`);

    // Start agent supervision
    const supervised = agents.start();
    console.log(
      supervised.length > 0
        ? `[agents] Supervising: ${supervised.join(", ")}`
        : "[agents] Off (no project sets agents.enabled)",
    );

    // Start the planner (after agent supervision: its planner agent is an agents run)
    const planning = planner.start();
    console.log(
      planning.length > 0
        ? `[planner] Planning for: ${planning.join(", ")}`
        : "[planner] Off (no project sets planner.enabled)",
    );

    // Start triage (re-checks waiting for capacity, bisect probes)
    const triaged = triage.start();
    console.log(
      triaged.length > 0
        ? `[triage] Triaging: ${triaged.join(", ")}`
        : "[triage] Off (no project sets triage.enabled)",
    );

    // Start placement (machine probes, estimates, moves or advice)
    const placed = placements.start();
    console.log(
      placed.length > 0
        ? `[placement] Placing jobs for: ${placed.join(", ")}`
        : "[placement] Off (no project sets placement.enabled)",
    );

    // Start host services (service probes, starts in act mode, lane holds)
    const hosting = hostServices.start();
    console.log(
      hosting.length > 0
        ? `[host-services] Watching services for: ${hosting.join(", ")}`
        : "[host-services] Off (no project sets host_services.enabled)",
    );

    // Start cloud checks (describe, meter, cost reading, money guard)
    const metered = clouds.start();
    console.log(
      metered.length > 0
        ? `[cloud] Watching cloud machines for: ${metered.join(", ")}`
        : "[cloud] Off (no project sets cloud.enabled)",
    );

    // Start infra monitor (machine probes, job tracking, notice raising)
    const infraMonitored = infraMonitor.start();
    console.log(
      infraMonitored.length > 0
        ? `[infra-monitor] Watching jobs for: ${infraMonitored.join(", ")}`
        : "[infra-monitor] Off (no project sets infra_monitor.enabled)",
    );

    // Start agent checks (reconcile queued/running from a restart)
    const checking = checks.start();
    console.log(
      checking.length > 0
        ? `[checks] Agent checks for: ${checking.join(", ")}`
        : "[checks] Off (no project sets checks:)",
    );

    // Start file watchers for all projects
    const projects = listProjects();
    for (const projectName of projects) {
      try {
        const config = loadProjectConfig(projectName);
        const watcher = createFileWatcher(wsServer, config);
        fileWatchers.set(projectName, watcher);
        watchedPaths.set(projectName, watchKey(config));
      } catch (err) {
        console.warn(`Failed to start file watcher for ${projectName}:`, err);
      }
    }

    // Lair's self-checks (after the modules and the file watchers they read)
    const checked = selfChecks.start();
    console.log(
      checked.length > 0
        ? `[supervisor] Self-checks for: ${checked.join(", ")}`
        : "[supervisor] Self-checks off (supervisor.checks.enabled: false)",
    );
    // The supervisor's questions and digests: following their runs, and the digest's schedule
    supervisorChat.start();

    // Reload the modules when a project file changes
    reloader.start();
    console.log("[config] Watching projects/ and projects/local/: changes reload the modules they affect");

    console.log(`WebSocket server ready at ws://${HOST}:${PORT}/ws`);
    console.log(`Node WebSocket ready at ws://${HOST}:${PORT}/ws/node`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
