/**
 * The planner service (docs/design/planner.md): one per project with
 * `planner.enabled`. Every planner.interval_seconds a cycle:
 *
 * 1. reads the tasks file and compares it with what Lair last wrote or
 *    accepted (an edit by someone else is recorded; in act mode one made while
 *    a planner run is active is put back and the run's proposals refused);
 * 2. reads the sources (plans, backlogs, owner messages, new queue lines);
 * 3. the deterministic part: a task the queue reports done (fill's checkDone)
 *    is marked done, one the plan marks done is dropped; written atomically
 *    in act mode, recorded as planned in observe mode;
 * 4. routes new BLOCKED lines (owner and environment: a decision; a task
 *    problem: a planner run, within attempts_per_task) and collects triggers
 *    (DONE with no next task, idle agents, owner messages, plan changes);
 * 5. follows the planner run in progress, or starts one when triggers are
 *    pending, debounced and at least min_interval_seconds apart.
 *
 * A finished run's proposal file is checked (proposals.ts). Accepted
 * proposals are applied (act mode, ops without approval: always) or wait for
 * the owner, in the Planner view and as one Decision Inbox item per run.
 * Cycles and the owner's actions run one at a time.
 */
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { EventType } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  BlockedClass,
  BlockedView,
  ChangeSource,
  ChangeView,
  PlannerOverviewView,
  PlannerRunView,
  PlannerStatusView,
  PlanTaskView,
  ProposalStatus,
  ProposalView,
  SourceStatusView,
  TriggerKind,
  TriggerView,
  VerifierVerdict,
} from "../../shared/planner-types.js";
import type { DecisionProducer, DecisionResolution, RaiseDecisionInput } from "../decisions/types.js";
import { buildPrompt, checkDone, MAX_TASKS_FILE_BYTES, QueueLines, queueWindowEnd, type DoneCheck } from "../agents/fill.js";
import { doneLineMatches, fillPatternFor } from "../agents/config.js";
import { utcStamp } from "../agents/sessions.js";
import { isActive, type QueueMark } from "../agents/types.js";
import { getPromptsDir } from "../routes/controls.js";
import { loadKnownDragons } from "../services/dragon-registry.js";
import type { PlannerAgents } from "./agents.js";
import { classifyBlocked } from "./blocked.js";
import type { OwnerSourceSettings, PlannerSettings, PlanSourceSettings, QueueSourceSettings } from "./config.js";
import { buildContext, plannerSection } from "./context.js";
import { clean, readTasksFile, sha256, writeTasksFile } from "./files.js";
import { checkProposals, isOp, PROPOSAL_FILE, readProposalFile, type CheckContext } from "./proposals.js";
import {
  namesTask,
  readOwnerMessages,
  readPlanSource,
  readQueueEvents,
  reasonOf,
  type OwnerMessage,
  type PlanTask,
  type QueueEvent,
} from "./sources.js";
import { proposalView, type ChangeInput, type PlannerStore, type StoredProposal, type StoredRun } from "./store.js";
import { applyEdit, diffOf, diffTexts, findTask, parseTasksDoc, renderLine, type TaskEdit, type TasksDoc } from "./tasks-file.js";
import { parseVerdicts, readVerdictsFile, verifierSection, VERDICTS_FILE } from "./verifier.js";

/** The module name the planner raises decisions as. */
export const DECISION_MODULE = "planner";

/** A run's prompt is at most this long (the agents module's limit is 200,000) */
const PROMPT_LIMIT = 190_000;
const MAX_TRIGGERS = 50;
const MAX_RECENT_EVENTS = 100;
const MAX_SEEN_MESSAGES = 500;
const MAX_BLOCKED = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** An error with the HTTP status the routes answer with. */
export class PlannerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (id: string) => id.slice(0, 8);
const iso = (ms: number) => new Date(ms).toISOString();

/** State keys (planner_state) */
const KNOWN = "known";
const INTENT = "intent";
const CURSOR = "queue_cursor";
const SEEN = "seen_messages";
const HASHES = "source_hashes";
const TRIGGERS = "triggers";
const LAST_TRIGGER = "last_trigger_at";
const LAST_RUN = "last_run_at";
const FAILURES = "failures";
const PAUSED = "paused";
const IDLE = "idle_fingerprint";
const BLOCKED = "blocked";
const RECENT = "recent_events";
const BASELINE = "baseline";

interface Known {
  hash: string;
  text: string;
}

/** A write in progress: the history it records once the rename has happened. */
interface Intent {
  afterHash: string;
  text: string;
  changes: ChangeInput[];
}

interface BlockedRecord {
  task: string;
  agent: string | null;
  reason: string;
  class: BlockedClass;
  rule: string;
  at: number;
  route: string;
  /** The owner kept it blocked while the task's line was this: BLOCKED lines are left alone until it changes */
  kept?: string;
}

/** A change to make: an edit of the tasks file, and its record. */
interface PlannedChange {
  edit: TaskEdit;
  source: ChangeSource;
  reason: string;
  agent: string | null;
  runId?: string;
  proposalId?: string;
}

export interface PlannerServiceOptions {
  project: string;
  config: ProjectConfig;
  settings: PlannerSettings;
  store: PlannerStore;
  agents: PlannerAgents;
  clock: { now(): number };
  events?: EventBus;
  /** The Decision Inbox, when the server has connected it (read on each use) */
  decisions: () => DecisionProducer | null;
}

function withReadiness(tasks: PlanTask[]): PlanTaskView[] {
  const done = new Map<string, boolean>();
  for (const t of tasks) if (t.id !== null) done.set(t.id, t.done);
  return tasks.map((t) => {
    const waitingOn = t.dependsOn.filter((d) => done.get(d) !== true);
    return { ...t, ready: !t.done && waitingOn.length === 0, waitingOn };
  });
}

export class PlannerService {
  readonly project: string;
  readonly settings: PlannerSettings;
  private config: ProjectConfig;
  private store: PlannerStore;
  private agents: PlannerAgents;
  private clock: { now(): number };
  private events?: EventBus;
  private decisions: () => DecisionProducer | null;
  private queue: Promise<unknown> = Promise.resolve();
  private cycling: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private lastCycle: number | null = null;
  private lastError: string | null = null;
  /** A problem this cycle got past (a write that failed), shown as its error */
  private cycleError: string | null = null;
  private sourceViews: SourceStatusView[] = [];
  private planTasks: PlanTaskView[] = [];
  private doc: TasksDoc | null = null;
  private idle: string[] = [];
  private messages: OwnerMessage[] = [];

  constructor(options: PlannerServiceOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.agents = options.agents;
    this.clock = options.clock;
    this.events = options.events;
    this.decisions = options.decisions;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Lair writes the tasks file: act mode, and the project is not read_only. */
  private get writes(): boolean {
    return this.settings.mode === "act" && this.config.read_only !== true;
  }

  private state<T>(key: string): T | null {
    return this.store.get<T>(this.project, key);
  }

  private setState(key: string, value: unknown): void {
    this.store.set(this.project, key, value);
  }

  /** Cycles and the owner's actions run one at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async emit(type: EventType, data: Record<string, unknown>): Promise<void> {
    await this.events?.emit(type, { project: this.project, ...data });
  }

  // ============ THE CYCLE ============

  /** Run one cycle. Concurrent calls share the one in progress; it never rejects. */
  cycle(): Promise<void> {
    if (!this.cycling) {
      this.cycling = this.exclusive(() => this.runCycle()).finally(() => {
        this.cycling = null;
      });
    }
    return this.cycling;
  }

  private async runCycle(): Promise<void> {
    const now = this.clock.now();
    this.cycleError = null;
    try {
      await this.cycleAt(now);
      this.lastError = this.cycleError;
    } catch (e) {
      const error = message(e);
      if (error !== this.lastError) console.warn(`[planner] ${this.project}: cycle failed: ${error}`);
      this.lastError = error;
    } finally {
      this.lastCycle = now;
    }
  }

  private async cycleAt(now: number): Promise<void> {
    this.finishIntent();
    const plan = this.readPlans();
    const owner = this.readOwner();
    this.planTasks = withReadiness(plan.tasks);
    const read = readTasksFile(this.settings.tasksFile, MAX_TASKS_FILE_BYTES);
    if (!read.ok) {
      this.sourceViews = [...plan.views, ...(owner ? [owner.view] : [])];
      throw new Error(`the tasks file: ${read.reason}`);
    }
    const queue = this.readQueue();
    this.sourceViews = [...plan.views, ...(owner ? [owner.view] : []), ...(queue ? [queue.view] : [])];
    this.messages = owner?.messages ?? [];

    let doc = parseTasksDoc(read.text, this.settings.doneMarker, this.settings.onePerAgent);
    doc = await this.watchTasksFile(doc, this.store.activeRun(this.project), now);
    const { doc: afterRules, settled } = await this.deterministic(doc, plan.tasks, now);
    doc = afterRules;
    const baseline = this.state<boolean>(BASELINE) !== true;
    await this.onEvents(doc, settled, queue?.events ?? [], now);
    this.collect(doc, settled, plan.hashes, this.messages, baseline, now);
    this.doc = doc;
    this.setState(BASELINE, true);

    const active = this.store.activeRun(this.project);
    if (active) await this.follow(active, doc, now);
    else await this.maybeStart(doc, now);
  }

  private readPlans(): { tasks: PlanTask[]; views: SourceStatusView[]; hashes: Map<string, string> } {
    const tasks: PlanTask[] = [];
    const views: SourceStatusView[] = [];
    const hashes = new Map<string, string>();
    for (const source of this.settings.sources) {
      if (source.kind !== "markdown_plan" && source.kind !== "backlog_file") continue;
      const read = readPlanSource(source as PlanSourceSettings, this.settings.roots);
      tasks.push(...read.tasks);
      views.push(read.status);
      hashes.set(source.name, read.hash);
    }
    return { tasks, views, hashes };
  }

  private readOwner(): { view: SourceStatusView; messages: OwnerMessage[] } | null {
    const source = this.settings.sources.find((s): s is OwnerSourceSettings => s.kind === "owner_messages");
    if (!source) return null;
    const read = readOwnerMessages(source, this.settings.roots);
    return { view: read.status, messages: read.messages };
  }

  private readQueue(): { view: SourceStatusView; events: QueueEvent[] } | null {
    const source = this.settings.sources.find((s): s is QueueSourceSettings => s.kind === "queue_events");
    if (!source) return null;
    const read = readQueueEvents(source, this.settings.roots, this.state<QueueMark>(CURSOR));
    this.setState(CURSOR, read.cursor);
    if (read.events.length > 0) {
      const recent = [...(this.state<QueueEvent[]>(RECENT) ?? []), ...read.events].slice(-MAX_RECENT_EVENTS);
      this.setState(RECENT, recent);
    }
    return { view: read.status, events: read.events };
  }

  // ============ THE TASKS FILE ============

  /** A write a restart interrupted: finish its history if the rename happened, else drop it (rolled back). */
  private finishIntent(): void {
    const intent = this.state<Intent>(INTENT);
    if (!intent) return;
    const read = readTasksFile(this.settings.tasksFile, MAX_TASKS_FILE_BYTES);
    if (read.ok && sha256(read.text) === intent.afterHash) {
      for (const change of intent.changes) this.store.addChange(change);
      this.setState(KNOWN, { hash: intent.afterHash, text: intent.text });
    }
    this.setState(INTENT, null);
  }

  /**
   * Write `changes` to the tasks file in one atomic write. Each is applied in
   * order to `doc`; one that doesn't apply is returned as refused. Throws when
   * the file can't be written (it changed since it was read, say).
   */
  private async commit(
    doc: TasksDoc,
    changes: PlannedChange[],
    now: number,
  ): Promise<{ doc: TasksDoc; applied: PlannedChange[]; refused: { change: PlannedChange; reason: string }[] }> {
    let working = doc;
    const records: ChangeInput[] = [];
    const applied: PlannedChange[] = [];
    const refused: { change: PlannedChange; reason: string }[] = [];
    for (const change of changes) {
      const result = applyEdit(working, change.edit, this.settings.doneMarker);
      if (!result.ok) {
        refused.push({ change, reason: result.reason });
        continue;
      }
      working = result.doc;
      applied.push(change);
      records.push({
        project: this.project,
        at: now,
        source: change.source,
        outcome: "applied",
        op: change.edit.op,
        task: change.edit.task,
        agent: change.agent,
        reason: change.reason,
        diff: diffOf(result.line, result.before, result.after),
        runId: change.runId ?? null,
        proposalId: change.proposalId ?? null,
      });
    }
    if (applied.length === 0) return { doc, applied, refused };
    this.setState(INTENT, { afterHash: working.hash, text: working.text, changes: records } satisfies Intent);
    const written = writeTasksFile(this.settings.tasksFile, working.text, doc.hash, MAX_TASKS_FILE_BYTES);
    if (!written.ok) {
      this.setState(INTENT, null);
      throw new PlannerError(409, `the tasks file was not written: ${written.reason}`);
    }
    for (const record of records) this.store.addChange(record);
    this.setState(KNOWN, { hash: working.hash, text: working.text } satisfies Known);
    this.setState(INTENT, null);
    for (const change of applied) {
      await this.emit("planner.changed", { op: change.edit.op, task: change.edit.task, source: change.source, outcome: "applied" });
    }
    return { doc: working, applied, refused };
  }

  /**
   * The tasks file against what Lair last wrote or accepted. An edit by
   * someone else is recorded and accepted, except in act mode while a planner
   * run is active: then Lair puts its version back, refuses the run's
   * proposals and asks the owner.
   */
  private async watchTasksFile(doc: TasksDoc, active: StoredRun | null, now: number): Promise<TasksDoc> {
    const known = this.state<Known>(KNOWN);
    if (!known) {
      this.setState(KNOWN, { hash: doc.hash, text: doc.text } satisfies Known);
      return doc;
    }
    if (known.hash === doc.hash) return doc;
    const diff = diffTexts(known.text, doc.text);
    if (active && this.writes) {
      const restored = writeTasksFile(this.settings.tasksFile, known.text, doc.hash, MAX_TASKS_FILE_BYTES);
      active.tampered = true;
      this.store.saveRun(active);
      if (restored.ok) {
        this.store.addChange({
          project: this.project,
          at: now,
          source: "restored",
          outcome: "applied",
          op: "restore",
          reason: `the tasks file changed while planner run ${short(active.id)} was active: Lair put back what it last wrote, and refuses the run's proposals`,
          diff: diffTexts(doc.text, known.text),
          runId: active.id,
        });
        await this.emit("planner.tasks_file_restored", { runId: active.id });
      } else {
        this.store.addChange({
          project: this.project,
          at: now,
          source: "external",
          outcome: "applied",
          op: "edit",
          reason: `the tasks file changed while planner run ${short(active.id)} was active, and Lair could not put its version back (${restored.reason}); the run's proposals are refused`,
          diff,
          runId: active.id,
        });
        this.setState(KNOWN, { hash: doc.hash, text: doc.text } satisfies Known);
      }
      await this.raise({
        kind: "escalation",
        key: `tamper:${active.id}`,
        ref: `run:${active.id}`,
        title: `The tasks file changed while planner run ${short(active.id)} was active`,
        context: [
          restored.ok
            ? "Lair put back the tasks file it last wrote. The planner run's proposals are refused. The change was:"
            : `Lair could not put its version back (${restored.reason}). The planner run's proposals are refused. The change was:`,
          "",
          ...diff.map((line) => `    ${line}`),
          "",
          "Only Lair writes the tasks file in act mode. If you made this change, make it again once the run ends.",
        ].join("\n"),
        options: [
          { id: "continue", label: "Keep planning", consequences: "Planner runs go on as before." },
          { id: "pause", label: "Pause planner runs", consequences: "No planner run starts until you resume it in the Planner view. The rules (done, plan done) keep running." },
        ],
        recommended: { optionId: "pause", reasoning: "A change during a planner run may be the planner agent's: pause until you know who made it." },
      });
      return restored.ok ? parseTasksDoc(known.text, this.settings.doneMarker, this.settings.onePerAgent) : doc;
    }
    this.store.addChange({
      project: this.project,
      at: now,
      source: "external",
      outcome: "applied",
      op: "edit",
      reason: active
        ? `edited outside Lair while planner run ${short(active.id)} was active (${this.writes ? "" : "observe mode: "}kept as it is)`
        : "edited outside Lair",
      diff,
      runId: active?.id ?? null,
    });
    this.setState(KNOWN, { hash: doc.hash, text: doc.text } satisfies Known);
    return doc;
  }

  /**
   * The rules: done in the queue (fill's checkDone), done in the plan. Act
   * mode writes them; observe mode records each as planned, once. Returns the
   * tasks these settle (done or dropped, written or planned).
   */
  private async deterministic(doc: TasksDoc, tasks: PlanTask[], now: number): Promise<{ doc: TasksDoc; settled: Set<string> }> {
    const changes: PlannedChange[] = [];
    const settled = new Set<string>();
    const agentsStore = this.agents.store();
    if (this.settings.markDone !== "off" && agentsStore) {
      const queue = new QueueLines(this.config.queue_file);
      for (const line of doc.tasks) {
        const latest = agentsStore.latestRunForTask(this.project, line.task);
        if (this.settings.markDone === "lair_runs" && !latest) continue;
        // A task with an active run is not done yet (fill shows it started)
        if (latest && isActive(latest.state)) continue;
        let check: DoneCheck;
        try {
          const patterns = this.settings.fillPatterns;
          const until = queueWindowEnd(agentsStore, this.project, patterns, line, latest);
          check = checkDone(agentsStore, this.project, queue, patterns, line, latest, until);
        } catch {
          continue;
        }
        if (!check) continue;
        settled.add(line.task);
        changes.push({
          edit: { op: "mark_done", task: line.task },
          source: "deterministic",
          reason: `the queue reports it done: ${clean(check.line, 300)}`,
          agent: line.agent,
        });
      }
    }
    if (this.settings.dropPlanDone) {
      const done = new Map<string, PlanTask>();
      for (const t of tasks) if (t.done && t.id !== null) done.set(t.id, t);
      for (const line of doc.tasks) {
        const planned = done.get(line.task);
        if (!planned || settled.has(line.task)) continue;
        settled.add(line.task);
        changes.push({
          edit: { op: "drop", task: line.task },
          source: "deterministic",
          reason: `${planned.source} marks it done (${planned.file}:${planned.line})`,
          agent: line.agent,
        });
      }
    }
    if (changes.length === 0) return { doc, settled };
    if (!this.writes) {
      for (const change of changes) {
        const result = applyEdit(doc, change.edit, this.settings.doneMarker);
        if (!result.ok) continue;
        const recorded = this.store.addChange({
          project: this.project,
          at: now,
          source: "deterministic",
          outcome: "planned",
          op: change.edit.op,
          task: change.edit.task,
          agent: change.agent,
          reason: `${change.reason} (${this.config.read_only ? "read_only" : "observe mode"}: not written)`,
          diff: diffOf(result.line, result.before, result.after),
          dedupeKey: `planned:${change.edit.op}:${change.edit.task}:${sha256(result.before ?? "")}`,
        });
        if (recorded) await this.emit("planner.changed", { op: change.edit.op, task: change.edit.task, source: "deterministic", outcome: "planned" });
      }
      return { doc, settled };
    }
    try {
      const result = await this.commit(doc, changes, now);
      return { doc: result.doc, settled };
    } catch (e) {
      // Not written (the file changed meanwhile, say): the next cycle tries again. The rest of this cycle goes on,
      // so the queue lines read this cycle (a BLOCKED line, say) are still handled.
      this.cycleError = message(e);
      return { doc, settled: new Set() };
    }
  }

  // ============ EVENTS AND TRIGGERS ============

  private addTrigger(kind: TriggerKind, now: number, fields: { agent?: string | null; task?: string | null; detail: string }): void {
    const triggers = this.state<TriggerView[]>(TRIGGERS) ?? [];
    const agent = fields.agent ?? null;
    const task = fields.task ?? null;
    const same = triggers.findIndex((t) => t.kind === kind && t.agent === agent && t.task === task);
    const trigger: TriggerView = { kind, at: iso(now), agent, task, detail: clean(fields.detail, 300) };
    if (same >= 0) triggers[same] = trigger;
    else triggers.push(trigger);
    this.setState(TRIGGERS, triggers.slice(-MAX_TRIGGERS));
    this.setState(LAST_TRIGGER, now);
  }

  /** The task a queue line is about: a task id it names, else the reporting agent's only open line. */
  private taskOf(event: QueueEvent, doc: TasksDoc): string | null {
    for (const line of doc.tasks) if (namesTask(event.text, line.task)) return line.task;
    for (const task of doc.done.keys()) if (namesTask(event.text, task)) return task;
    if (event.agent) {
      const own = doc.tasks.filter((t) => t.agent === event.agent);
      if (own.length === 1) return own[0].task;
    }
    return null;
  }

  private lineKey(doc: TasksDoc, task: string): string {
    const line = findTask(doc, task);
    return line ? sha256(renderLine(line.agent, line.name, line.task, line.description)) : "none";
  }

  private async onEvents(doc: TasksDoc, settled: Set<string>, events: QueueEvent[], now: number): Promise<void> {
    const doneAgents = new Map<string, QueueEvent>();
    for (const event of events) {
      if (event.type === "BLOCKED") await this.onBlocked(event, doc, now);
      if (event.type === "DONE" && event.agent) doneAgents.set(event.agent, event);
    }
    for (const [agent, event] of doneAgents) {
      if (!this.settings.allowlist.includes(agent)) continue;
      if (doc.tasks.some((t) => t.agent === agent && !settled.has(t.task))) continue;
      this.addTrigger("done_no_next", now, { agent, task: event.task, detail: `${agent} reported DONE and has no open line: ${event.text}` });
    }
  }

  private async onBlocked(event: QueueEvent, doc: TasksDoc, now: number): Promise<void> {
    const blocked = this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {};
    const task = this.taskOf(event, doc);
    const reason = reasonOf(event.text);
    const c = classifyBlocked(reason, this.settings.blocked);
    if (!task) {
      // Not a task Lair knows: shown, nothing else
      const key = `?${event.agent ?? "unknown"}`;
      blocked[key] = { task: key, agent: event.agent, reason, class: c.class, rule: c.rule, at: now, route: "no task in the tasks file matches this line: shown only" };
      this.saveBlocked(blocked);
      return;
    }
    const lineKey = this.lineKey(doc, task);
    const previous = blocked[task];
    const record: BlockedRecord = { task, agent: event.agent, reason, class: c.class, rule: c.rule, at: now, route: "", kept: previous?.kept };
    if (previous?.kept === lineKey) {
      record.route = "left to you: you kept it blocked (until its line in the tasks file changes)";
      blocked[task] = record;
      this.saveBlocked(blocked);
      return;
    }
    record.kept = undefined;
    await this.emit("planner.blocked", { task, agent: event.agent, class: c.class, rule: c.rule });
    const lineAgent = findTask(doc, task)?.agent ?? null;
    const fillRunsIt = this.settings.fillEnabled && lineAgent !== null && this.settings.allowlist.includes(lineAgent);
    // Fill holds the run, and asks the owner itself, only when its blocked_pattern matches this line for this task.
    // The planner maps more lines to a task (by the agent's only open line), and those fill takes for runs without
    // a done line: it would start them again before it asks
    const fillHoldsIt = fillRunsIt && lineAgent !== null && this.fillBlockedPatternMatches(event.text, task, lineAgent);
    if ((c.class === "owner" || c.class === "environment") && fillHoldsIt) {
      // One decision for one line: fill's
      record.route = `${c.class === "owner" ? "needs you" : "its environment"}: fill holds the task and asks you (its decision, in the Agents view)`;
    } else if (c.class === "owner" || c.class === "environment") {
      const id = await this.raise({
        kind: "escalation",
        key: `blocked:${task}:${c.class}`,
        ref: `task:${task}`,
        title: `${event.agent ?? "An agent"} is blocked on ${task}: ${c.class === "owner" ? "it needs you" : "its environment"}`,
        context: [
          `The agent reported: ${reason}`,
          "",
          `The queue line: ${event.text}`,
          "",
          c.class === "owner"
            ? `Lair reads this as needing you (pattern: ${c.rule}).`
            : `Lair reads this as an environment problem (pattern: ${c.rule}): permissions, disk, memory, containers, network, load, locks, runners. Fix it, then let the task go on.`,
        ].join("\n"),
        options: [
          {
            id: "unblock",
            label: "It's sorted: let the task go on",
            consequences: `The planner records ${task} as unblocked, and releases fill's blocked or no_done hold on it if there is one, so fill starts it again.`,
          },
          { id: "keep", label: "Leave it blocked", consequences: `The planner leaves ${task} alone until its line in the tasks file changes.` },
        ],
        recommended: { optionId: "keep", reasoning: "Only you know whether the blocker is gone." },
        blocks: [`planner:${this.project}:task:${task}`],
      });
      const why = fillRunsIt ? ": fill's blocked_pattern doesn't match this line, so fill won't hold it and ask you" : "";
      record.route = id ? `a decision (${c.class})${why}` : `a decision (${c.class}), not delivered: no Decision Inbox${why}`;
    } else {
      const attempts = this.store.attempts(this.project, task);
      if (attempts >= this.settings.attemptsPerTask) {
        const id = await this.raise({
          kind: "escalation",
          key: `attempts:${task}`,
          ref: `task:${task}`,
          title: `The planner tried ${attempts} time(s) to unblock ${task}`,
          context: [
            `${event.agent ?? "The agent"} is still blocked on ${task}: ${reason}`,
            "",
            `The planner had ${attempts} run(s) for it (planner.attempts_per_task is ${this.settings.attemptsPerTask}).`,
          ].join("\n"),
          options: [
            { id: "retry", label: "Let the planner try again", consequences: `The planner's attempts on ${task} count from zero, and a planner run starts.` },
            { id: "keep", label: "Leave it to me", consequences: `The planner leaves ${task} alone until its line in the tasks file changes.` },
          ],
          recommended: { optionId: "keep", reasoning: "A task that stays blocked after the planner reworded it usually needs a person." },
          blocks: [`planner:${this.project}:task:${task}`],
        });
        record.route = id ? "a decision: the planner's attempts are spent" : "attempts spent; the decision was not delivered (no Decision Inbox)";
      } else if (!this.settings.agent) {
        record.route = "a task problem; no planner agent is configured, so nothing more";
      } else {
        this.addTrigger("blocked", now, { agent: event.agent, task, detail: reason });
        record.route = `a planner run (attempt ${attempts + 1} of ${this.settings.attemptsPerTask})`;
      }
    }
    blocked[task] = record;
    this.saveBlocked(blocked);
  }

  /** Whether fill's blocked_pattern, for this task and agent, matches the queue line (fill's own match). */
  private fillBlockedPatternMatches(line: string, task: string, agent: string): boolean {
    try {
      return doneLineMatches(fillPatternFor(this.settings.fillPatterns.blockedPattern, task, agent), line);
    } catch {
      return false;
    }
  }

  private saveBlocked(blocked: Record<string, BlockedRecord>): void {
    const entries = Object.entries(blocked).sort((a, b) => a[1].at - b[1].at).slice(-MAX_BLOCKED);
    this.setState(BLOCKED, Object.fromEntries(entries));
  }

  /** Triggers from the state of things: new owner messages, changed plans, idle agents. */
  private collect(doc: TasksDoc, settled: Set<string>, hashes: Map<string, string>, messages: OwnerMessage[], baseline: boolean, now: number): void {
    const seen = this.state<string[]>(SEEN) ?? [];
    const seenSet = new Set(seen);
    for (const m of messages) {
      if (seenSet.has(m.id)) continue;
      seenSet.add(m.id);
      seen.push(m.id);
      if (!baseline) this.addTrigger("owner_message", now, { task: null, detail: `owner message [${m.id}]: ${m.text}` });
    }
    this.setState(SEEN, seen.slice(-MAX_SEEN_MESSAGES));

    const known = this.state<Record<string, string>>(HASHES) ?? {};
    for (const [name, hash] of hashes) {
      if (known[name] !== undefined && known[name] !== hash) this.addTrigger("plan_changed", now, { detail: `${name} changed` });
      known[name] = hash;
    }
    this.setState(HASHES, known);

    const agentsStore = this.agents.store();
    this.idle = this.settings.allowlist.filter(
      (agent) =>
        agent !== this.settings.agent?.id &&
        !agentsStore?.activeRunForAgent(this.project, agent) &&
        !doc.tasks.some((t) => t.agent === agent && !settled.has(t.task)),
    );
    // The idle set alone: an edit of the tasks file that leaves the same agents idle is no new reason to plan
    const fingerprint = this.idle.length > 0 ? sha256(this.idle.join(",")) : "";
    if (fingerprint !== "" && fingerprint !== this.state<string>(IDLE)) {
      this.addTrigger("idle", now, { detail: `idle with no open line: ${this.idle.join(", ")}` });
    }
    this.setState(IDLE, fingerprint);
  }

  // ============ PLANNER RUNS ============

  /** Planner runs started in the 24 hours before `now`, oldest first. */
  private runsInDay(now: number): number[] {
    return this.store.runStartsSince(this.project, now - DAY_MS);
  }

  /**
   * When a run can start, given the pending triggers (null: none pending):
   * the newest trigger debounce_seconds old, min_interval_seconds after the
   * last run, and fewer than max_runs_per_day runs in the 24 hours before.
   */
  private nextRunAt(now: number): number | null {
    const triggers = this.state<TriggerView[]>(TRIGGERS) ?? [];
    const agent = this.settings.agent;
    if (!agent || triggers.length === 0) return null;
    const lastTrigger = this.state<number>(LAST_TRIGGER) ?? 0;
    const lastRun = this.state<number>(LAST_RUN);
    const day = this.runsInDay(now);
    // At the cap: once the oldest run of the window is 24 hours old (the one that makes room)
    const dayFree = day.length >= agent.maxRunsPerDay ? day[day.length - agent.maxRunsPerDay] + DAY_MS : 0;
    return Math.max(lastTrigger + agent.debounceSeconds * 1000, lastRun === null ? 0 : lastRun + agent.minIntervalSeconds * 1000, dayFree);
  }

  private async maybeStart(doc: TasksDoc, now: number): Promise<void> {
    const agent = this.settings.agent;
    if (!agent || this.state(PAUSED) || this.config.read_only === true) return;
    const at = this.nextRunAt(now);
    if (at === null || now < at) return;
    await this.startRun(doc, now);
  }

  private blockedViews(): BlockedView[] {
    const blocked = this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {};
    return Object.values(blocked)
      .sort((a, b) => b.at - a.at)
      .map((b) => ({
        task: b.task,
        agent: b.agent,
        reason: b.reason,
        class: b.class,
        rule: b.rule,
        at: iso(b.at),
        attempts: b.task.startsWith("?") ? 0 : this.store.attempts(this.project, b.task),
        route: b.route,
      }));
  }

  private async startRun(doc: TasksDoc, now: number): Promise<void> {
    const agent = this.settings.agent;
    if (!agent) return;
    const triggers = this.state<TriggerView[]>(TRIGGERS) ?? [];
    const id = randomUUID();
    const task = `planner-${utcStamp(now)}-${id.slice(0, 6)}`;
    const dir = join(this.settings.workDir, id);
    const run: StoredRun = {
      id,
      project: this.project,
      state: "running",
      agent: agent.id,
      task,
      agentRunId: null,
      chainId: null,
      dir,
      triggers,
      requestedAt: now,
      endedAt: null,
      detail: "requested",
      tampered: false,
      decisionId: null,
      verifierState: null,
      verifierRunId: null,
      verifierChainId: null,
      verifierTask: null,
    };
    this.setState(LAST_RUN, now);
    const fail = async (detail: string) => {
      run.state = "failed";
      run.endedAt = now;
      run.detail = detail;
      if (this.store.getRun(id)) this.store.saveRun(run);
      else this.store.insertRun(run);
      await this.failed(run, now, false);
    };
    const template = buildPrompt([agent.promptFile], getPromptsDir(this.config), { agent: agent.id, task });
    if (!template.ok) return fail(`the planner agent's prompt: ${template.reason}`);
    try {
      mkdirSync(this.settings.workDir, { recursive: true, mode: 0o700 });
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      return fail(`the run directory ${dir} could not be made (${message(e)})`);
    }
    const proposalFile = join(dir, PROPOSAL_FILE);
    const input = {
      project: this.project,
      runId: id,
      now: iso(now),
      mode: this.settings.mode,
      maxProposals: agent.maxProposals,
      approval: this.settings.approval,
      triggers,
      allowlist: this.settings.allowlist,
      idleAgents: this.idle,
      doc,
      openTasks: this.planTasks.filter((t) => !t.done),
      events: this.state<QueueEvent[]>(RECENT) ?? [],
      messages: this.messages,
      blocked: this.blockedViews().filter((b) => !b.task.startsWith("?")),
      maxBytes: this.settings.contextMaxBytes,
    };
    let context = buildContext(input);
    let prompt = `${template.text}\n\n${plannerSection({ runId: id, proposalFile, maxProposals: agent.maxProposals, context })}`;
    if (prompt.length > PROMPT_LIMIT) {
      const room = PROMPT_LIMIT - template.text.length - 4000;
      if (room < 4096) return fail(`the planner agent's prompt template is too long (${template.text.length} characters)`);
      context = buildContext({ ...input, maxBytes: room });
      prompt = `${template.text}\n\n${plannerSection({ runId: id, proposalFile, maxProposals: agent.maxProposals, context })}`;
    }
    try {
      writeFileSync(join(dir, "context.json"), context.json, { mode: 0o600 });
    } catch (e) {
      return fail(`context.json could not be written (${message(e)})`);
    }
    // Recorded before the request: after a restart its agent run is found by task id
    this.store.insertRun(run);
    try {
      const view = await this.agents.requestRun(this.project, { agent: agent.id, task, prompt });
      run.agentRunId = view.id;
      run.chainId = view.chainId;
      run.detail = `agent run ${short(view.id)} requested`;
      this.store.saveRun(run);
    } catch (e) {
      return fail(`the agents module refused the run: ${message(e)}`);
    }
    for (const t of new Set(triggers.filter((t) => t.kind === "blocked" && t.task).map((t) => t.task as string))) {
      this.store.addAttempt(this.project, t, now);
    }
    this.setState(TRIGGERS, []);
    await this.emit("planner.run_started", { runId: id, agentRunId: run.agentRunId, triggers: triggers.map((t) => t.kind) });
  }

  /** A run that didn't give proposals: its triggers wait for the next one; too many in a row pause runs. */
  private async failed(run: StoredRun, now: number, requeue = true): Promise<void> {
    if (requeue) {
      const pending = this.state<TriggerView[]>(TRIGGERS) ?? [];
      for (const t of run.triggers) {
        if (!pending.some((p) => p.kind === t.kind && p.agent === t.agent && p.task === t.task)) pending.push(t);
      }
      this.setState(TRIGGERS, pending.slice(-MAX_TRIGGERS));
    }
    const failures = (this.state<number>(FAILURES) ?? 0) + 1;
    this.setState(FAILURES, failures);
    await this.emit("planner.run_finished", { runId: run.id, state: "failed", detail: run.detail });
    if (failures >= this.settings.maxFailedRuns && !this.state(PAUSED)) {
      this.setState(PAUSED, { reason: `${failures} planner runs in a row gave no proposals; the last: ${run.detail}`, at: now });
      await this.raise({
        kind: "escalation",
        key: `failing:${run.id}`,
        ref: "planner",
        title: `${failures} planner runs in a row failed: planner runs are paused`,
        context: [`The last one: ${run.detail}`, "", "The rules (done, plan done) keep running; only planner runs are paused."].join("\n"),
        options: [
          { id: "retry", label: "Resume planner runs", consequences: "The failure count starts from zero and the next trigger starts a run." },
          { id: "pause", label: "Keep them paused", consequences: "No planner run starts until you resume it in the Planner view." },
        ],
        recommended: { optionId: "pause", reasoning: "Check the planner agent's last run (Agents view) and its prompt first." },
      });
    }
  }

  private async follow(run: StoredRun, doc: TasksDoc, now: number): Promise<void> {
    // If verifier is running, follow it instead of the planner agent
    if (run.verifierState === "running") {
      await this.followVerifier(run, now);
      return;
    }

    const agentsStore = this.agents.store();
    if (!agentsStore) return;
    if (!run.chainId) {
      // Recorded, but the request's answer was lost (a restart): find its run by task id
      const found = agentsStore.latestRunForTask(this.project, run.task);
      if (found) {
        // agentRunId is the chain's first run, as requestRun returned it on the normal path; `found` is the task's
        // latest run, which may be a later attempt of that chain (a retry or a fresh session), and its chain id is
        // that first run's id
        run.agentRunId = found.chainId;
        run.chainId = found.chainId;
        this.store.saveRun(run);
      } else {
        run.state = "failed";
        run.endedAt = now;
        run.detail = "its agent run was never requested (the server stopped while it was being requested)";
        this.store.saveRun(run);
        return this.failed(run, now);
      }
    }
    const latest = agentsStore.chainRuns(run.chainId).at(-1);
    if (!latest) {
      run.state = "failed";
      run.endedAt = now;
      run.detail = "its agent run is gone from the agents store";
      this.store.saveRun(run);
      return this.failed(run, now);
    }
    if (isActive(latest.state)) {
      run.detail = `agent run ${short(latest.id)} is ${latest.state}`;
      this.store.saveRun(run);
      return;
    }
    if (latest.state !== "completed") {
      run.state = "failed";
      run.endedAt = now;
      run.detail = `its agent run ${short(latest.id)} ended ${latest.state}: ${clean(latest.detail, 200)}`;
      this.store.saveRun(run);
      return this.failed(run, now);
    }
    await this.finish(run, doc, now);
  }

  private checkContext(doc: TasksDoc, maxProposals: number): CheckContext {
    const dragons = loadKnownDragons(this.config);
    const agentsStore = this.agents.store();
    return {
      maxProposals,
      allowlist: this.settings.allowlist,
      plannerAgent: this.settings.agent?.id ?? null,
      taskIdPattern: this.settings.taskIdPattern,
      doneMarker: this.settings.doneMarker,
      doc,
      nameOf: (agent) => dragons.get(agent)?.name || agent,
      activeRun: (task) => {
        const latest = agentsStore?.latestRunForTask(this.project, task);
        return latest && isActive(latest.state) ? { id: latest.id, agent: latest.agent } : null;
      },
      blocked: (task) => {
        const record = (this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {})[task];
        if (!record) return null;
        return {
          class: record.class,
          kept: record.kept !== undefined && record.kept === this.lineKey(doc, task),
          attempts: this.store.attempts(this.project, task),
        };
      },
      attemptsPerTask: this.settings.attemptsPerTask,
    };
  }

  /** A completed run: check its proposals, optionally start verification, then apply/ask. */
  private async finish(run: StoredRun, doc: TasksDoc, now: number): Promise<void> {
    const file = readProposalFile(join(run.dir, PROPOSAL_FILE), run.dir);
    if (!file.ok) {
      run.state = "failed";
      run.endedAt = now;
      run.detail = file.reason;
      this.store.saveRun(run);
      return this.failed(run, now);
    }
    const agent = this.settings.agent;
    const { checked } = checkProposals(file.items, this.checkContext(doc, agent?.maxProposals ?? 10));
    const stored = checked.map((c) =>
      this.store.insertProposal({
        project: this.project,
        runId: run.id,
        index: c.index,
        op: c.op,
        task: c.task,
        agent: c.agent,
        text: c.text,
        reason: c.reason,
        status: c.refusal || run.tampered ? "rejected" : "pending",
        refusal: run.tampered
          ? "the tasks file changed while this planner run was active: its proposals are refused"
          : c.refusal,
        decidedBy: c.refusal || run.tampered ? "lair" : null,
        decidedAt: c.refusal || run.tampered ? now : null,
        createdAt: now,
        verifierVerdict: null,
        verifierReason: null,
      }),
    );
    const accepted = stored.filter((p) => p.status === "pending");

    // Check if verification is needed
    const verifier = this.settings.verifier;
    if (verifier && accepted.length > 0 && !run.tampered) {
      // Filter proposals that need verification (not in skip_ops)
      const needsVerification = accepted.filter((p) => !verifier.skipOps.includes(p.op as never));
      if (needsVerification.length > 0) {
        // Start verifier run
        const started = await this.startVerifier(run, accepted, now);
        if (started) {
          run.verifierState = "running";
          run.detail = `${accepted.length} proposal(s) accepted; verifier run started`;
          this.store.saveRun(run);
          return;
        }
        // Verifier couldn't start: proceed without verification (verdicts are defer)
        run.verifierState = "skipped";
        run.detail = `${accepted.length} proposal(s) accepted; verifier could not start, proceeding without verification`;
        this.store.saveRun(run);
      } else {
        // All accepted proposals are in skip_ops: skip verification
        run.verifierState = "skipped";
        this.store.saveRun(run);
      }
    } else if (verifier && accepted.length === 0) {
      run.verifierState = "skipped";
      this.store.saveRun(run);
    }

    // No verification needed or skipped: proceed to approval
    await this.finishAfterVerification(run, now);
  }

  /** Start the verifier agent run for a planner run's accepted proposals. */
  private async startVerifier(run: StoredRun, accepted: StoredProposal[], now: number): Promise<boolean> {
    const verifier = this.settings.verifier;
    if (!verifier) return false;

    const verifyDir = join(run.dir, "verify");
    const verdictsFile = join(verifyDir, VERDICTS_FILE);
    const id = randomUUID();
    const task = `verifier-${utcStamp(now)}-${id.slice(0, 6)}`;

    const template = buildPrompt([verifier.promptFile], getPromptsDir(this.config), { agent: verifier.id, task });
    if (!template.ok) {
      console.warn(`[planner] ${this.project}: verifier prompt template: ${template.reason}`);
      return false;
    }

    try {
      mkdirSync(verifyDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      console.warn(`[planner] ${this.project}: verifier directory ${verifyDir} could not be made (${message(e)})`);
      return false;
    }

    // Read the context.json that was written for the planner run
    let contextJson = "{}";
    try {
      const contextPath = join(run.dir, "context.json");
      const { readFileSync } = await import("fs");
      contextJson = readFileSync(contextPath, "utf-8");
    } catch {
      // Context not available; verifier runs with minimal context
    }

    const proposals = accepted.map((p) => ({
      index: p.index,
      op: p.op,
      task: p.task,
      agent: p.agent,
      text: p.text,
      reason: p.reason,
    }));

    const section = verifierSection({
      runId: run.id,
      verdictsFile,
      proposals,
      context: { json: contextJson },
    });

    let prompt = `${template.text}\n\n${section}`;
    if (prompt.length > PROMPT_LIMIT) {
      // Truncate context if prompt is too long
      const room = PROMPT_LIMIT - template.text.length - 4000;
      if (room < 4096) {
        console.warn(`[planner] ${this.project}: verifier prompt template is too long`);
        return false;
      }
      const truncatedSection = verifierSection({
        runId: run.id,
        verdictsFile,
        proposals,
        context: { json: contextJson.slice(0, room) },
      });
      prompt = `${template.text}\n\n${truncatedSection}`;
    }

    try {
      const view = await this.agents.requestRun(this.project, { agent: verifier.id, task, prompt });
      run.verifierRunId = view.id;
      run.verifierChainId = view.chainId;
      run.verifierTask = task;
      await this.emit("planner.verifier_started", { runId: run.id, verifierRunId: view.id });
      return true;
    } catch (e) {
      console.warn(`[planner] ${this.project}: verifier run could not be started: ${message(e)}`);
      return false;
    }
  }

  /** Follow a verifier run in progress. */
  private async followVerifier(run: StoredRun, now: number): Promise<void> {
    const agentsStore = this.agents.store();
    if (!agentsStore || !run.verifierChainId) {
      // No chain id: verifier was never started properly
      run.verifierState = "failed";
      await this.finishAfterVerification(run, now);
      return;
    }

    const latest = agentsStore.chainRuns(run.verifierChainId).at(-1);
    if (!latest) {
      run.verifierState = "failed";
      run.detail = `verifier run is gone from the agents store`;
      this.store.saveRun(run);
      await this.finishAfterVerification(run, now);
      return;
    }

    if (isActive(latest.state)) {
      // Still running
      return;
    }

    if (latest.state !== "completed") {
      run.verifierState = "failed";
      run.detail = `verifier run ${short(latest.id)} ended ${latest.state}: ${clean(latest.detail, 200)}`;
      this.store.saveRun(run);
      await this.finishAfterVerification(run, now);
      return;
    }

    // Verifier completed: read and apply verdicts
    await this.applyVerdicts(run, now);
  }

  /** Read verifier verdicts and apply them to proposals. */
  private async applyVerdicts(run: StoredRun, now: number): Promise<void> {
    const verifyDir = join(run.dir, "verify");
    const verdictsFile = join(verifyDir, VERDICTS_FILE);

    const file = readVerdictsFile(verdictsFile, verifyDir);
    if (!file.ok) {
      run.verifierState = "failed";
      run.detail = `verifier: ${file.reason}`;
      this.store.saveRun(run);
      await this.finishAfterVerification(run, now);
      return;
    }

    const proposals = this.store.runProposals(run.id);
    const acceptedIndices = new Set(proposals.filter((p) => p.status === "pending").map((p) => p.index));
    const verdicts = parseVerdicts(file.items, acceptedIndices);

    // Build a map of proposal index to verdict
    const verdictMap = new Map<number, { verdict: VerifierVerdict; reason: string }>();
    for (const v of verdicts) {
      if (v.refusal === null) {
        verdictMap.set(v.proposal, { verdict: v.verdict, reason: v.reason });
      }
    }

    // Apply verdicts to proposals
    for (const p of proposals) {
      if (p.status !== "pending") continue;

      const v = verdictMap.get(p.index);
      if (v) {
        this.store.setVerifierVerdict(p.id, v.verdict, v.reason);
        if (v.verdict === "fail") {
          // Fail: reject the proposal with the verifier's reason
          this.store.decide(p.id, "rejected", "verifier", now, `verifier: ${v.reason}`);
        }
      } else {
        // No verdict: treat as defer
        this.store.setVerifierVerdict(p.id, "defer", "no verdict from verifier");
      }
    }

    run.verifierState = "done";
    this.store.saveRun(run);
    await this.emit("planner.verifier_finished", { runId: run.id, verifierState: "done" });
    await this.finishAfterVerification(run, now);
  }

  /** Complete the run after verification (or without it): apply immediate proposals, ask about the rest. */
  private async finishAfterVerification(run: StoredRun, now: number): Promise<void> {
    const proposals = this.store.runProposals(run.id);
    const accepted = proposals.filter((p) => p.status === "pending");
    const verifier = this.settings.verifier;

    // Determine which proposals to apply immediately
    // - Without verifier: apply if approval[op] === "never"
    // - With verifier: apply if approval[op] === "never" AND (verdict === "pass" OR op in skip_ops)
    const immediate = accepted.filter((p) => {
      if (!this.writes || !isOp(p.op)) return false;
      if (this.settings.approval[p.op] !== "never") return false;

      if (!verifier) return true;

      // With verifier
      if (verifier.skipOps.includes(p.op as never)) return true;
      return p.verifierVerdict === "pass";
    });

    let note = "";
    if (immediate.length > 0) {
      try {
        await this.apply(immediate, "planner", now);
      } catch (e) {
        note = `; applying failed (${message(e)}), so they wait for you`;
      }
    }

    const pending = this.store.runProposals(run.id).filter((p) => p.status === "pending");
    if (pending.length > 0) {
      run.decisionId = await this.askApproval(run, pending);
      await this.emit("planner.proposals_pending", { runId: run.id, pending: pending.length });
    }

    const after = this.store.runProposals(run.id);
    const count = (status: ProposalStatus) => after.filter((p) => p.status === status).length;

    // Build detail with verifier info
    let verifierNote = "";
    if (verifier && run.verifierState) {
      const verdictCounts = {
        pass: after.filter((p) => p.verifierVerdict === "pass").length,
        fail: after.filter((p) => p.verifierVerdict === "fail").length,
        defer: after.filter((p) => p.verifierVerdict === "defer").length,
      };
      if (run.verifierState === "done") {
        verifierNote = ` (verifier: ${verdictCounts.pass} pass, ${verdictCounts.fail} fail, ${verdictCounts.defer} defer)`;
      } else if (run.verifierState === "failed") {
        verifierNote = " (verifier failed)";
      } else if (run.verifierState === "skipped") {
        verifierNote = " (verification skipped)";
      }
    }

    run.state = run.tampered ? "failed" : "done";
    run.endedAt = now;
    run.detail = `${after.length} proposal(s): ${count("applied")} applied, ${count("pending")} waiting for you, ${count("rejected")} refused${verifierNote}${
      run.tampered ? " (the tasks file changed while it ran)" : ""
    }${note}`;
    this.store.saveRun(run);

    if (run.tampered) return this.failed(run, now, true);
    this.setState(FAILURES, 0);
    await this.emit("planner.run_finished", { runId: run.id, state: run.state, detail: run.detail });
  }

  /** One decision for a run's waiting proposals. */
  private async askApproval(run: StoredRun, pending: StoredProposal[]): Promise<string | null> {
    const hasDrop = pending.some((p) => p.op === "drop");
    const verifier = this.settings.verifier;

    // Build list with verifier verdicts if available
    const list = pending.map((p) => {
      const base = `- ${p.op} ${p.task}${p.agent ? ` -> ${p.agent}` : ""}${p.text ? `: "${p.text}"` : ""} (why: ${p.reason})`;
      if (verifier && p.verifierVerdict) {
        return `${base} [verifier: ${p.verifierVerdict}${p.verifierReason ? ` - ${p.verifierReason}` : ""}]`;
      }
      return base;
    });

    // Adjust recommendation based on verifier verdicts
    let recommended: { optionId: string; reasoning: string };
    if (hasDrop) {
      recommended = { optionId: "reject_all", reasoning: "A drop removes a task: look at it in the Planner view, where you can approve the others one by one." };
    } else if (verifier && pending.some((p) => p.verifierVerdict === "fail")) {
      recommended = { optionId: "reject_all", reasoning: "The verifier flagged at least one proposal as failing: review them in the Planner view." };
    } else if (verifier && pending.every((p) => p.verifierVerdict === "pass")) {
      recommended = { optionId: "approve_all", reasoning: "Every proposal passed the verifier's review." };
    } else {
      recommended = { optionId: "approve_all", reasoning: "Every proposal passed Lair's checks; look them over first." };
    }

    return this.raise({
      kind: "other",
      key: `approve:${run.id}`,
      ref: `run:${run.id}`,
      title: `The planner proposes ${pending.length} change(s) to the tasks file`,
      context: [
        `Planner run ${short(run.id)} (${run.triggers.map((t) => t.kind).join(", ") || "no trigger"}) proposes:`,
        "",
        ...list,
        "",
        "Each passed Lair's checks. Approving applies them to the tasks file (checked again first); you can also decide them one by one in the Planner view.",
      ].join("\n"),
      options: [
        { id: "approve_all", label: "Apply them all", consequences: "Lair checks each against the tasks file as it is now and applies those that still pass." },
        { id: "reject_all", label: "Reject them all", consequences: "Nothing changes; the next planner run sees the same state." },
      ],
      recommended,
    });
  }

  /**
   * Apply proposals (the cycle's own in act mode, or the owner's approval):
   * checked again against the tasks file as it is now, the file edits written
   * together, then the unblocks. Throws when the file can't be written.
   */
  private async apply(proposals: StoredProposal[], by: string, now: number): Promise<void> {
    const read = readTasksFile(this.settings.tasksFile, MAX_TASKS_FILE_BYTES);
    if (!read.ok) throw new PlannerError(409, `the tasks file: ${read.reason}`);
    let doc = parseTasksDoc(read.text, this.settings.doneMarker, this.settings.onePerAgent);
    doc = await this.watchTasksFile(doc, by === "planner" ? null : this.store.activeRun(this.project), now);
    const items = proposals.map((p) => ({
      op: p.op,
      task: p.task,
      ...(p.agent !== null ? { agent: p.agent } : {}),
      ...(p.text !== null ? { text: p.text } : {}),
      reason: p.reason,
    }));
    const { checked } = checkProposals(items, this.checkContext(doc, proposals.length));
    const changes: PlannedChange[] = [];
    const unblocks: { proposal: StoredProposal; reason: string }[] = [];
    checked.forEach((c, i) => {
      const p = proposals[i];
      if (c.refusal) {
        this.store.decide(p.id, "rejected", by, now, `no longer valid: ${c.refusal}`);
        return;
      }
      if (c.edit) changes.push({ edit: c.edit, source: "proposal", reason: p.reason, agent: p.agent, runId: p.runId, proposalId: p.id });
      else unblocks.push({ proposal: p, reason: p.reason });
    });
    if (changes.length > 0) {
      const result = await this.commit(doc, changes, now);
      for (const change of result.applied) this.store.decide(change.proposalId ?? "", "applied", by, now);
      for (const { change, reason } of result.refused) this.store.decide(change.proposalId ?? "", "rejected", by, now, `no longer valid: ${reason}`);
    }
    for (const { proposal, reason } of unblocks) {
      const outcome = await this.unblock(proposal.task, reason, now, { runId: proposal.runId, proposalId: proposal.id, by });
      this.store.decide(proposal.id, "applied", by, now, outcome);
    }
  }

  /**
   * Unblock: release fill's blocked or no_done hold (a run that stopped
   * without done and said so; never an owner or a waiting hold) and clear the
   * planner's record. One the planner proposed spends an attempt on the task,
   * so a task that keeps getting blocked reaches the owner's decision instead
   * of a loop of runs (fill's release counts its runs without done from zero).
   */
  private async unblock(task: string, reason: string, now: number, ref: { runId?: string; proposalId?: string; by: string }): Promise<string> {
    if (ref.proposalId) this.store.addAttempt(this.project, task, now);
    const line = this.agents.fillLines(this.project).find((l) => l.task === task);
    let outcome: string;
    if (line && line.state === "held" && (line.hold === "no_done" || line.hold === "blocked")) {
      try {
        await this.agents.releaseFillHold(this.project, task);
        outcome = `released fill's ${line.hold} hold: fill starts it again`;
      } catch (e) {
        outcome = `fill's hold was not released (${message(e)})`;
      }
    } else {
      outcome = line ? `nothing to release (fill shows it ${line.state}${line.hold ? `: ${line.hold}` : ""})` : "nothing to release (fill has no line for it)";
    }
    const blocked = this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {};
    delete blocked[task];
    this.saveBlocked(blocked);
    this.store.addChange({
      project: this.project,
      at: now,
      source: ref.proposalId ? "proposal" : "deterministic",
      outcome: "applied",
      op: "unblock",
      task,
      agent: line?.agent ?? null,
      reason: `${reason} (${ref.by}): ${outcome}`,
      diff: [],
      runId: ref.runId ?? null,
      proposalId: ref.proposalId ?? null,
    });
    await this.emit("planner.changed", { op: "unblock", task, source: ref.proposalId ? "proposal" : "decision", outcome: "applied" });
    return outcome;
  }

  // ============ DECISIONS ============

  private async raise(
    input: Omit<RaiseDecisionInput, "project" | "source" | "title" | "context"> & { ref: string; title: string; context: string },
  ): Promise<string | null> {
    const producer = this.decisions();
    if (!producer) return null;
    const { ref, ...rest } = input;
    try {
      const { decision } = await producer.raise({
        ...rest,
        project: this.project,
        title: clean(input.title, 200),
        context: input.context.slice(0, 19_000) || input.title,
        source: { module: DECISION_MODULE, ref: clean(ref, 200) },
        key: clean(input.key, 200),
      });
      return decision.id;
    } catch (e) {
      console.warn(`[planner] ${this.project}: a decision was not raised: ${message(e)}`);
      return null;
    }
  }

  /** Withdraw a run's approval decision once nothing of it waits. */
  private async settleDecision(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run?.decisionId) return;
    if (this.store.runProposals(runId).some((p) => p.status === "pending")) return;
    const producer = this.decisions();
    const decisionId = run.decisionId;
    run.decisionId = null;
    this.store.saveRun(run);
    try {
      await producer?.withdraw(decisionId, { module: DECISION_MODULE, reason: "Every proposal of the run was decided in the Planner view." });
    } catch {
      // Answered meanwhile, or already closed
    }
  }

  /**
   * An answer to one of the planner's decisions (PlannerManager.useDecisions
   * delivers them): approve or reject a run's proposals; unblock or keep a
   * blocked task; let the planner try again or not; pause or go on.
   */
  followAnswer(resolution: DecisionResolution): Promise<void> {
    return this.exclusive(async () => {
      const { decision, optionId } = resolution;
      const key = decision.key;
      const now = this.clock.now();
      const by = `owner (decision ${short(decision.id)})`;
      if (key.startsWith("approve:")) {
        const runId = key.slice("approve:".length);
        const run = this.store.getRun(runId);
        if (run && run.decisionId === decision.id) {
          run.decisionId = null;
          this.store.saveRun(run);
        }
        const pending = this.store.runProposals(runId).filter((p) => p.status === "pending");
        if (optionId === "approve_all") {
          try {
            await this.apply(pending, by, now);
          } catch (e) {
            // They stay pending: the Planner view shows them, and the owner approves them once the file can be written
            this.lastError = `approved proposals of run ${short(runId)} were not applied: ${message(e)}`;
            console.warn(`[planner] ${this.project}: ${this.lastError}`);
          }
        } else {
          for (const p of pending) this.store.decide(p.id, "declined", by, now, "rejected by the owner");
        }
        return;
      }
      if (key.startsWith("blocked:")) {
        const rest = key.slice("blocked:".length);
        const task = rest.slice(0, rest.lastIndexOf(":"));
        if (optionId === "unblock") await this.unblock(task, "the owner answered: it's sorted", now, { by });
        else this.keep(task);
        return;
      }
      if (key.startsWith("attempts:")) {
        const task = key.slice("attempts:".length);
        if (optionId === "retry") {
          this.store.resetAttempts(this.project, task);
          const blocked = this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {};
          if (blocked[task]) {
            blocked[task].kept = undefined;
            blocked[task].route = "the owner let the planner try again";
            this.saveBlocked(blocked);
          }
          this.addTrigger("owner_retry", now, { task, detail: `the owner let the planner try ${task} again` });
        } else {
          this.keep(task);
        }
        return;
      }
      if (key.startsWith("tamper:") || key.startsWith("failing:")) {
        if (optionId === "pause") {
          this.setState(PAUSED, { reason: `paused by the owner (decision ${short(decision.id)})`, at: now });
        } else {
          this.setState(PAUSED, null);
          this.setState(FAILURES, 0);
        }
      }
    });
  }

  /** The owner keeps a task blocked: BLOCKED lines for it are left alone until its line changes. */
  private keep(task: string): void {
    const blocked = this.state<Record<string, BlockedRecord>>(BLOCKED) ?? {};
    const record = blocked[task];
    if (!record) return;
    record.kept = this.doc ? this.lineKey(this.doc, task) : "none";
    record.route = "left to you";
    this.saveBlocked(blocked);
  }

  // ============ THE OWNER'S ACTIONS ============

  private pendingProposal(id: string): StoredProposal {
    const p = this.store.getProposal(id);
    if (!p || p.project !== this.project) throw new PlannerError(404, `No proposal ${id}`);
    if (p.status !== "pending") throw new PlannerError(409, `Proposal ${short(id)} is ${p.status}, not waiting for you`);
    return p;
  }

  approveProposal(id: string): Promise<ProposalView> {
    return this.exclusive(async () => {
      const p = this.pendingProposal(id);
      await this.apply([p], "owner", this.clock.now());
      await this.settleDecision(p.runId);
      return proposalView(this.store.getProposal(id) ?? p);
    });
  }

  rejectProposal(id: string): Promise<ProposalView> {
    return this.exclusive(async () => {
      const p = this.pendingProposal(id);
      this.store.decide(p.id, "declined", "owner", this.clock.now(), "rejected by the owner");
      await this.settleDecision(p.runId);
      return proposalView(this.store.getProposal(id) ?? p);
    });
  }

  private runPending(runId: string): StoredProposal[] {
    const run = this.store.getRun(runId);
    if (!run || run.project !== this.project) throw new PlannerError(404, `No planner run ${runId}`);
    const pending = this.store.runProposals(runId).filter((p) => p.status === "pending");
    if (pending.length === 0) throw new PlannerError(409, `Planner run ${short(runId)} has no proposal waiting for you`);
    return pending;
  }

  approveRun(runId: string): Promise<ProposalView[]> {
    return this.exclusive(async () => {
      const pending = this.runPending(runId);
      await this.apply(pending, "owner", this.clock.now());
      await this.settleDecision(runId);
      return this.store.runProposals(runId).map(proposalView);
    });
  }

  rejectRun(runId: string): Promise<ProposalView[]> {
    return this.exclusive(async () => {
      const now = this.clock.now();
      for (const p of this.runPending(runId)) this.store.decide(p.id, "declined", "owner", now, "rejected by the owner");
      await this.settleDecision(runId);
      return this.store.runProposals(runId).map(proposalView);
    });
  }

  /** Resume planner runs after a pause. */
  resume(): Promise<PlannerStatusView> {
    return this.exclusive(async () => {
      if (!this.state(PAUSED)) throw new PlannerError(409, "Planner runs are not paused");
      this.setState(PAUSED, null);
      this.setState(FAILURES, 0);
      return this.status();
    });
  }

  /** The owner's "check now": a cycle, then what the planner sees. */
  async checkNow(): Promise<PlannerOverviewView> {
    await this.cycle();
    return this.overview();
  }

  // ============ VIEWS ============

  status(errors: string[] = []): PlannerStatusView {
    const active = this.store.activeRun(this.project);
    return {
      project: this.project,
      enabled: true,
      mode: this.settings.mode,
      running: this.running,
      paused: this.state(PAUSED) !== null,
      lastCycle: this.lastCycle === null ? null : iso(this.lastCycle),
      lastError: this.lastError,
      errors,
      warnings: [
        ...this.settings.warnings,
        ...(this.config.read_only === true ? ["the project is read_only: the planner writes nothing and starts no run"] : []),
      ],
      counts: {
        sources: this.settings.sources.length,
        sourcesFailing: this.sourceViews.filter((s) => !s.ok).length,
        openTasks: this.planTasks.filter((t) => !t.done).length,
        readyTasks: this.planTasks.filter((t) => t.ready).length,
        pending: this.store.countPending(this.project),
        runs: this.store.countRuns(this.project),
      },
      activeRun: active ? { id: active.id, requestedAt: iso(active.requestedAt) } : null,
    };
  }

  overview(): PlannerOverviewView {
    const doc = this.doc;
    const agent = this.settings.agent;
    const now = this.clock.now();
    const next = this.nextRunAt(now);
    return {
      ...this.status(),
      tasksFile: this.settings.tasksFile,
      lines: doc ? doc.tasks.map((t) => ({ ...t })) : [],
      doneTasks: doc ? [...doc.done.keys()] : [],
      malformed: doc ? doc.malformed.map((m) => ({ line: m.line, reason: m.reason })) : [],
      sources: this.sourceViews,
      openTasks: this.planTasks.filter((t) => !t.done).slice(0, 500),
      triggers: this.state<TriggerView[]>(TRIGGERS) ?? [],
      blocked: this.blockedViews(),
      idleAgents: this.idle,
      allowlist: this.settings.allowlist,
      agent: agent
        ? {
            id: agent.id,
            promptFile: agent.promptFile,
            minIntervalSeconds: agent.minIntervalSeconds,
            debounceSeconds: agent.debounceSeconds,
            maxProposals: agent.maxProposals,
            maxRunsPerDay: agent.maxRunsPerDay,
            runsInDay: this.runsInDay(now).length,
            nextRunAt: next === null ? null : iso(next),
          }
        : null,
      pausedReason: this.state<{ reason: string }>(PAUSED)?.reason ?? null,
    };
  }

  proposals(options: { status?: ProposalStatus; limit?: number } = {}): ProposalView[] {
    return this.store.listProposals(this.project, options).map(proposalView);
  }

  runs(limit = 50): PlannerRunView[] {
    return this.store.listRuns(this.project, limit).map((run) => this.store.runView(run));
  }

  history(limit = 100): ChangeView[] {
    return this.store.listChanges(this.project, limit);
  }

  // ============ LIFECYCLE ============

  /** Cycle soon, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = this.settings.intervalSeconds * 1000;
    const loop = async () => {
      if (this.stopped) return;
      await this.cycle();
      if (this.stopped) return;
      this.timer = setTimeout(loop, interval);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, Math.min(1000, interval));
    this.timer.unref();
  }

  /** Stop the loop; resolves once the cycle or action in progress has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queue;
  }
}
