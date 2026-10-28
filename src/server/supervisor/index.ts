/**
 * The supervisor, part 1 (S1-1, docs/design/supervisor.md): Lair's
 * deterministic self-checks, on Home and at GET /api/health/diagnostics
 * (owner only), a failing check as one notice in the Decision Inbox, and
 * the read-only ops API an AI supervisor uses (POST /api/ops/call, served
 * to MCP tools by `lair ops-mcp`), on scoped tokens kept in memory, every
 * call audited in data/supervisor.db.
 *
 * src/server/index.ts calls mountSupervisor(), and the tests call the same
 * function, so what the tests drive is what runs.
 */
import type { FastifyInstance } from "fastify";
import type { EventBus } from "../core/event-bus.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { CheckSources } from "./checks.js";
import type { RequestLatency } from "./latency.js";
import { SystemMeasures, type OsMeasures } from "./measures.js";
import type { OpsSources } from "./ops-tools.js";
import { registerSupervisorRoutes } from "./routes.js";
import { Supervisor, type Clock, type ProjectEntry } from "./service.js";
import { SupervisorStore } from "./store.js";
import { OpsTokens } from "./tokens.js";
import type { CommandTimeoutLog } from "../core/command-timeouts.js";

export { Supervisor, SERVER_SCOPE } from "./service.js";
export { RequestLatency, registerLatencyHook } from "./latency.js";
export { OpsTokens } from "./tokens.js";
export { parseSupervisorConfig, SupervisorSchema } from "./config.js";
export type { CheckSources, ModuleReport } from "./checks.js";
export type { OpsSources } from "./ops-tools.js";

export interface MountSupervisorOptions {
  /** data/supervisor.db in the server; ":memory:" in tests */
  dbPath: string;
  humanAuth: HumanAuth;
  defaultProject(): string;
  projects: ProjectEntry[];
  /** What the checks read */
  checks: CheckSources;
  /** What the ops tools read (diagnostics.run is the supervisor's own) */
  ops: Omit<OpsSources, "diagnostics">;
  latency: RequestLatency;
  events?: EventBus;
  /** The Decision Inbox, for the notices */
  decisions?: DecisionProducer;
  measures?: OsMeasures;
  timeouts?: CommandTimeoutLog;
  clock?: Clock;
  projectsDir?: string;
  callTimeoutMs?: number;
}

export interface SupervisorModule {
  supervisor: Supervisor;
  tokens: OpsTokens;
  store: SupervisorStore;
}

export async function mountSupervisor(fastify: FastifyInstance, options: MountSupervisorOptions): Promise<SupervisorModule> {
  const clock = options.clock ?? { now: () => Date.now() };
  const measures = options.measures ?? new SystemMeasures();
  const store = new SupervisorStore(options.dbPath);
  const tokens = new OpsTokens(() => clock.now());
  const supervisor = new Supervisor({
    sources: options.checks,
    defaultProject: options.defaultProject,
    measures,
    latency: options.latency,
    timeouts: options.timeouts,
    clock,
  });
  supervisor.load(options.projects);
  if (options.decisions) supervisor.useDecisions(options.decisions);

  await registerSupervisorRoutes(fastify, {
    supervisor,
    tokens,
    store,
    auth: options.humanAuth,
    defaultProject: options.defaultProject,
    projectsDir: options.projectsDir,
    clock: () => clock.now(),
    callTimeoutMs: options.callTimeoutMs,
    ops: {
      ...options.ops,
      clock: () => clock.now(),
      diagnostics: async (project) => {
        await supervisor.runNow(project);
        return supervisor.diagnostics(project);
      },
    },
  });

  // A run's tokens end with the run: when the agents module says it ended, or ended in a recovery
  const unsubscribe = ["agent.run.ended", "agent.recovery"].map((type) =>
    options.events?.on(type as "agent.run.ended", (event) => {
      const runId = event.data.runId;
      if (typeof runId === "string") tokens.endRun(runId);
    }),
  );

  fastify.addHook("onClose", async () => {
    for (const off of unsubscribe) off?.();
    await supervisor.stop();
    if (measures instanceof SystemMeasures) measures.dispose();
    store.close();
  });
  return { supervisor, tokens, store };
}
