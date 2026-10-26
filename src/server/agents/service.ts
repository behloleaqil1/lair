/**
 * The agents service (docs/design/autonomy.md §6): one per project with
 * `agents.enabled`. It starts agent runs itself and supervises them.
 *
 * A run request claims its task (one claim per task, owned by a pid and that
 * process's start time). Each tick then, for every active run:
 * - queued / waiting_lock: checks the budget, picks a usable profile
 *   (failover), takes the launch locks (breaking any whose holder is dead),
 *   and spawns the agent; the claim passes to the agent's process. With no
 *   live process within start_timeout_minutes the run is never-started, with
 *   the reason, and retried with backoff.
 * - running: a run that lost its claim stops itself; a provider error or
 *   rate limit fails over to the next profile; a hung agent (the watchdog's
 *   rule, so a WAITING agent never is) is stopped; a dead process completed
 *   (exit 0), died on start, or crashed.
 * - stopping: SIGTERM, then SIGKILL after stop_grace_seconds.
 * Failures restart with the same session up to recovery.same_session_restarts
 * times, then in a fresh session (the old one moved aside) with a resume
 * summary, then escalate to the Decision Inbox. Finally claims and locks whose
 * owner is dead are released and broken. Every step is recorded as an event.
 */
import { randomUUID } from "crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { EventType } from "../../shared/server-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  AgentEventKind,
  AgentEventView,
  AgentProfile,
  AgentRunView,
  AgentState,
  AgentsStatusView,
  AgentsTickSummary,
  AgentView,
  BudgetScopeView,
  LockView,
  StopReason,
} from "../../shared/agents-types.js";
import { buildStartCommand, getAdapter } from "../services/adapters.js";
import { knownDragonIds, loadKnownDragons } from "../services/dragon-registry.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getPromptsDir } from "../routes/controls.js";
import { parseWatchdogConfig, type WatchdogSettings } from "../watchdog/config.js";
import { hungFinding } from "../watchdog/detectors.js";
import { WatchdogStore } from "../watchdog/store.js";
import { ProjectView } from "../watchdog/view.js";
import type { ProjectEntry } from "../watchdog/service.js";
import { backoffMs, MODEL_ID, parseAgentsConfig, type AgentLockSettings, type AgentsSettings } from "./config.js";
import {
  agentLimits,
  describeUsage,
  evaluateBudget,
  periodEnd,
  type FleetBudget,
} from "./budgets.js";
import { InboxFileDecisions, type DecisionInbox, type DecisionRequest } from "./decisions.js";
import { chooseProfile, matchFailover, profileLabel, profilesFor } from "./failover.js";
import {
  createLock,
  judgeLock,
  readLock,
  releaseLock,
  removeLock,
  transferLock,
  type LockFile,
  type LockOwnerLabel,
} from "./locks.js";
import { ProcessSnapshot, systemAgentProbes, type AgentProbes, type ProcessOwner } from "./probes.js";
import { lastLines, moveSessionAside, readTail, resumeSummary, sessionDirFor, utcStamp } from "./sessions.js";
import { AgentsStore } from "./store.js";
import {
  claimView,
  eventView,
  isActive,
  runView,
  type AgentRun,
  type Claim,
  type FailoverInfo,
  type StoredLockWait,
} from "./types.js";

/** An error with the HTTP status the routes answer with. */
export class AgentsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentsError";
  }
}

/** Task ids: they reach argv placeholders and file names, so no shell characters and no leading dash. */
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}$/;
const MAX_PROMPT_CHARS = 200_000;

/** The events shown as an agent's recoveries. */
export const RECOVERY_KINDS: readonly AgentEventKind[] = [
  "claim_released",
  "lock_broken",
  "never_started",
  "dead_on_start",
  "crashed",
  "hung",
  "lost_claim",
  "restart_same_session",
  "fresh_session",
  "escalated",
  "failover",
  "budget_warning",
  "budget_exceeded",
  "decision",
];

const BUS_EVENTS: Partial<Record<AgentEventKind, EventType>> = {
  requested: "agent.run.requested",
  started: "agent.run.started",
  completed: "agent.run.ended",
  claim_released: "agent.claim.released",
  lock_broken: "agent.lock.broken",
  never_started: "agent.recovery",
  dead_on_start: "agent.recovery",
  crashed: "agent.recovery",
  hung: "agent.recovery",
  lost_claim: "agent.recovery",
  restart_same_session: "agent.recovery",
  fresh_session: "agent.recovery",
  escalated: "agent.recovery",
  failover: "agent.failover",
  budget_warning: "agent.budget.warning",
  budget_exceeded: "agent.budget.exceeded",
};

const iso = (ms: number) => new Date(ms).toISOString();
const short = (id: string) => id.slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const oneLine = (text: string, max = 300) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
const failoverLabel = (kind: FailoverInfo["kind"]) => (kind === "rate_limit" ? "rate limit" : "provider error");

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes of a file from `offset`, at most `max`. */
function readFrom(path: string, offset: number, max: number): Buffer {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const length = Math.min(size - offset, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer;
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function watchdogSettingsFor(config: ProjectConfig, hungMinutes?: number): WatchdogSettings {
  const own = parseWatchdogConfig(config.watchdog);
  const parsed = own.ok ? own : parseWatchdogConfig({});
  if (!parsed.ok) throw new Error("the watchdog defaults do not parse");
  return { ...parsed.settings, hungMinutes: hungMinutes ?? parsed.settings.hungMinutes };
}

/** One tick's (or one action's) view of the world. */
interface Tick {
  now: number;
  snap: ProcessSnapshot;
  summary: AgentsTickSummary;
  /** Tasks and locks handled this tick: the reapers leave them alone */
  touchedTasks: Set<string>;
  touchedLocks: Set<string>;
  view?: ProjectView;
}

function emptySummary(now: number): AgentsTickSummary {
  return {
    at: iso(now),
    started: 0,
    ended: 0,
    recovered: 0,
    locksBroken: 0,
    claimsReleased: 0,
    neverStarted: 0,
    failovers: 0,
    escalations: 0,
    warnings: 0,
  };
}

export interface RunRequest {
  agent: unknown;
  task: unknown;
  prompt: unknown;
  model?: unknown;
}

export interface AgentsServiceOptions {
  project: string;
  config: ProjectConfig;
  settings: AgentsSettings;
  store: AgentsStore;
  probes: AgentProbes;
  /** Where decisions go (read on each use, so a decisions module can be plugged in later) */
  decisions: () => DecisionInbox;
  budget?: FleetBudget;
  events?: EventBus;
}

interface EventInput {
  agent?: string;
  task?: string;
  runId?: string;
  subject?: string;
  summary: string;
  evidence?: string[];
  data?: Record<string, unknown>;
  dedupeKey?: string;
}

type LockAttempt = { ok: true; held: AgentLockSettings[] } | { ok: false; wait: StoredLockWait };

export class AgentsService {
  readonly project: string;
  readonly settings: AgentsSettings;
  private config: ProjectConfig;
  private store: AgentsStore;
  private probes: AgentProbes;
  private decisions: () => DecisionInbox;
  private budget?: FleetBudget;
  private events?: EventBus;
  private watchdogSettings: WatchdogSettings;
  private watchdogStore: WatchdogStore | null = null;
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ticking: Promise<AgentsTickSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private snapshot: ProcessSnapshot | null = null;
  lastTick?: AgentsTickSummary;
  lastError?: string;

  constructor(options: AgentsServiceOptions) {
    this.project = options.project;
    this.config = options.config;
    this.settings = options.settings;
    this.store = options.store;
    this.probes = options.probes;
    this.decisions = options.decisions;
    this.budget = options.budget;
    this.events = options.events;
    this.watchdogSettings = watchdogSettingsFor(options.config, options.settings.hungMinutes);
    // Usage reaches the per-agent and per-project budgets through the fleet budget
    this.unsubscribe =
      this.budget?.onCost((event) => {
        const who = event.attribution;
        if (!who || who.project !== this.project) return;
        this.store.addUsage({
          project: this.project,
          agent: who.agent,
          provider: event.provider,
          runId: who.runId,
          tokens: who.tokens ?? 0,
          cost: event.cost,
          at: this.probes.clock.now(),
          reason: event.reason,
        });
      }) ?? null;
  }

  get readOnly(): boolean {
    return this.config.read_only === true;
  }

  get running(): boolean {
    return !this.stopped;
  }

  private get toleranceMs(): number {
    return this.settings.pidStartToleranceSeconds * 1000 + 1000;
  }

  /** Ticks and actions run one at a time, so no two of them change a run at once. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async newTick(now: number): Promise<Tick> {
    const list = await this.probes.processes.list();
    const snap = new ProcessSnapshot(list, now, this.probes.self, this.settings.pidStartToleranceSeconds);
    this.snapshot = snap;
    return {
      now,
      snap,
      summary: emptySummary(now),
      touchedTasks: new Set(),
      touchedLocks: new Set(),
    };
  }

  private view(t: Tick): ProjectView {
    if (!t.view) {
      // The view's own store is only used by detectors this module doesn't run
      const store = this.watchdogStore ?? new WatchdogStore(":memory:");
      this.watchdogStore = store;
      t.view = new ProjectView({
        project: this.project,
        config: this.config,
        settings: this.watchdogSettings,
        probes: this.probes,
        store,
      });
    }
    return t.view;
  }

  // ============ EVENTS AND DECISIONS ============

  private async record(kind: AgentEventKind, input: EventInput, at: number): Promise<boolean> {
    const event = this.store.addEvent({
      project: this.project,
      kind,
      agent: input.agent,
      task: input.task,
      runId: input.runId,
      subject: input.subject,
      summary: input.summary,
      evidence: input.evidence ?? [],
      data: input.data ?? {},
      dedupeKey: input.dedupeKey,
      at,
    });
    if (!event) return false;
    const type = BUS_EVENTS[kind];
    if (type) {
      await this.events?.emit(type, {
        project: this.project,
        kind,
        eventId: event.id,
        agent: input.agent ?? null,
        task: input.task ?? null,
        runId: input.runId ?? null,
        subject: input.subject ?? null,
        summary: input.summary,
      });
    }
    return true;
  }

  /** Raise a decision once per key. True when this call raised it. */
  private async raise(
    request: Omit<DecisionRequest, "project" | "requestedBy">,
    t: Tick,
    run?: AgentRun,
  ): Promise<boolean> {
    const dedupeKey = `decision:${request.key}`;
    if (this.store.hasEvent(this.project, dedupeKey)) return false;
    const full: DecisionRequest = { ...request, project: this.project, requestedBy: "agents" };
    let outcome: { id: string; via: string };
    try {
      outcome = await this.decisions().request(full);
    } catch (e) {
      outcome = { id: "", via: `not delivered: ${message(e)}` };
    }
    const recorded = await this.record(
      "decision",
      {
        agent: run?.agent,
        task: run?.task,
        runId: run?.id,
        subject: request.kind,
        summary: `asked: ${request.question}`,
        evidence: [outcome.via],
        data: {
          decisionId: outcome.id,
          kind: request.kind,
          key: request.key,
          via: outcome.via,
          options: request.options,
          recommended: request.recommended ?? null,
        },
        dedupeKey,
      },
      t.now,
    );
    if (recorded) t.summary.escalations++;
    return recorded;
  }

  // ============ TICK ============

  /** Run one tick. Concurrent calls share the tick in progress. */
  tick(): Promise<AgentsTickSummary> {
    if (!this.ticking) {
      this.ticking = this.exclusive(() => this.runTick()).finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async runTick(): Promise<AgentsTickSummary> {
    // A failed `ps` fails the tick: nothing is judged on data that couldn't be read
    const t = await this.newTick(this.probes.clock.now());
    if (!this.readOnly) {
      for (const run of this.store.activeRuns(this.project)) {
        if (run.state === "running" || run.state === "stopping") this.readUsage(run);
      }
    }
    await this.checkBudgets(t);
    if (!this.readOnly) {
      for (const run of this.store.activeRuns(this.project)) {
        t.touchedTasks.add(run.task);
        await this.advance(run, t);
      }
      await this.reapClaims(t);
      await this.reapLocks(t);
    }
    this.lastTick = t.summary;
    this.lastError = undefined;
    return t.summary;
  }

  private async advance(run: AgentRun, t: Tick): Promise<void> {
    switch (run.state) {
      case "queued":
      case "waiting_lock":
        return this.launch(run, t);
      case "running":
        return this.supervise(run, t);
      case "stopping":
        return this.finishStop(run, t);
      default:
        return;
    }
  }

  // ============ LAUNCH ============

  private profiles(agent: string, model?: string): AgentProfile[] {
    return profilesFor(this.config, this.settings, agent, model);
  }

  /** When a provider that rate-limited or failed may be used again, or null. */
  private coolingUntil(provider: string, now: number): number | null {
    const cooldown = this.settings.failover.cooldownMinutes * 60000;
    if (cooldown <= 0) return null;
    const recent = this.store.listEvents(this.project, {
      kinds: ["failover"],
      subject: provider,
      since: now - cooldown,
      limit: 20,
    });
    const failure = recent.find((e) => e.data.kind === "rate_limit" || e.data.kind === "provider_error");
    return failure && failure.at + cooldown > now ? failure.at + cooldown : null;
  }

  /** Why a profile can't be used now, or null. */
  private unusable(profile: AgentProfile, now: number): string | null {
    if (!getAdapter(profile.adapter, this.config)) return `adapter ${profile.adapter} is not defined`;
    const until = this.coolingUntil(profile.provider, now);
    if (until !== null) return `provider ${profile.provider} is cooling down until ${iso(until)}`;
    if (this.budget && !this.budget.isProviderAvailable(profile.provider)) {
      return `the fleet budget has provider ${profile.provider} paused or rate limited`;
    }
    return null;
  }

  /** The hard budget limit an agent's new runs are blocked by, or null. */
  private budgetBlock(agent: string, now: number): string | null {
    const scopes = [
      evaluateBudget(this.store, this.project, null, this.settings.budgets.project, now),
      evaluateBudget(this.store, this.project, agent, agentLimits(this.settings, agent), now),
    ];
    for (const scope of scopes) {
      const line = scope?.lines.find((l) => l.level === "hard");
      if (scope && line) return describeUsage(scope, line, "hard");
    }
    return null;
  }

  private async launch(run: AgentRun, t: Tick): Promise<void> {
    if (run.notBefore > t.now) return;

    // No new runs past a hard budget limit (the wait doesn't count as a start attempt)
    const blocked = this.budgetBlock(run.agent, t.now);
    if (blocked) {
      run.state = "queued";
      run.launchingSince = undefined;
      run.waitingLock = undefined;
      run.detail = `not starting: over budget (${blocked})`;
      this.store.saveRun(run);
      return;
    }

    // A usable profile: the run's own, else the next one (failover at start)
    const profiles = this.profiles(run.agent, run.requestModel);
    if (profiles.length === 0) {
      run.state = "failed";
      run.endedAt = t.now;
      run.detail = `agent ${run.agent} has no adapter to start it with (not in dragons: or dragons.txt, or an unknown adapter)`;
      this.store.saveRun(run);
      t.summary.ended++;
      await this.escalate(run, run.detail, t);
      return;
    }
    const { chosen, skipped } = chooseProfile(profiles, Math.min(run.profileIndex, profiles.length - 1), true, (p) =>
      this.unusable(p, t.now),
    );
    if (!chosen) {
      const ends = profiles
        .map((p) => this.coolingUntil(p.provider, t.now))
        .filter((at): at is number => at !== null);
      run.state = "queued";
      run.launchingSince = undefined;
      run.notBefore = ends.length > 0 ? Math.min(...ends) : t.now + 60_000;
      run.detail = `not starting: no usable profile until ${iso(run.notBefore)} (${skipped.join("; ")})`;
      this.store.saveRun(run);
      await this.raiseExhausted(run, skipped, t);
      return;
    }
    if (chosen.index !== run.profileIndex || chosen.profile.adapter !== run.profile.adapter) {
      await this.record(
        "failover",
        {
          agent: run.agent,
          task: run.task,
          runId: run.id,
          subject: run.profile.provider,
          summary: `${run.agent} on ${run.task}: ${profileLabel(run.profile)} can't be used now; starting with ${profileLabel(chosen.profile)}`,
          evidence: skipped,
          data: { kind: "unavailable", from: run.profile, to: chosen.profile, fromIndex: run.profileIndex, toIndex: chosen.index },
        },
        t.now,
      );
      t.summary.failovers++;
      if (chosen.profile.adapter !== run.profile.adapter && run.sessionMode === "resume") {
        // Another CLI can't resume this session
        run.sessionMode = "new";
        run.sessionId = randomUUID();
      }
    }
    run.profileIndex = chosen.index;
    run.profile = chosen.profile;
    run.launchingSince ??= t.now;

    // The task's claim: the server holds it until the agent process runs
    const claimed = this.store.claim(this.project, run.task, run.id, run.agent, this.probes.self, t.now, (pid, started) =>
      t.snap.isAlive(pid, started),
    );
    if (!claimed.ok) {
      const holder = claimed.holder;
      return this.endRun(
        run,
        "superseded",
        `task ${run.task} is claimed by run ${short(holder.runId)} (agent ${holder.agent}, ${t.snap.describe(holder.ownerPid, holder.ownerStartedAt)})`,
        t,
        false,
      );
    }
    if (claimed.replaced) await this.claimReleased(claimed.replaced, t, "a new claim replaced it");

    // Launch locks (a dead holder's lock is broken here, so a waiter never waits on it)
    const locks = await this.acquireLocks(run, t);
    if (!locks.ok) {
      run.state = "waiting_lock";
      run.waitingLock = locks.wait;
      run.detail = locks.wait.detail;
      if (!(await this.startTimedOut(run, t, locks.wait.detail))) this.store.saveRun(run);
      return;
    }
    run.waitingLock = undefined;

    // Spawn
    let spawned: ProcessOwner;
    let argv: string[];
    try {
      run.promptFile = this.writePrompt(run);
      argv = this.startCommand(run);
      const logPath = join(this.config.agents_dir, `${run.agent}-${utcStamp(t.now)}.log`);
      run.logPath = logPath;
      run.logOffset = fileSize(logPath);
      spawned = await this.probes.spawner.spawn(argv, { cwd: this.config.repo, env: this.env(run), logPath });
    } catch (e) {
      this.releaseHeld(locks.held);
      run.state = "queued";
      run.launchFailures++;
      run.lastError = `spawn error: ${message(e)}`;
      run.detail = `${run.lastError} (attempt ${run.launchFailures}; retried on the next check)`;
      if (!(await this.startTimedOut(run, t, run.lastError))) this.store.saveRun(run);
      return;
    }
    t.snap.addSpawned(spawned);
    run.pid = spawned.pid;
    run.pidStartedAt = spawned.startedAt;
    run.spawnedAt = t.now;
    run.state = "running";
    run.detail = `working (pid ${spawned.pid})`;
    run.lastError = undefined;
    this.store.transferClaim(this.project, run.task, run.id, run.id, spawned);
    this.handOverLocks(locks.held, run, spawned, t);
    this.store.saveRun(run);
    t.summary.started++;
    await this.record(
      "started",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        summary: `started ${run.agent} on ${run.task} as pid ${spawned.pid} (${profileLabel(run.profile)}, ${run.sessionMode} session ${short(run.sessionId)})`,
        evidence: [argv.join(" ")],
        data: {
          argv,
          pid: spawned.pid,
          sessionId: run.sessionId,
          sessionMode: run.sessionMode,
          profile: run.profile,
          logPath: run.logPath ?? null,
        },
      },
      t.now,
    );
  }

  private writePrompt(run: AgentRun): string {
    const dir = getPromptsDir(this.config);
    mkdirSync(dir, { recursive: true });
    const dragon = loadKnownDragons(this.config).get(run.agent);
    const parts = [this.config.default_instructions, dragon?.instructions, run.resumeSummary, run.prompt]
      .map((part) => part?.trim())
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    const file = join(dir, `${run.task.replace(/[^A-Za-z0-9_-]/g, "-")}-${run.agent}-${short(run.id)}.txt`);
    writeFileSync(file, parts.join("\n\n") + "\n", "utf-8");
    return file;
  }

  /** The adapter's start command for this run: the resume flag only when resuming the same session. */
  private startCommand(run: AgentRun): string[] {
    const adapter = getAdapter(run.profile.adapter, this.config);
    if (!adapter) throw new Error(`adapter ${run.profile.adapter} is not defined`);
    const built = buildStartCommand(adapter, {
      agentId: run.agent,
      agentName: run.agent,
      task: run.task,
      promptFile: run.promptFile ?? "",
      model: run.profile.model,
      sessionId: run.sessionMode === "resume" ? run.sessionId : undefined,
      sessionDir: sessionDirFor(this.settings, this.config, run.agent) ?? undefined,
      outputDir: this.config.agents_dir,
      agentProfile: run.agent,
    });
    if (built.warnings.length > 0 || built.command.length === 0) {
      throw new Error(`cannot build the start command of adapter ${adapter.id}: ${built.warnings.join("; ") || "empty"}`);
    }
    return built.command;
  }

  private env(run: AgentRun): Record<string, string> {
    const env: Record<string, string> = {
      LAIR_RUN_ID: run.id,
      LAIR_TASK: run.task,
      LAIR_AGENT: run.agent,
      LAIR_SESSION_ID: run.sessionId,
      LAIR_SESSION_MODE: run.sessionMode,
      TASK: run.task,
    };
    if (run.profile.model) env.MODEL = run.profile.model;
    const adapter = getAdapter(run.profile.adapter, this.config);
    if (adapter?.session_id_env) env[adapter.session_id_env] = run.sessionId;
    return env;
  }

  // ============ LOCKS ============

  private async acquireLocks(run: AgentRun, t: Tick): Promise<LockAttempt> {
    const held: AgentLockSettings[] = [];
    const owner: LockOwnerLabel = { ...this.probes.self, label: `lair run ${short(run.id)} task ${run.task}` };
    const locks = [...this.settings.locks].sort((a, b) => a.name.localeCompare(b.name));
    for (const lock of locks) {
      t.touchedLocks.add(lock.name);
      await this.breakIfStale(lock, t, run);
      if (createLock(lock.path, owner)) {
        held.push(lock);
        continue;
      }
      // Held by a live process (or by no pid, and not old enough to break): wait
      this.releaseHeld(held);
      const info = readLock(lock.path, lock.pidFile);
      const verdict = judgeLock(info, t.snap, lock.staleMinutes);
      const since = run.waitingLock?.lock === lock.name ? run.waitingLock.since : t.now;
      const why =
        verdict.state === "held" || verdict.state === "young"
          ? verdict.detail
          : verdict.state === "stale"
            ? `stale (${verdict.reason}) but could not be broken`
            : "it was taken and released again";
      return {
        ok: false,
        wait: {
          lock: lock.name,
          path: lock.path,
          holderPid: info?.pid ?? null,
          holderStartedAt: info?.startedAt ?? null,
          holderAlive: verdict.state === "held",
          since,
          detail: `waiting on lock ${lock.name} (${lock.path}): ${why}; waiting since ${iso(since)}`,
        },
      };
    }
    return { ok: true, held };
  }

  /**
   * Break a lock whose holder is dead (or a pid-less one past stale_minutes,
   * or one this server left behind: launch locks never outlive a launch).
   */
  private async breakIfStale(lock: AgentLockSettings, t: Tick, run?: AgentRun): Promise<void> {
    const info = readLock(lock.path, lock.pidFile);
    const verdict = judgeLock(info, t.snap, lock.staleMinutes);
    if (verdict.state === "stale") {
      await this.breakLock(lock, verdict.lock, verdict.reason, t, run);
    } else if (
      verdict.state === "held" &&
      verdict.lock.pid === this.probes.self.pid &&
      verdict.lock.startedAt !== null &&
      Math.abs(verdict.lock.startedAt - this.probes.self.startedAt) <= this.toleranceMs
    ) {
      await this.breakLock(lock, verdict.lock, "it was left behind by this server (no launch holds it)", t, run);
    }
  }

  private async breakLock(lock: AgentLockSettings, info: LockFile, reason: string, t: Tick, run?: AgentRun): Promise<void> {
    const result = removeLock(info);
    if (!result.removed) return;
    t.summary.locksBroken++;
    const breaks = this.store.countEvents(this.project, "lock_broken", lock.name) + 1;
    console.warn(`[agents] ${this.project}: broke lock ${lock.name} (${lock.path}): ${reason}`);
    await this.record(
      "lock_broken",
      {
        agent: run?.agent,
        task: run?.task,
        runId: run?.id,
        subject: lock.name,
        summary: `broke lock ${lock.name}: ${reason}`,
        evidence: [
          `lock ${lock.path} (${info.format === "lair" ? "pid and start time" : info.format === "pid" ? "pid only" : "no pid"})`,
          `content: ${oneLine(info.content) || "(empty)"}`,
          run ? `run ${short(run.id)} (${run.agent}, ${run.task}) was waiting on it` : "found by the lock check",
        ],
        data: {
          lock: lock.name,
          path: lock.path,
          pid: info.pid,
          startedAt: info.startedAt === null ? null : iso(info.startedAt),
          format: info.format,
          reason,
          breaks,
        },
      },
      t.now,
    );
  }

  private releaseHeld(held: AgentLockSettings[]): void {
    for (const lock of held) {
      try {
        releaseLock(lock.path, this.probes.self, this.toleranceMs);
      } catch (e) {
        console.warn(`[agents] ${this.project}: could not release lock ${lock.name}: ${message(e)}`);
      }
    }
    held.length = 0;
  }

  /** After a spawn: `run` locks go to the agent process, `launch` locks are released. */
  private handOverLocks(held: AgentLockSettings[], run: AgentRun, agent: ProcessOwner, t: Tick): void {
    for (const lock of held) {
      t.touchedLocks.add(lock.name);
      try {
        if (lock.hold === "run") {
          transferLock(lock.path, this.probes.self, { ...agent, label: `${run.agent} run ${short(run.id)} task ${run.task}` }, this.toleranceMs);
        } else {
          releaseLock(lock.path, this.probes.self, this.toleranceMs);
        }
      } catch (e) {
        console.warn(`[agents] ${this.project}: could not hand over lock ${lock.name}: ${message(e)}`);
      }
    }
  }

  /** Release the `run` locks a run's process holds. */
  private releaseRunLocks(run: AgentRun): void {
    if (run.pid === undefined || run.pidStartedAt === undefined) return;
    for (const lock of this.settings.locks) {
      if (lock.hold !== "run") continue;
      try {
        releaseLock(lock.path, { pid: run.pid, startedAt: run.pidStartedAt }, this.toleranceMs);
      } catch (e) {
        console.warn(`[agents] ${this.project}: could not release lock ${lock.name}: ${message(e)}`);
      }
    }
  }

  // ============ NEVER STARTED ============

  /**
   * Past start_timeout_minutes with no live agent process: the run is
   * never-started (with the reason), and retried with backoff, or escalated
   * after retries.max_retries. True when it timed out (and was saved).
   */
  private async startTimedOut(run: AgentRun, t: Tick, reason: string): Promise<boolean> {
    const since = run.launchingSince ?? t.now;
    if (t.now - since < this.settings.startTimeoutMinutes * 60000) return false;
    run.state = "never_started";
    run.endedAt = t.now;
    run.waitingLock = undefined;
    run.detail = `never started: no live agent process ${Math.round((t.now - since) / 60000)} min after starting began: ${reason}`;
    t.summary.neverStarted++;
    t.summary.ended++;
    const r = this.settings.retries;
    const retry = run.startRetries < r.maxRetries;
    const next = retry
      ? this.followUp(run, t.now, t.now + backoffMs(run.startRetries + 1, r.backoffSeconds, r.maxBackoffSeconds))
      : null;
    await this.record(
      "never_started",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        summary: `${run.agent} never started on ${run.task}: ${reason}`,
        evidence: [reason, ...(run.lastError && run.lastError !== reason ? [run.lastError] : [])],
        data: {
          reason,
          launchingSince: iso(since),
          retry: next ? next.startRetries + 1 : null,
          retryAt: next ? iso(next.notBefore) : null,
          nextRunId: next?.id ?? null,
        },
      },
      t.now,
    );
    if (!next) {
      this.store.saveRun(run);
      await this.escalate(run, `never started in ${run.startRetries + 1} attempt(s): ${reason}`, t);
      return true;
    }
    next.startRetries = run.startRetries + 1;
    next.detail = `retry ${next.startRetries}/${r.maxRetries} at ${iso(next.notBefore)} (never started: ${reason})`;
    this.store.saveRun(run);
    this.store.insertRun(next);
    this.store.transferClaim(this.project, run.task, run.id, next.id, this.probes.self);
    return true;
  }

  /** The next attempt of a run's chain: same task, profile and session unless the caller changes them. */
  private followUp(prev: AgentRun, now: number, notBefore: number): AgentRun {
    return {
      id: randomUUID(),
      project: this.project,
      task: prev.task,
      agent: prev.agent,
      prompt: prev.prompt,
      requestModel: prev.requestModel,
      chainId: prev.chainId,
      previousRunId: prev.id,
      attempt: prev.attempt + 1,
      profileIndex: prev.profileIndex,
      profile: prev.profile,
      sessionId: prev.sessionId,
      sessionMode: prev.sessionMode,
      sameSessionRestarts: prev.sameSessionRestarts,
      freshSessions: prev.freshSessions,
      startRetries: prev.startRetries,
      launchFailures: 0,
      // A summary that never reached a running agent is still owed
      resumeSummary: prev.spawnedAt === undefined ? prev.resumeSummary : undefined,
      state: "queued",
      detail: "queued",
      requestedAt: now,
      notBefore,
      logOffset: 0,
    };
  }

  // ============ SUPERVISION ============

  private async supervise(run: AgentRun, t: Tick): Promise<void> {
    if (run.pid === undefined || !t.snap.isAlive(run.pid, run.pidStartedAt)) return this.onExit(run, t);

    // A run that lost its claim stops itself
    const claim = this.store.getClaim(this.project, run.task);
    if (!claim || claim.runId !== run.id) {
      const why = claim
        ? `task ${run.task} is now claimed by run ${short(claim.runId)} (agent ${claim.agent})`
        : `its claim on task ${run.task} was released`;
      return this.stop(run, "lost_claim", why, [why], t);
    }

    // A rate limit or provider error at the end of a silent log
    const failover = this.failoverWhileAlive(run, t.now);
    if (failover) {
      run.failover = failover;
      return this.stop(run, "failover", `${failoverLabel(failover.kind)}: ${failover.line}`, [`log line: ${failover.line}`], t);
    }

    // Hung: the watchdog's rule (never for an agent WAITING on a gate)
    const proc = t.snap.get(run.pid);
    const hung = proc ? hungFinding(this.view(t), run.agent, proc, this.watchdogSettings.hungMinutes) : null;
    if (hung) return this.stop(run, "hung", hung.summary, hung.evidence, t);

    const detail = `working (pid ${run.pid})`;
    if (run.detail !== detail) {
      run.detail = detail;
      this.store.saveRun(run);
    }
  }

  private failoverWhileAlive(run: AgentRun, now: number): FailoverInfo | null {
    if (!run.logPath) return null;
    let mtime: number;
    try {
      mtime = statSync(run.logPath).mtimeMs;
    } catch {
      return null;
    }
    if (now - mtime < this.settings.failover.silenceSeconds * 1000) return null;
    return matchFailover(lastLines(readTail(run.logPath, 8192), 1), this.settings);
  }

  private async stop(run: AgentRun, reason: StopReason, detail: string, evidence: string[], t: Tick): Promise<void> {
    run.state = "stopping";
    run.stopReason = reason;
    run.stopDetail = detail;
    run.stopEvidence = evidence;
    run.stopRequestedAt = t.now;
    run.killed = false;
    run.detail = `stopping (${reason.replace("_", " ")}): ${detail}`;
    if (run.pid !== undefined) this.probes.spawner.kill(run.pid, "SIGTERM");
    this.store.saveRun(run);
    if (reason === "hung" || reason === "lost_claim") {
      await this.record(
        reason,
        {
          agent: run.agent,
          task: run.task,
          runId: run.id,
          summary: `${run.agent} on ${run.task}: ${detail}; stopping pid ${run.pid}`,
          evidence,
          data: { pid: run.pid ?? null, sessionId: run.sessionId },
        },
        t.now,
      );
    }
  }

  private async finishStop(run: AgentRun, t: Tick): Promise<void> {
    if (run.pid !== undefined && t.snap.isAlive(run.pid, run.pidStartedAt)) {
      const since = run.stopRequestedAt ?? t.now;
      if (!run.killed && t.now - since >= this.settings.stopGraceSeconds * 1000) {
        this.probes.spawner.kill(run.pid, "SIGKILL");
        run.killed = true;
        run.detail = `${run.detail} (SIGKILL after ${this.settings.stopGraceSeconds} s)`;
        this.store.saveRun(run);
      }
      return;
    }
    this.collectExit(run);
    const detail = run.stopDetail ?? "stopped";
    const evidence = run.stopEvidence ?? [];
    switch (run.stopReason) {
      case "lost_claim":
        return this.endRun(run, "lost_claim", `stopped: ${detail}`, t, false);
      case "failover":
        return this.failover(run, run.failover ?? { kind: "provider_error", line: detail }, t);
      case "fresh_session":
        return this.recover(run, "fresh_session", detail, evidence, t);
      default:
        return this.recover(run, "hung", detail, evidence, t);
    }
  }

  /** The process's exit code, if the spawner saw it end. */
  private collectExit(run: AgentRun): number | null | undefined {
    if (run.pid === undefined) return undefined;
    const code = this.probes.spawner.exitCode(run.pid);
    this.probes.spawner.forget(run.pid);
    if (code !== undefined) run.exitCode = code;
    return code;
  }

  /** The agent reported the task DONE in the queue file. */
  private reportedDone(run: AgentRun, t: Tick): boolean {
    const line = this.view(t).latestLineFor(run.agent);
    return line?.type === "DONE" && line.message.match(/^DONE\s+(\S+)/i)?.[1] === run.task;
  }

  /** The process is gone and nobody stopped it. */
  private async onExit(run: AgentRun, t: Tick): Promise<void> {
    const code = this.collectExit(run);
    const claim = this.store.getClaim(this.project, run.task);
    if (!claim || claim.runId !== run.id) {
      // Its claim went first: the task isn't this run's to restart
      return this.endRun(run, "lost_claim", "the process ended after its claim was released", t, false);
    }
    if (code === 0 || (code === undefined && this.reportedDone(run, t))) {
      return this.endRun(run, "completed", code === 0 ? "exited 0" : "the agent reported the task DONE", t, true);
    }
    const tail = run.logPath ? readTail(run.logPath, 64 * 1024) : "";
    const failover = matchFailover(lastLines(tail, 20), this.settings);
    if (failover) return this.failover(run, failover, t);

    const exit = code === undefined ? "exit status unknown" : code === null ? "ended by a signal" : `exit code ${code}`;
    const lived = t.now - (run.spawnedAt ?? t.now);
    const empty = run.logPath ? fileSize(run.logPath) === 0 : true;
    const evidence = [`pid ${run.pid} ${exit}`, ...lastLines(tail, 10).map((line) => `log: ${oneLine(line)}`)];
    if (empty || lived < this.settings.deadOnStartSeconds * 1000) {
      const why = empty
        ? `died with an empty log ${seconds(lived)} after it started (${exit})`
        : `died ${seconds(lived)} after it started (${exit})`;
      return this.recover(run, "dead_on_start", why, evidence, t);
    }
    return this.recover(run, "crashed", `the process ended after ${seconds(lived)} (${exit})`, evidence, t);
  }

  private async endRun(
    run: AgentRun,
    state: "completed" | "lost_claim" | "superseded",
    detail: string,
    t: Tick,
    releaseClaim: boolean,
  ): Promise<void> {
    run.state = state;
    run.detail = detail;
    run.endedAt = t.now;
    run.waitingLock = undefined;
    this.releaseRunLocks(run);
    if (releaseClaim) this.store.releaseClaim(this.project, run.task, run.id);
    this.store.saveRun(run);
    t.summary.ended++;
    if (state === "completed") {
      await this.record(
        "completed",
        { agent: run.agent, task: run.task, runId: run.id, summary: `${run.agent} finished ${run.task}: ${detail}` },
        t.now,
      );
    }
  }

  // ============ RECOVERY ============

  /**
   * A failed attempt: restart with the same session up to
   * recovery.same_session_restarts times, then in a fresh session (the old
   * session directory moved aside, a resume summary in the prompt) up to
   * recovery.fresh_sessions times, then escalate.
   */
  private async recover(
    run: AgentRun,
    kind: "hung" | "crashed" | "dead_on_start" | "fresh_session",
    detail: string,
    evidence: string[],
    t: Tick,
  ): Promise<void> {
    run.state = "failed";
    run.endedAt = t.now;
    run.detail = `${kind.replace(/_/g, " ")}: ${detail}`;
    this.releaseRunLocks(run);
    // The server keeps the task between attempts
    this.store.transferClaim(this.project, run.task, run.id, run.id, this.probes.self);
    t.summary.ended++;
    if (kind === "crashed" || kind === "dead_on_start") {
      await this.record(
        kind,
        {
          agent: run.agent,
          task: run.task,
          runId: run.id,
          summary: `${run.agent} on ${run.task} ${detail}`,
          evidence,
          data: { pid: run.pid ?? null, exitCode: run.exitCode ?? null, sessionId: run.sessionId },
        },
        t.now,
      );
    }

    const r = this.settings.recovery;
    const mode =
      kind === "fresh_session"
        ? "fresh"
        : run.sameSessionRestarts < r.sameSessionRestarts
          ? "resume"
          : run.freshSessions < r.freshSessions
            ? "fresh"
            : null;
    if (mode === null) {
      this.store.saveRun(run);
      await this.escalate(run, `${kind.replace(/_/g, " ")}: ${detail}`, t);
      return;
    }

    const attempt = run.sameSessionRestarts + run.freshSessions + 1;
    const next = this.followUp(run, t.now, t.now + backoffMs(attempt, r.backoffSeconds, r.maxBackoffSeconds));
    next.startRetries = 0;
    if (mode === "resume") {
      next.sessionMode = "resume";
      next.sameSessionRestarts = run.sameSessionRestarts + 1;
      next.detail = `restart with the same session (${next.sameSessionRestarts}/${r.sameSessionRestarts}) at ${iso(next.notBefore)}`;
      await this.record(
        "restart_same_session",
        {
          agent: run.agent,
          task: run.task,
          runId: next.id,
          summary: `restarting ${run.agent} on ${run.task} with session ${short(run.sessionId)} (${next.sameSessionRestarts}/${r.sameSessionRestarts}) after: ${kind.replace(/_/g, " ")}`,
          evidence: [detail, ...evidence],
          data: { previousRunId: run.id, sessionId: run.sessionId, after: kind, at: iso(next.notBefore) },
        },
        t.now,
      );
    } else {
      const dir = sessionDirFor(this.settings, this.config, run.agent);
      let moved: string;
      try {
        const aside = dir ? moveSessionAside(dir, t.now) : null;
        moved = aside
          ? `moved session directory ${dir} to ${aside}`
          : dir
            ? `no session directory at ${dir}`
            : "agents.session_dir is not set: no session directory to move aside";
      } catch (e) {
        moved = `could not move ${dir} aside: ${message(e)}`;
      }
      next.sessionMode = "fresh";
      next.sessionId = randomUUID();
      next.freshSessions = run.freshSessions + 1;
      next.resumeSummary = await this.summary(run, t, `${kind.replace(/_/g, " ")}: ${detail}`);
      next.detail = `start a fresh session (${next.freshSessions}/${Math.max(r.freshSessions, next.freshSessions)}) at ${iso(next.notBefore)}`;
      await this.record(
        "fresh_session",
        {
          agent: run.agent,
          task: run.task,
          runId: next.id,
          summary: `${run.agent} on ${run.task}: starting a fresh session after: ${kind.replace(/_/g, " ")}`,
          evidence: [moved, detail, ...evidence],
          data: {
            previousRunId: run.id,
            oldSessionId: run.sessionId,
            newSessionId: next.sessionId,
            after: kind,
            moved,
            at: iso(next.notBefore),
          },
        },
        t.now,
      );
    }
    this.store.saveRun(run);
    this.store.insertRun(next);
    this.store.transferClaim(this.project, run.task, run.id, next.id, this.probes.self);
    t.summary.recovered++;
  }

  /** The resume summary for the attempt after `run`. */
  private async summary(run: AgentRun, t: Tick, why: string): Promise<string> {
    let branchState: string | undefined;
    if (this.settings.branchStateCmd) {
      const vars: Record<string, string> = { task: run.task, agent: run.agent, repo: this.config.repo };
      const argv = this.settings.branchStateCmd.map((arg) =>
        arg.replace(/\{(task|agent|repo)\}/g, (match, name: string) => vars[name] ?? match),
      );
      const out = await this.probes.runner.run(argv, { timeoutMs: this.settings.commandTimeoutSeconds * 1000 });
      branchState = out.code === 0 ? out.stdout : `(${argv[0]} exited ${out.code}: ${out.stderr.trim().slice(0, 200)})`;
    }
    const chain = this.store.chainRuns(run.chainId).map((r) => (r.id === run.id ? run : r));
    return resumeSummary({ run, chain, config: this.config, view: this.view(t), branchState, why });
  }

  private async escalate(run: AgentRun, why: string, t: Tick): Promise<void> {
    this.store.releaseClaim(this.project, run.task, run.id);
    const chain = this.store.chainRuns(run.chainId).map((r) => (r.id === run.id ? run : r));
    const attempts = chain.map(
      (r) => `attempt ${r.attempt} (${r.sessionMode} session, ${profileLabel(r.profile)}): ${r.state}: ${oneLine(r.detail)}`,
    );
    await this.record(
      "escalated",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        summary: `${run.agent} could not finish ${run.task}: ${why}; asking the owner`,
        evidence: attempts,
        data: { chainId: run.chainId, attempts: chain.length },
      },
      t.now,
    );
    const output = run.logPath ? lastLines(readTail(run.logPath, 8192), 10) : [];
    await this.raise(
      {
        kind: "escalation",
        key: `escalation:${run.chainId}`,
        question: `Agent ${run.agent} could not finish task ${run.task} after ${chain.length} attempt(s): ${oneLine(why, 200)}`,
        context: [
          "Attempts:",
          ...attempts.map((a) => `- ${a}`),
          ...(output.length > 0 ? ["", "Last output:", ...output.map((line) => `- ${oneLine(line)}`)] : []),
        ].join("\n"),
        options: [
          { id: "fresh_session", label: "Start it again in a fresh session (Agents view)" },
          { id: "release", label: "Leave the task unclaimed for another agent" },
        ],
        recommended: "release",
        why: "Every automatic recovery was used; starting again the same way would repeat the loop.",
        reversible: true,
      },
      t,
      run,
    );
  }

  // ============ FAILOVER ============

  /** A rate limit or provider error: the next profile carries the task on, with a resume summary. */
  private async failover(run: AgentRun, info: FailoverInfo, t: Tick): Promise<void> {
    run.state = "failed";
    run.endedAt = t.now;
    run.failover = info;
    run.detail = `${failoverLabel(info.kind)} on ${profileLabel(run.profile)}: ${oneLine(info.line)}`;
    this.releaseRunLocks(run);
    this.store.transferClaim(this.project, run.task, run.id, run.id, this.probes.self);
    t.summary.ended++;

    const cooldown = this.settings.failover.cooldownMinutes * 60000;
    const profiles = this.profiles(run.agent, run.requestModel);
    const { chosen, skipped } = chooseProfile(profiles, run.profileIndex + 1, true, (p) =>
      p.provider === run.profile.provider ? `provider ${p.provider} just failed` : this.unusable(p, t.now),
    );
    const next = this.followUp(run, t.now, t.now);
    next.sessionMode = "new";
    next.sessionId = randomUUID();
    next.sameSessionRestarts = 0;
    next.freshSessions = 0;
    next.startRetries = 0;
    next.resumeSummary = await this.summary(run, t, `${failoverLabel(info.kind)}: ${info.line}`);
    if (chosen) {
      next.profileIndex = chosen.index;
      next.profile = chosen.profile;
      next.detail = `failing over to ${profileLabel(chosen.profile)}`;
    } else {
      const ends = [t.now + cooldown, ...profiles.map((p) => this.coolingUntil(p.provider, t.now) ?? t.now)];
      next.profileIndex = 0;
      next.profile = profiles[0] ?? run.profile;
      next.notBefore = cooldown > 0 ? Math.min(...ends.filter((at) => at > t.now), t.now + cooldown) : t.now;
      next.detail = `every profile failed or is cooling down; trying again at ${iso(next.notBefore)}`;
    }
    await this.record(
      "failover",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        subject: run.profile.provider,
        summary: chosen
          ? `${run.agent} on ${run.task}: ${failoverLabel(info.kind)} on ${profileLabel(run.profile)}; switched to ${profileLabel(chosen.profile)}`
          : `${run.agent} on ${run.task}: ${failoverLabel(info.kind)} on ${profileLabel(run.profile)}; no fallback left`,
        evidence: [`log line: ${oneLine(info.line)}`, ...skipped],
        data: {
          kind: info.kind,
          line: info.line,
          from: run.profile,
          to: chosen?.profile ?? null,
          fromIndex: run.profileIndex,
          toIndex: chosen?.index ?? null,
          nextRunId: next.id,
          coolingUntil: cooldown > 0 ? iso(t.now + cooldown) : null,
        },
      },
      t.now,
    );
    t.summary.failovers++;
    this.store.saveRun(run);
    this.store.insertRun(next);
    this.store.transferClaim(this.project, run.task, run.id, next.id, this.probes.self);
    if (!chosen) await this.raiseExhausted(next, skipped, t);
  }

  /** Every profile is unusable: the only time the owner hears about failover. */
  private async raiseExhausted(run: AgentRun, skipped: string[], t: Tick): Promise<void> {
    await this.raise(
      {
        kind: "escalation",
        key: `exhausted:${run.chainId}`,
        question: `Every configured agent profile for ${run.agent} is failing or rate limited; task ${run.task} waits until ${iso(run.notBefore)}`,
        context: ["Profiles:", ...skipped.map((s) => `- ${s}`)].join("\n"),
        options: [
          { id: "wait", label: "Wait: Lair retries when a provider's cooldown ends" },
          { id: "add_fallback", label: "Add a fallback profile in agents.fallbacks" },
        ],
        recommended: "wait",
        why: "Rate limits and provider errors usually clear on their own.",
        reversible: true,
      },
      t,
      run,
    );
  }

  // ============ USAGE AND BUDGETS ============

  /** Usage lines (agents.usage_patterns) written to the run's log since the last read. */
  private readUsage(run: AgentRun): void {
    if (!run.logPath || this.settings.usagePatterns.length === 0) return;
    const bytes = readFrom(run.logPath, run.logOffset, 1024 * 1024);
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) return;
    const text = bytes.subarray(0, end + 1).toString("utf-8");
    let tokens = 0;
    let cost = 0;
    let found = false;
    for (const pattern of this.settings.usagePatterns) {
      for (const match of text.matchAll(pattern)) {
        const groups: Record<string, string | undefined> = match.groups ?? {};
        const tk = groups.tokens ? Number(groups.tokens.replace(/[,_]/g, "")) : Number.NaN;
        const cs = groups.cost ? Number(groups.cost.replace(/[,_]/g, "")) : Number.NaN;
        if (Number.isFinite(tk)) {
          tokens += tk;
          found = true;
        }
        if (Number.isFinite(cs)) {
          cost += cs;
          found = true;
        }
      }
    }
    run.logOffset += end + 1;
    this.store.saveRun(run);
    if (!found) return;
    const reason = `usage in ${basename(run.logPath)}`;
    const attribution = { project: this.project, agent: run.agent, runId: run.id, tokens };
    if (this.budget) {
      this.budget.recordCost(run.profile.provider, cost, reason, attribution);
    } else {
      this.store.addUsage({
        project: this.project,
        agent: run.agent,
        provider: run.profile.provider,
        runId: run.id,
        tokens,
        cost,
        at: this.probes.clock.now(),
        reason,
      });
    }
  }

  private scopes(now: number): BudgetScopeView[] {
    const scopes: BudgetScopeView[] = [];
    const project = evaluateBudget(this.store, this.project, null, this.settings.budgets.project, now);
    if (project) scopes.push(project);
    for (const agent of this.agentIds()) {
      const scope = evaluateBudget(this.store, this.project, agent, agentLimits(this.settings, agent), now);
      if (scope) scopes.push(scope);
    }
    return scopes;
  }

  /** Soft limits warn once per period; hard limits stop new runs and raise a `spend` decision once. */
  private async checkBudgets(t: Tick): Promise<void> {
    for (const scope of this.scopes(t.now)) {
      const scopeKey = scope.scope === "project" ? "project" : `agent:${scope.agent}`;
      for (const line of scope.lines) {
        if (line.level === "ok") continue;
        const key = `${scopeKey}:${line.metric}:${line.period}`;
        if (line.soft !== undefined && line.used >= line.soft) {
          const warned = await this.record(
            "budget_warning",
            {
              agent: scope.agent,
              subject: scopeKey,
              summary: `budget warning: ${describeUsage(scope, line, "soft")}`,
              evidence: [describeUsage(scope, line, "soft")],
              data: { scope: scopeKey, ...line },
              dedupeKey: `budget_warning:${key}`,
            },
            t.now,
          );
          if (warned) t.summary.warnings++;
        }
        if (line.level !== "hard") continue;
        const text = describeUsage(scope, line, "hard");
        const until = iso(periodEnd(line.metric, t.now));
        await this.record(
          "budget_exceeded",
          {
            agent: scope.agent,
            subject: scopeKey,
            summary: `over budget: ${text}; no new runs ${scope.scope === "project" ? "in the project" : `for ${scope.agent}`} until ${until}`,
            evidence: [text],
            data: { scope: scopeKey, ...line, until },
            dedupeKey: `budget_exceeded:${key}`,
          },
          t.now,
        );
        await this.raise(
          {
            kind: "spend",
            key: `budget:${key}`,
            question: `${text.charAt(0).toUpperCase()}${text.slice(1)}. No new runs ${scope.scope === "project" ? "in this project" : `for ${scope.agent}`} until ${until}. Raise the limit?`,
            context: [
              `Scope: ${scopeKey}`,
              `Metric: ${line.metric} for ${line.period}`,
              `Used: ${line.used} (soft ${line.soft ?? "none"}, hard ${line.hard ?? "none"})`,
              "Runs already working continue; new runs and restarts wait.",
            ].join("\n"),
            options: [
              { id: "raise", label: "Raise the limit (agents.budgets in the project config)" },
              { id: "wait", label: `Wait until ${until}` },
            ],
            recommended: "wait",
            why: "A hard budget limit is the owner's call to change.",
            reversible: true,
            onTimeout: "wait",
          },
          t,
        );
      }
    }
  }

  // ============ REAPERS ============

  private async claimReleased(claim: Claim, t: Tick, why: string): Promise<void> {
    t.summary.claimsReleased++;
    await this.record(
      "claim_released",
      {
        agent: claim.agent,
        task: claim.task,
        runId: claim.runId,
        subject: claim.task,
        summary: `released the claim on ${claim.task} (run ${short(claim.runId)}): its owner ${t.snap.describe(claim.ownerPid, claim.ownerStartedAt)}; ${why}`,
        evidence: [
          `owner pid ${claim.ownerPid}, started ${iso(claim.ownerStartedAt)}`,
          t.snap.describe(claim.ownerPid, claim.ownerStartedAt),
        ],
        data: { ownerPid: claim.ownerPid, ownerStartedAt: iso(claim.ownerStartedAt), why },
      },
      t.now,
    );
  }

  /** Claims whose owner is dead, or whose run has ended, and that no active run handled this tick. */
  private async reapClaims(t: Tick): Promise<void> {
    for (const claim of this.store.listClaims(this.project)) {
      if (t.touchedTasks.has(claim.task)) continue;
      const run = this.store.getRun(claim.runId);
      const alive = t.snap.isAlive(claim.ownerPid, claim.ownerStartedAt);
      if (alive && run && isActive(run.state)) continue;
      const why = !alive
        ? "no live process owns it"
        : !run
          ? `its run ${short(claim.runId)} does not exist`
          : `its run ${short(run.id)} has ended (${run.state})`;
      if (this.store.releaseClaim(this.project, claim.task, claim.runId)) await this.claimReleased(claim, t, why);
    }
  }

  /** Locks no launch handled this tick whose holder is dead. */
  private async reapLocks(t: Tick): Promise<void> {
    for (const lock of this.settings.locks) {
      if (t.touchedLocks.has(lock.name)) continue;
      await this.breakIfStale(lock, t);
    }
  }

  // ============ ACTIONS ============

  /** Request a run: the task is claimed now, and the run starts on the next tick. */
  requestRun(input: RunRequest): Promise<AgentRunView> {
    return this.exclusive(async () => {
      if (this.readOnly) throw new AgentsError(403, "The project is read_only: Lair starts no agents");
      const { agent, task, prompt, model } = input;
      if (typeof agent !== "string" || !isValidDragonId(agent) || !knownDragonIds(this.config).has(agent)) {
        throw new AgentsError(400, `Unknown agent: ${String(agent)}`);
      }
      if (typeof task !== "string" || !TASK_ID.test(task)) {
        throw new AgentsError(
          400,
          "Invalid task: 1-128 characters (letters, digits, '.', '_', '-', '/', ':', '#'), starting with a letter or digit",
        );
      }
      if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
        throw new AgentsError(400, `Invalid prompt: a non-empty string of at most ${MAX_PROMPT_CHARS} characters`);
      }
      if (model !== undefined && (typeof model !== "string" || !MODEL_ID.test(model))) {
        throw new AgentsError(400, "Invalid model id");
      }
      const busy = this.store.activeRunForAgent(this.project, agent);
      if (busy) {
        throw new AgentsError(409, `Agent ${agent} is busy: run ${short(busy.id)} on task ${busy.task} is ${busy.state}`);
      }
      const now = this.probes.clock.now();
      const blocked = this.budgetBlock(agent, now);
      if (blocked) throw new AgentsError(403, `Over budget: ${blocked}`);
      const profiles = this.profiles(agent, model);
      if (profiles.length === 0) throw new AgentsError(400, `Agent ${agent} has no adapter to start it with`);

      const t = await this.newTick(now);
      const id = randomUUID();
      const run: AgentRun = {
        id,
        project: this.project,
        task,
        agent,
        prompt,
        requestModel: model,
        chainId: id,
        attempt: 1,
        profileIndex: 0,
        profile: profiles[0],
        sessionId: randomUUID(),
        sessionMode: "new",
        sameSessionRestarts: 0,
        freshSessions: 0,
        startRetries: 0,
        launchFailures: 0,
        state: "queued",
        detail: "queued: starts on the next check",
        requestedAt: now,
        notBefore: now,
        logOffset: 0,
      };
      const claimed = this.store.claim(this.project, task, id, agent, this.probes.self, now, (pid, started) =>
        t.snap.isAlive(pid, started),
      );
      if (!claimed.ok) {
        const holder = claimed.holder;
        throw new AgentsError(
          409,
          `Task ${task} is already claimed by run ${short(holder.runId)} (agent ${holder.agent}, ${t.snap.describe(holder.ownerPid, holder.ownerStartedAt)})`,
        );
      }
      this.store.insertRun(run);
      if (claimed.replaced) await this.claimReleased(claimed.replaced, t, "a new run claimed the task");
      await this.record(
        "requested",
        {
          agent,
          task,
          runId: id,
          summary: `requested ${agent} on ${task} (${profileLabel(profiles[0])})`,
          data: { profile: profiles[0] },
        },
        now,
      );
      return runView(run);
    });
  }

  /**
   * Release a task's claim. A running run notices on the next tick and stops
   * itself; a run that hasn't started yet ends now.
   */
  releaseClaim(task: string): Promise<{ task: string; runId: string; runState: string | null }> {
    return this.exclusive(async () => {
      if (this.readOnly) throw new AgentsError(403, "The project is read_only");
      const claim = this.store.getClaim(this.project, task);
      if (!claim) throw new AgentsError(404, `Task ${task} has no claim`);
      const now = this.probes.clock.now();
      this.store.releaseClaim(this.project, task, claim.runId);
      await this.record(
        "claim_released",
        {
          agent: claim.agent,
          task,
          runId: claim.runId,
          subject: task,
          summary: `released the claim on ${task} (run ${short(claim.runId)}) on request`,
          evidence: ["released through the API (Agents view)"],
          data: { by: "request", ownerPid: claim.ownerPid },
        },
        now,
      );
      const run = this.store.getRun(claim.runId);
      if (run && (run.state === "queued" || run.state === "waiting_lock")) {
        run.state = "lost_claim";
        run.detail = "its claim was released on request before it started";
        run.endedAt = now;
        run.waitingLock = undefined;
        this.store.saveRun(run);
      }
      return { task, runId: claim.runId, runState: run?.state ?? null };
    });
  }

  /**
   * Start a run's task again in a fresh session: a running run is stopped
   * first (the next tick restarts it fresh); a run that hasn't started yet
   * switches to a fresh session; an ended chain's last run is followed by a
   * fresh-session run.
   */
  freshSession(runId: string): Promise<AgentRunView> {
    return this.exclusive(async () => {
      if (this.readOnly) throw new AgentsError(403, "The project is read_only");
      const run = this.store.getRun(runId);
      if (!run || run.project !== this.project) throw new AgentsError(404, `Unknown run: ${runId}`);
      const now = this.probes.clock.now();
      const t = await this.newTick(now);
      if (run.state === "running") {
        await this.stop(run, "fresh_session", "a fresh session was requested", ["requested through the API (Agents view)"], t);
        return runView(run);
      }
      if (run.state === "stopping") throw new AgentsError(409, `Run ${short(run.id)} is already stopping`);
      if (run.state === "queued" || run.state === "waiting_lock") {
        await this.switchToFresh(run, run, t, "a fresh session was requested");
        this.store.saveRun(run);
        return runView(run);
      }
      const chain = this.store.chainRuns(run.chainId);
      const latest = chain[chain.length - 1];
      if (latest && latest.id !== run.id) {
        throw new AgentsError(409, `Run ${short(run.id)} is not the latest of its task; use run ${short(latest.id)}`);
      }
      if (run.state === "completed") throw new AgentsError(409, `Run ${short(run.id)} completed its task`);
      const busy = this.store.activeRunForAgent(this.project, run.agent);
      if (busy) throw new AgentsError(409, `Agent ${run.agent} is busy with task ${busy.task}`);
      const blocked = this.budgetBlock(run.agent, now);
      if (blocked) throw new AgentsError(403, `Over budget: ${blocked}`);
      const next = this.followUp(run, now, now);
      next.startRetries = 0;
      const claimed = this.store.claim(this.project, run.task, next.id, run.agent, this.probes.self, now, (pid, started) =>
        t.snap.isAlive(pid, started),
      );
      if (!claimed.ok) throw new AgentsError(409, `Task ${run.task} is claimed by run ${short(claimed.holder.runId)}`);
      await this.switchToFresh(next, run, t, "a fresh session was requested");
      this.store.insertRun(next);
      return runView(next);
    });
  }

  /** Make `next` a fresh session: move the session aside, a new session id, a resume summary. */
  private async switchToFresh(next: AgentRun, previous: AgentRun, t: Tick, why: string): Promise<void> {
    const dir = sessionDirFor(this.settings, this.config, next.agent);
    let moved: string;
    try {
      const aside = dir ? moveSessionAside(dir, t.now) : null;
      moved = aside ? `moved session directory ${dir} to ${aside}` : dir ? `no session directory at ${dir}` : "agents.session_dir is not set";
    } catch (e) {
      moved = `could not move ${dir} aside: ${message(e)}`;
    }
    const oldSession = next.sessionId;
    next.sessionMode = "fresh";
    next.sessionId = randomUUID();
    next.freshSessions = previous.freshSessions + 1;
    next.resumeSummary = await this.summary(previous, t, why);
    next.detail = `queued: a fresh session (${why})`;
    await this.record(
      "fresh_session",
      {
        agent: next.agent,
        task: next.task,
        runId: next.id,
        summary: `${next.agent} on ${next.task}: a fresh session (${why})`,
        evidence: [moved],
        data: { previousRunId: previous.id, oldSessionId: oldSession, newSessionId: next.sessionId, moved, by: "request" },
      },
      t.now,
    );
  }

  // ============ STATUS ============

  /** Agent ids: the project's dragons plus any with runs. */
  agentIds(): string[] {
    return [...new Set([...knownDragonIds(this.config), ...this.store.runAgents(this.project)])].sort();
  }

  runs(limit = 100): AgentRunView[] {
    return this.store.listRuns(this.project, { limit }).map(runView);
  }

  recoveries(limit = 100): AgentEventView[] {
    return this.store.listEvents(this.project, { kinds: RECOVERY_KINDS, limit }).map(eventView);
  }

  status(errors: string[] = []): AgentsStatusView {
    const now = this.probes.clock.now();
    const snap = this.snapshot;
    const alive = (pid: number, started: number): boolean | null => (snap ? snap.isAlive(pid, started) : null);
    const claims = this.store.listClaims(this.project);
    const projectBudget = evaluateBudget(this.store, this.project, null, this.settings.budgets.project, now);
    const agents = this.agentIds().map((id) => this.agentView(id, claims, projectBudget, now, alive));
    return {
      project: this.project,
      enabled: true,
      running: this.running,
      readOnly: this.readOnly,
      errors,
      intervalSeconds: this.settings.intervalSeconds,
      lastTick: this.lastTick ?? null,
      lastError: this.lastError ?? null,
      agents,
      claims: claims.map((c) => claimView(c, alive(c.ownerPid, c.ownerStartedAt))),
      locks: this.lockViews(snap),
      projectBudget,
    };
  }

  private agentView(
    id: string,
    claims: Claim[],
    projectBudget: BudgetScopeView | null,
    now: number,
    alive: (pid: number, started: number) => boolean | null,
  ): AgentView {
    const active = this.store.activeRunForAgent(this.project, id);
    const latest = active ?? this.store.latestRunForAgent(this.project, id);
    const budget = evaluateBudget(this.store, this.project, id, agentLimits(this.settings, id), now);
    const over = [projectBudget, budget].find((scope) => scope?.blocked);
    const overLine = over?.lines.find((line) => line.level === "hard");
    const overBudget = over && overLine ? describeUsage(over, overLine, "hard") : null;
    const previous = active?.previousRunId ? this.store.getRun(active.previousRunId) : null;
    const { state, detail } = deriveState(active, latest, previous, overBudget);
    return {
      id,
      state,
      detail,
      run: latest ? runView(latest) : undefined,
      profiles: this.profiles(id),
      claims: claims.filter((c) => c.agent === id).map((c) => claimView(c, alive(c.ownerPid, c.ownerStartedAt))),
      recoveries: this.store.listEvents(this.project, { kinds: RECOVERY_KINDS, agent: id, limit: 10 }).map(eventView),
      budget,
    };
  }

  private lockViews(snap: ProcessSnapshot | null): LockView[] {
    return this.settings.locks.map((lock) => {
      const info = readLock(lock.path, lock.pidFile);
      const verdict = snap && info ? judgeLock(info, snap, lock.staleMinutes) : null;
      const detail = !info
        ? "free"
        : !verdict
          ? "not checked yet"
          : verdict.state === "held" || verdict.state === "young"
            ? verdict.detail
            : verdict.state === "stale"
              ? `stale: ${verdict.reason}`
              : "free";
      return {
        name: lock.name,
        path: lock.path,
        hold: lock.hold,
        exists: info !== null,
        format: info?.format ?? null,
        holderPid: info?.pid ?? null,
        holderStartedAt: info && info.startedAt !== null ? iso(info.startedAt) : null,
        holderAlive: verdict ? verdict.state === "held" : null,
        breaks: this.store.countEvents(this.project, "lock_broken", lock.name),
        detail,
      };
    });
  }

  // ============ LIFECYCLE ============

  /** Tick soon, then every interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.lastError = message(e);
        console.error(`[agents] ${this.project}: tick failed:`, e);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, this.settings.intervalSeconds * 1000);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, Math.min(1000, this.settings.intervalSeconds * 1000));
    this.timer.unref();
  }

  /** Stop ticking; resolves once the tick or action in progress has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.queue;
  }

  /** Drop the fleet budget subscription and the watchdog view's scratch store. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watchdogStore?.close();
    this.watchdogStore = null;
  }
}

function deriveState(
  active: AgentRun | null,
  latest: AgentRun | null,
  previous: AgentRun | null,
  overBudget: string | null,
): { state: AgentState; detail: string } {
  if (active) {
    switch (active.state) {
      case "running":
        return active.profileIndex > 0
          ? { state: "failed_over", detail: `working on fallback ${profileLabel(active.profile)} (pid ${active.pid})` }
          : { state: "working", detail: active.detail };
      case "waiting_lock":
        return { state: "waiting_on_lock", detail: active.detail };
      case "stopping":
        return { state: active.stopReason === "hung" ? "hung" : "stopping", detail: active.detail };
      default:
        if (overBudget) return { state: "over_budget", detail: active.detail };
        if (previous?.state === "never_started") return { state: "never_started", detail: active.detail };
        if (previous?.failover || active.profileIndex > 0) return { state: "failed_over", detail: active.detail };
        if (previous?.stopReason === "hung") return { state: "hung", detail: active.detail };
        return { state: "starting", detail: active.detail };
    }
  }
  if (overBudget) return { state: "over_budget", detail: `no new runs: ${overBudget}` };
  if (!latest) return { state: "idle", detail: "no runs yet" };
  switch (latest.state) {
    case "failed":
      return { state: "failed", detail: latest.detail };
    case "never_started":
      return { state: "never_started", detail: latest.detail };
    default:
      return { state: "idle", detail: `last run ${latest.state}: ${latest.detail}` };
  }
}

export interface AgentsManagerOptions {
  dbPath: string;
  probes?: AgentProbes;
  events?: EventBus;
  budget?: FleetBudget;
  decisions?: DecisionInbox;
}

/**
 * All projects' agents services. The store (data/agents.db) is opened only
 * when at least one project enables the module.
 */
export class AgentsManager {
  private services = new Map<string, AgentsService>();
  private problems = new Map<string, string[]>();
  private configs = new Map<string, ProjectConfig>();
  private store: AgentsStore | null = null;
  private probes: AgentProbes | null = null;
  private decisions: DecisionInbox | null;
  private fallbackInbox: DecisionInbox | null = null;

  constructor(private options: AgentsManagerOptions) {
    this.decisions = options.decisions ?? null;
  }

  /** The decisions module registers its Decision Inbox here; until then decisions go to inbox files. */
  setDecisionInbox(inbox: DecisionInbox): void {
    this.decisions = inbox;
  }

  private getProbes(): AgentProbes {
    this.probes ??= this.options.probes ?? systemAgentProbes();
    return this.probes;
  }

  private inbox(): DecisionInbox {
    if (this.decisions) return this.decisions;
    const probes = this.getProbes();
    this.fallbackInbox ??= new InboxFileDecisions((project) => this.configs.get(project)?.inbox_file, probes.fs, probes.clock);
    return this.fallbackInbox;
  }

  load(projects: ProjectEntry[]): void {
    for (const entry of projects) {
      if (!entry.config) {
        if (entry.error) this.problems.set(entry.name, [entry.error]);
        continue;
      }
      this.configs.set(entry.name, entry.config);
      const parsed = parseAgentsConfig(entry.config.agents, entry.config);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[agents] ${entry.name}: not started: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (!parsed.settings.enabled) continue;
      this.store ??= new AgentsStore(this.options.dbPath);
      this.services.set(
        entry.name,
        new AgentsService({
          project: entry.name,
          config: entry.config,
          settings: parsed.settings,
          store: this.store,
          probes: this.getProbes(),
          decisions: () => this.inbox(),
          budget: this.options.budget,
          events: this.options.events,
        }),
      );
    }
  }

  start(): string[] {
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  /** Stop every service, wait for work in progress, then close the store. */
  async stop(): Promise<void> {
    await Promise.all([...this.services.values()].map((service) => service.stop()));
    for (const service of this.services.values()) service.dispose();
    this.services.clear();
    this.store?.close();
    this.store = null;
  }

  get(project: string): AgentsService | undefined {
    return this.services.get(project);
  }

  getStore(): AgentsStore | null {
    return this.store;
  }

  status(project: string): AgentsStatusView {
    const service = this.services.get(project);
    const errors = this.problems.get(project) ?? [];
    if (service) return service.status(errors);
    return {
      project,
      enabled: false,
      running: false,
      readOnly: this.configs.get(project)?.read_only === true,
      errors,
      intervalSeconds: null,
      lastTick: null,
      lastError: null,
      agents: [],
      claims: [],
      locks: [],
      projectBudget: null,
    };
  }
}
