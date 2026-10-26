/**
 * What triage needs from other modules, as small interfaces, and the
 * built-in adapters behind them.
 *
 * | Interface        | Built in (today)                          | Module that will implement it in-process |
 * |------------------|-------------------------------------------|------------------------------------------|
 * | RecheckExecutor  | triage.commands.recheck                   | runners (POST /api/pipelines/runs)       |
 * | AgentRouter      | triage.commands.notify_agent              | agents (the PR agent's mailbox)          |
 * | TaskSink         | triage.commands.create_task               | planner / intake                         |
 * | DecisionRaiser   | the Decision Inbox (InboxDecisions), else | decisions (connected by the server)      |
 * |                  | raise_decision, else an OWNER? line       |                                          |
 * | RevertOpener     | triage.commands.open_revert               | review / policy (revert PR through gate) |
 * | CapacityProbe    | load and memory limits, capacity_cmd      | runners / scheduler (measured capacity)  |
 * | OwnerGuard       | the owner credential (human-auth)         | (built)                                  |
 *
 * Without a command, a route or a task is still recorded in the store and
 * emitted on the event bus (triage.routed, triage.task_created), so a module
 * that listens can act on it. TriageManager's `adapters` option replaces any
 * of these for a project.
 */
import { cpus, freemem, loadavg } from "os";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Recheck, TriageTask } from "../../shared/triage-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { Clock, CommandRunner } from "../watchdog/probes.js";
import { COMMAND_PLACEHOLDERS, LIST_PLACEHOLDERS, type CommandId, type TriageSettings } from "./config.js";

/** The module name triage raises Decision Inbox decisions as */
export const DECISION_MODULE = "triage";

/**
 * Who may use the human-only routes (protect, unprotect, revert, release a
 * quarantine). The server passes the shared owner credential
 * (src/server/human-auth/ HumanAuth), which has this shape.
 */
export interface OwnerGuard {
  /** A route onRequest hook: 403 unless the request carries the owner's session */
  requireOwner(refusal?: string): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The session requireOwner() verified, to record who acted */
  sessionOf(request: FastifyRequest): { id: string } | undefined;
}

/** Without the owner credential, no request is the owner's. */
export const NO_OWNER: OwnerGuard = {
  requireOwner(refusal = "Only the owner can do this") {
    return async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(403).send({
        success: false,
        error: `${refusal}: the owner credential is not set up on this server`,
        timestamp: new Date().toISOString(),
      });
  },
  sessionOf: () => undefined,
};

export interface AdapterResult {
  ok: boolean;
  detail: string;
  /** The command that ran */
  argv?: string[];
  output?: string;
  /** What the adapter returned: a run id, a task or decision id, a PR URL */
  ref?: string;
}

export interface RecheckExecutor {
  /**
   * Start a re-check and return at once (within recheck.request_timeout_seconds),
   * with the run's id as `ref`. The run's result comes back later as a gate
   * result whose id is that run id (or the re-check's id), with
   * context.recheckId set: in-process, or signed over HTTP.
   */
  request(recheck: Recheck): Promise<AdapterResult>;
}

export interface AgentMessage {
  project: string;
  agent: string;
  recordId: string;
  gateId: string;
  sha: string;
  branch: string;
  pr?: number;
  text: string;
}

export interface AgentRouter {
  route(message: AgentMessage): Promise<AdapterResult>;
}

export interface TaskSink {
  create(task: TriageTask): Promise<AdapterResult>;
}

export interface DecisionChoice {
  /** Lowercase letters, digits, '_' and '-' (the Decision Inbox's option ids) */
  id: string;
  label: string;
  consequences: string;
}

/** What triage asks the human (the Decision Inbox's shape, docs/design/autonomy.md §1). */
export interface DecisionRequest {
  project: string;
  /** Stable id of what it is about, for dedupe: "revert:<incident>", "infra:<failure>" */
  subject: string;
  kind: "escalation" | "other";
  question: string;
  context: string[];
  options: DecisionChoice[];
  /** One of the options' ids */
  recommended: string;
  why: string;
}

export interface DecisionRaiser {
  raise(request: DecisionRequest): Promise<AdapterResult>;
}

/** Raises triage's decisions in the Decision Inbox (src/server/decisions/). */
export class InboxDecisions implements DecisionRaiser {
  constructor(private inbox: DecisionProducer) {}

  async raise(request: DecisionRequest): Promise<AdapterResult> {
    const result = await this.inbox.raise({
      project: request.project,
      kind: request.kind,
      title: oneLine(request.question, 190),
      context: request.context.join("\n\n").slice(0, 19_000),
      options: request.options.map((o) => ({ id: o.id, label: oneLine(o.label, 90), consequences: oneLine(o.consequences, 400) })),
      recommended: { optionId: request.recommended, reasoning: oneLine(request.why, 1900) },
      source: { module: DECISION_MODULE, ref: request.subject },
      key: request.subject,
    });
    const id = result.decision.id;
    return { ok: true, detail: result.created ? `decision ${id} raised` : `decision ${id} is already open`, ref: id };
  }
}

export interface RevertRequest {
  project: string;
  incidentId: string;
  sha: string;
  branch: string;
  reason: string;
  pr?: number;
}

export interface RevertOpener {
  open(request: RevertRequest): Promise<AdapterResult>;
}

export interface CapacityProbe {
  check(): Promise<{ ok: boolean; reason: string }>;
}

export interface TriageAdapters {
  recheck?: RecheckExecutor;
  router?: AgentRouter;
  tasks?: TaskSink;
  decisions?: DecisionRaiser;
  revert?: RevertOpener;
  capacity?: CapacityProbe;
}

// ============ COMMANDS ============

type Vars = Record<string, string | string[]>;

/**
 * Fill an argv template. An argument that is exactly a list placeholder
 * ({steps}, {tests}, {classes}, {options}) becomes one argument per item;
 * inside a longer argument a list is joined with ",". Values come from test
 * reports and logs, so one that would turn an argument into an option (a
 * leading "-" where the template has none) is refused.
 */
export function fillArgv(command: CommandId, template: string[], vars: Vars): { argv: string[] } | { error: string } {
  const allowed = new Set<string>([...COMMAND_PLACEHOLDERS[command], "project"]);
  const argv: string[] = [];
  for (const arg of template) {
    const whole = arg.match(/^\{([A-Za-z_]+)\}$/);
    if (whole && LIST_PLACEHOLDERS.has(whole[1]) && allowed.has(whole[1])) {
      const value = vars[whole[1]];
      const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const item of items) {
        if (item.startsWith("-")) {
          return { error: `triage.commands.${command}: an item of {${whole[1]}} starts with "-" and would be read as an option` };
        }
        argv.push(item);
      }
      continue;
    }
    for (const match of arg.matchAll(/\{([A-Za-z_]+)\}/g)) {
      if (!allowed.has(match[1])) return { error: `triage.commands.${command}: placeholder {${match[1]}} is not allowed` };
      if (vars[match[1]] === undefined) return { error: `triage.commands.${command}: no value for {${match[1]}}` };
    }
    const filled = arg.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => {
      const value = vars[name];
      return Array.isArray(value) ? value.join(",") : (value ?? "");
    });
    if (filled.startsWith("-") && !arg.startsWith("-")) {
      return { error: `triage.commands.${command}: a value starts with "-" and would be read as an option` };
    }
    argv.push(filled);
  }
  return { argv };
}

const OUTPUT_TAIL = 2000;

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/** Run one configured command. */
export async function runCommand(
  runner: CommandRunner,
  command: CommandId,
  template: string[],
  vars: Vars,
  timeoutMs: number,
): Promise<AdapterResult> {
  const built = fillArgv(command, template, vars);
  if ("error" in built) return { ok: false, detail: built.error };
  const out = await runner.run(built.argv, { timeoutMs });
  const output = tail(`${out.stdout}${out.stderr ? `\n${out.stderr}` : ""}`.trim());
  const ref = out.stdout.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300);
  if (out.code !== 0) {
    return { ok: false, detail: `${built.argv[0]} exited ${out.code}`, argv: built.argv, output };
  }
  return { ok: true, detail: `${built.argv[0]} exited 0`, argv: built.argv, output, ref };
}

/** The argv a command would run (observe mode), or null when it can't be built. */
export function plannedArgv(settings: TriageSettings, command: CommandId, vars: Vars): string[] | null {
  const template = settings.commands[command];
  if (!template) return null;
  const built = fillArgv(command, template, vars);
  return "argv" in built ? built.argv : null;
}

export function recheckVars(project: string, recheck: Recheck): Vars {
  return {
    project,
    request: recheck.id,
    purpose: recheck.purpose,
    sha: recheck.sha,
    branch: recheck.branch,
    gate: recheck.gateId,
    steps: recheck.steps,
    tests: recheck.tests,
    classes: recheck.classes,
    attempt: String(recheck.attempt),
  };
}

export function messageVars(message: AgentMessage): Vars {
  return {
    project: message.project,
    agent: message.agent,
    gate: message.gateId,
    sha: message.sha,
    branch: message.branch,
    pr: message.pr === undefined ? "" : String(message.pr),
    record: message.recordId,
    message: message.text,
  };
}

export function taskVars(task: TriageTask): Vars {
  return { project: task.project, kind: task.kind, key: task.key, title: task.title, body: task.body };
}

export function decisionVars(request: DecisionRequest): Vars {
  return {
    project: request.project,
    kind: request.kind,
    subject: request.subject,
    question: request.question,
    context: request.context.join("\n"),
    recommended: request.recommended,
    options: request.options.map((o) => o.id),
  };
}

export function revertVars(request: RevertRequest): Vars {
  return {
    project: request.project,
    sha: request.sha,
    branch: request.branch,
    incident: request.incidentId,
    reason: request.reason,
    pr: request.pr === undefined ? "" : String(request.pr),
  };
}

/** The adapters a project's triage.commands provide. */
export function commandAdapters(settings: TriageSettings, runner: CommandRunner): TriageAdapters {
  const timeoutMs = settings.commandTimeoutSeconds * 1000;
  const c = settings.commands;
  const adapters: TriageAdapters = {};
  if (c.recheck) {
    const template = c.recheck;
    // It only starts the run, so it gets the short request timeout
    const requestMs = settings.recheck.requestTimeoutSeconds * 1000;
    adapters.recheck = {
      request: (recheck) => runCommand(runner, "recheck", template, recheckVars(recheck.project, recheck), requestMs),
    };
  }
  if (c.notify_agent) {
    const template = c.notify_agent;
    adapters.router = { route: (message) => runCommand(runner, "notify_agent", template, messageVars(message), timeoutMs) };
  }
  if (c.create_task) {
    const template = c.create_task;
    adapters.tasks = { create: (task) => runCommand(runner, "create_task", template, taskVars(task), timeoutMs) };
  }
  if (c.raise_decision) {
    const template = c.raise_decision;
    adapters.decisions = {
      raise: (request) => runCommand(runner, "raise_decision", template, decisionVars(request), timeoutMs),
    };
  }
  if (c.open_revert) {
    const template = c.open_revert;
    adapters.revert = { open: (request) => runCommand(runner, "open_revert", template, revertVars(request), timeoutMs) };
  }
  return adapters;
}

// ============ DECISIONS IN THE INBOX FILE ============

function oneLine(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** The `OWNER?` entry the Decision Inbox importers read (same convention as the watchdog's escalations). */
export function formatDecision(request: DecisionRequest, at: string): string {
  const tag = request.subject.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "$1");
  const recommended = request.options.find((o) => o.id === request.recommended)?.label ?? request.recommended;
  const lines = [
    `- OWNER? ${at} [triage:${tag}] ${request.project}: ${oneLine(request.question)} Options: ${request.options.map((o) => o.label).join(" | ")} (recommended: ${recommended}). ${oneLine(request.why)}`,
    ...request.context.map((c) => `  - ${oneLine(c)}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Appends decisions to a file (the project's decision_file or inbox_file). */
export class InboxDecisionRaiser implements DecisionRaiser {
  constructor(
    private file: string,
    private fs: { append(path: string, text: string): void },
    private clock: Clock,
  ) {}

  async raise(request: DecisionRequest): Promise<AdapterResult> {
    try {
      this.fs.append(this.file, formatDecision(request, new Date(this.clock.now()).toISOString()));
      return { ok: true, detail: `appended to ${this.file}`, ref: this.file };
    } catch (e) {
      return { ok: false, detail: `could not write ${this.file}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

// ============ CAPACITY ============

export interface MachineStats {
  loadPerCore: number;
  freeMemoryMb: number;
}

export function systemStats(): MachineStats {
  return { loadPerCore: loadavg()[0] / Math.max(1, cpus().length), freeMemoryMb: freemem() / (1024 * 1024) };
}

/** Capacity from triage.recheck limits: load per core, free memory and capacity_cmd (exit 0 = capacity). */
export class LimitsCapacity implements CapacityProbe {
  constructor(
    private limits: TriageSettings["recheck"],
    private runner: CommandRunner,
    private stats: () => MachineStats = systemStats,
    private timeoutMs = 30_000,
  ) {}

  async check(): Promise<{ ok: boolean; reason: string }> {
    const { maxLoadPerCore, minFreeMemoryMb, capacityCmd } = this.limits;
    if (maxLoadPerCore !== undefined || minFreeMemoryMb !== undefined) {
      const stats = this.stats();
      if (maxLoadPerCore !== undefined && stats.loadPerCore > maxLoadPerCore) {
        return { ok: false, reason: `load per core ${stats.loadPerCore.toFixed(2)} is above ${maxLoadPerCore}` };
      }
      if (minFreeMemoryMb !== undefined && stats.freeMemoryMb < minFreeMemoryMb) {
        return { ok: false, reason: `free memory ${Math.round(stats.freeMemoryMb)} MB is below ${minFreeMemoryMb} MB` };
      }
    }
    if (capacityCmd) {
      const out = await this.runner.run(capacityCmd, { timeoutMs: this.timeoutMs });
      if (out.code !== 0) {
        const said = `${out.stdout}${out.stderr}`.trim().split("\n")[0] ?? "";
        return { ok: false, reason: `${capacityCmd[0]} exited ${out.code}${said ? `: ${said.slice(0, 200)}` : ""}` };
      }
      return { ok: true, reason: `${capacityCmd[0]} reports capacity` };
    }
    return { ok: true, reason: maxLoadPerCore !== undefined || minFreeMemoryMb !== undefined ? "within limits" : "no capacity limits set" };
  }
}
