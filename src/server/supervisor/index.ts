/**
 * The supervisor (docs/design/supervisor.md).
 *
 * Part 1 (S1-1): Lair's deterministic self-checks, on Home and at
 * GET /api/health/diagnostics (owner only), a failing check as one notice in
 * the Decision Inbox, and the read-only ops API an AI supervisor uses
 * (POST /api/ops/call, served to MCP tools by `lair ops-mcp` and to any
 * other tool by `lair ops call`), on scoped tokens kept in memory, every
 * call audited in data/supervisor.db.
 *
 * Part 2 (S1-2, chat.ts): the owner's questions (POST /api/supervisor/ask)
 * and the daily digest, each answered by a supervisor run the agents module
 * starts, with a run token in its environment; the run submits its answer
 * with `lair supervisor answer` (POST /api/ops/answer).
 *
 * src/server/index.ts calls mountSupervisor(), and the tests call the same
 * function, so what the tests drive is what runs.
 */
import type { FastifyInstance } from "fastify";
import type { Decision } from "../../shared/decision-types.js";
import type { EventBus } from "../core/event-bus.js";
import type { ListOptions } from "../decisions/store.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { CheckSources } from "./checks.js";
import { SupervisorChat, type ChatAgents } from "./chat.js";
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
export { parseSupervisorConfig, SupervisorSchema, type ActSettings } from "./config.js";
export { SupervisorChat, ChatError } from "./chat.js";
export { SupervisorAct } from "./act.js";
export { parseActConfig, defaultActSettings, actEnabled, opAllowed, ACT_OPS, type ActOp } from "./act-config.js";
export type { ChatAgents } from "./chat.js";
export type { CheckSources, ModuleReport } from "./checks.js";
export type { OpsSources } from "./ops-tools.js";
export type { ActEvidence, ActResult, ActModules } from "./act-ops.js";

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
  /**
   * Whether a run is still active, from the agents module's store: a run
   * token is refused once its run has ended, however it ended
   */
  runActive?: (runId: string) => boolean;
  /** The agents module, which starts the supervisor's runs (without it, questions and digests are refused) */
  agents?: ChatAgents;
  /** This server's address, given to supervisor runs as LAIR_URL */
  serverUrl?: string;
  /** Lair's notifications are on (data/server.yaml): a digest then raises its notice */
  notificationsOn?: () => boolean;
  /** How supervisor runs call Lair's CLI (default: the built one next to the server, else `lair`) */
  cli?: string;
  /** Lair's own supervisor prompt (default: prompts/supervisor.md) */
  defaultPromptPath?: string;
}

/** The agents module's events after which a run is over: its tokens end at once (runActive is the backstop) */
const RUN_OVER_EVENTS = ["agent.run.ended", "agent.recovery", "agent.failover"] as const;

export interface SupervisorModule {
  supervisor: Supervisor;
  tokens: OpsTokens;
  store: SupervisorStore;
  chat: SupervisorChat;
}

export async function mountSupervisor(fastify: FastifyInstance, options: MountSupervisorOptions): Promise<SupervisorModule> {
  const clock = options.clock ?? { now: () => Date.now() };
  const measures = options.measures ?? new SystemMeasures();
  const store = new SupervisorStore(options.dbPath);
  const tokens = new OpsTokens(() => clock.now(), { runActive: options.runActive });
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

  const chat = new SupervisorChat({
    supervisor,
    store,
    tokens,
    agents: options.agents,
    config: (project) => options.ops.config(project),
    decisions: options.ops.decisions ? (o: ListOptions): Decision[] => options.ops.decisions!(o) : undefined,
    inbox: options.decisions,
    notificationsOn: options.notificationsOn,
    serverUrl: options.serverUrl,
    clock: () => clock.now(),
    cli: options.cli,
    defaultPromptPath: options.defaultPromptPath,
  });
  // A question still waiting from before a restart can't be answered: its token was in the old process's memory
  await chat.recover();

  await registerSupervisorRoutes(fastify, {
    supervisor,
    tokens,
    store,
    chat,
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

  // A run's tokens end with the run: when the agents module says it ended, ended in a recovery, or failed over. A
  // failover is also recorded when a run starts on its next profile and goes on: then the store still has it active.
  // The chat then follows its questions soon, so one whose run ended without an answer is closed
  const unsubscribe = RUN_OVER_EVENTS.map((type) =>
    options.events?.on(type, (event) => {
      const runId = event.data.runId;
      if (typeof runId !== "string") return;
      if (type === "agent.failover" && options.runActive?.(runId)) return;
      tokens.endRun(runId);
      chat.soon();
    }),
  );

  fastify.addHook("onClose", async () => {
    for (const off of unsubscribe) off?.();
    await chat.stop();
    await supervisor.stop();
    if (measures instanceof SystemMeasures) measures.dispose();
    store.close();
  });
  return { supervisor, tokens, store, chat };
}
