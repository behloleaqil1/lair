/**
 * The triage service: one TriageService per project with `triage.enabled`.
 *
 * ingest(result) for every gate result (a POST, or a `gate.completed` event):
 * 1. parse its reports and failed steps into causes;
 * 2. record which tests failed and passed at that commit;
 * 3. classify each cause (infra, flaky, pre-existing, code) with evidence;
 * 4. earlier failures at the same commit whose tests now passed become flaky;
 * 5. act per class: infra -> one re-check of only the failed tests at the
 *    same commit (capacity permitting, up to max_retries); pre-existing ->
 *    not blocking, one fix task on the default branch; flaky -> recorded,
 *    a reliability task after `ticket_after` in a row; code -> back to the
 *    author agent with the tests and a log excerpt;
 * 6. on the default branch: red opens an incident and bisects the merges
 *    since the last green commit; green resolves it.
 *
 * Calls for one project run one at a time, so the bisect state and the
 * re-check queue never race.
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
  TestRef,
  TriageAction,
  TriageRecord,
  TriageTask,
  Verdict,
} from "../../shared/triage-types.js";
import { actBlockedReason, type TriageSettings } from "./config.js";
import { parseGateEvidence, type EvidenceParser, type ReportInput } from "./parsers/index.js";
import { classifyCause, overallClass, type BaseFacts, type ClassifyContext } from "./classifier.js";
import type { NewRecord, TestRow, TriageStore } from "./store.js";
import type { CommitInfo, GitProbe } from "./git.js";
import {
  InboxDecisionRaiser,
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
  type TriageAdapters,
} from "./adapters.js";
import { applyProbe, nextStep, retryProbe, startBisect, type ProbeOutcome } from "./bisect.js";
import { clip, testClass } from "./text.js";
import type { Clock, CommandRunner } from "../watchdog/probes.js";

// ============ INPUT AND ERRORS ============

/** What the gate runner knows besides the result. */
export interface IngestContext {
  /** The commit the change is based on (a PR's base) */
  baseSha?: string;
  /** Files the change touched; computed with git from baseSha when missing */
  changedFiles?: string[];
  /** The agent that authored the change */
  agent?: string;
  pr?: number;
  /** This result answers the re-check (or bisect probe) with this id */
  recheckId?: string;
  /** The machine's load per core while the gate ran */
  loadPerCore?: number;
}

export interface IngestInput {
  result: GateResult;
  reports?: ReportInput[];
  context?: IngestContext;
}

export interface IngestOutcome {
  record: TriageRecord;
  actions: TriageAction[];
  rechecks: Recheck[];
  incident: Incident | null;
}

/** Bad input: HTTP 400. */
export class TriageInputError extends Error {}
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
  parsers: EvidenceParser[];
  events?: EventBus;
}

type Target = { recordId?: string; incidentId?: string };

const OPEN_RECHECK: RecheckStatus[] = ["waiting_capacity", "requested", "planned", "unavailable"];

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

function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
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

export class TriageService {
  readonly project: string;
  readonly settings: TriageSettings;
  private queue: Promise<unknown> = Promise.resolve();
  private git: GitProbe;
  private capacity: CapacityProbe;
  private decisions?: DecisionRaiser;

  constructor(private o: TriageServiceOptions) {
    this.project = o.project;
    this.settings = o.settings;
    this.git = o.probes.git(o.config.repo, o.probes.runner);
    this.capacity = o.adapters.capacity ?? new LimitsCapacity(o.settings.recheck, o.probes.runner);
    const file = o.settings.decisionFile ?? o.config.inbox_file;
    this.decisions = o.adapters.decisions ?? (file ? new InboxDecisionRaiser(file, o.probes.fs, o.probes.clock) : undefined);
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

  private now(): number {
    return this.o.probes.clock.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  /** Run calls for this project one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves when the calls queued so far have finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
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
        at: this.iso(),
      },
      this.now(),
    );
  }

  /**
   * Run an adapter, or record why it didn't run: observe mode or read_only
   * (planned, with the argv it would run), no adapter (recorded), or the
   * adapter's result (done or failed).
   */
  private async perform(
    target: Target,
    kind: ActionKind,
    what: string,
    run: (() => Promise<AdapterResult>) | undefined,
    planned: string[] | null,
  ): Promise<AdapterResult | null> {
    const blocked = this.actBlocked;
    if (blocked) {
      this.action(target, kind, "planned", `${what} (not run: ${blocked})`, planned ?? undefined);
      return null;
    }
    if (!run) {
      this.action(target, kind, "recorded", `${what} (recorded and emitted; no command or module set)`);
      return null;
    }
    let result: AdapterResult;
    try {
      result = await run();
    } catch (e) {
      result = { ok: false, detail: message(e) };
    }
    this.action(target, kind, result.ok ? "done" : "failed", `${what}: ${result.detail}`, result.argv, result.output);
    return result;
  }

  // ============ INGEST ============

  ingest(input: IngestInput): Promise<IngestOutcome> {
    return this.serial(() => this.doIngest(input));
  }

  /** Expire, advance and request re-checks and bisect probes. */
  tick(): Promise<void> {
    return this.serial(() => this.pump());
  }

  private async doIngest(input: IngestInput): Promise<IngestOutcome> {
    const { store, settings, project } = this.o;
    const result = input.result;
    const context = input.context ?? {};
    const nowMs = this.now();
    const at = this.iso(nowMs);
    const sha = result.commitSha;

    let recheck: Recheck | null = null;
    if (context.recheckId) {
      recheck = store.getRecheck(context.recheckId);
      if (!recheck || recheck.project !== project) throw new TriageNotFoundError(`No re-check ${context.recheckId}`);
      if (!sameSha(recheck.sha, sha)) {
        throw new TriageInputError(`Re-check ${short(recheck.id)} is for ${recheck.sha}, not ${sha}`);
      }
      if (recheck.status === "passed" || recheck.status === "failed" || recheck.status === "cancelled") {
        throw new TriageConflictError(`Re-check ${short(recheck.id)} is already ${recheck.status}`);
      }
    }
    const origin = recheck?.recordId ? store.getRecord(recheck.recordId) : null;
    const purpose: ResultPurpose = recheck ? (recheck.purpose === "bisect" ? "bisect" : "recheck") : "gate";
    const isDefault = result.branch === settings.defaultBranch;
    const baseSha = context.baseSha ?? origin?.baseSha;
    const failed = result.status !== "passed";

    // 1. Causes
    const evidence = parseGateEvidence(result, input.reports ?? [], {
      contextPatterns: settings.contextPatterns,
      parsers: this.o.parsers,
    });

    // 2. Changed files
    let changedFiles = context.changedFiles ?? origin?.changedFiles ?? [];
    let changedNote: string | undefined;
    if (!context.changedFiles && !origin && baseSha && !isDefault && failed) {
      try {
        changedFiles = await this.git.changedFiles(baseSha, sha);
      } catch (e) {
        changedNote = `the changed files are unknown (${clip(message(e), 160)})`;
      }
    }

    const record: NewRecord = {
      project,
      gateId: result.id,
      sha,
      branch: result.branch,
      baseSha,
      agent: context.agent ?? origin?.agent,
      pr: context.pr ?? origin?.pr,
      purpose,
      recheckId: recheck?.id,
      originId: origin?.id,
      status: result.status,
      defaultBranch: isDefault,
      failedSteps: result.steps.filter((s) => s.status === "failed" || s.status === "timed_out").map((s) => s.name),
      changedFiles,
      receivedAt: at,
      receivedMs: nowMs,
    };
    const recordId = store.insertRecord(record);

    // 3. Which tests passed at this commit
    const windowMs = settings.flaky.windowMinutes * 60000;
    const passedKeys = new Set(evidence.passed.map((t) => t.key));
    const requested = this.requestedKeys(recheck, origin);
    if (!failed) {
      if (purpose === "gate") for (const key of store.failedKeysAt(project, sha, nowMs - windowMs)) passedKeys.add(key);
      for (const key of requested) passedKeys.add(key);
    } else if (requested.length > 0 && evidence.causes.some((c) => c.tests.length > 0)) {
      const failing = new Set(evidence.causes.flatMap((c) => c.tests.map((t) => t.key)));
      for (const key of requested) if (!failing.has(key)) passedKeys.add(key);
    }

    // 4. Classify
    let classified: ClassifiedCause[] = [];
    if (failed) {
      const ctx = this.classifyContext({
        sha,
        isDefault,
        baseSha,
        changedFiles,
        changedNote,
        recordId,
        nowMs,
        loadPerCore: context.loadPerCore,
        keys: evidence.causes.flatMap((c) => c.tests.map((t) => t.key)),
      });
      classified = evidence.causes.map((cause) => ({ id: randomUUID(), cause, verdict: classifyCause(cause, ctx, settings) }));
      store.insertCauses(recordId, classified);
    }
    const rows: TestRow[] = [];
    const failingKeys = new Set<string>();
    for (const c of classified) {
      for (const t of c.cause.tests) {
        failingKeys.add(t.key);
        rows.push({ key: t.key, outcome: "fail", cls: c.verdict.class });
      }
    }
    for (const key of passedKeys) if (!failingKeys.has(key)) rows.push({ key, outcome: "pass" });
    for (const t of uniqueTests(evidence.flaky)) {
      rows.push({ key: t.key, outcome: "fail", cls: "flaky" }, { key: t.key, outcome: "pass" });
    }
    store.addTests(project, sha, recordId, rows, nowMs);

    // 5. Earlier failures at this commit whose tests passed now
    await this.reclassifyFlaky(sha, passedKeys, recordId, nowMs);

    // 6. The re-check this result answers
    if (recheck) await this.answerRecheck(recheck, recordId, result.status, origin, classified);

    // 7. Act per class
    const stored = store.getRecord(recordId)!;
    if (failed && purpose !== "bisect") {
      await this.act(stored, classified, origin);
    } else if (failed) {
      store.updateRecord(recordId, { verdict: overallClass(classified) ?? null, blocking: false, resolution: "bisect probe" });
    } else if (purpose === "recheck") {
      store.updateRecord(recordId, { blocking: false, resolution: "re-check passed" });
    }
    for (const t of uniqueTests(evidence.flaky)) {
      await this.flakyOccurrence(t.key, stored, "failed, then passed on a rerun in the same run");
    }

    // 8. The default branch (a bisect probe runs old commits, so it never counts)
    if (isDefault && purpose !== "bisect") await this.defaultBranchResult(store.getRecord(recordId)!, classified);

    // 9. Re-checks and probes waiting for capacity
    await this.pump();

    const final = store.getRecord(recordId)!;
    await this.emit("triage.classified", {
      recordId,
      gateId: final.gateId,
      sha,
      branch: final.branch,
      status: final.status,
      verdict: final.verdict ?? null,
      blocking: final.blocking,
      causes: final.causes.map((c) => ({ signature: c.cause.signature, class: c.verdict.class, rule: c.verdict.rule })),
    });
    return {
      record: final,
      actions: store.actionsFor({ recordId }),
      rechecks: store.rechecksFor({ recordId: final.originId ?? recordId }),
      incident: store.openIncident(project, settings.defaultBranch),
    };
  }

  /** The tests a re-check was asked to run, by key. */
  private requestedKeys(recheck: Recheck | null, origin: TriageRecord | null): string[] {
    if (!recheck) return [];
    if (recheck.incidentId) return this.o.store.getIncident(recheck.incidentId)?.target.keys ?? [];
    if (!origin) return [];
    const ids = new Set(recheck.tests);
    return unique(origin.causes.flatMap((c) => c.cause.tests.filter((t) => ids.has(t.id)).map((t) => t.key)));
  }

  private classifyContext(input: {
    sha: string;
    isDefault: boolean;
    baseSha?: string;
    changedFiles: string[];
    changedNote?: string;
    recordId: string;
    nowMs: number;
    loadPerCore?: number;
    keys: string[];
  }): ClassifyContext {
    const { store, project, settings } = this.o;
    let base: BaseFacts | undefined;
    if (!input.isDefault) {
      const atBase = input.baseSha ? store.latestAt(project, input.baseSha, ["gate", "recheck"]) : null;
      const latest = atBase ?? store.latestOnBranch(project, settings.defaultBranch);
      if (latest && latest.id !== input.recordId) {
        base = {
          recordId: latest.id,
          sha: latest.sha,
          source: atBase ? "base" : "default-branch",
          status: latest.status,
          at: latest.receivedAt,
          failedKeys: new Set(latest.causes.flatMap((c) => c.cause.tests.map((t) => t.key))),
          signatures: new Set(latest.causes.map((c) => c.cause.signature)),
        };
      }
    }
    const incident = store.openIncident(project, settings.defaultBranch);
    const windowMs = settings.flaky.windowMinutes * 60000;
    return {
      sha: input.sha,
      defaultBranch: input.isDefault,
      changedFiles: input.changedFiles,
      changedNote: input.changedNote,
      base,
      incident: incident
        ? {
            id: incident.id,
            redSha: incident.redSha,
            keys: new Set(incident.target.keys),
            signatures: new Set(incident.target.signatures),
          }
        : undefined,
      passedAtSha: store.passesAt(project, input.sha, input.keys, input.nowMs - windowMs, input.nowMs + windowMs, input.recordId),
      quarantined: store.quarantinedKeys(project),
      loadPerCore: input.loadPerCore,
    };
  }

  // ============ ACTIONS PER CLASS ============

  private async act(record: TriageRecord, classified: ClassifiedCause[], origin: TriageRecord | null): Promise<void> {
    const { store, settings } = this.o;
    const of = (cls: Verdict["class"]) => classified.filter((c) => c.verdict.class === cls);
    const infra = of("infra");
    const code = of("code");
    let blocking = false;
    const pending: string[] = [];

    if (infra.length > 0) {
      blocking = true;
      if (settings.actions.infra === "recheck") {
        pending.push(await this.recheckInfra(record, infra, origin));
      } else if (settings.actions.infra === "route") {
        await this.routeToAuthor(record, infra, "infrastructure failures are routed to the author (triage.actions.infra: route)");
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
      } else if (settings.actions.code === "route") {
        await this.routeToAuthor(record, code);
        pending.push("code: back to the author");
      } else {
        this.action({ recordId: record.id }, "note", "skipped", "code: no action (triage.actions.code: none)");
      }
    }
    for (const c of of("pre-existing")) await this.preExisting(record, c);
    for (const c of of("flaky")) {
      for (const t of c.cause.tests) await this.flakyOccurrence(t.key, record, c.verdict.evidence[0] ?? c.verdict.rule);
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

  /** One re-check of only the failed tests (else only the failed steps) at the same commit. */
  private async recheckInfra(record: TriageRecord, infra: ClassifiedCause[], origin: TriageRecord | null): Promise<string> {
    const { store, settings, project } = this.o;
    const chainId = origin?.id ?? record.id;
    const done = store.rechecksFor({ recordId: chainId, purpose: "infra" });
    const max = settings.recheck.maxRetries;
    if (done.length >= max) return this.infraExhausted(record, infra, done.length, origin);

    const tests = uniqueTests(infra.flatMap((c) => c.cause.tests));
    let steps = unique(infra.flatMap((c) => (c.cause.step ? [c.cause.step] : [])));
    if (tests.length === 0 && steps.length === 0) steps = record.failedSteps;
    if (tests.length === 0 && steps.length === 0) {
      this.action({ recordId: chainId }, "recheck", "skipped", "no failed test or step to re-check, and a full re-run is never requested");
      return this.infraExhausted(record, infra, done.length, origin);
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

  /** No re-checks left: route to the author when the base passes, else ask the human. */
  private async infraExhausted(
    record: TriageRecord,
    infra: ClassifiedCause[],
    attempts: number,
    origin: TriageRecord | null,
  ): Promise<string> {
    const { store, settings, project } = this.o;
    const chainId = origin?.id ?? record.id;
    const base = record.defaultBranch
      ? null
      : (record.baseSha ? store.latestAt(project, record.baseSha, ["gate", "recheck"]) : null) ??
        store.latestOnBranch(project, settings.defaultBranch);
    if (base && base.status === "passed" && base.id !== record.id) {
      await this.routeToAuthor(
        record,
        infra,
        `still failing after ${attempts} re-check(s) at the same commit while ${short(base.sha)} passes`,
      );
      return `infra: still failing after ${attempts} re-check(s); routed to the author`;
    }
    await this.raiseDecision({ recordId: chainId }, {
      project,
      subject: `infra:${chainId}`,
      kind: "escalation",
      question: `Gate ${record.gateId} at ${short(record.sha)} on ${record.branch} still fails with an infrastructure error after ${attempts} re-check(s).`,
      context: infra.flatMap((c) => [describe(c), ...c.verdict.evidence.slice(0, 2)]).slice(0, 8),
      options: ["fix the environment, then re-run", "re-run now", "ignore"],
      recommended: "fix the environment, then re-run",
      why: "Lair re-checks an infrastructure failure only up to triage.recheck.max_retries.",
      reversible: true,
      onTimeout: "wait",
      requestedBy: "triage",
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

  private async routeToAuthor(record: TriageRecord, causes: ClassifiedCause[], why?: string): Promise<void> {
    const text = this.agentText(record, causes, why);
    const agent = record.agent;
    await this.emit("triage.routed", { recordId: record.id, agent: agent ?? null, sha: record.sha, text });
    if (!agent) {
      this.action({ recordId: record.id }, "route", "skipped", "no author agent in the result (send context.agent with it)");
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
    const router = this.o.adapters.router;
    await this.perform(
      { recordId: record.id },
      "route",
      `${causes.length} cause(s) sent to ${agent}`,
      router ? () => router.route(msg) : undefined,
      plannedArgv(this.settings, "notify_agent", messageVars(msg)),
    );
  }

  private async preExisting(record: TriageRecord, c: ClassifiedCause): Promise<void> {
    const { store, settings, project } = this.o;
    const incident = c.verdict.rule === "open-incident" ? store.openIncident(project, settings.defaultBranch) : null;
    if (incident) {
      this.action(
        { recordId: record.id },
        "note",
        "recorded",
        `${describe(c)}: part of the default branch's open incident ${short(incident.id)}, not this change`,
      );
    }
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
    await this.createTask(record, task, "fix_task");
  }

  private async createTask(record: TriageRecord, task: TriageTask, kind: ActionKind): Promise<void> {
    await this.emit("triage.task_created", { recordId: record.id, task });
    const sink = this.o.adapters.tasks;
    const result = await this.perform(
      { recordId: record.id },
      kind,
      `task ${short(task.id)} "${clip(task.title, 120)}"`,
      sink ? () => sink.create(task) : undefined,
      plannedArgv(this.settings, "create_task", taskVars(task)),
    );
    if (result?.ok && result.ref) this.o.store.setTaskRef(task.id, result.ref);
  }

  /** Record a flaky occurrence; flaky `ticket_after` times in a row opens a reliability task and quarantines the test. */
  private async flakyOccurrence(key: string, record: TriageRecord, why: string): Promise<void> {
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
        settings.flaky.quarantine ? "It is quarantined until then: it still runs, but it no longer blocks." : "",
        `Latest: ${why}`,
      ]
        .filter(Boolean)
        .join("\n"),
      createdAt: this.iso(),
    });
    if (!created) return;
    store.markFlaky(project, key, { ticketId: task.id });
    await this.createTask(record, task, "ticket");
    if (!settings.flaky.quarantine) return;
    const quarantined = store.quarantinedKeys(project);
    if (quarantined.size >= settings.flaky.quarantineCap) {
      this.action(
        { recordId: record.id },
        "quarantine",
        "skipped",
        `${key} not quarantined: the cap of ${settings.flaky.quarantineCap} quarantined tests is reached`,
      );
      return;
    }
    store.markFlaky(project, key, { quarantinedAt: this.iso() });
    this.action({ recordId: record.id }, "quarantine", "done", `${key} quarantined: it runs, but its failures no longer block`);
  }

  /** Earlier failures at this commit whose tests have all passed now are flaky, not code. */
  private async reclassifyFlaky(sha: string, passedKeys: Set<string>, recordId: string, nowMs: number): Promise<void> {
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
        for (const t of c.cause.tests) await this.flakyOccurrence(t.key, rec, verdict.evidence[0]);
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

  private async answerRecheck(
    recheck: Recheck,
    recordId: string,
    status: TriageRecord["status"],
    origin: TriageRecord | null,
    classified: ClassifiedCause[],
  ): Promise<void> {
    const { store } = this.o;
    store.updateRecheck(recheck.id, {
      status: status === "passed" ? "passed" : "failed",
      completedAt: this.iso(),
      answerId: recordId,
    });
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
      } else {
        this.action(
          { recordId: origin.id },
          "note",
          "recorded",
          `re-check ${recheck.attempt} failed again (result ${short(recordId)})`,
        );
      }
      return;
    }
    if (recheck.purpose === "bisect" && recheck.incidentId) {
      await this.bisectAnswer(recheck, recordId, status, classified);
    }
  }

  /** Expire stale re-checks, advance the bisect, then request what capacity allows. */
  private async pump(): Promise<void> {
    const { store, settings, project } = this.o;
    const nowMs = this.now();
    const timeoutMs = settings.recheck.timeoutMinutes * 60000;
    for (const r of store.rechecksWithStatus(project, ["requested", "unavailable"])) {
      const since = store.requestedMs(r.id);
      if (since === null || nowMs - since < timeoutMs) continue;
      const reason = `no result within ${settings.recheck.timeoutMinutes} min`;
      store.updateRecheck(r.id, { status: "expired", reason, completedAt: this.iso(nowMs) });
      await this.recheckLost(r, reason);
    }

    await this.advanceBisect();

    for (const r of store.rechecksWithStatus(project, ["waiting_capacity"])) {
      const target: Target = r.recordId ? { recordId: r.recordId } : { incidentId: r.incidentId };
      const blocked = this.actBlocked;
      if (blocked) {
        store.updateRecheck(r.id, { status: "planned", reason: `not run: ${blocked}` });
        this.action(
          target,
          "recheck",
          "planned",
          `re-check of ${selection(r)} at ${short(r.sha)} (not run: ${blocked})`,
          plannedArgv(settings, "recheck", recheckVars(project, r)) ?? undefined,
        );
        continue;
      }
      const inFlight = store.rechecksWithStatus(project, ["requested"]).length;
      if (inFlight >= settings.recheck.maxConcurrent) {
        store.updateRecheck(r.id, { reason: `waiting: ${inFlight} re-check(s) running (max_concurrent ${settings.recheck.maxConcurrent})` });
        break;
      }
      let capacity: { ok: boolean; reason: string };
      try {
        capacity = await this.capacity.check();
      } catch (e) {
        capacity = { ok: false, reason: `capacity check failed: ${message(e)}` };
      }
      if (!capacity.ok) {
        store.updateRecheck(r.id, { reason: `waiting for capacity: ${capacity.reason}` });
        break;
      }
      await this.requestRecheck(r, target, capacity.reason);
    }
  }

  private async requestRecheck(r: Recheck, target: Target, capacityReason: string): Promise<void> {
    const { store } = this.o;
    const nowMs = this.now();
    await this.emit("triage.recheck_requested", { recheck: r });
    const executor = this.o.adapters.recheck;
    if (!executor) {
      store.updateRecheck(r.id, {
        status: "unavailable",
        reason: "no re-check executor (triage.commands.recheck); answer with context.recheckId",
        requestedAt: this.iso(nowMs),
        requestedMs: nowMs,
      });
      this.action(target, "recheck", "recorded", `re-check ${short(r.id)} of ${selection(r)} at ${short(r.sha)}: no executor is set`);
      return;
    }
    let result: AdapterResult;
    try {
      result = await executor.request(r);
    } catch (e) {
      result = { ok: false, detail: message(e) };
    }
    store.updateRecheck(r.id, {
      status: result.ok ? "requested" : "unavailable",
      reason: result.ok ? capacityReason : result.detail,
      requestedAt: this.iso(nowMs),
      requestedMs: nowMs,
    });
    this.action(
      target,
      "recheck",
      result.ok ? "done" : "failed",
      `re-check ${r.attempt} (${short(r.id)}) of ${selection(r)} at ${short(r.sha)}: ${result.detail}`,
      result.argv,
      result.output,
    );
  }

  /** A re-check that never answered. */
  private async recheckLost(r: Recheck, reason: string): Promise<void> {
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
    const note = await this.recheckInfra(origin, infra, null);
    store.updateRecord(origin.id, { resolution: note });
  }

  // ============ DEFAULT BRANCH: INCIDENT AND BISECT ============

  private async defaultBranchResult(record: TriageRecord, classified: ClassifiedCause[]): Promise<void> {
    const { store, project } = this.o;
    const open = store.openIncident(project, record.branch);
    if (record.status === "passed") {
      // Only a full gate run proves the branch green; a re-check runs a few tests
      if (!open || record.purpose !== "gate") return;
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
      await this.emit("triage.incident_resolved", { incidentId: open.id, sha: record.sha });
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
    await this.openIncident(record, regressions);
  }

  private async openIncident(record: TriageRecord, regressions: ClassifiedCause[]): Promise<void> {
    const { store, settings, project } = this.o;
    const tests = uniqueTests(regressions.flatMap((c) => c.cause.tests));
    const steps = unique(regressions.flatMap((c) => (c.cause.step ? [c.cause.step] : [])));
    const target: IncidentTarget = {
      tests: tests.map((t) => t.id),
      keys: tests.map((t) => t.key),
      classes: unique(tests.map(testClass)),
      steps: steps.length > 0 ? steps : record.failedSteps,
      signatures: regressions.map((c) => c.cause.signature),
    };
    const receivedMs = store.receivedMs(record.id) ?? this.now();
    const lastGreen = store.latestOnBranch(project, record.branch, { passed: true, beforeMs: receivedMs });
    const stopped = (status: BisectState["status"], detail: string): BisectState => ({
      status,
      candidates: [],
      good: -1,
      bad: -1,
      skipped: [],
      probes: [],
      proven: false,
      detail,
    });
    let bisect: BisectState;
    if (!settings.bisect.enabled) {
      bisect = stopped("off", "triage.bisect.enabled is false");
    } else if (!lastGreen) {
      bisect = stopped("no_baseline", `no green result on ${record.branch} yet, so there is nothing to bisect from`);
    } else {
      try {
        const candidates = await this.git.firstParentRange(lastGreen.sha, record.sha);
        if (candidates.length > settings.bisect.maxCandidates) {
          bisect = stopped(
            "inconclusive",
            `${candidates.length} commits since the last green one is more than bisect.max_candidates (${settings.bisect.maxCandidates})`,
          );
        } else {
          const red = candidates.find((c) => sameSha(c, record.sha)) ?? record.sha;
          bisect = startBisect(candidates, red);
        }
      } catch (e) {
        bisect = stopped("inconclusive", `git: ${clip(message(e), 200)}`);
      }
    }
    const incident = store.createIncident({
      project,
      branch: record.branch,
      status: "open",
      openedAt: this.iso(),
      redSha: record.sha,
      lastGreenSha: lastGreen?.sha,
      recordId: record.id,
      target,
      bisect,
      revert: { status: "none" },
    });
    this.action(
      { incidentId: incident.id },
      "incident",
      "done",
      `${record.branch} is red at ${short(record.sha)}: ${regressions.map(describe).slice(0, 3).join("; ")}. ${bisect.detail}`,
    );
    this.action({ recordId: record.id }, "incident", "done", `opened incident ${short(incident.id)} (${bisect.status})`);
    await this.emit("triage.incident_opened", {
      incidentId: incident.id,
      sha: record.sha,
      lastGreenSha: lastGreen?.sha ?? null,
      candidates: bisect.candidates.length,
    });
  }

  private async advanceBisect(): Promise<void> {
    const { store, settings, project } = this.o;
    const incident = store.openIncident(project, settings.defaultBranch);
    if (!incident || incident.bisect.status !== "running") return;
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
      await this.onCulprit(store.getIncident(incident.id)!);
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
    await this.onSuspects(store.getIncident(incident.id)!);
  }

  private async bisectAnswer(recheck: Recheck, recordId: string, status: TriageRecord["status"], classified: ClassifiedCause[]): Promise<void> {
    const { store, settings } = this.o;
    const incident = recheck.incidentId ? store.getIncident(recheck.incidentId) : null;
    if (!incident || incident.status !== "open") return;
    const probe = incident.bisect.probes.find((p) => p.recheckId === recheck.id);
    if (!probe || probe.outcome !== "pending") return;
    const target = incident.target;
    let outcome: ProbeOutcome;
    let detail: string;
    if (status === "passed") {
      outcome = "pass";
      detail = `passed (result ${short(recordId)})`;
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
        const retried = incident.bisect.probes.filter((p) => p.sha === probe.sha && p.retried).length;
        if (retried < settings.recheck.maxRetries) {
          const bisect = retryProbe(incident.bisect, probe, `infrastructure (${classified[0].verdict.rule}); probing again`);
          store.updateIncident(incident.id, { bisect });
          this.action({ incidentId: incident.id }, "bisect", "recorded", `probe ${short(probe.sha)}: infrastructure, probing again`);
          return;
        }
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

  private protectedReason(sha: string, info: CommitInfo | null): string | null {
    const { store, settings, project } = this.o;
    const shas = [sha, ...(info?.parents.slice(1) ?? [])].map((s) => s.toLowerCase());
    const matches = (list: string[]) => list.some((p) => shas.some((s) => sameSha(s, p)));
    if (matches(store.listProtected(project).map((p) => p.sha))) return "a human marked it protected in Lair";
    if (matches(settings.bisect.protectedMerges)) return "it is listed in triage.bisect.protected_merges";
    const trailer = new RegExp(`^${settings.bisect.protectedTrailer}:\\s*(yes|true|1)\\s*$`, "im");
    if (info && trailer.test(info.body)) return `its message has "${settings.bisect.protectedTrailer}: yes"`;
    return null;
  }

  /** The gate result (with its agent and PR) of the change a merge brought in. */
  private authorOf(sha: string, info: CommitInfo | null): TriageRecord | null {
    const { store, project } = this.o;
    const shas = [sha, ...(info?.parents.slice(1) ?? [])];
    const direct = store.recordsAt(project, shas).find((r) => r.agent);
    if (direct) return direct;
    const pr = info ? Number((info.subject.match(/(?:\(#|pull request #)(\d+)/) ?? [])[1]) : NaN;
    if (!Number.isFinite(pr)) return null;
    return store.listRecords(project, { limit: 500 }).find((r) => r.pr === pr && r.agent) ?? null;
  }

  private async onCulprit(incident: Incident): Promise<void> {
    const { store, settings } = this.o;
    const culprit = incident.bisect.culprit!;
    let info: CommitInfo | null = null;
    try {
      info = await this.git.commit(culprit);
    } catch {
      info = null;
    }
    const protectedBy = this.protectedReason(culprit, info);
    const author = this.authorOf(culprit, info);
    const red = store.getRecord(incident.recordId);
    const causes = red?.causes.filter((c) => incident.target.signatures.includes(c.cause.signature)) ?? [];
    const reason = `${incident.branch} is red since ${short(culprit)}${info?.subject ? ` (${clip(info.subject, 100)})` : ""}: ${
      causes.map(describe).slice(0, 2).join("; ") || "see the incident"
    }. Green before, red after, the same cause twice.`;
    await this.emit("triage.culprit_found", { incidentId: incident.id, sha: culprit, proven: true, protected: protectedBy !== null });

    if (author?.agent && red) {
      await this.routeToAuthor(
        { ...red, agent: author.agent, pr: author.pr },
        causes,
        `your change ${short(culprit)} broke ${incident.branch}`,
      );
    }

    const revert: Incident["revert"] = { ...incident.revert, protected: protectedBy !== null };
    const policy = settings.bisect.revert;
    if (policy === "off") {
      store.updateIncident(incident.id, { revert: { ...revert, status: "off", detail: "triage.bisect.revert is off" } });
      return;
    }
    if (policy === "auto" && !protectedBy) {
      const opened = await this.openRevert(incident, culprit, reason, author?.pr);
      if (opened?.ok) {
        store.updateIncident(incident.id, { revert: { ...revert, status: "opened", ref: opened.ref, detail: opened.detail } });
        return;
      }
      revert.detail = opened ? `the revert could not be opened: ${opened.detail}` : "the revert was not opened";
    }
    const status = protectedBy ? "protected" : "proposed";
    store.updateIncident(incident.id, {
      revert: {
        ...revert,
        status,
        detail: protectedBy ? `never reverted automatically: ${protectedBy}` : revert.detail ?? "a decision proposes the revert",
      },
    });
    await this.raiseDecision({ incidentId: incident.id }, {
      project: this.project,
      subject: `revert:${incident.id}`,
      kind: "other",
      question: `Revert ${short(culprit)} to make ${incident.branch} green again?`,
      context: [
        reason,
        ...(protectedBy ? [`It is protected: ${protectedBy}.`] : []),
        `Incident ${incident.id}; last green ${incident.lastGreenSha ? short(incident.lastGreenSha) : "unknown"}.`,
        ...incident.bisect.probes.filter((p) => p.recheckId).map((p) => `probe ${short(p.sha)}: ${p.outcome}${p.detail ? ` (${p.detail})` : ""}`),
      ],
      options: ["revert", "keep and fix forward"],
      recommended: protectedBy ? "keep and fix forward" : "revert",
      why: protectedBy
        ? "A merge a human protected is never reverted automatically."
        : "Bisect proved this merge broke the branch; triage.bisect.revert is propose.",
      reversible: true,
      onTimeout: "wait",
      requestedBy: "triage",
    });
  }

  private async onSuspects(incident: Incident): Promise<void> {
    const { store, settings } = this.o;
    const suspects = incident.bisect.suspects ?? [];
    if (settings.bisect.revert === "off") {
      store.updateIncident(incident.id, { revert: { ...incident.revert, status: "off", detail: "triage.bisect.revert is off" } });
      return;
    }
    store.updateIncident(incident.id, {
      revert: { ...incident.revert, status: suspects.length > 0 ? "proposed" : "none", detail: "not proven: never reverted automatically" },
    });
    await this.raiseDecision({ incidentId: incident.id }, {
      project: this.project,
      subject: `revert:${incident.id}`,
      kind: "escalation",
      question: `${incident.branch} is red since ${short(incident.redSha)} and bisect could not prove which merge did it.`,
      context: [
        incident.bisect.detail,
        `Suspects: ${suspects.map(short).join(", ") || "none"}.`,
        ...incident.bisect.probes.filter((p) => p.recheckId).map((p) => `probe ${short(p.sha)}: ${p.outcome}${p.detail ? ` (${p.detail})` : ""}`),
      ],
      options: [...suspects.slice(0, 5).map((s) => `revert ${short(s)}`), "investigate"],
      recommended: "investigate",
      why: "Only a merge proven to break the branch is reverted; this one is not proven.",
      reversible: true,
      onTimeout: "wait",
      requestedBy: "triage",
    });
  }

  private async openRevert(incident: Incident, sha: string, reason: string, pr?: number): Promise<AdapterResult | null> {
    const opener = this.o.adapters.revert;
    const request = { project: this.project, incidentId: incident.id, sha, branch: incident.branch, reason, pr };
    await this.emit("triage.revert_requested", { incidentId: incident.id, sha });
    return this.perform(
      { incidentId: incident.id },
      "revert",
      `revert ${short(sha)} on ${incident.branch}`,
      opener ? () => opener.open(request) : undefined,
      plannedArgv(this.settings, "open_revert", revertVars(request)),
    );
  }

  private async raiseDecision(target: Target, request: DecisionRequest): Promise<void> {
    const { store } = this.o;
    if (!store.claimDecision(this.project, request.subject, this.iso())) {
      this.action(target, "decision", "skipped", `already asked: ${clip(request.question, 160)}`);
      return;
    }
    await this.emit("triage.decision_requested", { decision: request });
    const raiser = this.decisions;
    const viaCommand = this.o.decisionsViaCommand === true;
    let result: AdapterResult | null;
    if (viaCommand) {
      result = await this.perform(
        target,
        "decision",
        clip(request.question, 200),
        raiser ? () => raiser.raise(request) : undefined,
        plannedArgv(this.settings, "raise_decision", decisionVars(request)),
      );
    } else if (raiser) {
      // Asking the human is safe in observe mode too, as the watchdog's escalations are
      try {
        result = await raiser.raise(request);
      } catch (e) {
        result = { ok: false, detail: message(e) };
      }
      this.action(target, "decision", result.ok ? "done" : "failed", `${clip(request.question, 200)}: ${result.detail}`);
    } else {
      result = null;
      this.action(target, "decision", "recorded", `${clip(request.question, 200)} (no decision_file, inbox_file or decisions module)`);
    }
    if (result?.ok && result.ref) store.setDecisionRef(this.project, request.subject, result.ref);
    if (target.incidentId && result?.ok) store.updateIncident(target.incidentId, { decisionRef: result.ref ?? request.subject });
  }

  // ============ HUMAN ACTIONS ============

  /** A human asked for the revert (from the UI, or answering the decision). */
  requestRevert(incidentId: string, sha?: string): Promise<Incident> {
    return this.serial(async () => {
      const { store } = this.o;
      const incident = store.getIncident(incidentId);
      if (!incident || incident.project !== this.project) throw new TriageNotFoundError(`No incident ${incidentId}`);
      const candidates = [incident.bisect.culprit, ...(incident.bisect.suspects ?? [])].filter((s): s is string => !!s);
      const target = sha ? candidates.find((c) => sameSha(c, sha)) : incident.bisect.culprit;
      if (!target) {
        throw new TriageConflictError(
          sha ? `${sha} is not this incident's culprit or a suspect` : "The bisect has not found a culprit (yet)",
        );
      }
      if (incident.revert.status === "opened") throw new TriageConflictError("A revert is already open");
      const blocked = this.actBlocked;
      if (blocked) throw new TriageConflictError(`Commands don't run: ${blocked}`);
      if (!this.o.adapters.revert) throw new TriageConflictError("triage.commands.open_revert is not set");
      const opened = await this.openRevert(incident, target, `requested by a human for incident ${short(incident.id)}`);
      store.updateIncident(incident.id, {
        revert: {
          ...incident.revert,
          status: opened?.ok ? "opened" : "failed",
          ref: opened?.ref,
          detail: opened?.detail ?? "not opened",
        },
      });
      return store.getIncident(incident.id)!;
    });
  }

  protect(sha: string, note: string): void {
    this.o.store.protect(this.project, sha, note, this.iso());
  }

  unprotect(sha: string): boolean {
    return this.o.store.unprotect(this.project, sha);
  }
}
