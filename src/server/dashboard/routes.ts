/**
 * The dashboard's own read routes: what the other modules' routes don't
 * expose yet, for the sections' nav and detail views.
 *
 *   GET /api/dashboard/modules?project=                which modules the project turns on (the nav)
 *   GET /api/dashboard/gates/:id?project=              a gate: track, sha, branch, lane, machine, steps
 *                                                      with results and durations, triage's verdict, placement
 *   GET /api/dashboard/gates/:id/output?project=&lines= owner: its log tail and failing tests with messages
 *   GET /api/dashboard/agents/:id/log?project=&lines=  owner: an agent's log tail
 *
 * Logs and test output can hold anything a test or an agent printed
 * (tokens, customer data), so they are the owner's: requireOwner() runs
 * before anything is read, and the answer is bounded (services/log-tail.ts,
 * gate-detail.ts). Every route only reads. /api/dashboard is in
 * OWNER_ONLY_PREFIXES, so no CORS is granted for it. `?project=` is
 * validated by the root guards (src/server/root-guards.ts); without it the
 * default project is used.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { statSync } from "fs";
import { resolve, sep } from "path";
import { z } from "zod";
import { rejectCrossSiteRequests } from "../origin.js";
import { requireValidIdParam } from "../root-guards.js";
import { isSafeGateId, type DataService } from "../services/data.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { clampLines, readLogTail } from "../services/log-tail.js";
import type { HumanAuth } from "../human-auth/index.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentRunView } from "../../shared/agents-types.js";
import type { PipelineRun } from "../../shared/pipeline-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import type { TriageRecord } from "../../shared/triage-types.js";
import type { AgentLogView, DashboardModules, GateDetailView, GateOutputView } from "../../shared/dashboard-types.js";
import { NO_MODULES, moduleFlags } from "./modules.js";
import {
  findPipelineRun,
  gateOutput,
  pipelineGateDetail,
  pipelineIds,
  pipelineLog,
  queueGateDetail,
  triageGateDetail,
  triageRecordFor,
} from "./gate-detail.js";

/** How many pipeline runs, agent runs and triage records a lookup reads */
export const LOOKUP_LIMIT = 200;

/** What the routes read, from the modules the server runs. Every module but the config and files is optional. */
export interface DashboardSources {
  defaultProject(): string;
  /** The project's config; throws when it can't be read */
  config(project: string): ProjectConfig;
  /** The project's gates_dir and agents_dir reader */
  data(project: string): Pick<DataService, "getGateRecord" | "getGateLogText" | "getGateLogTail" | "getDragonLogPath">;
  /** The agents module's runs, newest first ([] when it is off) */
  agentRuns?(project: string, limit: number): AgentRunView[];
  /** Lair pipeline runs, newest first */
  pipelineRuns?(project: string, limit: number): PipelineRun[];
  /** Triage's records, newest first */
  triageRecords?(project: string, limit: number): TriageRecord[];
  /** Placement's status (enabled: false when it is off) */
  placement?(project: string): PlacementStatus | null;
  /** Registered lair-node machines */
  nodeCount?(): number;
}

function respond<T>(data: T) {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ success: false, error, timestamp: new Date().toISOString() });
}

/**
 * What a caller is told when a read fails unexpectedly, or a project's
 * config can't be read: never the error's own text, which can name paths on
 * this machine. The error goes to the server log.
 */
export const READ_FAILED = "Lair could not read this: the server log says why";
export const CONFIG_UNREADABLE = "The project's config could not be read: the server log says why";

/**
 * Whether a project's controls are off. Like every module (services/command.ts
 * isReadOnly, the agents, review, pipelines, delivery ...), only `read_only: true`
 * turns them off: a config without the key has them on.
 */
export function isReadOnly(config: Pick<ProjectConfig, "read_only">): boolean {
  return config.read_only === true;
}

const ProjectQuery = z.object({ project: z.string().optional() });
const LinesQuery = ProjectQuery.extend({ lines: z.string().max(10).optional() });

/** A module's reader that fails answers as if the module had nothing: the detail still shows what the others know. */
function tryRead<T>(read: (() => T) | undefined, fallback: T): T {
  if (!read) return fallback;
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** True when `path` is inside `dir` (after resolving both). */
function inside(dir: string, path: string): boolean {
  const root = resolve(dir);
  const target = resolve(path);
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export async function registerDashboardRoutes(
  fastify: FastifyInstance,
  sources: DashboardSources,
  auth: HumanAuth,
): Promise<void> {
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // Before anything is read: a refused request learns nothing
    const owner = auth.requireOwner("Only the owner can read logs and test output, from the dashboard signed in as the owner");
    const gateId = requireValidIdParam(isSafeGateId, "gate");
    const agentId = requireValidIdParam(isValidDragonId, "agent");

    const projectOf = (query: { project?: string }) => query.project ?? sources.defaultProject();

    /** The gate an id names, and what is needed for its output. */
    const lookUp = (project: string, id: string) => {
      const data = sources.data(project);
      const records = tryRead(() => sources.triageRecords?.(project, LOOKUP_LIMIT) ?? [], [] as TriageRecord[]);
      const placement = tryRead(() => sources.placement?.(project) ?? null, null as PlacementStatus | null);
      const record = data.getGateRecord(id);
      if (record.gate || record.result || record.logPath) {
        const logText = data.getGateLogText(id);
        const triage = triageRecordFor(records, [id]);
        const detail = queueGateDetail(project, id, { ...record, logText }, { triage, placement });
        return { detail, triage, logText, run: null as PipelineRun | null };
      }
      const runs = tryRead(() => sources.pipelineRuns?.(project, LOOKUP_LIMIT) ?? [], [] as PipelineRun[]);
      const run = findPipelineRun(runs, id);
      if (run) {
        const triage = triageRecordFor(records, pipelineIds(run));
        return { detail: pipelineGateDetail(project, id, run, { triage, placement }), triage, logText: null, run };
      }
      const triage = triageRecordFor(records, [id]);
      if (triage) return { detail: triageGateDetail(project, id, triage), triage, logText: null, run: null };
      return null;
    };

    app.get("/api/dashboard/modules", async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const project = projectOf(query.data);
      const nodes = tryRead(() => sources.nodeCount?.() ?? 0, 0);
      let view: DashboardModules;
      try {
        const config = sources.config(project);
        view = { project, readOnly: isReadOnly(config), error: null, modules: moduleFlags(config, nodes) };
      } catch (e) {
        request.log.warn({ err: e, project }, "dashboard: the project's config could not be read");
        view = { project, readOnly: true, error: CONFIG_UNREADABLE, modules: { ...NO_MODULES, nodes: nodes > 0 } };
      }
      return respond(view);
    });

    app.get<{ Params: { id: string } }>("/api/dashboard/gates/:id", { preHandler: gateId }, async (request, reply) => {
      const query = ProjectQuery.safeParse(request.query ?? {});
      if (!query.success) return fail(reply, 400, "Invalid query");
      const project = projectOf(query.data);
      try {
        const found = lookUp(project, request.params.id);
        if (!found) return fail(reply, 404, `No gate ${request.params.id} in ${project}: not in the queue, the results, the pipeline runs or triage`);
        return respond<GateDetailView>(found.detail);
      } catch (e) {
        request.log.error({ err: e }, "dashboard: a gate's detail could not be read");
        return fail(reply, 500, READ_FAILED);
      }
    });

    app.get<{ Params: { id: string } }>(
      "/api/dashboard/gates/:id/output",
      { onRequest: owner, preHandler: gateId },
      async (request, reply) => {
        const query = LinesQuery.safeParse(request.query ?? {});
        if (!query.success) return fail(reply, 400, "Invalid query");
        const project = projectOf(query.data);
        const lines = clampLines(query.data.lines);
        try {
          const found = lookUp(project, request.params.id);
          if (!found) return fail(reply, 404, `No gate ${request.params.id} in ${project}`);
          const id = request.params.id;
          const log = found.run
            ? pipelineLog(found.run, lines)
            : found.detail.source === "queue"
              ? sources.data(project).getGateLogTail(id, lines)
              : null;
          const output: GateOutputView = gateOutput(id, log, found.triage, {
            logText: found.logText,
            failedSteps: found.detail.failedSteps,
          });
          return respond(output);
        } catch (e) {
          request.log.error({ err: e }, "dashboard: an owner read failed");
          return fail(reply, 500, READ_FAILED);
        }
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/dashboard/agents/:id/log",
      { onRequest: owner, preHandler: agentId },
      async (request, reply) => {
        const query = LinesQuery.safeParse(request.query ?? {});
        if (!query.success) return fail(reply, 400, "Invalid query");
        const project = projectOf(query.data);
        const lines = clampLines(query.data.lines);
        const id = request.params.id;
        try {
          const config = sources.config(project);
          const runs = tryRead(() => sources.agentRuns?.(project, LOOKUP_LIMIT) ?? [], [] as AgentRunView[]);
          // The agents module names its run logs; only one in agents_dir is read
          const run = runs.find((r) => r.agent === id && typeof r.logPath === "string" && inside(config.agents_dir, r.logPath));
          const runPath = run?.logPath ?? null;
          const dragonPath = sources.data(project).getDragonLogPath(id);
          let view: AgentLogView = { agent: id, source: null, runId: null, log: null };
          // The newer of the two (a launcher outside Lair may have written since)
          if (runPath && (!dragonPath || runPath === dragonPath || mtimeOf(runPath) >= mtimeOf(dragonPath))) {
            view = { agent: id, source: "run", runId: run?.id ?? null, log: readLogTail(runPath, lines) };
          } else if (dragonPath) {
            view = { agent: id, source: "dragon", runId: null, log: readLogTail(dragonPath, lines) };
          }
          return respond(view);
        } catch (e) {
          request.log.error({ err: e }, "dashboard: an owner read failed");
          return fail(reply, 500, READ_FAILED);
        }
      },
    );
  });
}
