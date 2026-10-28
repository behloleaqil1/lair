/**
 * The ops API's tools, server side: each reads one module through its own
 * API (never its files directly, except through the dashboard's readers for
 * logs and gates), with bounded arguments. The route (routes.ts) checks the
 * token and the project, audits the call, times it out, and redacts and
 * bounds what is returned (redact.ts).
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { Decision } from "../../shared/decision-types.js";
import type { Event } from "../../shared/server-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import type { TriageRecord } from "../../shared/triage-types.js";
import type { AgentEventKind } from "../../shared/agents-types.js";
import type { DiagnosticsView } from "../../shared/supervisor-types.js";
import type { AgentsStore } from "../agents/store.js";
import { eventView, runView } from "../agents/types.js";
import type { ListOptions } from "../decisions/store.js";
import { agentLogTail, gateLogTail, lookUpGate, type DashboardSources } from "../dashboard/routes.js";
import { isSafeGateId } from "../services/data.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { STATUS_MODULES, type OpsToolSpec, type StatusModule } from "./ops-catalog.js";
import { redactConfig, redactText } from "./redact.js";

export class OpsError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** What the tools read, from the modules the server runs. */
export interface OpsSources {
  /** The project's config; throws when it can't be read */
  config(project: string): ProjectConfig;
  /** status.<module>: each module's own status route's answer */
  status: Partial<Record<StatusModule, (project: string) => unknown>>;
  agentsStore?(): AgentsStore | null;
  /** The server's recent events (the event bus keeps the last 1000 in memory) */
  serverEvents?(): Event[];
  decisions?(options: ListOptions): Decision[];
  /** The dashboard's readers: gates, their logs, agents' logs */
  dashboard?: DashboardSources;
  triageRecords?(project: string, limit: number): TriageRecord[];
  placement?(project: string): PlacementStatus | null;
  /** Run the self-checks now (rate-limited) and return their results */
  diagnostics(project: string): Promise<DiagnosticsView>;
  clock?: () => number;
}

const DAY = 86_400_000;
const MAX_SPAN = 7 * DAY;
const LOG_LINE = 500;

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

function time(value: unknown, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) throw new OpsError(400, `${what} is not a time`);
  return t;
}

async function eventsQuery(project: string, args: Args, s: OpsSources, caller: OpsCaller) {
  const now = (s.clock ?? Date.now)();
  // Server events that name no project (nodes, jobs, tasks...) are Lair-wide: only a token for every project sees
  // them, and only when it asks about no project in particular
  const unscoped = caller.allProjects && !caller.projectGiven;
  const until = time(args.until, now, "until");
  const since = time(args.since, until - DAY, "since");
  if (since > until) throw new OpsError(400, "since is after until");
  if (until - since > MAX_SPAN) throw new OpsError(400, "the range is longer than 7 days: ask for a shorter one");
  const limit = num(args.limit, 50);
  const kinds = Array.isArray(args.kinds) ? (args.kinds as string[]) : undefined;
  const agent = str(args.agent);
  const task = str(args.task);
  const runId = str(args.run_id);
  if (args.source === "server") {
    const events = (s.serverEvents?.() ?? [])
      .filter((e) => {
        const at = Date.parse(e.timestamp);
        const d = e.data;
        return (
          at >= since &&
          at <= until &&
          (d.project === project || (unscoped && d.project === undefined)) &&
          (!kinds || kinds.includes(e.type)) &&
          (agent === undefined || d.agent === agent) &&
          (task === undefined || d.task === task) &&
          (runId === undefined || d.runId === runId)
        );
      })
      .reverse()
      .slice(0, limit)
      .map((e) => ({ id: e.id, type: e.type, at: e.timestamp, data: e.data }));
    return { project, source: "server", since: new Date(since).toISOString(), until: new Date(until).toISOString(), events };
  }
  const store = s.agentsStore?.() ?? null;
  if (!store) return { project, source: "agents", events: [], note: "the agents module runs for no project" };
  const events = store
    .listEvents(project, { kinds: kinds as AgentEventKind[] | undefined, agent, task, runId, since, limit: Math.min(1000, limit * 4) })
    .filter((e) => e.at <= until)
    .slice(0, limit)
    .map((e) => {
      const v = eventView(e);
      return { ...v, evidence: v.evidence.slice(0, 10) };
    });
  return { project, source: "agents", since: new Date(since).toISOString(), until: new Date(until).toISOString(), events };
}

function decisionsList(project: string, args: Args, s: OpsSources) {
  if (!s.decisions) throw new OpsError(503, "the Decision Inbox isn't running");
  const status = (str(args.status) ?? "open") as ListOptions["status"];
  const attention = str(args.attention) as ListOptions["attention"];
  const decisions = s.decisions({ project, status, attention, limit: num(args.limit, 25) });
  return {
    project,
    decisions: decisions.map((d) => ({
      id: d.id,
      kind: d.kind,
      attention: d.attention,
      status: d.status,
      title: d.title,
      context: d.context.slice(0, 1500),
      options: d.options.map((o) => ({ id: o.id, label: o.label })),
      recommended: d.recommended.optionId,
      source: d.source,
      key: d.key,
      blocks: d.blocks,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt ?? null,
      closedAt: d.closedAt ?? null,
      answer: d.answer?.optionId ?? null,
      raisedVia: d.raisedVia,
    })),
  };
}

function runsGet(project: string, args: Args, s: OpsSources) {
  const store = s.agentsStore?.() ?? null;
  if (!store) throw new OpsError(404, "the agents module runs for no project");
  const id = str(args.id);
  const agent = str(args.agent);
  if (id === undefined && agent === undefined) throw new OpsError(400, "give id (a run) or agent (its latest runs)");
  if (id !== undefined) {
    const run = store.getRun(id);
    if (!run || run.project !== project) throw new OpsError(404, `no run ${id} in ${project}`);
    const chain = store.chainRuns(run.chainId).slice(-20);
    return {
      project,
      run: runView(run),
      chain: chain.map((r) => ({ id: r.id, attempt: r.attempt, state: r.state, detail: r.detail, endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null })),
      events: store.listEvents(project, { runId: id, limit: 50 }).map(eventView),
    };
  }
  const runs = store
    .listRuns(project, { limit: 500 })
    .filter((r) => r.agent === agent)
    .slice(0, num(args.limit, 5))
    .map(runView);
  return { project, agent, runs };
}

function logsTail(project: string, args: Args, s: OpsSources) {
  const agent = str(args.agent);
  const gate = str(args.gate);
  if ((agent === undefined) === (gate === undefined)) throw new OpsError(400, "give one of agent or gate");
  if (!s.dashboard) throw new OpsError(503, "the dashboard's readers aren't available");
  const lines = num(args.lines, 50);
  const clean = (view: { file: string; lines: string[]; truncated: boolean; modifiedAt: string } | null) =>
    view
      ? { file: redactText(view.file, 200), lines: view.lines.slice(-lines).map((l) => redactText(l, LOG_LINE)), truncated: view.truncated, modifiedAt: view.modifiedAt }
      : null;
  if (agent !== undefined) {
    if (!isValidDragonId(agent)) throw new OpsError(400, "agent is not an agent id");
    const view = agentLogTail(s.dashboard, project, agent, lines);
    return { project, agent, source: view.source, runId: view.runId, log: clean(view.log) };
  }
  if (!isSafeGateId(gate)) throw new OpsError(400, "gate is not a gate id");
  const found = lookUpGate(s.dashboard, project, gate);
  if (!found) throw new OpsError(404, `no gate ${gate} in ${project}`);
  return { project, gate, log: clean(gateLogTail(s.dashboard, project, gate, found, lines)) };
}

function gatesResult(project: string, args: Args, s: OpsSources) {
  if (!s.dashboard) throw new OpsError(503, "the dashboard's readers aren't available");
  const id = str(args.id);
  if (id === undefined) {
    const results = s.dashboard.data(project).getRecentGateResults(num(args.hours, 24), num(args.limit, 20));
    return { project, results };
  }
  if (!isSafeGateId(id)) throw new OpsError(400, "id is not a gate id");
  const found = lookUpGate(s.dashboard, project, id);
  if (!found) throw new OpsError(404, `no gate ${id} in ${project}: not in the queue, the results, the pipeline runs or triage`);
  return {
    project,
    gate: found.detail,
    triage: found.triage ? { id: found.triage.id, verdict: found.triage.verdict ?? null, blocking: found.triage.blocking, resolution: found.triage.resolution ?? null } : null,
  };
}

function triageRecord(project: string, args: Args, s: OpsSources) {
  if (!s.triageRecords) throw new OpsError(503, "triage isn't running");
  const id = str(args.id);
  const gate = str(args.gate);
  const limit = num(args.limit, 10);
  if (id !== undefined) {
    const record = s.triageRecords(project, 500).find((r) => r.id === id);
    if (!record) throw new OpsError(404, `no triage record ${id} in ${project}`);
    return { project, records: [record] };
  }
  const records = s.triageRecords(project, gate === undefined ? limit : 500);
  return { project, records: (gate === undefined ? records : records.filter((r) => r.gateId === gate)).slice(0, limit) };
}

/** Who calls, as far as a tool's answer depends on it */
export interface OpsCaller {
  /** The token reads every project (an owner's session token), not one project (a run's) */
  allProjects: boolean;
  /** The call named its project (else the default project was taken) */
  projectGiven: boolean;
}

/** The narrowest caller: one project, named */
const SCOPED: OpsCaller = { allProjects: false, projectGiven: true };

/** Run one tool for `project` (already checked against the token). Throws OpsError for a refusal. */
export async function runOpsTool(
  spec: OpsToolSpec,
  project: string,
  args: Args,
  s: OpsSources,
  caller: OpsCaller = SCOPED,
): Promise<unknown> {
  if (spec.name.startsWith("status.")) {
    const module = spec.name.slice("status.".length) as StatusModule;
    if (!STATUS_MODULES.includes(module)) throw new OpsError(404, `unknown tool ${spec.name}`);
    const status = s.status[module];
    if (!status) return { project, module, enabled: false, note: "this module isn't running in this server" };
    return { project, module, status: await status(project) };
  }
  switch (spec.name) {
    case "events.query":
      return eventsQuery(project, args, s, caller);
    case "decisions.list":
      return decisionsList(project, args, s);
    case "runs.get":
      return runsGet(project, args, s);
    case "logs.tail":
      return logsTail(project, args, s);
    case "gates.result":
      return gatesResult(project, args, s);
    case "triage.record":
      return triageRecord(project, args, s);
    case "placement.status":
      return { project, placement: s.placement?.(project) ?? { project, enabled: false } };
    case "config.get":
      return { project, config: redactConfig(s.config(project)) };
    case "diagnostics.run":
      return s.diagnostics(project);
    default:
      throw new OpsError(404, `unknown tool ${spec.name}`);
  }
}

/** The arguments as the tool takes them: unknown ones refused. */
export function parseArgs(spec: OpsToolSpec, raw: unknown): { ok: true; args: Args } | { ok: false; error: string } {
  const parsed = z.object(spec.shape).strict().safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as Args };
  return {
    ok: false,
    error: parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
      .join("; "),
  };
}
