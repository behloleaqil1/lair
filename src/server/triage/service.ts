/**
 * The triage service: one TriageService per project with `triage.enabled`.
 *
 * ingest(result) for every gate result: in-process from the gates module
 * (trusted: the gate.completed event), or a SignedGateResult over HTTP
 * (signed: verified against a trusted node key; only its re-check id is read
 * from its context, and the base comes from git):
 * 1. parse its reports and failed steps into causes;
 * 2. record which tests failed and passed at that commit. A test passed
 *    only when a report lists it as passed, or the run ran and passed the
 *    step it failed in;
 * 3. classify each cause (infra, flaky, pre-existing, code) with evidence;
 * 4. earlier failures at the same commit whose tests now passed become flaky;
 * 5. act per class: infra -> one re-check of only the failed tests at the
 *    same commit (capacity permitting, up to max_retries); pre-existing ->
 *    not blocking, one fix task on the default branch; flaky -> recorded,
 *    a reliability task after `ticket_after` in a row; code -> back to the
 *    author agent with the tests and a log excerpt;
 * 6. on the default branch (a commit in its history, whatever the label):
 *    red opens an incident (per pipeline) and bisects the merges since its
 *    last green run; a green run of the same pipeline that ran the failing
 *    steps, at a commit containing the red one, resolves it.
 *
 * Decisions run one at a time per project (the serial queue), each in one
 * store transaction that never waits on anything slow. Commands, decisions
 * and events go to an outbox drained outside the queue (the calls are also
 * written to the store, so a restart makes the ones a killed process left),
 * so a re-check command that posts its answer straight back never waits on
 * itself.
 */
import { randomUUID } from "crypto";
import type { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { EventType } from "../../shared/server-types.js";
import type { GateResult } from "../../shared/policy-types.js";
import type {
  ActionKind,
  ActionStatus,
  BisectState,
  ClassifiedCause,
  Incident,
  IncidentTarget,
  Recheck,
  RecheckStatus,
  ResultPurpose,
  ResultTrust,
  TestRef,
  TriageAction,
  TriageRecord,
  TriageTask,
  Verdict,
} from "../../shared/triage-types.js";
import type { DecisionProducer, DecisionResolution } from "../decisions/types.js";
import { verifySignedGateResult } from "../gates/signature.js";
import { FULL_SHA, actBlockedReason, type TriageSettings } from "./config.js";
import { parseGateEvidence, type EvidenceParser, type GateEvidence, type ReportInput } from "./parsers/index.js";
import { classifyCause, overallClass, type BaseFacts, type ClassifyContext } from "./classifier.js";
import type { TestRow, TriageStore, EnvironmentWaitRow } from "./store.js";
import type { CommitInfo, GitProbe } from "./git.js";
import { classifyEnvironment, getProbeForPattern, nextBackoff } from "./environment.js";
import {
  DECISION_MODULE,
  InboxDecisionRaiser,
  InboxDecisions,
  LimitsCapacity,
  decisionVars,
  messageVars,
  plannedArgv,
  recheckVars,
  revertVars,
  taskVars,
  type AdapterResult,
  type AgentMessage,
  type CapacityProbe,
  type DecisionRaiser,
  type DecisionRequest,
  type RevertRequest,
  type TriageAdapters,
} from "./adapters.js";
import { applyProbe, nextStep, retryProbe, startBisect, type ProbeOutcome } from "./bisect.js";
import { GateRechecks, type GatePlan } from "./gate-recheck.js";
import { clip, testClass } from "./text.js";
import type { Clock, CommandRunner } from "../watchdog/probes.js";

// ============ INPUT AND ERRORS ============

/** What the gate runner knows besides the result. Only a trusted result's context is read whole. */
export interface IngestContext {
  /** The commit the change is based on (a PR's base); from git when missing */
  baseSha?: string;
  /** Files the change touched; from git (base...head) when missing */
  changedFiles?: string[];
  /** The agent that authored the change */
  agent?: string;
  pr?: number;
  /** This result answers the re-check (or bisect probe) with this id */
  recheckId?: string;
  /** The run that produced it (in-process only): answers the re-check whose executor returned this run id */
  runId?: string;
  /** The machine's load per core while the gate ran */
  loadPerCore?: number;
}

export interface IngestInput {
  result: GateResult;
  reports?: ReportInput[];
  context?: IngestContext;
  trust: ResultTrust;
}

export interface IngestOutcome {
  record: TriageRecord;
  actions: TriageAction[];
  rechecks: Recheck[];
  incident: Incident | null;
}

/** Bad input: HTTP 400. */
export class TriageInputError extends Error {}
/** Not from a trusted source: HTTP 403. */
export class TriageForbiddenError extends Error {}
/** Unknown id: HTTP 404. */
export class TriageNotFoundError extends Error {}
/** Not possible in the current state (triage off, already answered, commands blocked): HTTP 409. */
export class TriageConflictError extends Error {}

export interface TriageProbes {
  runner: CommandRunner;
  clock: Clock;
  fs: { append(path: string, text: string): void };
  /** Git for a repository */
  git: (repo: string, runner: CommandRunner) => GitProbe;
}

export interface TriageServiceOptions {
  project: string;
  config: ProjectConfig;
  settings: TriageSettings;
  store: TriageStore;
  probes: TriageProbes;
  /** Command adapters, with any in-process ones from other modules on top */
  adapters: TriageAdapters;
  /** True when adapters.decisions is the raise_decision command (it doesn't run in observe mode) */
  decisionsViaCommand?: boolean;
  /** Trusted nodes' public keys (PEM), by node id */
  nodeKeys: Map<string, string>;
  parsers: EvidenceParser[];
  events?: EventBus;
}

/** A signed result as POSTed: the result object exactly as signed. */
export interface SignedInput {
  result: Record<string, unknown>;
  signature: string;
  nodePublicKey: string;
}

type Target = { recordId?: string; incidentId?: string };
type Job = () => Promise<void>;

/**
 * A call a decision queued. It is written to the store's outbox in the
 * decision's transaction and removed in the one that records its result, so
 * a call a killed process never ran runs after the restart (one that was
 * running when the process died may run again: at least once).
 */
type AdapterCall =
  | { kind: "route"; target: Target; what: string; message: AgentMessage }
  | { kind: "task"; target: Target; what: string; action: ActionKind; task: TriageTask }
  | { kind: "revert"; target: Target; what: string; request: RevertRequest; reason: string; actor?: string }
  | { kind: "decision"; target: Target; what: string; request: DecisionRequest };
/** Reading a culprit's commit, then deciding on it */
type Call = AdapterCall | { kind: "culprit"; incidentId: string; sha: string };

/** What one decision section leaves to do once its transaction commits. */
export interface Section {
  jobs: Job[];
  events: { type: EventType; data: Record<string, unknown> }[];
  dispatch: boolean;
}

interface IncidentPlan {
  target: IncidentTarget;
  lastGreenSha?: string;
  bisect: BisectState;
}

/** A re-check that an answer may still come back for. */
// "unavailable": the request failed or timed out, but the run may have started; its answer still counts until the re-check times out
const ANSWERABLE: RecheckStatus[] = ["dispatching", "requested", "unavailable"];
const OPEN_RECHECK: RecheckStatus[] = ["waiting_capacity", "dispatching", "requested", "planned", "unavailable"];
/** A re-check left "dispatching" this long (the server stopped mid-request) is given up */
const DISPATCH_STALE_MS = 10 * 60_000;

function short(sha: string): string {
  return sha.slice(0, 8);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function uniqueTests(tests: TestRef[]): TestRef[] {
  const seen = new Set<string>();
  const out: TestRef[] = [];
  for (const t of tests) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }
  return out;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function selection(recheck: Pick<Recheck, "tests" | "classes" | "steps">): string {
  if (recheck.tests.length > 0) {
    return `${recheck.tests.length} test(s) in ${recheck.classes.slice(0, 5).join(", ")}${recheck.classes.length > 5 ? ", ..." : ""}`;
  }
  return `step(s) ${recheck.steps.join(", ")}`;
}

function describe(cause: ClassifiedCause): string {
  const c = cause.cause;
  const tests = c.tests.length > 0 ? `${c.tests[0].key}${c.testCount > 1 ? ` (+${c.testCount - 1} more)` : ""}` : c.step ?? c.kind;
  return `${tests}: ${clip(c.type ? `${c.type}: ${c.message}` : c.message, 160)}`;
}

function actionKindOf(call: AdapterCall): ActionKind {
  return call.kind === "task" ? call.action : call.kind;
}

async function settle(run: () => Promise<AdapterResult>): Promise<AdapterResult> {
  try {
    return await run();
  } catch (e) {
    return { ok: false, detail: message(e) };
  }
}

/** `promise`, or a failed result after `ms`. */
function withTimeout(promise: Promise<AdapterResult>, ms: number): Promise<AdapterResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AdapterResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `no answer within ${Math.round(ms / 1000)} s` }), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stopped(status: BisectState["status"], detail: string): BisectState {
  return { status, candidates: [], good: -1, bad: -1, skipped: [], probes: [], proven: false, detail };
}

export class TriageService {
  readonly project: string;
  readonly settings: TriageSettings;
  private queue: Promise<unknown> = Promise.resolve();
  private outbox: Job[] = [];
  /** Outbox rows this process has queued (the others are a previous process's) */
  private queued = new Set<string>();
  private draining: Promise<void> | null = null;
  private dispatchQueued = false;
  private git: GitProbe;
  private capacity: CapacityProbe;
  private decisions?: DecisionRaiser;
  private decisionsViaCommand: boolean;
  private unsubscribe?: () => void;
  /** Re-checks in the project's own gate system (triage.recheck.mode) */
  private gateRechecks: GateRechecks;

  constructor(private o: TriageServiceOptions) {
    this.project = o.project;
    this.settings = o.settings;
    this.git = o.probes.git(o.config.repo, o.probes.runner);
    this.capacity = o.adapters.capacity ?? new LimitsCapacity(o.settings.recheck, o.probes.runner);
    const file = o.settings.decisionFile ?? o.config.inbox_file;
    this.decisions = o.adapters.decisions ?? (file ? new InboxDecisionRaiser(file, o.probes.fs, o.probes.clock) : undefined);
    this.decisionsViaCommand = o.decisionsViaCommand === true;
    this.gateRechecks = new GateRechecks({
      project: o.project,
      config: o.config,
      settings: o.settings,
      store: o.store,
      runner: o.probes.runner,
      now: () => this.now(),
      serial: <T>(fn: () => Promise<T>) => this.serial(fn),
      commit: <T>(fn: (s: Section) => T) => this.commit(fn),
      action: (target, kind, status, detail, argv, output, actor) => {
        this.action(target, kind, status, detail, argv, output, actor);
      },
      raiseDecision: (target, s, request) => this.raiseDecision(target, s, request),
      routeToAuthor: (record, causes, s, why) => this.routeToAuthor(record, causes, s, why),
      flakyOccurrence: (key, record, why, s) => this.flakyOccurrence(key, record, why, s),
    });
  }

  /** Re-checks in the project's own gate system: mode, why they don't run, how many are pending. */
  get gateRecheckStatus(): { mode: "off" | "observe" | "act"; blocked: string | null; pending: number } {
    return this.gateRechecks.status();
  }

  /** Raise decisions in the Decision Inbox, and follow their answers. */
  useDecisions(inbox: DecisionProducer): void {
    this.decisions = new InboxDecisions(inbox);
    this.decisionsViaCommand = false;
    this.unsubscribe?.();
    this.unsubscribe = inbox.onResolved(DECISION_MODULE, (r) => this.followDecision(r), { project: this.project });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Why commands don't run (observe mode, read_only), or null. */
  get actBlocked(): string | null {
    return actBlockedReason(this.o.config, this.o.settings);
  }

  /** Which commands and adapters are available. */
  get commands(): Record<string, boolean> {
    const a = this.o.adapters;
    return {
      recheck: a.recheck !== undefined,
      notify_agent: a.router !== undefined,
      create_task: a.tasks !== undefined,
      raise_decision: this.decisions !== undefined,
      open_revert: a.revert !== undefined,
    };
  }

  get trustedNodes(): string[] {
    return [...this.o.nodeKeys.keys()];
  }

  private now(): number {
    return this.o.probes.clock.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ============ QUEUE AND OUTBOX ============

  /** Run decisions for this project one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One decision section: its writes in one transaction; its jobs and events queued after it commits. */
  private commit<T>(fn: (s: Section) => T): T {
    const s: Section = { jobs: [], events: [], dispatch: false };
    const value = this.o.store.transaction(() => fn(s));
    for (const event of s.events) this.outbox.push(() => this.emit(event.type, event.data));
    this.outbox.push(...s.jobs);
    if (s.dispatch && !this.dispatchQueued) {
      this.dispatchQueued = true;
      this.outbox.push(() => this.dispatch());
    }
    return value;
  }

  /**
   * Run the outbox outside the serial queue. Returns at once when a drain is
   * already running (it takes the new jobs too): a job's command may call
   * back into ingest(), which must not wait for that very job.
   */
  private drain(): Promise<void> {
    if (this.draining) return Promise.resolve();
    if (this.outbox.length === 0) return Promise.resolve();
    const run = async () => {
      await Promise.resolve();
      try {
        while (this.outbox.length > 0) {
          const job = this.outbox.shift()!;
          try {
            await job();
          } catch (e) {
            console.warn(`[triage] ${this.project}: ${message(e)}`);
          }
        }
      } finally {
        this.draining = null;
      }
    };
    this.draining = run();
    return this.draining;
  }

  /** Resolves when no decision is queued and the outbox is empty. */
  async idle(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.queue;
      if (this.draining) {
        await this.draining;
        continue;
      }
      if (this.outbox.length > 0) {
        await this.drain();
        continue;
      }
      return;
    }
  }

  private async emit(type: EventType, data: Record<string, unknown>): Promise<void> {
    await this.o.events?.emit(type, { project: this.project, ...data });
  }

  private action(
    target: Target,
    kind: ActionKind,
    status: ActionStatus,
    detail: string,
    argv?: string[],
    output?: string,
    actor?: string,
  ): TriageAction {
    return this.o.store.addAction(
      {
        project: this.project,
        recordId: target.recordId,
        incidentId: target.incidentId,
        kind,
        status,
        detail,
        argv,
        output,
        actor,
        at: this.iso(),
      },
      this.now(),
    );
  }

  /**
   * Queue an adapter call, or record why it doesn't run: observe mode or
   * read_only (planned, with the argv it would run), or no adapter
   * (recorded). The call goes through the outbox; its result is recorded in
   * a decision section of its own (afterCall).
   */
  private perform(s: Section, call: AdapterCall, planned: string[] | null): void {
    const kind = actionKindOf(call);
    const actor = call.kind === "revert" ? call.actor : undefined;
    const blocked = this.actBlocked;
    if (blocked) {
      this.action(call.target, kind, "planned", `${call.what} (not run: ${blocked})`, planned ?? undefined, undefined, actor);
      return;
    }
    if (!this.hasAdapter(call)) {
      this.action(call.target, kind, "recorded", `${call.what} (recorded and emitted; no command or module set)`, undefined, undefined, actor);
      return;
    }
    this.enqueue(s, call);
  }

  private hasAdapter(call: AdapterCall): boolean {
    const a = this.o.adapters;
    if (call.kind === "route") return a.router !== undefined;
    if (call.kind === "task") return a.tasks !== undefined;
    if (call.kind === "revert") return a.revert !== undefined;
    return this.decisions !== undefined;
  }

  /** Write the call to the store's outbox (in this section's transaction) and run it once the section commits. */
  private enqueue(s: Section, call: Call): void {
    const id = this.o.store.addOutbox(this.project, call.kind, call, this.now());
    this.queued.add(id);
    s.jobs.push(() => this.runCall(id, call));
  }

  /** Queue the calls a previous process wrote to the outbox and never finished. */
  private requeue(): void {
    for (const row of this.o.store.outbox(this.project)) {
      if (this.queued.has(row.id)) continue;
      this.queued.add(row.id);
      const call = row.payload as Call;
      this.outbox.push(() => this.runCall(row.id, call));
    }
  }

  /** Run one outbox call outside the queue, then record its result and remove it, in one transaction. */
  private async runCall(id: string, call: Call): Promise<void> {
    const { store } = this.o;
    try {
      if (call.kind === "culprit") {
        let info: CommitInfo | null = null;
        try {
          info = await this.git.commit(call.sha);
        } catch {
          info = null;
        }
        await this.serial(async () =>
          this.commit((s) => {
            if (store.removeOutbox(id)) this.decideCulprit(call.incidentId, info, s);
          }),
        );
        return;
      }
      const kind = actionKindOf(call);
      const actor = call.kind === "revert" ? call.actor : undefined;
      // A previous process's call, after the project switched to observe mode or read_only
      const blocked = call.kind === "decision" ? null : this.actBlocked;
      const result: AdapterResult = blocked ? { ok: false, detail: `not run: ${blocked}` } : await settle(() => this.callAdapter(call));
      await this.serial(async () =>
        this.commit((s) => {
          if (!store.removeOutbox(id)) return;
          this.action(call.target, kind, blocked ? "planned" : result.ok ? "done" : "failed", `${call.what}: ${result.detail}`, result.argv, result.output, actor);
          if (!blocked) this.afterCall(call, result, s);
        }),
      );
    } finally {
      this.queued.delete(id);
    }
  }

  private callAdapter(call: AdapterCall): Promise<AdapterResult> {
    const a = this.o.adapters;
    const none = (what: string): Promise<AdapterResult> => Promise.resolve({ ok: false, detail: `${what} is no longer set` });
    if (call.kind === "route") return a.router ? a.router.route(call.message) : none("notify_agent");
    if (call.kind === "task") return a.tasks ? a.tasks.create(call.task) : none("create_task");
    if (call.kind === "revert") return a.revert ? a.revert.open(call.request) : none("open_revert");
    return this.decisions ? this.decisions.raise(call.request) : none("the Decision Inbox");
  }

  /** What a call's result changes besides its action record. */
  private afterCall(call: AdapterCall, result: AdapterResult, s: Section): void {
    const { store } = this.o;
    if (call.kind === "task") {
      if (result.ok && result.ref) store.setTaskRef(call.task.id, result.ref);
    } else if (call.kind === "revert") {
      this.revertDone(call.request.incidentId, call.request.sha, result, call.reason, call.actor, s);
    } else if (call.kind === "decision" && result.ok && result.ref) {
      store.setDecisionRef(this.project, call.request.subject, result.ref);
      if (call.target.incidentId) store.updateIncident(call.target.incidentId, { decisionRef: result.ref });
    }
  }

  // ============ TRUST ============

  /**
   * Throws unless a trusted node signed this result (its key from
   * triage.trusted_nodes); returns that key (PEM), whatever the caller sent
   * as `nodePublicKey`.
   */
  verifySigned(signed: SignedInput): string {
    const nodeId = typeof signed.result.nodeId === "string" ? signed.result.nodeId : "";
    const key = this.o.nodeKeys.get(nodeId);
    if (!key) {
      throw new TriageForbiddenError(
        nodeId ? `Node ${clip(nodeId, 80)} is not trusted (triage.trusted_nodes)` : "The result names no node (nodeId)",
      );
    }
    const check = verifySignedGateResult(
      { result: signed.result as unknown as GateResult, signature: signed.signature, nodePublicKey: key },
      key,
    );
    if (!check.valid) throw new TriageForbiddenError(`The signature does not verify: ${check.errors.join("; ")}`);
    return key;
  }

  // ============ INGEST ============

  /**
   * Decide on a result. By default this also waits for what the decision
   * queued (agent messages, tasks, re-check requests); with `background` (an
   * HTTP caller) it returns the record at once and that runs on its own.
   */
  async ingest(input: IngestInput, options: { background?: boolean } = {}): Promise<IngestOutcome> {
    const recordId = await this.serial(() => this.decideIngest(input));
    if (options.background) void this.drain();
    else await this.drain();
    return this.serial(async () => this.outcome(recordId));
  }

  /** Expire, advance and request re-checks and bisect probes; release ended quarantines. */
  async tick(): Promise<void> {
    await this.serial(async () => this.commit((s) => this.pumpSync(s)));
    this.requeue();
    await this.drain();
  }

  private outcome(recordId: string): IngestOutcome {
    const { store, settings, project } = this.o;
    const record = store.getRecord(recordId)!;
    return {
      record,
      actions: store.actionsFor({ recordId }),
      rechecks: store.rechecksFor({ recordId: record.originId ?? recordId }),
      incident: store.openIncident(project, settings.defaultBranch, record.pipelineId),
    };
  }

  /** Whether `sha` is in the default branch's history (its local or a remote's tip); false when git can't tell. */
  private async inDefaultBranch(sha: string): Promise<boolean> {
    try {
      for (const tip of await this.git.branchTips(this.o.settings.defaultBranch)) {
        if (await this.contains(tip, sha)) return true;
      }
    } catch {
      // Unknown history: not trusted as the default branch
    }
    return false;
  }

  /** Whether `descendant` is `ancestor` or has it in its history; false when git can't tell. */
  private async contains(descendant: string, ancestor: string): Promise<boolean> {
    if (descendant.toLowerCase() === ancestor.toLowerCase()) return true;
    try {
      return await this.git.isAncestor(ancestor, descendant);
    } catch {
      return false;
    }
  }

  private async decideIngest(input: IngestInput): Promise<string> {
    const { store, settings, project } = this.o;
    const result = input.result;
    // A signed result over HTTP: its context is not signed, so only its re-check id is read
    const context: IngestContext =
      input.trust === "trusted" ? (input.context ?? {}) : { recheckId: input.context?.recheckId };
    const sha = result.commitSha.toLowerCase();
    if (!FULL_SHA.test(sha)) throw new TriageInputError("commitSha must be a full commit sha (40 or 64 hex characters)");
    if (store.hasGateResult(project, result.id)) {
      throw new TriageConflictError(`A result with id ${clip(result.id, 80)} was already received`);
    }
    const nowMs = this.now();

    // A run the pipelines module names in-process; an HTTP caller's context is not signed
    const runId = input.trust === "trusted" ? context.runId : undefined;
    let recheck: Recheck | null = null;
    // A re-check in the project's own gate system names the result it re-checks (gate-recheck.ts)
    const gateLink = this.gateRechecks.link(context.recheckId, result.id, sha);
    const linked = gateLink?.kind === "link" ? gateLink.link : null;
    // It named one that can't take it: still a true result, kept as a plain gate result with a note
    const plainNote = gateLink?.kind === "plain" ? gateLink.note : undefined;
    // Without a re-check id, a result still answers the waiting re-check whose id or run id it carries
    const recheckId = gateLink
      ? undefined
      : (context.recheckId ?? store.answerableRecheck(project, [result.id, ...(runId ? [runId] : [])], sha, result.branch, ANSWERABLE)?.id);
    if (recheckId) {
      recheck = store.getRecheck(recheckId);
      if (!recheck || recheck.project !== project) throw new TriageNotFoundError(`No re-check ${recheckId}`);
      if (recheck.sha.toLowerCase() !== sha) {
        throw new TriageInputError(`Re-check ${short(recheck.id)} is for ${recheck.sha}, not ${sha}`);
      }
      if (recheck.branch !== result.branch) {
        throw new TriageInputError(`Re-check ${short(recheck.id)} is for branch ${recheck.branch}, not ${result.branch}`);
      }
      if (!ANSWERABLE.includes(recheck.status)) {
        throw new TriageConflictError(`Re-check ${short(recheck.id)} is ${recheck.status}: it was not requested, or it was already answered`);
      }
      if (result.id !== recheck.id && result.id !== recheck.runId && !(runId && runId === recheck.runId)) {
        throw new TriageConflictError(
          `An answer to re-check ${short(recheck.id)} must have its id (${recheck.id})${recheck.runId ? ` or its run id (${recheck.runId})` : ""} as the result id`,
        );
      }
    }
    const origin = linked?.origin ?? (recheck?.recordId ? store.getRecord(recheck.recordId) : null);
    const purpose: ResultPurpose = recheck ? (recheck.purpose === "bisect" ? "bisect" : "recheck") : linked ? "recheck" : "gate";
    const failed = result.status !== "passed";
    const pipelineId = result.pipelineId;
    const passedSteps = result.steps.filter((st) => st.status === "passed").map((st) => st.name);
    const failedSteps = result.steps.filter((st) => st.status === "failed" || st.status === "timed_out").map((st) => st.name);
    const notes: string[] = [];
    // A result's branch is only a label: it is the default branch's run only
    // when the commit is in that branch's history
    let branchNote: string | undefined;
    let isDefault = false;
    if (result.branch === settings.defaultBranch) {
      isDefault = await this.inDefaultBranch(sha);
      if (!isDefault) {
        branchNote = `labelled ${settings.defaultBranch}, but ${short(sha)} is not in ${settings.defaultBranch}'s history: triaged as a change`;
      }
    }
    // A green default branch ends an incident only at a commit that contains the red one
    let greenAfterRed = false;
    const openOnDefault = isDefault && !failed && purpose === "gate" ? store.openIncident(project, settings.defaultBranch, pipelineId) : null;
    if (openOnDefault) greenAfterRed = await this.contains(sha, openOnDefault.redSha);

    const evidence = parseGateEvidence(result, input.reports ?? [], {
      contextPatterns: settings.contextPatterns,
      parsers: this.o.parsers,
    });

    // The base and the changed files: a trusted result's context, else git
    let baseSha = context.baseSha?.toLowerCase() ?? origin?.baseSha;
    let changedFiles = context.changedFiles ?? origin?.changedFiles;
    if (!isDefault && !origin) {
      if (!baseSha) {
        try {
          baseSha = (await this.git.mergeBase(sha, settings.defaultBranch)) ?? undefined;
          if (!baseSha) notes.push(`${short(sha)} shares no history with ${settings.defaultBranch}`);
        } catch (e) {
          notes.push(`the base commit is unknown (${clip(message(e), 160)})`);
        }
      }
      if (!changedFiles && baseSha && failed) {
        try {
          changedFiles = await this.git.changedFiles(baseSha, sha);
        } catch (e) {
          notes.push(`the changed files are unknown (${clip(message(e), 160)})`);
        }
      }
    }

    // The default branch's open incident counts for a change only when its base includes the red commit
    let incident = store.openIncident(project, settings.defaultBranch, pipelineId);
    if (incident && !isDefault) {
      let applies = false;
      if (baseSha) {
        try {
          applies = baseSha === incident.redSha.toLowerCase() || (await this.git.isAncestor(incident.redSha, baseSha));
        } catch {
          applies = false;
        }
      }
      if (!applies) incident = null;
    }

    const classified = failed
      ? this.classify(evidence, {
          sha,
          isDefault,
          baseSha,
          pipelineId,
          changedFiles: changedFiles ?? [],
          notes,
          nowMs,
          loadPerCore: context.loadPerCore,
          incident,
        })
      : [];

    // A red default branch: what the incident's bisect needs from git, read before the transaction
    const regressions = isDefault && purpose !== "bisect" && failed ? classified.filter((c) => c.verdict.class === "code") : [];
    const plan =
      regressions.length > 0 && !store.openIncident(project, result.branch, pipelineId)
        ? await this.planIncident(result.branch, pipelineId, sha, regressions, failedSteps, nowMs)
        : null;

    return this.commit((s) => {
      const windowMs = settings.flaky.windowMinutes * 60000;
      const id = store.insertRecord({
        project,
        gateId: result.id,
        pipelineId,
        trust: input.trust,
        sha,
        branch: result.branch,
        baseSha,
        agent: context.agent ?? origin?.agent,
        pr: context.pr ?? origin?.pr,
        purpose,
        recheckId: recheck?.id ?? linked?.recheck.id,
        originId: origin?.id,
        status: result.status,
        defaultBranch: isDefault,
        failedSteps,
        passedSteps,
        changedFiles: changedFiles ?? [],
        receivedAt: this.iso(nowMs),
        receivedMs: nowMs,
      });
      if (classified.length > 0) store.insertCauses(id, classified);
      if (branchNote) this.action({ recordId: id }, "note", "recorded", branchNote);
      if (plainNote) this.action({ recordId: id }, "note", "recorded", plainNote);

      // Which tests passed: listed as passed by a report, or (a gate run) failed
      // at this commit in a step this run ran and passed
      const passedKeys = new Set(evidence.passed.map((t) => t.key));
      if (purpose === "gate" && passedSteps.length > 0) {
        for (const key of store.failedKeysInSteps(project, sha, passedSteps, nowMs - windowMs)) passedKeys.add(key);
      }
      const rows: TestRow[] = [];
      const failing = new Set<string>();
      for (const c of classified) {
        for (const t of c.cause.tests) {
          failing.add(t.key);
          rows.push({ key: t.key, outcome: "fail", cls: c.verdict.class, step: c.cause.step });
        }
      }
      for (const key of passedKeys) if (!failing.has(key)) rows.push({ key, outcome: "pass" });
      for (const t of uniqueTests(evidence.flaky)) {
        rows.push({ key: t.key, outcome: "fail", cls: "flaky" }, { key: t.key, outcome: "pass" });
      }
      store.addTests(project, sha, id, rows, nowMs);
      for (const key of failing) passedKeys.delete(key);
      this.quarantineObservations([...passedKeys], [...failing]);

      this.reclassifyFlaky(sha, passedKeys, id, nowMs, s);
      if (recheck) this.answerRecheck(recheck, id, result, evidence, classified, origin, s);
      if (linked) this.gateRechecks.answer(linked, id, result, evidence, classified, s);

      const record = store.getRecord(id)!;
      if (failed && purpose !== "bisect") {
        this.act(record, classified, origin, this.gateRechecks.plan(record, classified, linked, context.loadPerCore, s, plainNote), s);
      } else if (failed) {
        store.updateRecord(id, { verdict: overallClass(classified) ?? null, blocking: false, resolution: "bisect probe" });
      }
      for (const t of uniqueTests(evidence.flaky)) {
        this.flakyOccurrence(t.key, record, "failed, then passed on a rerun in the same run", s);
      }
      if (isDefault && purpose !== "bisect") {
        this.defaultBranchResult(store.getRecord(id)!, classified, passedSteps, plan, greenAfterRed, s);
      }
      this.pumpSync(s);

      const final = store.getRecord(id)!;
      s.events.push({
        type: "triage.classified",
        data: {
          recordId: id,
          gateId: final.gateId,
          pipelineId,
          trust: input.trust,
          sha,
          branch: final.branch,
          status: final.status,
          verdict: final.verdict ?? null,
          blocking: final.blocking,
          causes: final.causes.map((c) => ({ signature: c.cause.signature, class: c.verdict.class, rule: c.verdict.rule })),
        },
      });
      return id;
    });
  }

  /** The tests a re-check was asked to run, by key. */
  private requestedKeys(recheck: Recheck, origin: TriageRecord | null): string[] {
    if (recheck.incidentId) return this.o.store.getIncident(recheck.incidentId)?.target.keys ?? [];
    if (!origin) return [];
    const ids = new Set(recheck.tests);
    return unique(origin.causes.flatMap((c) => c.cause.tests.filter((t) => ids.has(t.id)).map((t) => t.key)));
  }

  private classify(
    evidence: GateEvidence,
    input: {
      sha: string;
      isDefault: boolean;
      baseSha?: string;
      pipelineId: string;
      changedFiles: string[];
      notes: string[];
      nowMs: number;
      loadPerCore?: number;
      incident: Incident | null;
    },
  ): ClassifiedCause[] {
    const { store, project, settings } = this.o;
    let base: BaseFacts | undefined;
    let baseNote: string | undefined;
    if (!input.isDefault) {
      if (input.baseSha) {
        const since = input.nowMs - settings.baseMaxAgeHours * 3_600_000;
        const latest = store.baseResult(project, input.baseSha, input.pipelineId, since, "");
        if (latest) {
          base = {
            recordId: latest.id,
            sha: latest.sha,
            status: latest.status,
            at: latest.receivedAt,
            failedKeys: new Set(latest.causes.flatMap((c) => c.cause.tests.map((t) => t.key))),
            signatures: new Set(latest.causes.map((c) => c.cause.signature)),
          };
        } else {
          baseNote = `no gate run of ${input.pipelineId || "this pipeline"} at the base commit ${short(input.baseSha)} in the last ${settings.baseMaxAgeHours} h`;
        }
      } else {
        baseNote = input.notes[0] ?? "the base commit is unknown";
      }
    }
    const keys = evidence.causes.flatMap((c) => c.tests.map((t) => t.key));
    const windowMs = settings.flaky.windowMinutes * 60000;
    const ctx: ClassifyContext = {
      sha: input.sha,
      defaultBranch: input.isDefault,
      changedFiles: input.changedFiles,
      changedNote: input.changedFiles.length === 0 && input.notes.length > 0 ? input.notes.join("; ") : undefined,
      base,
      baseNote,
      incident: input.incident
        ? {
            id: input.incident.id,
            redSha: input.incident.redSha,
            keys: new Set(input.incident.target.keys),
            signatures: new Set(input.incident.target.signatures),
          }
        : undefined,
      passedAtSha: store.passesAt(project, input.sha, keys, input.nowMs - windowMs, input.nowMs + windowMs, ""),
      quarantined: store.quarantinedKeys(project),
      loadPerCore: input.loadPerCore,
    };
    return evidence.causes.map((cause) => ({ id: randomUUID(), cause, verdict: classifyCause(cause, ctx, settings) }));
  }

  private targetOf(regressions: ClassifiedCause[], failedSteps: string[]): IncidentTarget {
    const tests = uniqueTests(regressions.flatMap((c) => c.cause.tests));
    const steps = unique(regressions.flatMap((c) => (c.cause.step ? [c.cause.step] : [])));
    return {
      tests: tests.map((t) => t.id),
      keys: tests.map((t) => t.key),
      classes: unique(tests.map(testClass)),
      steps: steps.length > 0 ? steps : failedSteps,
      signatures: regressions.map((c) => c.cause.signature),
    };
  }

  private async planIncident(
    branch: string,
    pipelineId: string,
    sha: string,
    regressions: ClassifiedCause[],
    failedSteps: string[],
    nowMs: number,
  ): Promise<IncidentPlan> {
    const { store, settings, project } = this.o;
    const target = this.targetOf(regressions, failedSteps);
    if (!settings.bisect.enabled) return { target, bisect: stopped("off", "triage.bisect.enabled is false") };
    const lastGreen = store.lastGreen(project, branch, pipelineId, target.steps, nowMs);
    if (!lastGreen) {
      return {
        target,
        bisect: stopped(
          "no_baseline",
          `no green run of ${pipelineId || "this pipeline"} on ${branch} that ran ${target.steps.join(", ") || "its steps"} yet, so there is nothing to bisect from`,
        ),
      };
    }
    try {
      const candidates = await this.git.firstParentRange(lastGreen.sha, sha);
      if (candidates.length > settings.bisect.maxCandidates) {
        return {
          target,
          lastGreenSha: lastGreen.sha,
          bisect: stopped(
            "inconclusive",
            `${candidates.length} commits since the last green one is more than bisect.max_candidates (${settings.bisect.maxCandidates})`,
          ),
        };
      }
      const red = candidates.find((c) => c.toLowerCase() === sha) ?? sha;
      return { target, lastGreenSha: lastGreen.sha, bisect: startBisect(candidates, red) };
    } catch (e) {
      return { target, lastGreenSha: lastGreen.sha, bisect: stopped("inconclusive", `git: ${clip(message(e), 200)}`) };
    }
  }

  // ============ ACTIONS PER CLASS ============

  /** `gate`: the gate system's re-check (gate-recheck.ts), null when triage.recheck.mode is off */
  private act(record: TriageRecord, classified: ClassifiedCause[], origin: TriageRecord | null, gate: GatePlan | null, s: Section): void {
    const { store, settings } = this.o;
    const of = (cls: Verdict["class"]) => classified.filter((c) => c.verdict.class === cls);
    const infra = of("infra");
    const code = of("code");
    let blocking = false;
    const pending: string[] = [];

    if (infra.length > 0) {
      blocking = true;

      // Check if this is an environment outage (all infra, no code, all steps match env patterns)
      const envResult = this.checkEnvironmentOutage(record, infra, code);
      const isEnvActMode = envResult.isEnvironment && settings.environment.mode === "act";

      if (envResult.isEnvironment && settings.environment.mode === "observe") {
        // Environment outage detected in observe mode: record what we would do
        this.action(
          { recordId: record.id },
          "note",
          "recorded",
          `environment outage detected: ${envResult.patternId} (observe mode: would wait for probe to pass)`,
        );
        // In observe mode, continue with normal flow (fall through to recheck/route)
      }

      if (isEnvActMode) {
        // act mode: add to environment wait (this blocks the normal recheck flow)
        const waitResult = this.addToEnvironmentWait(record, envResult.patternId!, envResult.probe!, s);
        pending.push(waitResult);
      } else if (gate) {
        // The project's gate system re-checks it, in place of a re-check Lair runs
        if (gate.text) pending.push(`infra: ${gate.text}`);
      } else if (settings.actions.infra === "recheck") {
        pending.push(this.recheckInfra(record, infra, origin, s));
      } else if (settings.actions.infra === "route") {
        this.routeToAuthor(record, infra, s, "infrastructure failures are routed to the author (triage.actions.infra: route)");
        pending.push("infra: routed to the author");
      } else {
        this.action({ recordId: record.id }, "note", "skipped", "infra: no action (triage.actions.infra: none)");
        pending.push("infra: no action");
      }
    }
    if (code.length > 0) {
      blocking = true;
      if (record.defaultBranch) {
        // Nobody authored the default branch's head: the incident's bisect finds the culprit and its author
        pending.push("code: the default branch is red");
      } else if (gate?.holdRoute) {
        // Test timeouts are re-checked quietly first, and go to the author if the re-check fails the same way
        // (or escalated: the failure it re-checked went to the author)
        pending.push(`code: ${gate.text ?? "re-checked first"}`);
      } else if (settings.actions.code === "route") {
        this.routeToAuthor(record, code, s);
        pending.push("code: back to the author");
      } else {
        this.action({ recordId: record.id }, "note", "skipped", "code: no action (triage.actions.code: none)");
      }
    }
    for (const c of of("pre-existing")) this.preExisting(record, c, s);
    for (const c of of("flaky")) {
      for (const t of c.cause.tests) this.flakyOccurrence(t.key, record, c.verdict.evidence[0] ?? c.verdict.rule, s);
    }

    const notBlocking = [
      ...(of("pre-existing").length > 0 ? ["pre-existing on the default branch"] : []),
      ...(of("flaky").length > 0 ? ["flaky"] : []),
    ];
    store.updateRecord(record.id, {
      verdict: overallClass(classified) ?? null,
      blocking,
      resolution: (blocking ? pending : notBlocking.map((n) => `not blocking: ${n}`)).join("; ") || null,
    });
  }

  /**
   * Check if a result represents an environment outage.
   * Returns the matched pattern and probe if it's an environment outage.
   */
  private checkEnvironmentOutage(
    record: TriageRecord,
    infra: ClassifiedCause[],
    code: ClassifiedCause[],
  ): { isEnvironment: boolean; patternId?: string; probe?: string[] } {
    // Not an environment outage if there are code failures
    if (code.length > 0) return { isEnvironment: false };

    const { settings } = this.o;
    if (settings.environment.patterns.length === 0) return { isEnvironment: false };

    // Build step outputs from the record's failed steps
    const stepOutputs = record.failedSteps.map((stepName) => {
      // Find the cause that mentions this step
      const cause = infra.find((c) => c.cause.step === stepName);
      return {
        step: stepName,
        status: "failed" as const,
        output: cause ? [cause.cause.message, ...cause.cause.evidence].join("\n") : "",
        exitCode: cause?.cause.type?.startsWith("exit ") ? parseInt(cause.cause.type.split(" ")[1], 10) : undefined,
      };
    });

    const envClass = classifyEnvironment(stepOutputs, settings.environment.patterns);
    if (!envClass.isEnvironment) return { isEnvironment: false };

    // Get the first matched pattern and its probe
    const patternId = envClass.matchedPatterns[0];
    const probe = getProbeForPattern(patternId, settings.environment.patterns);

    // Without a probe, we can't wait for recovery
    if (!probe) return { isEnvironment: false };

    return { isEnvironment: true, patternId, probe };
  }

  /**
   * Add a gate to an environment wait or create a new one.
   * Returns the action description.
   */
  private addToEnvironmentWait(record: TriageRecord, patternId: string, probe: string[], s: Section): string {
    const { store, settings, project } = this.o;
    const nowMs = this.now();
    const startedAt = this.iso(nowMs);
    const expiresAt = this.iso(nowMs + settings.environment.maxWaitMinutes * 60 * 1000);
    const nextProbeAt = this.iso(nowMs + settings.environment.initialBackoffSeconds * 1000);

    const pattern = settings.environment.patterns.find((p) => p.id === patternId);
    const probeTimeout = pattern?.probeTimeoutSeconds ?? 30;

    const waitId = store.addEnvironmentWait(
      project,
      patternId,
      probe,
      probeTimeout,
      [record.gateId],
      [record.id],
      startedAt,
      expiresAt,
      nextProbeAt,
      settings.environment.initialBackoffSeconds,
    );

    this.action(
      { recordId: record.id },
      "note",
      "recorded",
      `environment outage: waiting for ${patternId} to recover (probe: ${probe.join(" ")}, wait ${waitId.slice(0, 8)})`,
    );

    s.dispatch = true; // Schedule a tick to run probes
    return `infra: environment outage (${patternId}), waiting for recovery`;
  }

  /**
   * Process environment waits: run probes when due, resolve waits when probe passes,
   * expire waits that have been waiting too long, and raise decisions for expired waits.
   */
  private processEnvironmentWaits(s: Section): void {
    const { store, project } = this.o;
    const nowMs = this.now();
    const nowIso = this.iso(nowMs);

    // First, handle expired waits
    for (const wait of store.expiredEnvironmentWaits(project, nowIso)) {
      this.expireEnvironmentWait(wait, s);
    }

    // Then, process waits ready for probe
    for (const wait of store.environmentWaitsReadyForProbe(project, nowIso)) {
      // Schedule probe to run in the outbox (outside the serial queue)
      s.jobs.push(() => this.runEnvironmentProbe(wait.id));
    }
  }

  /**
   * Run the probe for an environment wait. Called from the outbox.
   */
  private async runEnvironmentProbe(waitId: string): Promise<void> {
    await this.serial(async () => {
      const { store, settings } = this.o;
      const wait = store.getEnvironmentWait(waitId);
      if (!wait || wait.status !== "waiting") return;

      const probe = JSON.parse(wait.probe) as string[];
      const nowMs = this.now();
      const nowIso = this.iso(nowMs);

      let result: { ok: boolean; output: string };
      try {
        const output = await this.o.probes.runner.run(probe);
        result = { ok: output.code === 0, output: (output.stdout + output.stderr).slice(0, 500) };
      } catch (e) {
        result = { ok: false, output: message(e).slice(0, 500) };
      }

      const probePassCount = result.ok ? wait.probe_pass_count + 1 : 0;
      const newBackoff = result.ok ? wait.current_backoff_seconds : nextBackoff(wait.current_backoff_seconds, settings.environment.maxBackoffSeconds);
      const nextProbeAt = this.iso(nowMs + newBackoff * 1000);

      store.updateEnvironmentWaitProbe(waitId, nowIso, result, probePassCount, nextProbeAt, newBackoff);

      this.commit((s) => {
        if (result.ok) {
          // Probe passed! Resolve the wait and trigger re-checks
          this.resolveEnvironmentWait(wait, s);
        } else {
          // Probe failed, will retry with backoff
          this.action(
            {},
            "note",
            "recorded",
            `environment probe failed for ${wait.pattern_id} (wait ${wait.id.slice(0, 8)}): ${result.output.slice(0, 200)}`,
          );
        }
      });
    });
  }

  /**
   * Resolve an environment wait after its probe passes. Triggers re-checks for all waiting gates.
   */
  private resolveEnvironmentWait(wait: EnvironmentWaitRow, s: Section): void {
    const { store, project } = this.o;
    const nowIso = this.iso();

    store.resolveEnvironmentWait(wait.id, "resolved", nowIso);

    // Get all gates that were waiting
    const gates = store.getEnvironmentWaitGates(wait.id);

    this.action(
      {},
      "note",
      "done",
      `environment recovered: ${wait.pattern_id} (wait ${wait.id.slice(0, 8)}), triggering re-checks for ${gates.length} gate(s)`,
    );

    // Trigger re-checks for each waiting gate
    // These re-checks don't count against max_per_result (they're environment-triggered)
    for (const gate of gates) {
      const record = store.getRecord(gate.recordId);
      if (!record) continue;

      // Create re-check with special purpose to indicate it's from environment recovery
      const tests = uniqueTests(record.causes.flatMap((c) => c.cause.tests));
      let steps = unique(record.causes.flatMap((c) => (c.cause.step ? [c.cause.step] : [])));
      if (tests.length === 0 && steps.length === 0) steps = record.failedSteps;

      if (tests.length > 0 || steps.length > 0) {
        store.createRecheck(
          {
            project,
            purpose: "infra",
            recordId: record.id,
            sha: record.sha,
            branch: record.branch,
            gateId: record.gateId,
            steps,
            tests: tests.map((t) => t.id),
            classes: unique(tests.map(testClass)),
            attempt: 0, // Start fresh - doesn't count against max_per_result
            status: "waiting_capacity",
            reason: "environment recovered",
            createdAt: nowIso,
          },
          this.now(),
        );
        this.action(
          { recordId: record.id },
          "recheck",
          "waiting",
          `re-check queued after environment recovery (${wait.pattern_id})`,
        );
      }
    }

    // Schedule dispatch to process waiting re-checks
    s.dispatch = true;
  }

  /**
   * Expire an environment wait that has been waiting too long.
   * Raises ONE decision for all gates in the wait.
   */
  private expireEnvironmentWait(wait: EnvironmentWaitRow, s: Section): void {
    const { store, project } = this.o;
    const nowIso = this.iso();

    store.resolveEnvironmentWait(wait.id, "expired", nowIso);

    const gates = store.getEnvironmentWaitGates(wait.id);

    this.action(
      {},
      "note",
      "failed",
      `environment wait expired: ${wait.pattern_id} (wait ${wait.id.slice(0, 8)}), ${gates.length} gate(s) affected`,
    );

    // Raise ONE decision for all affected gates
    const gateIds = gates.map((g) => g.gateId);
    this.raiseDecision({}, s, {
      project,
      subject: `env-wait:${wait.id}`,
      kind: "escalation",
      question: `The environment has been down for ${this.o.settings.environment.maxWaitMinutes} minutes (${wait.pattern_id}). ${gates.length} gate(s) are waiting: ${gateIds.slice(0, 5).join(", ")}${gateIds.length > 5 ? ` (+${gateIds.length - 5} more)` : ""}.`,
      context: [
        `Pattern: ${wait.pattern_id}`,
        `Probe: ${wait.probe}`,
        `Last probe result: ${wait.last_probe_result ?? "none"}`,
        `Gates affected: ${gateIds.join(", ")}`,
      ],
      options: [
        { id: "fix-environment", label: "Fix the environment", consequences: "Re-checks will be triggered after the next successful probe" },
        { id: "rerun-anyway", label: "Re-check now anyway", consequences: "Re-check all gates immediately" },
        { id: "ignore", label: "Ignore", consequences: "The failures stay blocking" },
      ],
      recommended: "fix-environment",
      why: `The probe command (${wait.probe}) hasn't passed in ${this.o.settings.environment.maxWaitMinutes} minutes.`,
    });
  }

  /** One re-check of only the failed tests (else only the failed steps) at the same commit. */
  private recheckInfra(record: TriageRecord, infra: ClassifiedCause[], origin: TriageRecord | null, s: Section): string {
    const { store, settings, project } = this.o;
    const chainId = origin?.id ?? record.id;
    const done = store.rechecksFor({ recordId: chainId, purpose: "infra" });
    const max = settings.recheck.maxRetries;
    if (done.length >= max) return this.infraExhausted(record, infra, done.length, origin, s);

    const tests = uniqueTests(infra.flatMap((c) => c.cause.tests));
    let steps = unique(infra.flatMap((c) => (c.cause.step ? [c.cause.step] : [])));
    if (tests.length === 0 && steps.length === 0) steps = record.failedSteps;
    if (tests.length === 0 && steps.length === 0) {
      this.action({ recordId: chainId }, "recheck", "skipped", "no failed test or step to re-check, and a full re-run is never requested");
      return this.infraExhausted(record, infra, done.length, origin, s);
    }
    const recheck = store.createRecheck(
      {
        project,
        purpose: "infra",
        recordId: chainId,
        sha: record.sha,
        branch: record.branch,
        gateId: record.gateId,
        steps,
        tests: tests.map((t) => t.id),
        classes: unique(tests.map(testClass)),
        attempt: done.length + 1,
        status: "waiting_capacity",
        reason: "queued",
        createdAt: this.iso(),
      },
      this.now(),
    );
    this.action(
      { recordId: chainId },
      "recheck",
      "waiting",
      `re-check ${recheck.attempt}/${max} of ${selection(recheck)} at ${short(record.sha)} queued (infra: ${infra.map((c) => c.verdict.rule).join(", ")})`,
    );
    return `infra: re-check ${recheck.attempt}/${max} queued`;
  }

  /** No re-checks left: route to the author when the base's own run passes, else ask the human. */
  private infraExhausted(
    record: TriageRecord,
    infra: ClassifiedCause[],
    attempts: number,
    origin: TriageRecord | null,
    s: Section,
  ): string {
    const { store, settings, project } = this.o;
    const chainId = origin?.id ?? record.id;
    const since = this.now() - settings.baseMaxAgeHours * 3_600_000;
    const base =
      !record.defaultBranch && record.baseSha ? store.baseResult(project, record.baseSha, record.pipelineId, since, record.id) : null;
    if (base && base.status === "passed") {
      this.routeToAuthor(
        record,
        infra,
        s,
        `still failing after ${attempts} re-check(s) at the same commit while ${short(base.sha)} passes`,
      );
      return `infra: still failing after ${attempts} re-check(s); routed to the author`;
    }
    const first = origin ?? record;
    this.raiseDecision({ recordId: chainId }, s, {
      project,
      subject: `infra:${chainId}`,
      kind: "escalation",
      question: `Gate ${first.gateId} at ${short(first.sha)} on ${first.branch} still fails with an infrastructure error after ${attempts} re-check(s).`,
      context: infra.flatMap((c) => [describe(c), ...c.verdict.evidence.slice(0, 2)]).slice(0, 8),
      options: [
        { id: "fix-environment", label: "Fix the environment", consequences: "Nothing runs; re-run the gate once it is fixed", effect: "reversible" },
        { id: "rerun", label: "Re-check now", consequences: "One more re-check of the same tests at the same commit", effect: "reversible" },
        { id: "ignore", label: "Ignore", consequences: "The failure stays blocking", effect: "reversible" },
      ],
      recommended: "fix-environment",
      structure: {
        class: "triage.gate_failure",
        evidence: {
          code: "infra_other",
          facts: { gate: first.gateId, sha: first.sha, recheck_count: attempts, same_commit: true },
          cause_cleared: false,
          linked_issue: null,
        },
      },
      why: "Lair re-checks an infrastructure failure only up to triage.recheck.max_retries.",
    });
    return `infra: still failing after ${attempts} re-check(s); asked the human`;
  }

  private agentText(record: TriageRecord, causes: ClassifiedCause[], why?: string): string {
    const lines = [
      `Gate ${record.gateId} failed at ${short(record.sha)} on ${record.branch}${why ? ` (${why})` : ""}. ${causes.length} cause(s) to fix:`,
    ];
    for (const c of causes.slice(0, 10)) {
      const cause = c.cause;
      lines.push(
        `* ${cause.kind === "context" ? "context failure" : cause.kind}${cause.step ? ` in step ${cause.step}` : ""}: ${clip(
          cause.type ? `${cause.type}: ${cause.message}` : cause.message,
          200,
        )}`,
      );
      if (cause.tests.length > 0) {
        const shown = cause.tests.slice(0, 20).map((t) => t.id);
        lines.push(`  failing tests (${cause.testCount}): ${shown.join(", ")}${cause.testCount > shown.length ? ", ..." : ""}`);
      }
      if (cause.causedBy.length > 0) lines.push(`  root cause: ${cause.rootCause}`);
      for (const line of cause.evidence.slice(0, 6)) lines.push(`  | ${line}`);
      if (cause.locations.length > 0) {
        lines.push(`  at: ${cause.locations.slice(0, 3).map((l) => `${l.file}${l.line ? `:${l.line}` : ""}`).join(", ")}`);
      }
      for (const line of c.verdict.evidence.slice(0, 2)) lines.push(`  why: ${line}`);
    }
    return lines.join("\n");
  }

  private routeToAuthor(record: TriageRecord, causes: ClassifiedCause[], s: Section, why?: string): void {
    const text = this.agentText(record, causes, why);
    const agent = record.agent;
    s.events.push({ type: "triage.routed", data: { recordId: record.id, agent: agent ?? null, sha: record.sha, text } });
    if (!agent) {
      this.action(
        { recordId: record.id },
        "route",
        "skipped",
        "no author agent: only a trusted result (the gates module's gate.completed event) names one",
      );
      return;
    }
    const msg: AgentMessage = {
      project: this.project,
      agent,
      recordId: record.id,
      gateId: record.gateId,
      sha: record.sha,
      branch: record.branch,
      pr: record.pr,
      text,
    };
    this.perform(
      s,
      { kind: "route", target: { recordId: record.id }, what: `${causes.length} cause(s) sent to ${agent}`, message: msg },
      plannedArgv(this.settings, "notify_agent", messageVars(msg)),
    );
  }

  private preExisting(record: TriageRecord, c: ClassifiedCause, s: Section): void {
    const { store, settings, project } = this.o;
    const incident = c.verdict.rule === "open-incident" ? store.openIncident(project, settings.defaultBranch, record.pipelineId) : null;
    if (incident) {
      this.action(
        { recordId: record.id },
        "note",
        "recorded",
        `${describe(c)}: part of the default branch's open incident ${short(incident.id)}, not this change`,
      );
    }
    // The default branch's own failure is its incident's to fix
    if (record.defaultBranch) return;
    if (settings.actions.preExisting !== "fix_task") {
      this.action({ recordId: record.id }, "fix_task", "skipped", `${describe(c)}: no fix task (triage.actions.pre_existing: none)`);
      return;
    }
    const title = `Fix on ${settings.defaultBranch}: ${describe(c)}`;
    const body = [
      `${settings.defaultBranch} fails on its own: this failure is not caused by the change that hit it.`,
      `First seen by gate ${record.gateId} at ${short(record.sha)} on ${record.branch}.`,
      ...(incident ? [`The default branch's incident ${incident.id} is bisecting it.`] : []),
      ...c.verdict.evidence,
      ...(c.cause.tests.length > 0 ? [`Tests: ${c.cause.tests.slice(0, 20).map((t) => t.id).join(", ")}`] : []),
      ...c.cause.evidence.slice(0, 6),
    ].join("\n");
    const { task, created } = store.openTask({
      project,
      kind: "fix",
      key: `pre-existing:${c.cause.signature}`,
      title,
      body,
      createdAt: this.iso(),
    });
    if (!created) {
      this.action({ recordId: record.id }, "fix_task", "skipped", `fix task ${short(task.id)} is already open for ${describe(c)}`);
      return;
    }
    this.createTask(record, task, "fix_task", s);
  }

  private createTask(record: TriageRecord, task: TriageTask, kind: ActionKind, s: Section): void {
    s.events.push({ type: "triage.task_created", data: { recordId: record.id, task } });
    this.perform(
      s,
      { kind: "task", target: { recordId: record.id }, what: `task ${short(task.id)} "${clip(task.title, 120)}"`, action: kind, task },
      plannedArgv(this.settings, "create_task", taskVars(task)),
    );
  }

  /** Record a flaky occurrence; flaky `ticket_after` times in a row opens a reliability task and quarantines the test. */
  private flakyOccurrence(key: string, record: TriageRecord, why: string, s: Section): void {
    const { store, settings, project } = this.o;
    const flaky = store.bumpFlaky(project, key, this.iso());
    this.action({ recordId: record.id }, "flaky", "recorded", `${key} is flaky (${flaky.occurrences} time(s)): ${clip(why, 200)}`);
    const n = settings.flaky.ticketAfter;
    const recent = store.recentFailureClasses(project, key, n);
    if (recent.length < n || !recent.every((c) => c === "flaky")) return;

    const deadline = this.iso(this.now() + settings.flaky.ticketDeadlineDays * 86_400_000);
    const { task, created } = store.openTask({
      project,
      kind: "reliability",
      key: `flaky:${key}`,
      title: `Flaky test: ${key}`,
      body: [
        `${key} was flaky ${n} time(s) in a row (${flaky.occurrences} in all): it failed and then passed at the same commit.`,
        `Make it reliable by ${deadline}.`,
        settings.flaky.quarantine
          ? `It is quarantined until then, or until it passes ${settings.flaky.releaseAfterPasses} times in a row: it still runs, it no longer blocks a change (it still counts on the default branch).`
          : "",
        `Latest: ${why}`,
      ]
        .filter(Boolean)
        .join("\n"),
      createdAt: this.iso(),
    });
    if (!created) return;
    store.setTicket(project, key, task.id);
    this.createTask(record, task, "ticket", s);
    if (!settings.flaky.quarantine) return;
    if (store.quarantinedKeys(project).size >= settings.flaky.quarantineCap) {
      this.action(
        { recordId: record.id },
        "quarantine",
        "skipped",
        `${key} not quarantined: the cap of ${settings.flaky.quarantineCap} quarantined tests is reached`,
      );
      return;
    }
    store.quarantine(project, key, this.iso(), deadline);
    this.action(
      { recordId: record.id },
      "quarantine",
      "done",
      `${key} quarantined until ${deadline} (or ${settings.flaky.releaseAfterPasses} passes in a row): it runs, but its failures no longer block a change`,
    );
  }

  /** A quarantined test that passed enough times in a row is released; a failure starts its count over. */
  private quarantineObservations(passed: string[], failing: string[]): void {
    const { store, settings, project } = this.o;
    const quarantined = store.quarantinedKeys(project);
    if (quarantined.size === 0) return;
    for (const key of passed) {
      if (!quarantined.has(key)) continue;
      const passes = store.quarantinedPass(project, key);
      if (passes !== null && passes >= settings.flaky.releaseAfterPasses && store.liftQuarantine(project, key)) {
        this.action({}, "quarantine", "done", `${key} released: it passed ${passes} times in a row`);
      }
    }
    for (const key of failing) if (quarantined.has(key)) store.quarantinedFail(project, key);
  }

  /** Earlier failures at this commit whose tests have all passed now are flaky, not code. */
  private reclassifyFlaky(sha: string, passedKeys: Set<string>, recordId: string, nowMs: number, s: Section): void {
    const { store, settings, project } = this.o;
    if (passedKeys.size === 0) return;
    const earlier = store
      .failsAt(project, sha, [...passedKeys], nowMs - settings.flaky.windowMinutes * 60000, recordId)
      .filter((f) => f.cls === "code" || f.cls === "pre-existing");
    for (const rid of unique(earlier.map((f) => f.recordId))) {
      const rec = store.getRecord(rid);
      if (!rec) continue;
      let changed = false;
      for (const c of rec.causes) {
        if (c.verdict.class !== "code" && c.verdict.class !== "pre-existing") continue;
        if (c.cause.tests.length === 0 || !c.cause.tests.every((t) => passedKeys.has(t.key))) continue;
        const verdict: Verdict = {
          class: "flaky",
          rule: "passed-at-same-sha",
          confidence: "high",
          evidence: [
            `failed in result ${short(rid)}, then passed at the same commit ${short(sha)} in result ${short(recordId)}`,
            ...c.verdict.evidence.slice(0, 2).map((e) => `was ${c.verdict.class}: ${e}`),
          ],
        };
        store.updateCauseVerdict(c.id, verdict);
        store.setTestClass(rid, c.cause.tests.map((t) => t.key), "flaky");
        changed = true;
        for (const t of c.cause.tests) this.flakyOccurrence(t.key, rec, verdict.evidence[0], s);
      }
      if (!changed) continue;
      const updated = store.getRecord(rid)!;
      const blocking =
        updated.causes.some((c) => c.verdict.class === "code") ||
        (updated.blocking && updated.causes.some((c) => c.verdict.class === "infra"));
      store.updateRecord(rid, {
        verdict: overallClass(updated.causes) ?? null,
        blocking,
        resolution: blocking ? updated.resolution ?? null : `flaky: passed at the same commit in result ${short(recordId)}`,
      });
      if (!blocking && rec.blocking) {
        this.action({ recordId: rid }, "unblock", "done", `no longer blocking: its failing tests passed at ${short(sha)}`);
      }
    }
  }

  // ============ RE-CHECKS ============

  /**
   * A result for a re-check. It counts as passed only when it shows the
   * requested tests passing (a report lists every one of them as passed), or,
   * for a re-check of steps, every requested step passed. A "passed" without
   * that is unproven and unblocks nothing.
   */
  private answerRecheck(
    recheck: Recheck,
    recordId: string,
    result: GateResult,
    evidence: GateEvidence,
    classified: ClassifiedCause[],
    origin: TriageRecord | null,
    s: Section,
  ): void {
    const { store } = this.o;
    const requested = this.requestedKeys(recheck, origin);
    const listed = new Set(evidence.passed.map((t) => t.key));
    const stepsPassed = new Set(result.steps.filter((st) => st.status === "passed").map((st) => st.name));
    const shown =
      requested.length > 0
        ? requested.every((k) => listed.has(k))
        : recheck.steps.length > 0 && recheck.steps.every((st) => stepsPassed.has(st));
    const status: RecheckStatus = result.status !== "passed" ? "failed" : shown ? "passed" : "unproven";
    const missing = requested.filter((k) => !listed.has(k));
    const why =
      requested.length > 0
        ? `${missing.length} of the ${requested.length} requested test(s) are not listed as passed (send the test report with the result)`
        : `the requested step(s) ${recheck.steps.join(", ")} did not all pass`;
    store.updateRecheck(recheck.id, { status, completedAt: this.iso(), answerId: recordId });
    if (result.status === "passed") {
      store.updateRecord(recordId, { blocking: false, resolution: shown ? "re-check passed" : `re-check unproven: ${why}` });
    }

    if (recheck.purpose === "infra" && origin) {
      if (status === "passed") {
        const stillBlocking = origin.causes.some((c) => c.verdict.class === "code");
        store.updateRecord(origin.id, {
          blocking: stillBlocking,
          resolution: stillBlocking
            ? `re-check ${recheck.attempt} passed; code failures remain`
            : `re-check ${recheck.attempt} passed at the same commit: it was infrastructure`,
        });
        this.action(
          { recordId: origin.id },
          "unblock",
          "done",
          `re-check ${recheck.attempt} of ${selection(recheck)} passed at ${short(recheck.sha)} (result ${short(recordId)})`,
        );
      } else if (status === "unproven") {
        this.action(
          { recordId: origin.id },
          "recheck",
          "failed",
          `re-check ${recheck.attempt} answered "passed" but ${why}: not unblocked`,
        );
        const infra = origin.causes.filter((c) => c.verdict.class === "infra");
        store.updateRecord(origin.id, { resolution: this.recheckInfra(origin, infra, null, s) });
      } else {
        this.action({ recordId: origin.id }, "note", "recorded", `re-check ${recheck.attempt} failed again (result ${short(recordId)})`);
      }
      return;
    }
    if (recheck.purpose === "bisect") this.bisectAnswer(recheck, recordId, status, classified, why);
  }

  /** Expire stale re-checks, release ended quarantines, advance bisects, and ask for a dispatch. */
  private pumpSync(s: Section): void {
    const { store, settings, project } = this.o;
    const nowMs = this.now();
    const timeoutMs = settings.recheck.timeoutMinutes * 60000;
    for (const r of store.rechecksWithStatus(project, ["dispatching", "requested", "unavailable"])) {
      const since = store.requestedMs(r.id);
      const limit = r.status === "dispatching" ? DISPATCH_STALE_MS : timeoutMs;
      if (since === null || nowMs - since < limit) continue;
      const reason =
        r.status === "dispatching" ? "its request never finished" : `no result within ${settings.recheck.timeoutMinutes} min`;
      store.updateRecheck(r.id, { status: "expired", reason, completedAt: this.iso(nowMs) });
      this.recheckLost(r, reason, s);
    }

    for (const key of store.expiredQuarantines(project, this.iso(nowMs))) {
      if (store.liftQuarantine(project, key)) {
        this.action({}, "quarantine", "done", `${key} released: its reliability task's deadline passed`);
      }
    }

    for (const incident of store.openIncidents(project)) {
      if (incident.branch === settings.defaultBranch) this.advanceBisect(incident, s);
    }

    // The gate system's re-checks: interrupted commands, expiry, the ones whose cool-down is over
    this.gateRechecks.pump(s);

    // Process environment waits: run probes, resolve or expire waits
    this.processEnvironmentWaits(s);

    const waiting = store.rechecksWithStatus(project, ["waiting_capacity"]);
    if (waiting.length === 0) return;
    const blocked = this.actBlocked;
    if (!blocked) {
      s.dispatch = true;
      return;
    }
    for (const r of waiting) {
      store.updateRecheck(r.id, { status: "planned", reason: `not run: ${blocked}` });
      this.action(
        r.recordId ? { recordId: r.recordId } : { incidentId: r.incidentId },
        "recheck",
        "planned",
        `re-check of ${selection(r)} at ${short(r.sha)} (not run: ${blocked})`,
        plannedArgv(settings, "recheck", recheckVars(project, r)) ?? undefined,
      );
    }
  }

  /**
   * Ask the executor for the oldest waiting re-check, when there is room and
   * capacity. Runs from the outbox: the capacity check and the request are
   * outside the serial queue, so the run's answer can come straight back.
   */
  private async dispatch(): Promise<void> {
    this.dispatchQueued = false;
    const { store, settings, project } = this.o;
    const inFlight = () => store.rechecksWithStatus(project, ["dispatching", "requested"]).length;
    const pick = await this.serial(async () => {
      const [next] = store.rechecksWithStatus(project, ["waiting_capacity"]);
      if (!next) return null;
      const running = inFlight();
      if (running >= settings.recheck.maxConcurrent) {
        store.updateRecheck(next.id, {
          reason: `waiting: ${running} re-check(s) running (max_concurrent ${settings.recheck.maxConcurrent})`,
        });
        return null;
      }
      return next;
    });
    if (!pick) return;

    let capacity: { ok: boolean; reason: string };
    try {
      capacity = await this.capacity.check();
    } catch (e) {
      capacity = { ok: false, reason: `capacity check failed: ${message(e)}` };
    }
    const go = await this.serial(async () =>
      this.commit((s) => {
        const r = store.getRecheck(pick.id);
        if (!r || r.status !== "waiting_capacity" || this.actBlocked) return null;
        if (!capacity.ok) {
          store.updateRecheck(r.id, { reason: `waiting for capacity: ${capacity.reason}` });
          return null;
        }
        if (inFlight() >= settings.recheck.maxConcurrent) return null;
        const at = this.now();
        store.updateRecheck(r.id, { status: "dispatching", reason: capacity.reason, requestedAt: this.iso(at), requestedMs: at });
        const dispatching = store.getRecheck(r.id)!;
        s.events.push({ type: "triage.recheck_requested", data: { recheck: dispatching } });
        return dispatching;
      }),
    );
    if (!go) return;

    const executor = this.o.adapters.recheck;
    const result = executor
      ? await withTimeout(settle(() => executor.request(go)), settings.recheck.requestTimeoutSeconds * 1000 + 1000)
      : null;
    await this.serial(async () =>
      this.commit((s) => {
        this.dispatched(go, result);
        this.pumpSync(s);
      }),
    );
  }

  /** Record what the executor said. The answer may already have arrived while it ran. */
  private dispatched(r: Recheck, result: AdapterResult | null): void {
    const { store } = this.o;
    const current = store.getRecheck(r.id);
    if (!current) return;
    const target: Target = r.recordId ? { recordId: r.recordId } : { incidentId: r.incidentId };
    const stillAsking = current.status === "dispatching";
    if (!result) {
      if (stillAsking) {
        store.updateRecheck(r.id, { status: "unavailable", reason: "no re-check executor (triage.commands.recheck)" });
      }
      this.action(target, "recheck", "recorded", `re-check ${short(r.id)} of ${selection(r)} at ${short(r.sha)}: no executor is set`);
      return;
    }
    if (result.ok) {
      store.updateRecheck(r.id, { ...(stillAsking ? { status: "requested" as const } : {}), ...(result.ref ? { runId: result.ref } : {}) });
    } else if (stillAsking) {
      store.updateRecheck(r.id, { status: "unavailable", reason: result.detail });
    }
    this.action(
      target,
      "recheck",
      result.ok ? "done" : "failed",
      `re-check ${r.attempt} (${short(r.id)}) of ${selection(r)} at ${short(r.sha)}: ${result.detail}${result.ref ? ` (run ${clip(result.ref, 80)})` : ""}`,
      result.argv,
      result.output,
    );
  }

  /** A re-check that never answered. */
  private recheckLost(r: Recheck, reason: string, s: Section): void {
    const { store } = this.o;
    if (r.purpose === "bisect" && r.incidentId) {
      const incident = store.getIncident(r.incidentId);
      const probe = incident?.bisect.probes.find((p) => p.recheckId === r.id);
      if (incident && probe && incident.status === "open") {
        store.updateIncident(incident.id, { bisect: applyProbe(incident.bisect, probe, "skip", reason) });
        this.action({ incidentId: incident.id }, "bisect", "failed", `probe ${short(r.sha)}: ${reason}`);
      }
      return;
    }
    const origin = r.recordId ? store.getRecord(r.recordId) : null;
    if (!origin) return;
    this.action({ recordId: origin.id }, "recheck", "failed", `re-check ${r.attempt} (${short(r.id)}): ${reason}`);
    const infra = origin.causes.filter((c) => c.verdict.class === "infra");
    store.updateRecord(origin.id, { resolution: this.recheckInfra(origin, infra, null, s) });
  }

  // ============ DEFAULT BRANCH: INCIDENT AND BISECT ============

  private defaultBranchResult(
    record: TriageRecord,
    classified: ClassifiedCause[],
    passedSteps: string[],
    plan: IncidentPlan | null,
    greenAfterRed: boolean,
    s: Section,
  ): void {
    const { store, project } = this.o;
    const open = store.openIncident(project, record.branch, record.pipelineId);
    if (record.status === "passed") {
      // Only a full gate run of the same pipeline that ran the failing steps,
      // at a commit that contains the red one, proves the branch green
      if (!open || record.purpose !== "gate") return;
      if (!greenAfterRed) {
        this.action(
          { incidentId: open.id },
          "note",
          "recorded",
          `a green run at ${short(record.sha)} does not contain the red commit ${short(open.redSha)}: the incident stays open`,
        );
        return;
      }
      const missing = open.target.steps.filter((st) => !passedSteps.includes(st));
      if (missing.length > 0) {
        this.action(
          { incidentId: open.id },
          "note",
          "recorded",
          `a green run at ${short(record.sha)} did not run ${missing.join(", ")}: the incident stays open`,
        );
        return;
      }
      for (const r of store.rechecksFor({ incidentId: open.id })) {
        if (OPEN_RECHECK.includes(r.status)) store.updateRecheck(r.id, { status: "cancelled", reason: "the branch is green again" });
      }
      const bisect: BisectState = open.bisect.status === "running" ? { ...open.bisect, status: "cancelled" } : open.bisect;
      store.updateIncident(open.id, {
        status: "resolved",
        resolvedAt: this.iso(),
        resolution: `green again at ${short(record.sha)} (result ${short(record.id)})`,
        bisect,
      });
      this.action({ incidentId: open.id }, "incident", "done", `resolved: ${record.branch} is green at ${short(record.sha)}`);
      s.events.push({ type: "triage.incident_resolved", data: { incidentId: open.id, sha: record.sha } });
      return;
    }
    const regressions = classified.filter((c) => c.verdict.class === "code");
    if (regressions.length === 0) return;
    if (open) {
      this.action(
        { incidentId: open.id },
        "note",
        "recorded",
        `also failing at ${short(record.sha)}: ${regressions.map(describe).slice(0, 3).join("; ")}`,
      );
      return;
    }
    if (plan) this.openIncident(record, regressions, plan, s);
  }

  private openIncident(record: TriageRecord, regressions: ClassifiedCause[], plan: IncidentPlan, s: Section): void {
    const { store, project } = this.o;
    const incident = store.createIncident({
      project,
      branch: record.branch,
      pipelineId: record.pipelineId,
      status: "open",
      openedAt: this.iso(),
      redSha: record.sha,
      lastGreenSha: plan.lastGreenSha,
      recordId: record.id,
      target: plan.target,
      bisect: plan.bisect,
      revert: { status: "none" },
    });
    this.action(
      { incidentId: incident.id },
      "incident",
      "done",
      `${record.branch} is red at ${short(record.sha)}: ${regressions.map(describe).slice(0, 3).join("; ")}. ${plan.bisect.detail}`,
    );
    this.action({ recordId: record.id }, "incident", "done", `opened incident ${short(incident.id)} (${plan.bisect.status})`);
    s.events.push({
      type: "triage.incident_opened",
      data: {
        incidentId: incident.id,
        sha: record.sha,
        pipelineId: record.pipelineId,
        lastGreenSha: plan.lastGreenSha ?? null,
        candidates: plan.bisect.candidates.length,
      },
    });
  }

  private advanceBisect(incident: Incident, s: Section): void {
    const { store, project } = this.o;
    if (incident.bisect.status !== "running") return;
    if (incident.bisect.probes.some((p) => p.outcome === "pending")) return;
    const step = nextStep(incident.bisect);
    if (step.type === "probe") {
      const tries = incident.bisect.probes.filter((p) => p.sha === step.sha && p.recheckId !== undefined).length;
      const recheck = store.createRecheck(
        {
          project,
          purpose: "bisect",
          incidentId: incident.id,
          sha: step.sha,
          branch: incident.branch,
          gateId: `bisect-${short(incident.id)}`,
          steps: incident.target.steps,
          tests: incident.target.tests,
          classes: incident.target.classes,
          attempt: tries + 1,
          status: "waiting_capacity",
          reason: "queued",
          createdAt: this.iso(),
        },
        this.now(),
      );
      const bisect: BisectState = {
        ...incident.bisect,
        probes: [...incident.bisect.probes, { sha: step.sha, recheckId: recheck.id, confirm: step.confirm, outcome: "pending" }],
        detail: `${step.confirm ? "confirming" : "probing"} ${short(step.sha)}`,
      };
      store.updateIncident(incident.id, { bisect });
      this.action(
        { incidentId: incident.id },
        "bisect",
        "waiting",
        `${step.confirm ? "confirm the culprit" : "probe"} ${short(step.sha)}: ${selection(recheck)}`,
      );
      return;
    }
    if (step.type === "found") {
      const bisect: BisectState = { ...incident.bisect, status: "found", culprit: step.culprit, proven: true, detail: step.detail };
      store.updateIncident(incident.id, { bisect });
      this.action({ incidentId: incident.id }, "bisect", "done", `culprit ${short(step.culprit)}: ${step.detail}`);
      const culprit = step.culprit;
      // The culprit's commit (parents, message) is read outside the queue, then decided on
      this.enqueue(s, { kind: "culprit", incidentId: incident.id, sha: culprit });
      return;
    }
    const bisect: BisectState = {
      ...incident.bisect,
      status: "inconclusive",
      culprit: step.suspects.length === 1 ? step.suspects[0] : undefined,
      suspects: step.suspects,
      proven: false,
      detail: step.detail,
    };
    store.updateIncident(incident.id, { bisect });
    this.action(
      { incidentId: incident.id },
      "bisect",
      "done",
      `not proven: ${step.detail}; suspects ${step.suspects.map(short).join(", ") || "none"}`,
    );
    this.onSuspects(store.getIncident(incident.id)!, s);
  }

  private bisectAnswer(recheck: Recheck, recordId: string, status: RecheckStatus, classified: ClassifiedCause[], why: string): void {
    const { store, settings } = this.o;
    const incident = recheck.incidentId ? store.getIncident(recheck.incidentId) : null;
    if (!incident || incident.status !== "open") return;
    const probe = incident.bisect.probes.find((p) => p.recheckId === recheck.id);
    if (!probe || probe.outcome !== "pending") return;
    const target = incident.target;
    let outcome: ProbeOutcome;
    let detail: string;
    const retried = incident.bisect.probes.filter((p) => p.sha === probe.sha && p.retried).length;
    const retry = (reason: string): boolean => {
      if (retried >= settings.recheck.maxRetries) return false;
      store.updateIncident(incident.id, { bisect: retryProbe(incident.bisect, probe, `${reason}; probing again`) });
      this.action({ incidentId: incident.id }, "bisect", "recorded", `probe ${short(probe.sha)}: ${reason}, probing again`);
      return true;
    };
    if (status === "passed") {
      outcome = "pass";
      detail = `passed (result ${short(recordId)})`;
    } else if (status === "unproven") {
      if (retry(`answered "passed" but ${why}`)) return;
      outcome = "skip";
      detail = `unproven: ${why}`;
    } else {
      const hit = classified.find(
        (c) =>
          c.verdict.class !== "infra" &&
          (c.cause.tests.some((t) => target.keys.includes(t.key)) || target.signatures.includes(c.cause.signature)),
      );
      if (hit) {
        outcome = "fail";
        detail = `the same cause: ${clip(hit.cause.rootCause, 140)} (result ${short(recordId)})`;
      } else if (classified.length > 0 && classified.every((c) => c.verdict.class === "infra")) {
        if (retry(`infrastructure (${classified[0].verdict.rule})`)) return;
        outcome = "skip";
        detail = `infrastructure after ${retried + 1} attempt(s)`;
      } else {
        outcome = "skip";
        detail = `a different failure: ${clip(classified[0]?.cause.rootCause ?? "no cause", 140)}`;
      }
    }
    store.updateIncident(incident.id, { bisect: applyProbe(incident.bisect, probe, outcome, detail) });
    this.action(
      { incidentId: incident.id },
      "bisect",
      "done",
      `${probe.confirm ? "confirmation" : "probe"} ${short(probe.sha)}: ${outcome} (${detail})`,
    );
  }

  /**
   * What protects a merge from an automatic revert. A human's mark (in Lair)
   * and the project's config protect it; the message trailer is only a hint
   * (whoever merged it wrote it), which turns an automatic revert into a
   * proposal.
   */
  private protection(sha: string, info: CommitInfo | null): { kind: "human" | "config" | "hint"; text: string } | null {
    const { store, settings, project } = this.o;
    const shas = new Set([sha, ...(info?.parents.slice(1) ?? [])].map((x) => x.toLowerCase()));
    if (store.listProtected(project).some((p) => shas.has(p.sha))) {
      return { kind: "human", text: "a human marked it protected in Lair" };
    }
    if (settings.bisect.protectedMerges.some((p) => shas.has(p))) {
      return { kind: "config", text: "it is listed in triage.bisect.protected_merges" };
    }
    const trailer = new RegExp(`^${settings.bisect.protectedTrailer}:\\s*(yes|true|1)\\s*$`, "im");
    if (info && trailer.test(info.body.slice(0, 20_000))) {
      return {
        kind: "hint",
        text: `its merge message carries "${settings.bisect.protectedTrailer}: yes" (written by whoever merged it, not a human's mark)`,
      };
    }
    return null;
  }

  /** The gate result (with its agent and PR) of the change a merge brought in; only trusted results name one. */
  private authorOf(sha: string, info: CommitInfo | null): TriageRecord | null {
    const { store, project } = this.o;
    const shas = [sha, ...(info?.parents.slice(1) ?? [])];
    const direct = store.recordsAt(project, shas).find((r) => r.agent);
    if (direct) return direct;
    const pr = info ? Number((info.subject.match(/(?:\(#|pull request #)(\d+)/) ?? [])[1]) : NaN;
    if (!Number.isFinite(pr)) return null;
    return store.listRecords(project, { limit: 500 }).find((r) => r.pr === pr && r.agent) ?? null;
  }

  private decideCulprit(incidentId: string, info: CommitInfo | null, s: Section): void {
    const { store, settings } = this.o;
    const incident = store.getIncident(incidentId);
    if (!incident || incident.status !== "open" || !incident.bisect.culprit) return;
    const culprit = incident.bisect.culprit;
    const protection = this.protection(culprit, info);
    const author = this.authorOf(culprit, info);
    const red = store.getRecord(incident.recordId);
    const causes = red?.causes.filter((c) => incident.target.signatures.includes(c.cause.signature)) ?? [];
    const reason = `${incident.branch} is red since ${short(culprit)}${info?.subject ? ` (${clip(info.subject, 100)})` : ""}: ${
      causes.map(describe).slice(0, 2).join("; ") || "see the incident"
    }. Green before, red after, the same cause twice.`;
    s.events.push({
      type: "triage.culprit_found",
      data: { incidentId, sha: culprit, proven: true, protected: protection?.kind ?? null },
    });

    if (author?.agent && red) {
      this.routeToAuthor({ ...red, agent: author.agent, pr: author.pr }, causes, s, `your change ${short(culprit)} broke ${incident.branch}`);
    }

    const humanProtected = protection !== null && protection.kind !== "hint";
    const revert: Incident["revert"] = { ...incident.revert, protected: humanProtected };
    const policy = settings.bisect.revert;
    if (policy === "off") {
      store.updateIncident(incidentId, { revert: { ...revert, status: "off", detail: "triage.bisect.revert is off" } });
      return;
    }
    if (policy === "auto" && !protection) {
      store.updateIncident(incidentId, { revert });
      if (this.openRevert(store.getIncident(incidentId)!, culprit, reason, author?.pr, undefined, s)) return;
      revert.detail = this.actBlocked ? `not opened: ${this.actBlocked}` : "triage.commands.open_revert is not set";
    }
    store.updateIncident(incidentId, {
      revert: {
        ...revert,
        status: humanProtected ? "protected" : "proposed",
        detail: protection
          ? `never reverted automatically: ${protection.text}`
          : (revert.detail ?? "a decision proposes the revert"),
      },
    });
    this.proposeRevert(
      store.getIncident(incidentId)!,
      culprit,
      reason,
      protection ? { text: protection.text, keep: humanProtected } : undefined,
      s,
    );
  }

  private proposeRevert(
    incident: Incident,
    culprit: string,
    reason: string,
    protection: { text: string; keep: boolean } | undefined,
    s: Section,
  ): void {
    const protectedBy = protection?.text;
    this.raiseDecision({ incidentId: incident.id }, s, {
      project: this.project,
      subject: `revert:${incident.id}`,
      kind: "other",
      question: `Revert ${short(culprit)} to make ${incident.branch} green again?`,
      context: [
        reason,
        ...(protectedBy ? [`Not reverted automatically: ${protectedBy}.`] : []),
        `Incident ${incident.id}; last green ${incident.lastGreenSha ? short(incident.lastGreenSha) : "unknown"}.`,
        ...incident.bisect.probes.filter((p) => p.recheckId).map((p) => `probe ${short(p.sha)}: ${p.outcome}${p.detail ? ` (${p.detail})` : ""}`),
      ],
      options: [
        { id: "revert", label: `Revert ${short(culprit)}`, consequences: "Lair opens a revert, which goes through the gate and the merge policy", effect: "outward" },
        { id: "keep", label: "Keep it and fix forward", consequences: "Nothing is reverted; the branch stays red until a fix merges", effect: "reversible" },
      ],
      recommended: protection?.keep ? "keep" : "revert",
      structure: {
        class: "triage.revert",
        evidence: {
          code: "bisect_proved",
          facts: { incident: incident.id, culprit, branch: incident.branch, human_protected: protectedBy !== undefined },
          cause_cleared: false,
          linked_issue: null,
        },
      },
      why: protection?.keep
        ? "A merge a human protected is never reverted automatically."
        : protectedBy
          ? "Bisect proved this merge broke the branch; its message asks not to revert it automatically."
          : "Bisect proved this merge broke the branch; triage.bisect.revert is propose.",
    });
  }

  private onSuspects(incident: Incident, s: Section): void {
    const { store, settings } = this.o;
    const suspects = incident.bisect.suspects ?? [];
    if (settings.bisect.revert === "off") {
      store.updateIncident(incident.id, { revert: { ...incident.revert, status: "off", detail: "triage.bisect.revert is off" } });
      return;
    }
    store.updateIncident(incident.id, {
      revert: {
        ...incident.revert,
        status: suspects.length > 0 ? "proposed" : "none",
        detail: "not proven: reverted only on a human's explicit decision",
      },
    });
    this.raiseDecision({ incidentId: incident.id }, s, {
      project: this.project,
      subject: `revert:${incident.id}`,
      kind: "escalation",
      question: `${incident.branch} is red since ${short(incident.redSha)} and bisect could not prove which merge did it.`,
      context: [
        incident.bisect.detail,
        `Suspects: ${suspects.map(short).join(", ") || "none"}.`,
        ...incident.bisect.probes.filter((p) => p.recheckId).map((p) => `probe ${short(p.sha)}: ${p.outcome}${p.detail ? ` (${p.detail})` : ""}`),
      ],
      options: [
        ...suspects.slice(0, 5).map((sha, i) => ({
          id: `revert-${i + 1}`,
          label: `Revert ${short(sha)} (not proven)`,
          consequences: `Lair opens a revert of ${short(sha)} although bisect did not prove it broke the branch`,
          effect: "outward" as const,
        })),
        { id: "investigate", label: "Investigate", consequences: "Nothing is reverted", effect: "reversible" as const },
      ],
      recommended: "investigate",
      structure: {
        class: "triage.revert",
        evidence: {
          code: "bisect_unproven",
          facts: { incident: incident.id, branch: incident.branch, suspects: suspects.length },
          cause_cleared: false,
          linked_issue: null,
        },
      },
      why: "Only a merge proven to break the branch is reverted without a human; this one is not proven.",
    });
  }

  /** Queue the revert; false when it can't run (observe mode, read_only, no command). */
  private openRevert(incident: Incident, sha: string, reason: string, pr: number | undefined, actor: string | undefined, s: Section): boolean {
    const opener = this.o.adapters.revert;
    if (this.actBlocked || !opener) return false;
    const request: RevertRequest = { project: this.project, incidentId: incident.id, sha, branch: incident.branch, reason, pr };
    this.o.store.updateIncident(incident.id, {
      revert: { ...incident.revert, status: "opening", detail: `opening the revert of ${short(sha)}`, by: actor },
    });
    s.events.push({ type: "triage.revert_requested", data: { incidentId: incident.id, sha, by: actor ?? null } });
    this.perform(
      s,
      {
        kind: "revert",
        target: { incidentId: incident.id },
        what: `revert ${short(sha)} on ${incident.branch}${actor ? ` (asked by ${actor})` : ""}`,
        request,
        reason,
        actor,
      },
      plannedArgv(this.settings, "open_revert", revertVars(request)),
    );
    return true;
  }

  private revertDone(incidentId: string, sha: string, result: AdapterResult, reason: string, actor: string | undefined, s: Section): void {
    const { store } = this.o;
    const incident = store.getIncident(incidentId);
    if (!incident) return;
    store.updateIncident(incidentId, {
      revert: { ...incident.revert, status: result.ok ? "opened" : "failed", ref: result.ref, detail: result.detail, by: actor },
    });
    // An automatic revert that could not be opened becomes a proposal
    if (!result.ok && !actor) this.proposeRevert(store.getIncident(incidentId)!, sha, reason, undefined, s);
  }

  private raiseDecision(target: Target, s: Section, request: DecisionRequest): void {
    const { store } = this.o;
    if (!store.claimDecision(this.project, request.subject, this.iso())) {
      this.action(target, "decision", "skipped", `already asked: ${clip(request.question, 160)}`);
      return;
    }
    s.events.push({ type: "triage.decision_requested", data: { decision: request } });
    const call: AdapterCall = { kind: "decision", target, what: clip(request.question, 200), request };
    if (this.decisionsViaCommand) {
      this.perform(s, call, plannedArgv(this.settings, "raise_decision", decisionVars(request)));
      return;
    }
    if (!this.decisions) {
      this.action(target, "decision", "recorded", `${clip(request.question, 200)} (no Decision Inbox, decision_file or inbox_file)`);
      return;
    }
    // Asking the human is safe in observe mode too, as the watchdog's escalations are
    this.enqueue(s, call);
  }

  /** An answer from the Decision Inbox: revert (the culprit or a chosen suspect), or one more re-check. */
  async followDecision(resolution: DecisionResolution): Promise<void> {
    const subject = resolution.decision.source.ref;
    const by = resolution.by;
    await this.serial(async () =>
      this.commit((s) => {
        const { store } = this.o;
        store.releaseDecision(this.project, subject);
        if (subject.startsWith("revert:")) {
          const incident = store.getIncident(subject.slice("revert:".length));
          if (!incident || incident.status !== "open") return;
          const suspect = resolution.optionId.match(/^revert-(\d)$/);
          const sha =
            resolution.optionId === "revert"
              ? incident.bisect.culprit
              : suspect
                ? incident.bisect.suspects?.[Number(suspect[1]) - 1]
                : undefined;
          if (!sha) {
            this.action({ incidentId: incident.id }, "decision", "done", `answered "${resolution.optionId}": nothing is reverted`, undefined, undefined, by);
            return;
          }
          const reason = `the owner chose to revert it (decision ${resolution.decision.id})`;
          if (!this.openRevert(incident, sha, reason, undefined, by, s)) {
            this.action(
              { incidentId: incident.id },
              "revert",
              "failed",
              `the owner chose to revert ${short(sha)}, but ${this.actBlocked ?? "triage.commands.open_revert is not set"}`,
              undefined,
              undefined,
              by,
            );
          }
          return;
        }
        if (subject.startsWith("infra:")) {
          const origin = store.getRecord(subject.slice("infra:".length));
          if (!origin) return;
          const last = store.rechecksFor({ recordId: origin.id, purpose: "infra" }).pop();
          if (resolution.optionId !== "rerun" || !last) {
            this.action({ recordId: origin.id }, "decision", "done", `answered "${resolution.optionId}"`, undefined, undefined, by);
            return;
          }
          store.createRecheck(
            { ...last, attempt: last.attempt + 1, status: "waiting_capacity", reason: "asked by the owner", createdAt: this.iso() },
            this.now(),
          );
          this.action({ recordId: origin.id }, "recheck", "waiting", `one more re-check, asked by the owner`, undefined, undefined, by);
          this.pumpSync(s);
        }
        // An escalated re-check in the gate system (gate-recheck.ts)
        if (subject.startsWith("recheck:")) this.gateRechecks.followDecision(subject.slice("recheck:".length), resolution.optionId, by, s);
      }),
    );
    await this.drain();
  }

  // ============ HUMAN ACTIONS (the owner's credential is checked by the routes) ============

  /**
   * The owner asked for a revert. A culprit bisect did not prove needs
   * `acknowledgeUnproven`: an explicit decision to revert a suspect.
   */
  async requestRevert(
    incidentId: string,
    options: { sha?: string; acknowledgeUnproven?: boolean; actor?: string } = {},
  ): Promise<Incident> {
    const id = await this.serial(async () =>
      this.commit((s) => {
        const { store } = this.o;
        const incident = store.getIncident(incidentId);
        if (!incident || incident.project !== this.project) throw new TriageNotFoundError(`No incident ${incidentId}`);
        if (incident.status !== "open") throw new TriageConflictError("The incident is resolved");
        const candidates = [incident.bisect.culprit, ...(incident.bisect.suspects ?? [])].filter((x): x is string => !!x);
        const wanted = options.sha?.toLowerCase();
        const target = wanted ? candidates.find((c) => c.toLowerCase() === wanted) : incident.bisect.culprit;
        if (!target) {
          throw new TriageConflictError(
            wanted ? `${wanted} is not this incident's culprit or a suspect` : "The bisect has not found a culprit (yet)",
          );
        }
        const proven = incident.bisect.proven && incident.bisect.culprit === target;
        if (!proven && options.acknowledgeUnproven !== true) {
          throw new TriageConflictError(
            `${short(target)} is not proven to have broken ${incident.branch}: revert it only as an explicit decision ("acknowledgeUnproven": true)`,
          );
        }
        if (incident.revert.status === "opened" || incident.revert.status === "opening") {
          throw new TriageConflictError("A revert is already open");
        }
        const blocked = this.actBlocked;
        if (blocked) throw new TriageConflictError(`Commands don't run: ${blocked}`);
        if (!this.o.adapters.revert) throw new TriageConflictError("triage.commands.open_revert is not set");
        const reason = `requested by the owner for incident ${short(incident.id)}${proven ? "" : " (not proven; acknowledged)"}`;
        this.openRevert(incident, target, reason, undefined, options.actor, s);
        return incident.id;
      }),
    );
    await this.drain();
    return this.o.store.getIncident(id)!;
  }

  protect(sha: string, note: string, actor?: string): void {
    const value = sha.toLowerCase();
    if (!FULL_SHA.test(value)) throw new TriageInputError("Protect a merge by its full commit sha");
    this.o.store.transaction(() => {
      this.o.store.protect(this.project, value, note, actor, this.iso());
      this.action({}, "note", "done", `protected ${short(value)} from automatic reverts${note ? `: ${clip(note, 200)}` : ""}`, undefined, undefined, actor);
    });
  }

  unprotect(sha: string, actor?: string): boolean {
    const value = sha.toLowerCase();
    return this.o.store.transaction(() => {
      const removed = this.o.store.unprotect(this.project, value);
      if (removed) this.action({}, "note", "done", `no longer protected: ${short(value)}`, undefined, undefined, actor);
      return removed;
    });
  }

  liftQuarantine(key: string, actor?: string): boolean {
    return this.o.store.transaction(() => {
      const lifted = this.o.store.liftQuarantine(this.project, key);
      if (lifted) this.action({}, "quarantine", "done", `${key} released by the owner`, undefined, undefined, actor);
      return lifted;
    });
  }
}
