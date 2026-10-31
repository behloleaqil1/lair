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
 *   (exit 0), died on start, or crashed. One whose exit status was lost (it
 *   ended while Lair was restarting) completed when its agent's queue line
 *   for the task says DONE, WAITING or BLOCKED, and is a failed attempt
 *   otherwise.
 * - stopping: SIGTERM, then SIGKILL after stop_grace_seconds.
 * Failures restart with the same session up to recovery.same_session_restarts
 * times, then in a fresh session (the old one moved aside) with a resume
 * summary, then escalate to the Decision Inbox. A run that died of a
 * transient network or provider error (agents.transient_patterns) is none of
 * these: its provider is marked unreachable, starts on it wait (one tries it
 * per backoff step, 60 s doubling to 15 min) until one works, nothing is
 * counted, and only an outage past agents.transient_max_minutes raises one
 * decision for the project. Finally claims and locks whose owner is dead are
 * released and broken. Every step is recorded as an event.
 *
 * With agents.fill on, a second loop (fill.ts) requests runs itself from a
 * task list, through requestRun like any other in-process caller.
 */
import { randomUUID } from "crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { EventType } from "../../shared/server-types.js";
import type { ManagedRunInfo, ProjectConfig } from "../../shared/types.js";
import type {
  AgentEventKind,
  AgentEventView,
  AgentProfile,
  AgentRunView,
  AgentState,
  AgentsStatusView,
  AgentsTickSummary,
  AgentView,
  BudgetLine,
  BudgetScopeView,
  FillLineView,
  FillStatusView,
  LockView,
  ProviderUnreachableView,
  RunOrigin,
  StopReason,
} from "../../shared/agents-types.js";
import type { Decision } from "../../shared/decision-types.js";
import type { DecisionProducer, DecisionResolution } from "../decisions/types.js";
import type { SignInRefusal, ToolReadiness } from "../ai/types.js";
import { buildStartCommand, getAdapter } from "../services/adapters.js";
import { knownDragonIds, loadKnownDragons } from "../services/dragon-registry.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getPromptsDir } from "../routes/controls.js";
import { parseWatchdogConfig, type WatchdogSettings } from "../watchdog/config.js";
import { hungFinding } from "../watchdog/detectors.js";
import { WatchdogStore } from "../watchdog/store.js";
import { ProjectView } from "../watchdog/view.js";
import type { ProjectEntry } from "../watchdog/service.js";
import type { SupervisedAgents } from "../watchdog/types.js";
import { backoffMs, MODEL_ID, parseAgentsConfig, type AgentLockSettings, type AgentsSettings } from "./config.js";
import {
  agentLimits,
  describeUsage,
  evaluateBudget,
  periodEnd,
  type FleetBudget,
} from "./budgets.js";
import {
  DECISION_MODULE,
  InboxFileDecisions,
  ProducerDecisions,
  escalationDecisionKey,
  type DecisionInbox,
  type DecisionRequest,
} from "./decisions.js";
import { chooseProfile, matchFailover, matchTransient, profileLabel, profilesFor, TRANSIENT_TAIL_LINES } from "./failover.js";
import {
  AgentsFill,
  DECISION_FILL_KEEP,
  DECISION_FILL_START,
  OWNER_HOLDS,
  parseIdleNoticeKey,
  QueueLines,
  queueMark,
  queueWindowEnd,
  reportedOutcome,
  type HoldDecisionState,
  type ReportedOutcome,
} from "./fill.js";
import {
  createLock,
  judgeLock,
  readLock,
  releaseLock,
  removeLock,
  transferLock,
  type LockFile,
  type LockOwnerLabel,
  type LockVerdict,
} from "./locks.js";
import {
  agentEnvironment,
  ProcessSnapshot,
  systemAgentProbes,
  type AgentProbes,
  type ProcessOwner,
} from "./probes.js";
import { extractHungLogLines, extractLastTool, lastLines, moveSessionAside, readTail, resumeSummary, sessionDirFor, utcStamp } from "./sessions.js";
import { AgentsStore, type ClaimResult, type HungInfo } from "./store.js";
import {
  claimView,
  eventView,
  isActive,
  isValidTaskId,
  runView,
  type AgentRun,
  type Claim,
  type FailoverInfo,
  type StoredLockWait,
} from "./types.js";
import { commandFingerprint, findTaskProcess, reconcileRun, runPromptFileName } from "./reconcile.js";
import type { ProcessInfo, ProcessReading } from "../watchdog/probes.js";
import type { ReadyFactsSource } from "../ready-guard/guard.js";

export { TASK_ID, isValidTaskId } from "./types.js";

/** How long the server's shutdown may wait on runs it stops (agents.on_restart: stop), at most: it has 60 s in all */
export const SHUTDOWN_RUN_WAIT_MS = 20_000;
/** How often that wait reads the process table */
const SHUTDOWN_POLL_MS = 1_000;

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

const MAX_PROMPT_CHARS = 200_000;

/** The options of this module's decisions (see followAnswer) */
export const DECISION_FRESH = "fresh_session";
export const DECISION_RELEASE = "release";
export const DECISION_WAIT = "wait";
export const DECISION_STOP = "stop";
export const DECISION_ALLOW = "allow";
export const DECISION_RETRY_NOW = "retry_now";

/** In the detail of a run that waits for its tool's sign-in */
const SIGNED_OUT_DETAIL = "not signed in on this machine";
/**
 * A run whose every profile's tool is signed out looks again after this
 * long: half the life of a sign-in state, so each look starts the next
 * background check while the last answer still stands
 */
const SIGNED_OUT_RECHECK_MS = 30_000;

/** Why a profile on a signed-out tool can't start, with the fix */
function signedOutDetail(refusal: SignInRefusal): string {
  const fix = refusal.fix ? `: run \`${refusal.fix}\` in a terminal on it, as the user Lair runs as` : "";
  return `${refusal.name} (${refusal.tool}) is ${SIGNED_OUT_DETAIL}${fix}`;
}

/** A provider marked unreachable is tried by one start after this long, doubling per failed try, up to the max */
export const TRANSIENT_BACKOFF_SECONDS = 60;
export const TRANSIENT_MAX_BACKOFF_SECONDS = 900;
/** Two agents' runs dying of transient errors this close together make the outage the fleet's */
export const TRANSIENT_FLEET_WINDOW_SECONDS = 900;

/**
 * A provider's outage: runs on it died of transient errors
 * (agents.transient_patterns), and nothing on it has worked since. Kept on
 * each `transient` event (its data), so the newest one says where it stands.
 * Until it is the fleet's, only the agents whose runs died wait.
 */
interface Outage {
  provider: string;
  /** The first transient failure of the outage */
  since: number;
  failures: number;
  /** Backoff steps: the first failure, then each one at or after the next try (a try that failed) */
  steps: number;
  /** When one start may try the provider again */
  nextTryAt: number;
  /** The log line that matched last (agent CLI output: data) */
  line: string;
  /** The agents whose runs died of it (at most 50) */
  agents: string[];
  /** Every agent waits: two agents' runs died within TRANSIENT_FLEET_WINDOW_SECONDS, or a retry failed too */
  fleet: boolean;
  /** The latest failure, and whose run it was */
  lastAt: number;
  lastAgent: string;
}

/** The events shown as an agent's recoveries. */
export const RECOVERY_KINDS: readonly AgentEventKind[] = [
  "claim_released",
  "lock_broken",
  "never_started",
  "dead_on_start",
  "crashed",
  "exit_unknown",
  "hung",
  "lost_claim",
  "restart_same_session",
  "fresh_session",
  "escalated",
  "failover",
  "budget_warning",
  "budget_exceeded",
  "budget_override",
  "decision",
  "transient",
  "transient_cleared",
  "run_lost",
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
  exit_unknown: "agent.recovery",
  hung: "agent.recovery",
  lost_claim: "agent.recovery",
  restart_same_session: "agent.recovery",
  fresh_session: "agent.recovery",
  escalated: "agent.recovery",
  run_lost: "agent.recovery",
  failover: "agent.failover",
  budget_warning: "agent.budget.warning",
  budget_exceeded: "agent.budget.exceeded",
  fill_started: "agents.fill_started",
  fill_held: "agents.fill_held",
  fill_idle_notice: "agents.fill_idle_notice",
  fill_idle_resolved: "agents.fill_idle_resolved",
  fill_unmatched: "agents.fill_unmatched",
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

/** Why a run of `agent` on another task is refused while its fill task is open (fill matching by agent). */
const openTaskRefusal = (agent: string, open: FillLineView) =>
  `Agent ${agent} has an open fill task, ${open.task} (${open.state}${open.hold ? `: ${open.hold}` : ""}): with fill's patterns matching by agent, its lines on another task would count for that one. Let ${open.task} finish, or take its line out of tasks_file first`;

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
  /** The latest reading of the process table */
  snap: ProcessSnapshot;
  /** The tick's own first reading (it may come from the shared cache) */
  first: ProcessSnapshot;
  /** A fresh reading taken after `first` (relist); null when one was tried and failed */
  confirmed?: ProcessSnapshot | null;
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
  /**
   * Run variables from the module that requests the run, in-process only (the
   * HTTP body can't carry them): names from MODULE_RUN_VARIABLES only. They
   * are kept in memory, never in the store, and reach the run's environment
   * only; a run whose variables a restart lost ends instead of starting.
   */
  variables?: unknown;
  /**
   * The requesting module's prompt is the whole task (a supervisor run's, a
   * review run's): the project's default_instructions, the builders' standing
   * orders, don't go before it. The agent's own `instructions` still do.
   * In-process only, like `variables`.
   */
  ownPrompt?: boolean;
}

/**
 * Run variables another module may give a run: the review module's, for a
 * review run (src/server/review/agent-assigner.ts), and the supervisor's, for
 * a supervisor run (src/server/supervisor/chat.ts). LAIR_REVIEW_TOKEN is the
 * review's assignment token and LAIR_OPS_TOKEN the run's ops token, so none
 * of them is ever written to disk.
 */
export const MODULE_RUN_VARIABLES: readonly string[] = [
  "LAIR_REVIEW_TOKEN",
  "LAIR_REVIEW_PROJECT",
  "LAIR_URL",
  "LAIR_OPS_TOKEN",
  "LAIR_SUPERVISOR_CONVERSATION",
  "LAIR_BUS_TOKEN",
];
const MAX_RUN_VARIABLE_CHARS = 1000;

/** Validated module run variables, or the reason they are refused. */
function moduleVariables(value: unknown): Record<string, string> | string {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "variables must be an object";
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    if (!MODULE_RUN_VARIABLES.includes(name)) return `${name} is not one of ${MODULE_RUN_VARIABLES.join(", ")}`;
    // eslint-disable-next-line no-control-regex
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_RUN_VARIABLE_CHARS || /[\x00-\x1f\x7f]/.test(v)) {
      return `${name} must be 1-${MAX_RUN_VARIABLE_CHARS} characters, without control characters`;
    }
    out[name] = v;
  }
  return out;
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
  /** Whether a tool is signed in on this machine (src/server/ai/): a signed-out tool starts nothing here */
  tools?: ToolReadiness;
  /** Mint a bus token for a run. Returns the plaintext token (to give to the agent) and stores its hash. */
  mintBusToken?: (runId: string, agent: string) => string;
  /** Revoke a run's bus token when the run ends */
  revokeBusToken?: (runId: string) => void;
  /** What the ready guard reads a PR from (read on each use); undefined: the project has no git host to ask */
  readyFacts?: () => ReadyFactsSource | undefined;
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
  private tools?: ToolReadiness;
  private mintBusToken?: (runId: string, agent: string) => string;
  private revokeBusToken?: (runId: string) => void;
  private watchdogSettings: WatchdogSettings;
  private watchdogStore: WatchdogStore | null = null;
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ticking: Promise<AgentsTickSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private snapshot: ProcessSnapshot | null = null;
  /** Locks no run waits on that the last reaper check judged stale (name -> what was read) */
  private staleSeen = new Map<string, string>();
  /** agents.fill: starts runs from tasks_file through requestRun (null when off) */
  private fill: AgentsFill | null = null;
  /** Module run variables per chain (RunRequest.variables): in memory only, dropped once the chain ends */
  private moduleVars = new Map<string, Record<string, string>>();
  /** start() reconciles the runs the store says are active first: until that has finished, fill starts nothing */
  private reconcilePending = false;
  /** The runs reconciliation has given a verdict since start() */
  private reconciled = new Set<string>();
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
    this.tools = options.tools;
    this.mintBusToken = options.mintBusToken;
    this.revokeBusToken = options.revokeBusToken;
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
          // Never negative: usage can't buy budget back
          tokens: Math.max(0, who.tokens ?? 0),
          cost: Math.max(0, event.cost),
          at: this.probes.clock.now(),
          reason: event.reason,
        });
      }) ?? null;
    if (options.settings.fill.enabled) {
      // Once per start (and config reload): what can make fill close or change the wrong task (also on Home → Health)
      for (const warning of options.settings.fill.warnings) console.warn(`[agents] ${this.project}: ${warning}`);
      this.fill = new AgentsFill({
        project: this.project,
        config: this.config,
        settings: options.settings.fill,
        commandTimeoutSeconds: options.settings.commandTimeoutSeconds,
        store: this.store,
        probes: this.probes,
        readOnly: () => this.readOnly,
        // A read_only project starts nothing: it has no runs to reconcile first
        ready: () => this.readOnly || !this.reconcilePending,
        taskProcess: (task) => this.taskProcess(task),
        // The in-process path every module uses: claims, locks, retries and budgets apply
        requestRun: (input) => this.requestRun(input, { origin: "fill" }),
        record: (kind, input, at) => this.record(kind, input, at),
        raise: (request, run) => this.raiseAt(request, this.probes.clock.now(), run ?? undefined),
        openDecisions: () => this.decisions().open?.(this.project) ?? [],
        findDecision: (key) => {
          const inbox = this.decisions();
          return inbox.find ? inbox.find(this.project, key) : undefined;
        },
        withdraw: (decision, reason) => this.withdrawDecision(decision, reason, this.probes.clock.now()),
        readyFacts: options.readyFacts,
      });
    }
  }

  get readOnly(): boolean {
    return this.config.read_only === true;
  }

  /** The project's prompts_dir: where run prompts are written, and where the Agents view loads prompts from */
  promptsDir(): string {
    return getPromptsDir(this.config);
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

  /** A tick on a new reading of the process table; its time is taken after the reading (a slow `ps` takes seconds). */
  private async newTick(fresh = false): Promise<Tick> {
    return this.tickOn(await this.readSnapshot(fresh));
  }

  private tickOn(snap: ProcessSnapshot): Tick {
    const now = this.probes.clock.now();
    this.snapshot = snap;
    return {
      now,
      snap,
      first: snap,
      summary: emptySummary(now),
      touchedTasks: new Set(),
      touchedLocks: new Set(),
    };
  }

  /**
   * Read the process table. Start times count back from when the reading was taken: the shared cache hands out
   * readings up to seconds old, and `ps` itself may take seconds under load, so neither makes a live process look
   * like another one. A table that doesn't say when it read is timed here, around the call. `fresh`: a reading
   * started now, never one the cache kept.
   */
  private async readSnapshot(fresh: boolean): Promise<ProcessSnapshot> {
    const table = this.probes.processes;
    const asked = this.probes.clock.now();
    let reading: ProcessReading;
    if (table.read) {
      reading = await table.read({ fresh });
    } else {
      const processes = await table.list();
      reading = { processes, startedAt: asked, takenAt: this.probes.clock.now() };
    }
    const spread = Math.max(0, reading.takenAt - reading.startedAt);
    return new ProcessSnapshot(reading.processes, reading.takenAt, this.probes.self, this.settings.pidStartToleranceSeconds, spread);
  }

  /**
   * Read the process table again, fresh (never the cached reading). A holder
   * (of a lock or a claim) is only judged dead on a reading taken AFTER its
   * lock or claim was read: a process that took it after the tick's first
   * reading isn't in that one. Callers read the lock or claim first, then
   * call this. The processes this tick started stay alive in the new reading.
   */
  private async relist(t: Tick): Promise<ProcessSnapshot> {
    const fresh = await this.readSnapshot(true);
    for (const owner of t.snap.spawnedOwners()) fresh.addSpawned(owner);
    t.snap = fresh;
    t.confirmed = fresh;
    this.snapshot = fresh;
    return fresh;
  }

  /**
   * A second reading for the tick, fresh and taken after its first: once per tick. Null when it failed: then
   * nothing may be judged ended on this tick's readings.
   */
  private async confirmingReading(t: Tick): Promise<ProcessSnapshot | null> {
    if (t.confirmed === undefined) {
      try {
        await this.relist(t);
      } catch (e) {
        t.confirmed = null;
        console.warn(`[agents] ${this.project}: a second reading of the process table failed: ${message(e)}`);
      }
    }
    return t.confirmed ?? null;
  }

  /**
   * Whether a run's process still runs. One that this server started is judged as before (its exit status comes
   * from the spawner). Any other (a run adopted after a restart) is ended only when two readings agree: the tick's
   * own and a fresh one taken after it. A slow, old or cut-short reading never ends a live run: when the fresh
   * reading fails the answer is "unknown", and the run is left as it is until the next tick.
   */
  private async processState(run: AgentRun, t: Tick): Promise<"alive" | "ended" | "unknown"> {
    const pid = run.pid;
    if (pid === undefined) return "ended";
    if (t.snap.isAlive(pid, run.pidStartedAt)) return "alive";
    if (this.probes.spawner.knows(pid) || this.probes.spawner.exitCode(pid) !== undefined) return "ended";
    const confirmed = await this.confirmingReading(t);
    if (!confirmed) return "unknown";
    return t.first.isAlive(pid, run.pidStartedAt) || confirmed.isAlive(pid, run.pidStartedAt) ? "alive" : "ended";
  }

  /**
   * Claim a task for a run. An existing claim is replaced only when its owner
   * is dead on a reading taken after the claim was read.
   */
  private async claimFor(t: Tick, task: string, runId: string, agent: string): Promise<ClaimResult> {
    const existing = this.store.getClaim(this.project, task);
    let snap = t.snap;
    if (existing && !snap.isAlive(existing.ownerPid, existing.ownerStartedAt)) snap = await this.relist(t);
    return this.store.claim(this.project, task, runId, agent, this.probes.self, t.now, (pid, started) => {
      if (snap.isAlive(pid, started)) return true;
      // Only the owner that was read before the reading may be judged dead by it
      return !(existing && existing.ownerPid === pid && existing.ownerStartedAt === started);
    });
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

  /** Raise a decision once per key, counted in the tick. True when this call raised it. */
  private async raise(
    request: Omit<DecisionRequest, "project" | "requestedBy">,
    t: Tick,
    run?: AgentRun,
    again = false,
  ): Promise<boolean> {
    const raised = await this.raiseAt(request, t.now, run, again);
    if (raised) t.summary.escalations++;
    return raised;
  }

  /**
   * Raise a decision once per key (fill raises outside a tick): not again
   * while it is open or once it was answered. One the module withdrew (its
   * condition lifted) is raised again if the condition comes back, once per
   * withdrawn decision, so a refused inbox can't make it write the inbox
   * file on every check. With `again`, one that was answered is asked again
   * too (once per answered decision, never while one is open): for a
   * condition that outlasts its answer. True when this call raised it.
   */
  private async raiseAt(
    request: Omit<DecisionRequest, "project" | "requestedBy">,
    now: number,
    run?: AgentRun,
    again = false,
  ): Promise<boolean> {
    const known = this.decisions().find?.(this.project, request.key) ?? null;
    if (known && (known.status === "open" || (known.status !== "withdrawn" && !again))) return false;
    const dedupeKey = known ? `decision:${request.key}:after:${known.id}` : `decision:${request.key}`;
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
      now,
    );
    return recorded;
  }

  /**
   * Withdraw one of this module's open decisions whose condition is gone (a
   * hold that lifted another way, a chain that moved on), and record it.
   * Never throws: an answer that won the race, or a missing inbox, makes it
   * moot either way.
   */
  private async withdrawDecision(decision: Decision, reason: string, now: number): Promise<void> {
    const inbox = this.decisions();
    if (!inbox.withdraw) return;
    try {
      await inbox.withdraw(decision.id, reason);
    } catch (e) {
      console.warn(`[agents] ${this.project}: could not withdraw decision ${decision.id}: ${message(e)}`);
      return;
    }
    await this.record(
      "decision",
      {
        subject: decision.kind,
        summary: `withdrawn: ${decision.title}; ${reason}`,
        data: { decisionId: decision.id, key: decision.key, withdrawn: true, reason },
        dedupeKey: `decision_withdrawn:${decision.id}`,
      },
      now,
    );
  }

  /**
   * Why an open decision of this module is moot, by what its ref is about
   * (the part before the first ':'), or null while it still stands. Each
   * kind of ref the tick follows has one entry; a module part that raises
   * decisions about something else adds its own (`transient:<provider>`,
   * say). Fill's `fill:` decisions are fill's to withdraw (it sees the lines).
   */
  private readonly mootBy: ReadonlyMap<string, (decision: Decision, rest: string) => string | null> = new Map([
    ["chain", (decision: Decision, chainId: string) => this.chainMoot(decision, chainId)],
    ["transient", (decision: Decision, provider: string) => this.outageMoot(decision, provider)],
    ["signin", (_decision: Decision, tool: string) => this.signInMoot(tool)],
  ]);

  /** A tool's sign-in decision (ref `signin:<tool>`) is moot once its check says it is signed in here. */
  private signInMoot(tool: string): string | null {
    return this.tools?.lastSignIn(tool, this.config) === "signed_in" ? `${tool} is signed in on this machine now` : null;
  }

  /**
   * A provider outage's decision (key `transient:<provider>:<since>`) is moot
   * once that outage is over: a start worked (transient_cleared), or a newer
   * outage of the provider began since.
   */
  private outageMoot(decision: Decision, provider: string): string | null {
    const since = Number(decision.key.slice(decision.key.lastIndexOf(":") + 1));
    const outage = this.outage(provider);
    if (!outage) return `provider ${provider} is reachable again`;
    if (outage.since !== since) return `that outage of provider ${provider} ended (another began ${iso(outage.since)})`;
    return null;
  }

  /**
   * A run chain's escalation or "every profile is failing" decision is moot
   * once the chain moved on: started again some other way (the owner's run
   * or a fresh session from Work, fill after the owner released its hold),
   * or no longer waiting for a provider.
   */
  private chainMoot(decision: Decision, chainId: string): string | null {
    const chain = this.store.chainRuns(chainId);
    const last = chain[chain.length - 1];
    if (!last) return "its runs are gone";
    if (decision.key.startsWith("escalation:")) {
      const attempts = Number(decision.key.slice(decision.key.lastIndexOf(":") + 1));
      const latest = this.store.latestRunForTask(this.project, last.task);
      if (chain.length > attempts || isActive(last.state)) return `${last.task} started again (run ${short(last.id)})`;
      if (latest && latest.chainId !== chainId) return `${last.task} started again as run ${short(latest.id)}`;
      return null;
    }
    if (decision.key.startsWith("exhausted:") && !chain.some((r) => r.state === "queued" || r.state === "waiting_lock")) {
      return `nothing of ${last.task} waits for a provider any more (run ${short(last.id)} is ${last.state})`;
    }
    return null;
  }

  /** Withdraw this module's open decisions that are moot (mootBy), every tick. */
  private async withdrawMoot(t: Tick): Promise<void> {
    for (const decision of this.decisions().open?.(this.project) ?? []) {
      const at = decision.source.ref.indexOf(":");
      if (at <= 0) continue;
      const why = this.mootBy.get(decision.source.ref.slice(0, at))?.(decision, decision.source.ref.slice(at + 1)) ?? null;
      if (why) await this.withdrawDecision(decision, `It moved on: ${why}.`, t.now);
    }
  }

  /**
   * An open provider-limit decision whose limit has reset (`limit_resets_at` is past) says so: its cause is
   * cleared. Done at the start of the tick, before the waiting run launches and the decision is withdrawn as
   * moot. Only its evidence changes, for the policy rules (docs/design/decision-policies.md §4). Only while the
   * decision policies are on (the inbox has causeCleared: AgentsManager.useEvidenceUpdates). Never throws.
   */
  private async refreshCauses(t: Tick): Promise<void> {
    const inbox = this.decisions();
    if (!inbox.causeCleared) return;
    try {
      for (const decision of inbox.open?.(this.project) ?? []) {
        const evidence = decision.evidence;
        if (decision.class !== "agents.provider_limit" || !evidence || evidence.cause_cleared) continue;
        const resets = evidence.facts.limit_resets_at;
        if (typeof resets === "string" && Date.parse(resets) <= t.now) await inbox.causeCleared(decision.id);
      }
    } catch (e) {
      console.warn(`[agents] ${this.project}: could not update the evidence of a decision: ${message(e)}`);
    }
  }

  /**
   * Where the decision of one of fill's holds stands (fill.ts holdDecision;
   * `key` from fillDecisionKey or escalationDecisionKey): for code that keeps
   * a hold only while its decision is open or was answered "keep".
   */
  fillHoldDecision(key: string): HoldDecisionState {
    return this.fill ? this.fill.holdDecision(key) : { status: "unknown" };
  }

  /** The owner's pause of `task` (fill's `paused` hold): fill starts it again once they release it. */
  private async recordFillPause(task: string, latest: AgentRun | null, why: string, now: number): Promise<void> {
    await this.record(
      "fill_paused",
      {
        agent: latest?.agent,
        task,
        runId: latest?.id,
        summary: `the owner paused ${task} (${why}): fill starts it again once it is released`,
        data: { runId: latest?.id ?? null, why },
      },
      now,
    );
  }

  /**
   * An answer from the Decision Inbox to one of this module's decisions
   * (AgentsManager.useDecisions delivers them):
   * - an escalated task: "fresh_session" starts it again in a fresh session
   *   (if that fails too, Lair asks again), "release" leaves it unclaimed (a
   *   task fill runs is then the owner's pause, so its hold no longer waits
   *   for them);
   * - every profile failing: "wait" keeps the run waiting for the cooldown,
   *   "stop" ends it and frees the task;
   * - a hard budget limit: "allow" lets runs start past it until the period
   *   ends, "wait" keeps them waiting;
   * - a task fill holds for the owner: "start_again" releases the hold (if
   *   the run it was about is still the task's latest), "keep_held" makes it
   *   the owner's pause (`paused`);
   * - a provider unreachable too long: "retry_now" lets every run waiting on
   *   it start on the next check, "wait" keeps trying one start at a time.
   * A resume that can't happen (the task was claimed meanwhile, say) is
   * recorded, not retried, so the answer still counts as delivered.
   */
  followAnswer(resolution: DecisionResolution): Promise<void> {
    return this.exclusive(async () => {
      const { decision, optionId } = resolution;
      const t = await this.newTick();
      let outcome: string;
      try {
        outcome = await this.applyAnswer(decision.key, decision.source.ref, optionId, t);
      } catch (e) {
        outcome = `could not act on it: ${message(e)}`;
      }
      await this.record(
        "decision",
        {
          subject: decision.kind,
          summary: `answered (${optionId}): ${decision.title}; ${outcome}`,
          evidence: [`by ${resolution.by}`, ...(resolution.note ? [`note: ${oneLine(resolution.note)}`] : [])],
          data: { decisionId: decision.id, key: decision.key, optionId, outcome, resolution: resolution.outcome },
        },
        t.now,
      );
    });
  }

  private async applyAnswer(key: string, ref: string, optionId: string, t: Tick): Promise<string> {
    if (key.startsWith("budget:")) {
      const budgetKey = key.slice("budget:".length);
      if (optionId !== DECISION_ALLOW) return "runs keep waiting until the period ends";
      await this.record(
        "budget_override",
        {
          subject: budgetKey,
          summary: `the owner allowed runs past ${budgetKey} until the period ends`,
          data: { key: budgetKey },
          dedupeKey: `budget_override:${budgetKey}`,
        },
        t.now,
      );
      return `runs may start past ${budgetKey} until the period ends`;
    }
    if (key.startsWith("fill:") && ref.startsWith("fill:")) {
      // The hold's run is the key's last part ("none": a task with no run yet)
      const task = ref.slice("fill:".length);
      const runPart = key.slice(key.lastIndexOf(":") + 1);
      const runId = runPart === "none" ? null : runPart;
      const latest = this.store.latestRunForTask(this.project, task);
      if ((latest?.id ?? null) !== runId) return "the task has moved on since: nothing to change";
      if (optionId === DECISION_FILL_KEEP) {
        await this.recordFillPause(task, latest, 'you chose "Keep it paused"', t.now);
        return "fill keeps the task paused until you release it";
      }
      if (optionId !== DECISION_FILL_START) return "nothing to do";
      if (this.readOnly) return "the project is read_only: Lair starts no agents";
      await this.recordFillRelease(task, latest, "decision", t.now);
      return "fill starts the task again on its next check";
    }
    const idle = parseIdleNoticeKey(key);
    if (idle) {
      // An idle notice asks nothing: closing it changes nothing, and this episode raises no other
      return `noted: fill raises no other idle notice for ${idle.agent} until it stops idling and then idles while ready work exists again`;
    }
    if (key.startsWith("signin:") && ref.startsWith("signin:")) {
      if (optionId !== DECISION_RETRY_NOW) {
        return "the runs on it keep waiting; Lair keeps checking its sign-in, and asks again only if it changes";
      }
      const tool = ref.slice("signin:".length);
      // Checked again now, in the background; until it answers, the last answer stands
      this.tools?.recheck(tool, this.config);
      // The runs waiting on it look again on the next check (a run waiting for something else keeps its time)
      for (const run of this.store.activeRuns(this.project)) {
        if (run.state !== "queued" || run.notBefore <= t.now || !run.detail.includes(SIGNED_OUT_DETAIL)) continue;
        if (!this.profiles(run.agent, run.requestModel).some((p) => p.adapter === tool)) continue;
        run.notBefore = t.now;
        this.store.saveRun(run);
      }
      return `${tool}'s sign-in is checked again now; the runs waiting on it start once it is signed in`;
    }
    if (key.startsWith("transient:") && ref.startsWith("transient:")) {
      if (optionId !== DECISION_RETRY_NOW) return "Lair keeps trying one start at a time";
      const provider = ref.slice("transient:".length);
      const outage = this.outage(provider);
      if (!outage) return `provider ${provider} is reachable again: nothing to do`;
      await this.record(
        "transient_cleared",
        {
          subject: provider,
          summary: `the owner chose to try provider ${provider} now: the runs waiting on it start on the next check`,
          data: { provider, since: outage.since, failures: outage.failures, by: "owner" },
        },
        t.now,
      );
      return "the runs waiting on the provider start on the next check";
    }
    const chain = ref.startsWith("chain:") ? this.store.chainRuns(ref.slice("chain:".length)) : [];
    const latest = chain[chain.length - 1];
    if (!latest) return "its task is gone";
    if (key.startsWith("escalation:")) {
      if (optionId !== DECISION_FRESH) {
        // Fill leaves the task too: the owner's pause, not a hold that still waits for them
        if (this.fill?.lineFor(latest.task) && this.store.latestRunForTask(this.project, latest.task)?.id === latest.id) {
          await this.recordFillPause(latest.task, latest, 'you chose "Leave the task unclaimed"', t.now);
          return "the task stays unclaimed, and fill leaves it paused until you release it";
        }
        return "the task stays unclaimed";
      }
      const next = await this.restartFresh(latest, t, "the owner chose a fresh session");
      return `started again as run ${short(next.id)} in a fresh session`;
    }
    if (key.startsWith("exhausted:")) {
      if (optionId !== DECISION_STOP) return "the run keeps waiting for the cooldown";
      const waiting = chain.find((r) => r.state === "queued" || r.state === "waiting_lock");
      if (!waiting) return "nothing was waiting any more";
      waiting.state = "failed";
      waiting.endedAt = t.now;
      waiting.waitingLock = undefined;
      waiting.detail = "stopped by the owner while every profile was failing";
      this.store.saveRun(waiting);
      this.store.releaseClaim(this.project, waiting.task, waiting.id);
      return `run ${short(waiting.id)} stopped; the task is free`;
    }
    return "nothing to do";
  }

  /** A budget line the owner allowed runs past, for its period. */
  private overridden(scope: BudgetScopeView, line: BudgetLine): boolean {
    const scopeKey = scope.scope === "project" ? "project" : `agent:${scope.agent}`;
    return this.store.hasEvent(this.project, `budget_override:${scopeKey}:${line.metric}:${line.period}`);
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
    const t = await this.newTick();
    // Until every run found active has a verdict (a read_only project judges none), the next tick tries again
    if (this.reconcilePending && !this.readOnly) this.reconcilePending = !(await this.reconcile(t));
    if (!this.readOnly) {
      for (const run of this.store.activeRuns(this.project)) {
        if (run.state === "running" || run.state === "stopping") this.readUsage(run);
      }
    }
    await this.checkBudgets(t);
    await this.refreshCauses(t);
    if (!this.readOnly) {
      for (const run of this.store.activeRuns(this.project)) {
        t.touchedTasks.add(run.task);
        await this.advance(run, t);
      }
      await this.checkOutages(t);
      await this.reapClaims(t);
      await this.reapLocks(t);
      const activeChains = new Set(this.store.activeRuns(this.project).map((run) => run.chainId));
      for (const chain of this.moduleVars.keys()) if (!activeChains.has(chain)) this.moduleVars.delete(chain);
    }
    // A question whose chain moved on is moot: withdrawn, so nothing is left waiting for the owner by mistake
    await this.withdrawMoot(t);
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

  /**
   * When a provider that rate-limited or failed may be used again by `agent`,
   * or null. A provider cools down for the agent whose run hit it; for every
   * agent only once runs of two or more agents hit it within the cooldown,
   * so one agent's output can't take a provider away from the others.
   */
  private coolingUntil(provider: string, agent: string, now: number): number | null {
    const cooldown = this.settings.failover.cooldownMinutes * 60000;
    if (cooldown <= 0) return null;
    const failures = this.store
      .listEvents(this.project, { kinds: ["failover"], subject: provider, since: now - cooldown, limit: 100 })
      .filter((e) => e.data.kind === "rate_limit" || e.data.kind === "provider_error");
    const own = failures.find((e) => e.agent === agent);
    const agents = new Set(failures.map((e) => e.agent ?? ""));
    const until = Math.max(own ? own.at + cooldown : 0, agents.size >= 2 ? failures[0].at + cooldown : 0);
    return until > now ? until : null;
  }

  /**
   * Why a profile can't be used now by `agent`, or null. A provider
   * unreachable after transient errors (for this agent, or for every agent
   * once the outage is the fleet's) is passed over like one cooling down, so
   * a fallback on another provider wins; `outages: false` leaves that out.
   */
  private unusable(profile: AgentProfile, agent: string, now: number, outages = true): string | null {
    if (!getAdapter(profile.adapter, this.config)) return `adapter ${profile.adapter} is not defined`;
    const until = this.coolingUntil(profile.provider, agent, now);
    if (until !== null) return `provider ${profile.provider} is cooling down until ${iso(until)}`;
    if (this.budget && !this.budget.isProviderAvailable(profile.provider)) {
      return `the fleet budget has provider ${profile.provider} paused or rate limited`;
    }
    if (outages) {
      const outage = this.outage(profile.provider);
      if (outage && this.downFor(outage, agent)) {
        return `provider ${profile.provider} unreachable since ${iso(outage.since)} (transient errors)`;
      }
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
      if (!scope) continue;
      // A limit the owner allowed runs past (a spend decision) doesn't block, for its period
      const line = scope.lines.find((l) => l.level === "hard" && !this.overridden(scope, l));
      if (line) return describeUsage(scope, line, "hard");
    }
    return null;
  }

  private async launch(run: AgentRun, t: Tick): Promise<void> {
    if (run.notBefore > t.now) return;

    // Module run variables live only in memory: without them (after a restart) the run ends, and its module asks again
    const lost = (run.variableNames ?? []).filter((name) => this.moduleVars.get(run.chainId)?.[name] === undefined);
    if (lost.length > 0) {
      return this.endRun(run, "failed", `not started: its run variables (${lost.join(", ")}) were lost in a restart`, t, true);
    }

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
    // A provider unreachable after transient errors is passed over (unusable), so a fallback on another provider wins
    const from = Math.min(run.profileIndex, profiles.length - 1);
    const unreachable = (p: AgentProfile): Outage | null => {
      const outage = this.outage(p.provider);
      return outage && this.downFor(outage, run.agent) ? outage : null;
    };
    // A tool whose last sign-in check says it is signed out here starts nothing on this machine: passed over like a
    // provider cooling down, with one decision per tool for the project (not one per agent or run). Nothing waits
    // for a check: they run in the background, and a tool not checked yet (or not lately) is not held
    const signedOut = this.signInRefusals(profiles);
    const usable = (p: AgentProfile, outages = true): string | null => {
      const refusal = signedOut.get(p.adapter);
      return refusal ? signedOutDetail(refusal) : this.unusable(p, run.agent, t.now, outages);
    };
    if (signedOut.size > 0) await this.raiseSignedOut([...signedOut.values()], t);
    const choice = chooseProfile(profiles, from, true, (p) => usable(p));
    let chosen = choice.chosen;
    const skipped = choice.skipped;
    if (!chosen && profiles.every((p) => signedOut.has(p.adapter))) {
      run.state = "queued";
      run.launchingSince = undefined;
      run.waitingLock = undefined;
      run.notBefore = t.now + SIGNED_OUT_RECHECK_MS;
      run.detail = `not starting: ${[...signedOut.values()].map(signedOutDetail).join("; ")}; looked at again at ${iso(run.notBefore)}`;
      this.store.saveRun(run);
      return;
    }
    if (!chosen) {
      // With no other profile, the run waits the outage out on the first profile it is the only problem of: one start
      // per backoff step tries it (the wait doesn't count toward start_timeout_minutes, and nothing is counted)
      const order = [...profiles.keys()].slice(from).concat([...profiles.keys()].slice(0, from));
      const index = order.find((i) => usable(profiles[i], false) === null && unreachable(profiles[i]) !== null);
      const outage = index === undefined ? null : unreachable(profiles[index]);
      if (index !== undefined && outage) {
        const due = t.now >= outage.nextTryAt;
        if (!due || this.probeInFlight(run, outage)) {
          const detail = `not starting: provider ${outage.provider} unreachable since ${iso(outage.since)} (${outage.failures} transient failure(s)); ${due ? "another start is trying it now" : `next try at ${iso(outage.nextTryAt)}`}`;
          if (run.state !== "queued" || run.detail !== detail || run.launchingSince !== undefined || run.waitingLock) {
            run.state = "queued";
            run.launchingSince = undefined;
            run.waitingLock = undefined;
            run.detail = detail;
            this.store.saveRun(run);
          }
          return;
        }
        chosen = { index, profile: profiles[index] };
      }
    }
    if (!chosen) {
      const ends = profiles
        .map((p) => this.coolingUntil(p.provider, run.agent, t.now))
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
    const claimed = await this.claimFor(t, run.task, run.id, run.agent);
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
    run.pgid = spawned.pgid ?? spawned.pid;
    run.pidStartedAt = spawned.startedAt;
    run.commandFingerprint = commandFingerprint(argv);
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
          pgid: spawned.pgid ?? spawned.pid,
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
    // A module's own prompt (ownPrompt) gets no default_instructions: those are the builders' standing orders
    const parts = [run.ownPrompt ? undefined : this.config.default_instructions, dragon?.instructions, run.resumeSummary, run.prompt]
      .map((part) => part?.trim())
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    // If the previous run on this task was hung, include the info as a data block
    const hungInfo = this.store.getHungInfo(this.project, run.agent, run.task);
    if (hungInfo) {
      parts.push(this.formatHungInfo(hungInfo));
    }
    const file = join(dir, runPromptFileName(run.task, run.agent, run.id));
    writeFileSync(file, parts.join("\n\n") + "\n", "utf-8");
    return file;
  }

  /**
   * Format hung info as a JSON data block that can't be escaped by log content.
   * The data is JSON-stringified so no log text (backticks, closing tags, etc.)
   * can break out of the block.
   */
  private formatHungInfo(info: HungInfo): string {
    const data = {
      hung_minutes: info.hungMinutes,
      last_tool: info.lastTool ?? null,
      last_lines: info.lastLines ? info.lastLines.split("\n") : [],
    };
    const parts: string[] = [
      `<hung_run_warning>`,
      `Your previous run was stopped as hung after ${info.hungMinutes} minutes.`,
      `Do not repeat the step that hung; if it was a search or a long command, narrow it or add a timeout.`,
      ``,
      `\`\`\`json`,
      JSON.stringify(data, null, 2),
      `\`\`\``,
      `</hung_run_warning>`,
    ];
    return parts.join("\n");
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
      extraArgs: run.profile.args,
    });
    if (built.warnings.length > 0 || built.command.length === 0) {
      throw new Error(`cannot build the start command of adapter ${adapter.id}: ${built.warnings.join("; ") || "empty"}`);
    }
    return built.command;
  }

  /**
   * The agent's whole environment: PATH, HOME and the like, agents.env_passthrough,
   * and the run's variables. Never the rest of this server's environment
   * (LAIR_NODE_TOKEN, say), and no LAIR_* but the run's own.
   */
  private env(run: AgentRun): Record<string, string> {
    const own: Record<string, string> = {
      ...this.moduleVars.get(run.chainId),
      LAIR_RUN_ID: run.id,
      LAIR_TASK: run.task,
      LAIR_AGENT: run.agent,
      LAIR_SESSION_ID: run.sessionId,
      LAIR_SESSION_MODE: run.sessionMode,
      TASK: run.task,
    };
    if (run.profile.model) own.MODEL = run.profile.model;
    const adapter = getAdapter(run.profile.adapter, this.config);
    if (adapter?.session_id_env && !adapter.session_id_env.toUpperCase().startsWith("LAIR_")) {
      own[adapter.session_id_env] = run.sessionId;
    }
    // Mint a bus token for this run (the token itself is never logged or stored)
    if (this.mintBusToken) {
      own.LAIR_BUS_TOKEN = this.mintBusToken(run.id, run.agent);
    }
    return agentEnvironment(process.env, this.settings.envPassthrough, own);
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
      const { info, verdict } = await this.judgeFresh(lock, t);
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
   * Read a lock, then judge it. A holder that looks dead is judged again on a
   * process reading taken after the lock was read (see relist).
   */
  private async judgeFresh(lock: AgentLockSettings, t: Tick): Promise<{ info: LockFile | null; verdict: LockVerdict }> {
    const info = readLock(lock.path, lock.pidFile);
    let verdict = judgeLock(info, t.snap, lock.staleMinutes);
    if (verdict.state === "stale" && verdict.lock.pid !== null) {
      verdict = judgeLock(info, await this.relist(t), lock.staleMinutes);
    }
    return { info, verdict };
  }

  /**
   * Break a lock whose holder is dead (or a pid-less one past stale_minutes,
   * or one this server left behind: launch locks never outlive a launch).
   * With a run waiting on it (`run`) that happens at once. A lock nobody
   * waits on is broken only when two checks in a row found it stale, and a
   * pid-less one only with break_without_waiter.
   */
  private async breakIfStale(lock: AgentLockSettings, t: Tick, run?: AgentRun): Promise<void> {
    const { verdict } = await this.judgeFresh(lock, t);
    if (verdict.state === "stale") {
      if (!run) {
        if (verdict.lock.pid === null && !lock.breakWithoutWaiter) {
          this.staleSeen.delete(lock.name);
          return;
        }
        const seen = `${verdict.lock.mtimeMs}\u0000${verdict.lock.content}`;
        if (this.staleSeen.get(lock.name) !== seen) {
          this.staleSeen.set(lock.name, seen);
          return;
        }
      }
      this.staleSeen.delete(lock.name);
      await this.breakLock(lock, verdict.lock, verdict.reason, t, run);
      return;
    }
    this.staleSeen.delete(lock.name);
    if (
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
      await this.escalate(run, `never started in ${run.startRetries + 1} attempt(s): ${reason}`, t, "dead_on_start");
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
      variableNames: prev.variableNames,
      ownPrompt: prev.ownPrompt,
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
      failovers: prev.failovers ?? 0,
      transientRetries: prev.transientRetries,
      origin: prev.origin,
      queueMark: prev.queueMark,
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
    const state = await this.processState(run, t);
    if (state === "unknown") return; // judged again on the next tick's readings
    if (state === "ended") return this.onExit(run, t);

    // A run that lost its claim stops itself
    const claim = this.store.getClaim(this.project, run.task);
    if (!claim || claim.runId !== run.id) {
      const why = claim
        ? `task ${run.task} is now claimed by run ${short(claim.runId)} (agent ${claim.agent})`
        : `its claim on task ${run.task} was released`;
      return this.stopRun(run, "lost_claim", why, [why], t);
    }

    // A start that has lived past dead_on_start_seconds on a provider marked unreachable: it is reachable again
    await this.noteReachable(run, t, false);

    // A rate limit or provider error at the end of a silent log
    const failover = this.failoverWhileAlive(run, t.now);
    if (failover) {
      run.failover = failover;
      return this.stopRun(run, "failover", `${failoverLabel(failover.kind)}: ${failover.line}`, [`log line: ${failover.line}`], t);
    }

    // Hung: the watchdog's rule (never for an agent WAITING on a gate)
    const proc = run.pid !== undefined ? t.snap.get(run.pid) : undefined;
    const hung = proc ? hungFinding(this.view(t), run.agent, proc, this.watchdogSettings.hungMinutes) : null;
    if (hung) return this.stopRun(run, "hung", hung.summary, hung.evidence, t);

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
    const last = lastLines(readTail(run.logPath, 8192), 1);
    // A transient error is handled as at an exit (finishStop): its provider counts as unreachable, nothing is counted
    const transient = matchTransient(last, this.settings);
    if (transient !== null) return { kind: "provider_error", line: transient, transient: true };
    return matchFailover(last, this.settings);
  }

  private async stopRun(run: AgentRun, reason: StopReason, detail: string, evidence: string[], t: Tick): Promise<void> {
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
    // Record hung info for the next run to see
    if (reason === "hung") {
      const hungMinutes = Math.round((t.now - (run.spawnedAt ?? run.requestedAt)) / 60000);
      const lastLines = extractHungLogLines(run.logPath);
      const lastTool = extractLastTool(run.logPath);
      this.store.recordHungInfo({
        project: this.project,
        agent: run.agent,
        task: run.task,
        lastLines,
        lastTool,
        hungMinutes,
        recordedAt: t.now,
      });
    }
  }

  private async finishStop(run: AgentRun, t: Tick): Promise<void> {
    const state = await this.processState(run, t);
    if (state === "unknown") return; // not signalled, not ended: the next tick reads again
    if (state === "alive" && run.pid !== undefined) {
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
      case "failover": {
        const info: FailoverInfo = run.failover ?? { kind: "provider_error", line: detail };
        // Its silent log ended on a transient error: waited out as at an exit, while the chain has transient retries left
        const used = this.transientRetriesUsed(run, t.now);
        if (info.transient && used < this.settings.transient.maxRetries) {
          return this.transientRetry(run, info.line, "stopped: its log went silent on it", used, t);
        }
        return this.failover(run, info, t);
      }
      case "fresh_session":
        return this.recover(run, "fresh_session", detail, evidence, t);
      case "server_shutdown":
        return this.stoppedForShutdown(run, t);
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

  /**
   * How the run ended by its agent's own queue line for its task since the
   * run's queue mark (DONE, WAITING or BLOCKED), read with fill's patterns
   * as fill reads them, so fill classifies the completed run the same way.
   */
  private reportedOutcome(run: AgentRun): ReportedOutcome | null {
    const patterns = this.settings.fill;
    try {
      const until = queueWindowEnd(this.store, this.project, patterns, run, run);
      return reportedOutcome(new QueueLines(this.config.queue_file), patterns, run, until);
    } catch {
      return null; // a pattern that doesn't compile for this task: no line found
    }
  }

  /** The process is gone and nobody stopped it. */
  private async onExit(run: AgentRun, t: Tick): Promise<void> {
    if (run.pid !== undefined && this.probes.spawner.exitCode(run.pid) === undefined && this.probes.spawner.knows(run.pid)) {
      return; // this server started it and its exit status is on its way: the next check has it
    }
    const code = this.collectExit(run);
    const claim = this.store.getClaim(this.project, run.task);
    if (!claim || claim.runId !== run.id) {
      // Its claim went first: the task isn't this run's to restart
      return this.endRun(run, "lost_claim", "the process ended after its claim was released", t, false);
    }
    if (code === 0) {
      await this.noteReachable(run, t, true);
      return this.endRun(run, "completed", "exited 0", t, true);
    }
    if (code === undefined) return this.unsupervisedExit(run, t);
    const tail = run.logPath ? readTail(run.logPath, 64 * 1024) : "";
    const exit = code === null ? "ended by a signal" : `exit code ${code}`;
    // A transient network or provider error is waited out, never a recovery attempt, while the chain has transient
    // retries left (its provider counts as unreachable, so the next attempt moves to a fallback when there is one)
    const transient = matchTransient(lastLines(tail, TRANSIENT_TAIL_LINES), this.settings);
    const used = this.transientRetriesUsed(run, t.now);
    if (transient !== null && used < this.settings.transient.maxRetries) return this.transientRetry(run, transient, exit, used, t);
    const failover = matchFailover(lastLines(tail, 20), this.settings);
    if (failover) return this.failover(run, failover, t);

    const lived = t.now - (run.spawnedAt ?? t.now);
    const empty = run.logPath ? fileSize(run.logPath) === 0 : true;
    const evidence = [
      `pid ${run.pid} ${exit}`,
      ...this.transientCapNote(transient, used),
      ...lastLines(tail, 10).map((line) => `log: ${oneLine(line)}`),
    ];
    if (empty || lived < this.settings.deadOnStartSeconds * 1000) {
      const why = empty
        ? `died with an empty log ${seconds(lived)} after it started (${exit})`
        : `died ${seconds(lived)} after it started (${exit})`;
      return this.recover(run, "dead_on_start", why, evidence, t);
    }
    return this.recover(run, "crashed", `the process ended after ${seconds(lived)} (${exit})`, evidence, t);
  }

  /**
   * A process that ended while this server wasn't supervising it: it was
   * started before a restart and re-adopted by pid, so no exit status
   * reached this server (a config reload keeps the spawner, and with it the
   * exit codes). An agent that wrote its queue line
   * for the task since the run's queue mark ended normally: DONE, WAITING or
   * BLOCKED completes the run, and fill (for its runs) carries the task on
   * from that line, as after exit 0: done, waiting on its wake, or held
   * blocked with fill's one decision. With no such line it is one failed
   * attempt: recovery restarts it (the same session first, per
   * agents.recovery), and escalates only once that budget is spent.
   */
  private async unsupervisedExit(run: AgentRun, t: Tick): Promise<void> {
    const outcome = this.reportedOutcome(run);
    if (outcome) {
      // The line is the agent's text: kept as evidence, never in the run's detail (resume summaries carry details)
      const detail = `exit unknown (it ended while Lair was restarting); classified from its queue line: ${outcome.kind.toUpperCase()}`;
      return this.endRun(run, "completed", detail, t, true, {
        evidence: [`queue line: ${oneLine(outcome.line)}`],
        data: { exit: "unknown", classifiedAs: outcome.kind, line: outcome.line },
      });
    }
    const tail = run.logPath ? readTail(run.logPath, 64 * 1024) : "";
    const transient = matchTransient(lastLines(tail, TRANSIENT_TAIL_LINES), this.settings);
    const used = this.transientRetriesUsed(run, t.now);
    if (transient !== null && used < this.settings.transient.maxRetries) {
      return this.transientRetry(run, transient, "its exit status is unknown", used, t);
    }
    const evidence = [
      `pid ${run.pid}: its exit status is unknown (it ended while Lair wasn't supervising it)`,
      "no DONE, WAITING or BLOCKED line of its own for the task since its chain was requested",
      ...this.transientCapNote(transient, used),
      ...lastLines(tail, 10).map((line) => `log: ${oneLine(line)}`),
    ];
    return this.recover(
      run,
      "exit_unknown",
      "ended while Lair wasn't supervising it (started before a restart), with no queue line for the task",
      evidence,
      t,
    );
  }

  /**
   * A run the previous server stopped for its shutdown (agents.on_restart: stop): its queue line decides, as for
   * an exit Lair didn't see. With none it ends, not counted as a failed attempt, and its task is free: fill starts
   * a fill task again; any other run is the owner's to start again.
   */
  private async stoppedForShutdown(run: AgentRun, t: Tick): Promise<void> {
    const outcome = this.reportedOutcome(run);
    if (outcome) {
      const detail = `stopped for the server's shutdown (agents.on_restart: stop); classified from its queue line: ${outcome.kind.toUpperCase()}`;
      return this.endRun(run, "completed", detail, t, true, {
        evidence: [`queue line: ${oneLine(outcome.line)}`],
        data: { exit: "stopped_for_shutdown", classifiedAs: outcome.kind, line: outcome.line },
      });
    }
    const detail = "stopped for the server's shutdown (agents.on_restart: stop), with no queue line for the task: the task is free";
    return this.endRun(run, "failed", detail, t, true);
  }

  private async endRun(
    run: AgentRun,
    state: "completed" | "lost_claim" | "superseded" | "failed",
    detail: string,
    t: Tick,
    releaseClaim: boolean,
    event: { evidence?: string[]; data?: Record<string, unknown> } = {},
  ): Promise<void> {
    run.state = state;
    run.detail = detail;
    run.endedAt = t.now;
    run.waitingLock = undefined;
    this.releaseRunLocks(run);
    if (releaseClaim) this.store.releaseClaim(this.project, run.task, run.id);
    // Revoke the run's bus token so it can't be used after the run ends
    this.revokeBusToken?.(run.id);
    this.store.saveRun(run);
    t.summary.ended++;
    if (state === "completed") {
      // Clear hung info after a normal completion
      this.store.clearHungInfo(this.project, run.agent, run.task);
      await this.record(
        "completed",
        { agent: run.agent, task: run.task, runId: run.id, summary: `${run.agent} finished ${run.task}: ${detail}`, ...event },
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
    kind: "hung" | "crashed" | "dead_on_start" | "exit_unknown" | "fresh_session",
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
    if (kind === "crashed" || kind === "dead_on_start" || kind === "exit_unknown") {
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

  private async escalate(
    run: AgentRun,
    why: string,
    t: Tick,
    code: "repeated_failure" | "dead_on_start" | "provider_limit" = "repeated_failure",
  ): Promise<void> {
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
        // Per chain and escalation: a chain the owner resumed can ask again when it fails again
        key: escalationDecisionKey(run.chainId, chain.length),
        ref: `chain:${run.chainId}`,
        blocks: [`agents:${this.project}:task:${run.task}`],
        // A plain sentence; what failed (it can quote the agent's output) stays in the context
        question: `${run.agent} is paused on ${run.task}: it failed ${chain.length} time(s), and Lair's automatic restarts are used up`,
        context: [
          `Why it stopped: ${oneLine(why, 300)}`,
          "",
          "Attempts:",
          ...attempts.map((a) => `- ${a}`),
          ...(output.length > 0 ? ["", "Last output:", ...output.map((line) => `- ${oneLine(line)}`)] : []),
        ].join("\n"),
        options: [
          {
            id: DECISION_FRESH,
            effect: "reversible",
            label: "Start it again",
            consequences: `Lair starts ${run.task} again for ${run.agent} in a fresh session (the old one moved aside), with a resume summary. If that fails too, Lair asks again.`,
          },
          {
            id: DECISION_RELEASE,
            effect: "frees_task",
            label: "Leave the task unclaimed",
            consequences: `Lair starts nothing more for ${run.task}; the task is free for another run. A task fill runs stays paused until you release it in Work.`,
          },
        ],
        recommended: DECISION_RELEASE,
        structure: {
          class: "agents.gave_up",
          evidence: {
            code,
            facts: { agent: run.agent, task: run.task, attempt_count: chain.length, last_exit: run.exitCode ?? null },
            cause_cleared: false,
            linked_issue: null,
          },
        },
        why: "Every automatic recovery was used; starting again the same way would repeat the loop.",
        reversible: true,
      },
      t,
      run,
    );
  }

  // ============ FAILOVER ============

  /**
   * A rate limit or provider error: the next profile carries the task on,
   * with a resume summary. The agent's output decides this, so a chain gets
   * at most failover.max_failovers of them (then it is escalated), and the
   * recovery counters carry over: failing over never buys more restarts.
   */
  private async failover(run: AgentRun, info: FailoverInfo, t: Tick): Promise<void> {
    run.state = "failed";
    run.endedAt = t.now;
    run.failover = info;
    run.detail = `${failoverLabel(info.kind)} on ${profileLabel(run.profile)}: ${oneLine(info.line)}`;
    this.releaseRunLocks(run);
    this.store.transferClaim(this.project, run.task, run.id, run.id, this.probes.self);
    t.summary.ended++;

    const cooldown = this.settings.failover.cooldownMinutes * 60000;
    const done = run.failovers ?? 0;
    const capped = done >= this.settings.failover.maxFailovers;
    const profiles = this.profiles(run.agent, run.requestModel);
    const { chosen, skipped } = capped
      ? { chosen: null, skipped: [`failover.max_failovers (${this.settings.failover.maxFailovers}) reached`] }
      : chooseProfile(profiles, run.profileIndex + 1, true, (p) =>
          p.provider === run.profile.provider ? `provider ${p.provider} just failed` : this.unusable(p, run.agent, t.now),
        );
    const next = capped ? null : this.followUp(run, t.now, t.now);
    if (next) {
      next.sessionMode = "new";
      next.sessionId = randomUUID();
      next.failovers = done + 1;
      next.resumeSummary = await this.summary(run, t, `${failoverLabel(info.kind)}: ${info.line}`);
      if (chosen) {
        next.profileIndex = chosen.index;
        next.profile = chosen.profile;
        next.detail = `failing over to ${profileLabel(chosen.profile)}`;
      } else {
        const ends = [
          t.now + cooldown,
          ...profiles.map((p) => this.coolingUntil(p.provider, run.agent, t.now) ?? t.now),
        ];
        next.profileIndex = 0;
        next.profile = profiles[0] ?? run.profile;
        next.notBefore = cooldown > 0 ? Math.min(...ends.filter((at) => at > t.now), t.now + cooldown) : t.now;
        next.detail = `every profile failed or is cooling down; trying again at ${iso(next.notBefore)}`;
      }
    }
    await this.record(
      "failover",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        subject: run.profile.provider,
        summary: capped
          ? `${run.agent} on ${run.task}: ${failoverLabel(info.kind)} on ${profileLabel(run.profile)}; ${done} failovers already: escalating`
          : chosen
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
          nextRunId: next?.id ?? null,
          failovers: done + 1,
          capped,
          coolingUntil: cooldown > 0 ? iso(t.now + cooldown) : null,
        },
      },
      t.now,
    );
    t.summary.failovers++;
    this.store.saveRun(run);
    if (!next) {
      await this.escalate(run, `${done + 1} provider errors or rate limits in a row (failover.max_failovers is ${this.settings.failover.maxFailovers}): ${oneLine(info.line, 200)}`, t, "provider_limit");
      return;
    }
    this.store.insertRun(next);
    this.store.transferClaim(this.project, run.task, run.id, next.id, this.probes.self);
    if (!chosen) await this.raiseExhausted(next, skipped, t);
  }

  /**
   * The tools among `profiles` whose last sign-in check says they are signed
   * out here (none without the AI module). It never waits for a check.
   */
  private signInRefusals(profiles: AgentProfile[]): Map<string, SignInRefusal> {
    const refusals = new Map<string, SignInRefusal>();
    if (!this.tools) return refusals;
    for (const tool of new Set(profiles.map((p) => p.adapter))) {
      try {
        const refusal = this.tools.signInRefusal(tool, this.config);
        if (refusal) refusals.set(tool, refusal);
      } catch (e) {
        // A check that fails says nothing about the sign-in: the start goes ahead
        this.lastError = `the sign-in check of ${tool} failed: ${message(e)}`;
      }
    }
    return refusals;
  }

  /** Start background sign-in checks of an agent's tools, when not fresh: a run on them was just requested. */
  private primeSignIn(profiles: AgentProfile[]): void {
    for (const tool of new Set(profiles.map((p) => p.adapter))) {
      try {
        this.tools?.prime(tool, this.config);
      } catch {
        // Only a head start: the launch asks again
      }
    }
  }

  /**
   * One decision per signed-out tool for the project (its key has no agent
   * or run in it, so the agents and runs that wait on the tool share it). It
   * is withdrawn once the tool's check says it is signed in (signInMoot), and
   * raised again when it is signed out after that. After an answer it is
   * asked again only when the owner said "check again now" and a check since
   * that answer still says signed out: "Keep waiting" is not asked again.
   */
  private async raiseSignedOut(refusals: SignInRefusal[], t: Tick): Promise<void> {
    for (const refusal of refusals) {
      const key = `signin:${refusal.tool}:${refusal.machine}`;
      const known = this.decisions().find?.(this.project, key) ?? null;
      const answeredAt = known?.answeredAt ? Date.parse(known.answeredAt) : NaN;
      const again =
        known?.status === "answered" &&
        known.answer?.optionId === DECISION_RETRY_NOW &&
        Number.isFinite(answeredAt) &&
        refusal.checkedAt > answeredAt;
      const waiting = this.store
        .activeRuns(this.project)
        .filter((run) => run.state === "queued" || run.state === "waiting_lock")
        .filter((run) => this.profiles(run.agent, run.requestModel).some((p) => p.adapter === refusal.tool));
      await this.raise(
        {
          kind: "credential",
          key,
          ref: `signin:${refusal.tool}`,
          blocks: [`agents:${this.project}:tool:${refusal.tool}`],
          question: `${refusal.name} is not signed in on this machine: Lair starts no agent on it here`,
          context: [
            // Fixed words only: the check's own output can name an account or an organisation
            `Its sign-in check (\`${refusal.check.join(" ")}\`) says it is not signed in on this machine.`,
            "",
            refusal.fix
              ? `To fix it, run \`${refusal.fix}\` in a terminal on this machine, as the user Lair runs as. Lair never signs in for you and never reads the tool's own token files.`
              : "Sign the tool in on this machine, as the user Lair runs as. Lair never signs in for you and never reads the tool's own token files.",
            "",
            `Waiting for it: ${waiting.map((run) => `${run.agent} on ${run.task}`).join(", ") || "no run yet"}. A run with a fallback on another tool starts on that one.`,
          ].join("\n"),
          options: [
            {
              id: DECISION_RETRY_NOW,
              effect: "reversible",
              label: "I signed it in: check again now",
              consequences: `Lair checks ${refusal.tool}'s sign-in again now; the runs waiting on it start once it is signed in, and you are asked again if it still isn't.`,
            },
            {
              id: DECISION_WAIT,
              effect: "reversible",
              label: "Keep waiting",
              consequences: `Lair keeps checking; the runs on ${refusal.tool} start once it is signed in. You are not asked again unless it signs in and out again.`,
            },
          ],
          recommended: DECISION_RETRY_NOW,
          structure: {
            class: "agents.cannot_start",
            evidence: {
              code: "probe_failed",
              facts: { tool: refusal.tool, waiting_runs: waiting.length },
              cause_cleared: false,
              linked_issue: null,
            },
          },
          why: "Only you can sign a tool in, with your own account.",
          reversible: true,
        },
        t,
        undefined,
        again,
      );
    }
  }

  /** Every profile is unusable: the only time the owner hears about failover. */
  private async raiseExhausted(run: AgentRun, skipped: string[], t: Tick): Promise<void> {
    await this.raise(
      {
        kind: "escalation",
        key: `exhausted:${run.chainId}`,
        ref: `chain:${run.chainId}`,
        blocks: [`agents:${this.project}:task:${run.task}`],
        question: `Every configured agent profile for ${run.agent} is failing or rate limited; task ${run.task} waits until ${iso(run.notBefore)}`,
        context: ["Profiles:", ...skipped.map((s) => `- ${s}`)].join("\n"),
        options: [
          {
            id: DECISION_WAIT,
            effect: "reversible",
            label: "Wait for the cooldown",
            consequences: `${run.task} starts again when a provider's cooldown ends (add a fallback in agents.fallbacks to widen the choice).`,
          },
          {
            id: DECISION_STOP,
            effect: "frees_task",
            label: "Stop the task",
            consequences: `Lair stops waiting: the waiting run of ${run.task} ends and the task is free for another run.`,
          },
        ],
        recommended: DECISION_WAIT,
        structure: {
          class: "agents.provider_limit",
          evidence: {
            code: "provider_rate_limit",
            facts: { agent: run.agent, task: run.task, profiles_failing: skipped.length, limit_resets_at: iso(run.notBefore) },
            cause_cleared: false,
            linked_issue: null,
          },
        },
        why: "Rate limits and provider errors usually clear on their own.",
        reversible: true,
      },
      t,
      run,
    );
  }

  // ============ TRANSIENT ERRORS ============

  /** The provider's outage now (its newest transient or transient_cleared event decides), or null when it is reachable. */
  private outage(provider: string): Outage | null {
    const [latest] = this.store.listEvents(this.project, { kinds: ["transient", "transient_cleared"], subject: provider, limit: 1 });
    if (!latest || latest.kind !== "transient") return null;
    const data = latest.data;
    const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
    const agents = Array.isArray(data.agents) ? data.agents.filter((a): a is string => typeof a === "string") : [];
    return {
      provider,
      since: num(data.since, latest.at),
      failures: num(data.failures, 1),
      steps: num(data.steps, 1),
      nextTryAt: num(data.nextTryAt, latest.at),
      line: typeof data.line === "string" ? data.line : "",
      agents: agents.length > 0 ? agents : latest.agent ? [latest.agent] : [],
      fleet: data.fleet === true,
      lastAt: latest.at,
      lastAgent: latest.agent ?? "",
    };
  }

  /** Whether `agent`'s starts on the provider wait: every agent's once the outage is the fleet's, else only its own. */
  private downFor(outage: Outage, agent: string): boolean {
    return outage.fleet || outage.agents.includes(agent);
  }

  /**
   * Another run already tries the provider in this backoff step: running (or
   * stopping), started at or after the step's next try. For an outage that
   * is only some agents' so far, only the agent's own runs count. A run that
   * waits on a lock is no try: it holds nothing up.
   */
  private probeInFlight(run: AgentRun, outage: Outage): boolean {
    return this.store
      .activeRuns(this.project)
      .some(
        (other) =>
          other.id !== run.id &&
          other.profile.provider === outage.provider &&
          (outage.fleet || other.agent === run.agent) &&
          (other.state === "running" || other.state === "stopping") &&
          other.spawnedAt !== undefined &&
          other.spawnedAt >= outage.nextTryAt,
      );
  }

  /** The run's log was written after `after`, and its newest lines are not a transient error (a CLI retrying on its own). */
  private wroteSince(run: AgentRun, after: number): boolean {
    if (!run.logPath) return false;
    try {
      if (statSync(run.logPath).mtimeMs <= after) return false;
    } catch {
      return false;
    }
    return matchTransient(lastLines(readTail(run.logPath, 8192), TRANSIENT_TAIL_LINES), this.settings) === null;
  }

  /**
   * A live run shows the provider works: one started during the outage that
   * is alive past dead_on_start_seconds (or exited 0), or one started before
   * it that is still writing its log since the latest transient failure. The
   * provider is reachable again for every agent: the runs waiting on it
   * start on the next check, and the next outage's backoff starts afresh.
   */
  private async noteReachable(run: AgentRun, t: Tick, exitedZero: boolean): Promise<void> {
    if (run.spawnedAt === undefined) return;
    const outage = this.outage(run.profile.provider);
    if (!outage) return;
    const lived = t.now - run.spawnedAt;
    const startedSince = run.spawnedAt >= outage.since;
    const how =
      startedSince && (exitedZero || lived >= this.settings.deadOnStartSeconds * 1000)
        ? exitedZero
          ? "exited 0"
          : `has run ${seconds(lived)}`
        : !startedSince && this.wroteSince(run, outage.lastAt)
          ? "is still writing its log"
          : null;
    if (how === null) return;
    await this.record(
      "transient_cleared",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        subject: outage.provider,
        summary: `provider ${outage.provider} is reachable again: run ${short(run.id)} of ${run.agent} ${how}; starts on it go ahead`,
        evidence: [`unreachable since ${iso(outage.since)}, ${outage.failures} transient failure(s)`],
        data: { provider: outage.provider, since: outage.since, failures: outage.failures, by: startedSince ? "start" : "log" },
      },
      t.now,
    );
  }

  /**
   * The transient retries the run's chain has used, which the run may add
   * one to while under agents.transient_max_retries: every attempt of the
   * chain carries the count, and only a run that lived
   * agents.transient_max_minutes (real work before this outage) starts it
   * again. So an agent whose own output looks transient gets a few retries,
   * then normal recovery and escalation.
   */
  private transientRetriesUsed(run: AgentRun, now: number): number {
    const lived = run.spawnedAt === undefined ? 0 : now - run.spawnedAt;
    return lived >= this.settings.transient.maxMinutes * 60000 ? 0 : (run.transientRetries ?? 0);
  }

  /** The note a recovery event gets when a transient match no longer counts: the chain used its transient retries. */
  private transientCapNote(line: string | null, used: number): string[] {
    if (line === null) return [];
    return [
      `a transient error, but this task used its transient retries (${used} of agents.transient_max_retries ${this.settings.transient.maxRetries}): ${oneLine(line)}`,
    ];
  }

  /**
   * A run that died of a transient network or provider error
   * (agents.transient_patterns), while its chain has transient retries left:
   * not a recovery attempt. The provider is marked unreachable for the
   * run's agent, and for every agent once the outage is the fleet's: a
   * second agent's run dies the same way within TRANSIENT_FLEET_WINDOW, or a
   * retry fails too. A failure at or after the next try is a failed try, and
   * the backoff doubles. The task's next attempt is queued at once with the
   * same counters and goes through launch, where a fallback on another
   * provider wins and, with none, it waits its turn. Nothing counts toward
   * recovery, failover or escalation. A run that died on start starts again
   * as it would have (with any resume summary it was owed); one that ran a
   * while resumes its session.
   */
  private async transientRetry(run: AgentRun, line: string, exit: string, used: number, t: Tick): Promise<void> {
    const provider = run.profile.provider;
    const lived = run.spawnedAt === undefined ? 0 : t.now - run.spawnedAt;
    run.state = "failed";
    run.endedAt = t.now;
    run.detail = `transient: provider ${provider} unreachable (${exit}): ${oneLine(line)}`;
    this.releaseRunLocks(run);
    // The server keeps the task between attempts
    this.store.transferClaim(this.project, run.task, run.id, run.id, this.probes.self);
    t.summary.ended++;

    const previous = this.outage(provider);
    const tried = previous !== null && t.now >= previous.nextTryAt;
    const steps = previous === null ? 1 : tried ? previous.steps + 1 : previous.steps;
    const since = previous?.since ?? t.now;
    const nextTryAt =
      previous !== null && !tried ? previous.nextTryAt : t.now + backoffMs(steps, TRANSIENT_BACKOFF_SECONDS, TRANSIENT_MAX_BACKOFF_SECONDS);
    const failures = (previous?.failures ?? 0) + 1;
    const agents = previous === null ? [run.agent] : previous.agents.includes(run.agent) ? previous.agents : [...previous.agents, run.agent].slice(-50);
    // The fleet's outage: a second agent within the window, or a try (this agent's own retry) that failed too
    const fleet =
      previous !== null &&
      (previous.fleet ||
        (tried && previous.agents.includes(run.agent)) ||
        (previous.lastAgent !== run.agent && t.now - previous.lastAt <= TRANSIENT_FLEET_WINDOW_SECONDS * 1000));
    await this.record(
      "transient",
      {
        agent: run.agent,
        task: run.task,
        runId: run.id,
        subject: provider,
        summary: `${run.agent} on ${run.task}: provider ${provider} unreachable (${exit}); waiting it out${fleet ? " (every agent)" : ""}, next try at ${iso(nextTryAt)} (not counted as a recovery; transient retry ${used + 1} of ${this.settings.transient.maxRetries})`,
        evidence: [`pid ${run.pid} ${exit} after ${seconds(lived)}`, `log: ${oneLine(line)}`],
        data: { provider, line: oneLine(line, 500), since, failures, steps, nextTryAt, agents, fleet, exitCode: run.exitCode ?? null },
      },
      t.now,
    );

    const next = this.followUp(run, t.now, t.now);
    next.transientRetries = used + 1;
    if (run.spawnedAt !== undefined && lived >= this.settings.deadOnStartSeconds * 1000) {
      next.sessionMode = "resume";
    } else {
      // It never got going: what it was owed (a fresh session's summary) is still owed
      next.resumeSummary = run.resumeSummary;
    }
    next.detail = `waiting: provider ${provider} unreachable since ${iso(since)}; next try at ${iso(nextTryAt)}`;
    this.store.saveRun(run);
    this.store.insertRun(next);
    this.store.transferClaim(this.project, run.task, run.id, next.id, this.probes.self);
  }

  /**
   * A provider unreachable for the fleet for agents.transient_max_minutes,
   * with runs waiting on it: one decision for the project per outage (per
   * provider and outage start), never one per agent or task. While it is
   * open, nothing more is raised; once answered ("Keep waiting"), it is
   * asked again after each further transient_max_minutes. Once the outage
   * is over, an open one is withdrawn (mootBy).
   */
  private async checkOutages(t: Tick): Promise<void> {
    const waiting = new Map<string, AgentRun[]>();
    for (const run of this.store.activeRuns(this.project)) {
      if (run.state !== "queued" && run.state !== "waiting_lock") continue;
      waiting.set(run.profile.provider, [...(waiting.get(run.profile.provider) ?? []), run]);
    }
    const max = this.settings.transient.maxMinutes * 60000;
    for (const [provider, runs] of waiting) {
      const outage = this.outage(provider);
      if (!outage || !outage.fleet || t.now - outage.since < max) continue;
      const minutes = Math.round((t.now - outage.since) / 60000);
      const key = `transient:${provider}:${outage.since}`;
      // Answered ("Keep waiting") and the outage goes on: asked again once another transient_max_minutes has passed
      const known = this.decisions().find?.(this.project, key) ?? null;
      const answered = known !== null && known.status !== "open" && known.status !== "withdrawn";
      if (known && answered && t.now - Date.parse(known.answeredAt ?? known.closedAt ?? known.createdAt) < max) continue;
      await this.raise(
        {
          kind: "escalation",
          key,
          ref: `transient:${provider}`,
          blocks: runs.slice(0, 50).map((r) => `agents:${this.project}:task:${r.task}`),
          question: `Provider ${provider} has been unreachable for ${minutes} min (since ${iso(outage.since)}): ${runs.length} run(s) wait for it`,
          context: [
            `${outage.failures} start(s) on ${provider} died of a transient network or provider error (agents.transient_patterns), and none has worked since ${iso(outage.since)}. Nothing was counted as a failure.`,
            `Lair tries one start at a time, every ${TRANSIENT_MAX_BACKOFF_SECONDS / 60} minutes at most; the next at ${iso(outage.nextTryAt)}.`,
            "",
            "The last error line:",
            "",
            "```text",
            oneLine(outage.line, 300).replace(/`/g, "'"),
            "```",
            "",
            "Waiting:",
            ...runs.slice(0, 20).map((r) => `- ${r.agent} on ${r.task} (run ${short(r.id)})`),
            ...(runs.length > 20 ? [`- and ${runs.length - 20} more`] : []),
          ].join("\n"),
          options: [
            {
              id: DECISION_WAIT,
              effect: "reversible",
              label: "Keep waiting",
              consequences: `Lair keeps trying one start on ${provider} at a time; the waiting runs start once one works. If it is still down after another ${this.settings.transient.maxMinutes} minutes, Lair asks again.`,
            },
            {
              id: DECISION_RETRY_NOW,
              effect: "reversible",
              label: "Try now",
              consequences: `Every run waiting on ${provider} starts on the next check (choose this once the network or the provider is back). If they fail the same way, they wait again.`,
            },
          ],
          recommended: DECISION_WAIT,
          structure: {
            class: "agents.provider_limit",
            evidence: {
              code: "provider_unreachable",
              facts: { provider, runs_waiting: runs.length, since: iso(outage.since), failures: outage.failures },
              cause_cleared: false,
              linked_issue: null,
            },
          },
          why: `Network and provider outages usually end on their own, and nothing waiting is counted against a task; this one has lasted longer than agents.transient_max_minutes (${this.settings.transient.maxMinutes}).`,
          reversible: true,
        },
        t,
        undefined,
        answered,
      );
    }
  }

  /** The providers marked unreachable now (any of the agents' profiles or active runs), for the status view. */
  private unreachableViews(agents: AgentView[]): ProviderUnreachableView[] {
    const active = this.store.activeRuns(this.project);
    const providers = new Set([...agents.flatMap((a) => a.profiles.map((p) => p.provider)), ...active.map((r) => r.profile.provider)]);
    const views: ProviderUnreachableView[] = [];
    for (const provider of [...providers].sort()) {
      const outage = this.outage(provider);
      if (!outage) continue;
      views.push({
        provider,
        since: iso(outage.since),
        failures: outage.failures,
        nextTryAt: iso(outage.nextTryAt),
        line: outage.line,
        fleet: outage.fleet,
        agents: outage.agents,
        waiting: active.filter(
          (r) =>
            r.profile.provider === provider &&
            (r.state === "queued" || r.state === "waiting_lock") &&
            this.downFor(outage, r.agent),
        ).length,
      });
    }
    return views;
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
        // The agent writes this text: a negative amount would buy budget back
        if (Number.isFinite(tk)) {
          tokens += Math.max(0, tk);
          found = true;
        }
        if (Number.isFinite(cs)) {
          cost += Math.max(0, cs);
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
            ref: `budget:${key}`,
            blocks: [`agents:${this.project}:budget:${scopeKey}`],
            question: `${text.charAt(0).toUpperCase()}${text.slice(1)}. No new runs ${scope.scope === "project" ? "in this project" : `for ${scope.agent}`} until ${until}. Allow runs over the limit?`,
            context: [
              `Scope: ${scopeKey}`,
              `Metric: ${line.metric} for ${line.period}`,
              `Used: ${line.used} (soft ${line.soft ?? "none"}, hard ${line.hard ?? "none"})`,
              "Runs already working continue; new runs and restarts wait.",
            ].join("\n"),
            options: [
              {
                id: DECISION_ALLOW,
                effect: "outward",
                label: `Allow runs over the limit until ${until}`,
                consequences: `New runs and restarts ${scope.scope === "project" ? "in this project" : `for ${scope.agent}`} start again, past the ${line.metric} hard limit, until ${until}. To change the limit itself, edit agents.budgets.`,
              },
              {
                id: DECISION_WAIT,
                effect: "reversible",
                label: `Wait until ${until}`,
                consequences: `Nothing new starts ${scope.scope === "project" ? "in this project" : `for ${scope.agent}`} until the period ends.`,
              },
            ],
            recommended: DECISION_WAIT,
            structure: {
              class: "agents.budget",
              evidence: {
                code: "budget_exceeded",
                facts: { scope: scopeKey, metric: line.metric, period: line.period, used: line.used },
                cause_cleared: false,
                linked_issue: null,
              },
            },
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

  /**
   * Claims no active run handled this tick: released when their owner is
   * dead, or when their run has ended. Owners are judged on a process reading
   * taken after the claims were read. A live owner's claim whose run isn't in
   * the store (yet) is left alone.
   */
  private async reapClaims(t: Tick): Promise<void> {
    const claims = this.store.listClaims(this.project).filter((claim) => !t.touchedTasks.has(claim.task));
    const snap = claims.some((c) => !t.snap.isAlive(c.ownerPid, c.ownerStartedAt)) ? await this.relist(t) : t.snap;
    for (const claim of claims) {
      const run = this.store.getRun(claim.runId);
      const alive = snap.isAlive(claim.ownerPid, claim.ownerStartedAt);
      if (alive && (!run || isActive(run.state))) continue;
      const why = !alive ? "no live process owns it" : `its run ${short(claim.runId)} has ended (${run?.state})`;
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

  /**
   * Request a run: the task is claimed now, and the run starts on the next
   * tick. `origin` marks a chain agents.fill started (for its max_active).
   */
  requestRun(input: RunRequest, options: { origin?: RunOrigin } = {}): Promise<AgentRunView> {
    return this.exclusive(async () => {
      if (this.readOnly) throw new AgentsError(403, "The project is read_only: Lair starts no agents");
      const { agent, task, prompt, model } = input;
      const variables = moduleVariables(input.variables);
      if (typeof variables === "string") throw new AgentsError(400, `Invalid run variables: ${variables}`);
      if (typeof agent !== "string" || !isValidDragonId(agent) || !knownDragonIds(this.config).has(agent)) {
        throw new AgentsError(400, `Unknown agent: ${String(agent)}`);
      }
      if (!isValidTaskId(task)) {
        throw new AgentsError(
          400,
          "Invalid task: 1-128 characters (letters, digits, '.', '_', '-', '/', ':', '#'), starting with a letter or digit, with no '.' or '..' segment",
        );
      }
      if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
        throw new AgentsError(400, `Invalid prompt: a non-empty string of at most ${MAX_PROMPT_CHARS} characters`);
      }
      if (model !== undefined && (typeof model !== "string" || !MODEL_ID.test(model))) {
        throw new AgentsError(400, "Invalid model id");
      }
      if (model !== undefined) {
        // Only a model the project configured for this agent (its own, or a fallback's)
        const allowed = [...new Set(this.profiles(agent).map((p) => p.model).filter((m): m is string => !!m))];
        if (!allowed.includes(model)) {
          throw new AgentsError(
            400,
            `Model ${model} is not one of agent ${agent}'s models (${allowed.join(", ") || "none configured"})`,
          );
        }
      }
      const busy = this.store.activeRunForAgent(this.project, agent);
      if (busy) {
        throw new AgentsError(409, `Agent ${agent} is busy: run ${short(busy.id)} on task ${busy.task} is ${busy.state}`);
      }
      // Fill matching by agent: the agent's lines about another task would read as its open fill task's
      const open = options.origin === "fill" ? null : this.fill?.openTaskFor(agent, task);
      if (open) throw new AgentsError(409, openTaskRefusal(agent, open));
      const now = this.probes.clock.now();
      const blocked = this.budgetBlock(agent, now);
      if (blocked) throw new AgentsError(403, `Over budget: ${blocked}`);
      const profiles = this.profiles(agent, model);
      if (profiles.length === 0) throw new AgentsError(400, `Agent ${agent} has no adapter to start it with`);
      // Its tools' sign-in is checked in the background meanwhile, so the start has an answer to go by
      this.primeSignIn(profiles);

      const t = await this.newTick();
      const id = randomUUID();
      const run: AgentRun = {
        id,
        project: this.project,
        task,
        agent,
        prompt,
        requestModel: model,
        variableNames: Object.keys(variables).length > 0 ? Object.keys(variables) : undefined,
        ownPrompt: input.ownPrompt === true ? true : undefined,
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
        origin: options.origin,
        // Fill's done_pattern looks at the queue lines written after this
        queueMark: queueMark(this.config.queue_file),
      };
      const claimed = await this.claimFor(t, task, id, agent);
      if (!claimed.ok) {
        const holder = claimed.holder;
        throw new AgentsError(
          409,
          `Task ${task} is already claimed by run ${short(holder.runId)} (agent ${holder.agent}, ${t.snap.describe(holder.ownerPid, holder.ownerStartedAt)})`,
        );
      }
      this.store.insertRun(run);
      if (run.variableNames) this.moduleVars.set(id, variables);
      if (claimed.replaced) await this.claimReleased(claimed.replaced, t, "a new run claimed the task");
      await this.record(
        "requested",
        {
          agent,
          task,
          runId: id,
          summary: `requested ${agent} on ${task} (${profileLabel(profiles[0])})${options.origin ? ` by ${options.origin}` : ""}`,
          data: { profile: profiles[0], origin: options.origin ?? null },
        },
        now,
      );
      return runView(run);
    });
  }

  /** A config reload: take over the run variables of the service this one replaces (same project, same store). */
  adoptModuleVariables(previous: AgentsService): void {
    for (const [chain, vars] of previous.moduleVars) this.moduleVars.set(chain, vars);
    previous.moduleVars.clear();
  }

  /**
   * Release a task's claim. A running run notices on the next tick and stops
   * itself; a run that hasn't started yet ends now. `why`: who asked, when
   * not the owner through the API (an in-process module).
   */
  releaseClaim(task: string, why?: string): Promise<{ task: string; runId: string; runState: string | null }> {
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
          evidence: [why ? `released by ${oneLine(why, 200)}` : "released through the API (Agents view)"],
          data: { by: why ? "module" : "request", ownerPid: claim.ownerPid },
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
      const t = await this.newTick();
      if (run.state === "running") {
        await this.stopRun(run, "fresh_session", "a fresh session was requested", ["requested through the API (Agents view)"], t);
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
      return runView(await this.restartFresh(run, t, "a fresh session was requested"));
    });
  }

  /** Start an ended run's task again in a fresh session: the next attempt of its chain. */
  private async restartFresh(run: AgentRun, t: Tick, why: string): Promise<AgentRun> {
    if (run.state === "completed") throw new AgentsError(409, `Run ${short(run.id)} completed its task`);
    const busy = this.store.activeRunForAgent(this.project, run.agent);
    if (busy) throw new AgentsError(409, `Agent ${run.agent} is busy with task ${busy.task}`);
    // As for a new run (requestRun): with fill matching by agent, not while the agent's fill task on another task is open
    const open = this.fill?.openTaskFor(run.agent, run.task);
    if (open) throw new AgentsError(409, openTaskRefusal(run.agent, open));
    const blocked = this.budgetBlock(run.agent, t.now);
    if (blocked) throw new AgentsError(403, `Over budget: ${blocked}`);
    const next = this.followUp(run, t.now, t.now);
    next.startRetries = 0;
    const claimed = await this.claimFor(t, run.task, next.id, run.agent);
    if (!claimed.ok) throw new AgentsError(409, `Task ${run.task} is claimed by run ${short(claimed.holder.runId)}`);
    await this.switchToFresh(next, run, t, why);
    this.store.insertRun(next);
    return next;
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
    const agents = this.agentIds().map((id) => this.agentView(id, claims, now, alive));
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
      fill: this.fillStatus(),
      unreachable: this.unreachableViews(agents),
    };
  }

  /**
   * The agents this module has an active run for (queued, waiting on a lock,
   * running or stopping), with the run and the agent's state as the Agents
   * view derives it: what the Dragons view shows as "managed by Lair".
   */
  managedRuns(): Map<string, ManagedRunInfo> {
    const now = this.probes.clock.now();
    const runs = new Map<string, ManagedRunInfo>();
    for (const run of this.store.activeRuns(this.project)) {
      // activeRuns is oldest first: an agent's newest active run wins
      const previous = run.previousRunId ? this.store.getRun(run.previousRunId) : null;
      const { state, detail } = deriveState(run, run, previous, this.budgetBlock(run.agent, now));
      runs.set(run.agent, { runId: run.id, task: run.task, state, detail });
    }
    return runs;
  }

  /** agents.fill: enabled, the last check, and each tasks_file line's state then. */
  fillStatus(): FillStatusView {
    if (this.fill) return this.fill.view();
    const fill = this.settings.fill;
    return {
      enabled: false,
      running: false,
      tasksFile: fill.tasksFile ?? null,
      agents: fill.agents,
      maxActive: fill.maxActive,
      active: 0,
      intervalSeconds: fill.intervalSeconds,
      lastCheck: null,
      lastError: null,
      lines: [],
      unmatchedReports: [],
      warnings: fill.warnings,
    };
  }

  /** Run one fill check now (the fill loop runs them every fill.interval_seconds; checkNow runs one too). */
  async checkFill(): Promise<FillStatusView> {
    if (!this.fill) throw new AgentsError(404, `agents.fill is off for ${this.project}`);
    await this.fill.check();
    return this.fill.view();
  }

  /** The owner's "check now" (POST /api/agents/tick): a tick, then a fill check when fill is on. */
  async checkNow(): Promise<AgentsTickSummary> {
    const summary = await this.tick();
    if (this.fill) await this.checkFill();
    return summary;
  }

  /**
   * Whether the ready guard accepts `line` as `task`'s done report (true when
   * fill or the guard is off). The planner settles a task through this too, so a
   * refused report is a done nowhere.
   */
  async reportAccepted(agent: string, task: string, line: string, taskText: string): Promise<boolean> {
    if (!this.fill) return true;
    return (await this.fill.guardReport(agent, task, line, this.store.latestRunForTask(this.project, task), taskText)) === null;
  }

  /**
   * The owner releases a task fill holds for them (an owner or no_done hold,
   * at fill's last check): fill starts it again on its next check, and counts
   * its completions without done from zero. Only while the run that hold was
   * about is still the task's latest: a release seen after the task moved on
   * (the owner answered its escalation with a fresh session, say) would lift
   * a hold the owner never saw, so it is refused, as the decision's answer is.
   * The planner (src/server/planner/, in-process: an unblock it applies) may
   * release only a blocked or no_done hold (a run that stopped without done
   * and said so): an owner, waiting or waited_too_long hold stays the owner's.
   */
  releaseFillHold(task: string, by: "owner" | "planner" = "owner"): Promise<{ task: string; runId: string | null }> {
    return this.exclusive(async () => {
      if (!this.fill) throw new AgentsError(404, `agents.fill is off for ${this.project}`);
      if (this.readOnly) throw new AgentsError(403, "The project is read_only");
      const line = this.fill.lineFor(task);
      if (!line || line.state !== "held" || line.hold === null || !OWNER_HOLDS.includes(line.hold)) {
        throw new AgentsError(
          409,
          `Task ${task} is not held for the owner at fill's last check${line ? ` (it is ${line.state}${line.hold ? `: ${line.hold}` : ""})` : ""}`,
        );
      }
      if (by === "planner" && line.hold !== "no_done" && line.hold !== "blocked") {
        throw new AgentsError(409, `Task ${task} is held for the owner (${line.hold}): only the owner releases that hold`);
      }
      const latest = this.store.latestRunForTask(this.project, task);
      if (line.runId !== (latest?.id ?? null)) {
        throw new AgentsError(
          409,
          `Task ${task} has moved on since fill's last check: its latest run is ${latest ? `${short(latest.id)} (${latest.state})` : "gone"}, not ${line.runId ? short(line.runId) : "none"}; nothing to release`,
        );
      }
      await this.recordFillRelease(task, latest, by, this.probes.clock.now());
      return { task, runId: latest?.id ?? null };
    });
  }

  /** Lift fill's owner hold on `task` for its latest run and chain (see fill.ts). */
  private async recordFillRelease(
    task: string,
    latest: AgentRun | null,
    by: "owner" | "decision" | "planner",
    now: number,
  ): Promise<void> {
    await this.record(
      "fill_released",
      {
        agent: latest?.agent,
        task,
        runId: latest?.id,
        summary:
          by === "planner"
            ? `the planner released fill's hold on ${task} (an unblock it applied): fill starts it again`
            : `the owner released fill's hold on ${task}${by === "decision" ? " (a decision)" : ""}: fill starts it again`,
        data: { by, runId: latest?.id ?? null, chainId: latest?.chainId ?? null },
      },
      now,
    );
  }

  private agentView(
    id: string,
    claims: Claim[],
    now: number,
    alive: (pid: number, started: number) => boolean | null,
  ): AgentView {
    const active = this.store.activeRunForAgent(this.project, id);
    const latest = active ?? this.store.latestRunForAgent(this.project, id);
    const budget = evaluateBudget(this.store, this.project, id, agentLimits(this.settings, id), now);
    // Over budget is what blocks new runs: a hard limit the owner didn't allow runs past
    const overBudget = this.budgetBlock(id, now);
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

  /**
   * Tick at once, then every interval_seconds, until stop(); and the fill loop, when it is on. The first tick
   * reconciles the runs the store says are active before it judges anything, and fill starts nothing until then.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconcilePending = true;
    this.reconciled.clear();
    this.fill?.start();
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
    this.timer = setTimeout(loop, 0);
    this.timer.unref();
  }

  /**
   * The runs the store says are running, against the process table, before the first tick after start() judges
   * anything (docs/design/autonomy.md §6). A run whose process is provably its own (pid and start time) is
   * adopted: supervised from here on, its claim kept. One whose pid another process has now (another start time)
   * is lost: ended, its task free, and that process never signalled. One whose process is gone is left to the
   * tick, which classifies its exit by its queue line as before.
   *
   * Lost and gone need two readings to agree: the tick's own (which may come from the shared cache) and a fresh
   * one taken after it. When the fresh one fails, the run has no verdict yet: it keeps its state, claim and locks,
   * and the next tick tries again. True once every run has its verdict.
   */
  private async reconcile(t: Tick): Promise<boolean> {
    const counts = { adopted: 0, lost: 0, gone: 0, unknown: 0 };
    for (const run of this.store.activeRuns(this.project)) {
      if (run.state !== "running" && run.state !== "stopping") continue;
      if (this.reconciled.has(run.id)) continue; // a verdict on an earlier tick
      // A config reload hands over the runs this server process started
      const startedHere = run.pid !== undefined && this.probes.spawner.knows(run.pid);
      let verdict = reconcileRun(run, t.first, startedHere);
      if (verdict.kind !== "adopted") {
        const confirmed = await this.confirmingReading(t);
        if (!confirmed) {
          counts.unknown++;
          continue;
        }
        verdict = reconcileRun(run, confirmed, startedHere);
      }
      this.reconciled.add(run.id);
      counts[verdict.kind]++;
      if (verdict.kind === "adopted") {
        if (startedHere) continue; // not a restart: nothing to record
        await this.record(
          "run_adopted",
          {
            agent: run.agent,
            task: run.task,
            runId: run.id,
            summary: `adopted ${run.agent}'s run ${short(run.id)} on ${run.task} after a restart (pid ${run.pid})`,
            evidence: [verdict.evidence],
            data: { pid: run.pid ?? null, pgid: run.pgid ?? null, commandDiffers: verdict.commandDiffers },
          },
          t.now,
        );
      } else if (verdict.kind === "lost") {
        const detail = `lost in a restart: ${verdict.reason}; that process isn't the run's, so Lair leaves it alone`;
        await this.endRun(run, "failed", detail, t, true);
        await this.record(
          "run_lost",
          {
            agent: run.agent,
            task: run.task,
            runId: run.id,
            summary: `${run.agent}'s run ${short(run.id)} on ${run.task} was lost in a restart: ${verdict.reason}`,
            evidence: [verdict.reason],
            data: { pid: run.pid ?? null, pgid: run.pgid ?? null },
          },
          t.now,
        );
      }
    }
    if (counts.adopted + counts.lost + counts.gone + counts.unknown > 0) {
      console.log(
        `[agents] ${this.project}: reconciled the active runs: ${counts.adopted} adopted, ${counts.lost} lost, ` +
          `${counts.gone} gone (their exit is classified by their queue line)` +
          (counts.unknown > 0 ? `, ${counts.unknown} not yet (the second reading failed: the next tick tries again)` : ""),
      );
    }
    return counts.unknown === 0;
  }

  /**
   * A live process that runs a run of `task` no active run here owns: its command line holds one of the task's
   * run prompt files. Fill starts nothing for the task while there is one.
   */
  private async taskProcess(task: string): Promise<ProcessInfo | null> {
    const ignore = new Set<number>([this.probes.self.pid]);
    for (const run of this.store.activeRuns(this.project)) if (run.pid !== undefined) ignore.add(run.pid);
    const agents = [...loadKnownDragons(this.config).keys()];
    return findTaskProcess(await this.probes.processes.list(), getPromptsDir(this.config), task, agents, ignore);
  }

  /**
   * Stop ticking and filling; resolves once the fill check, tick or action in
   * progress has finished (fill first, so it requests nothing more).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.fill?.stop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.ticking?.catch(() => undefined);
    await this.queue;
  }

  /**
   * The server's planned shutdown with agents.on_restart: stop (after stop()). Each running run whose process is
   * provably its own gets SIGTERM to its process group; up to stop_grace_seconds (never more than `maxWaitMs`)
   * for them to end, then SIGKILL; each signal is recorded. The runs stay stopping: the next server's first tick
   * ends them by their queue line. With on_restart: adopt (the default) nothing is signalled.
   *
   * A run this server started is judged by the spawner alone (its exit status). Any other (adopted after a
   * restart) only on a fresh reading of the process table, never the cached one: a reading seconds old would keep
   * a run that ended on SIGTERM waiting for the SIGKILL, or drop a live one before it. When a fresh reading fails,
   * an adopted run is not signalled (it can't be proven the run's), and while waiting it counts as still running.
   */
  async stopRunsForShutdown(maxWaitMs: number): Promise<{ signalled: number; killed: number }> {
    if (this.settings.onRestart !== "stop" || this.readOnly) return { signalled: 0, killed: 0 };
    return this.exclusive(async () => {
      const known = (run: AgentRun) => run.pid !== undefined && this.probes.spawner.knows(run.pid);
      const exited = (run: AgentRun) => run.pid === undefined || this.probes.spawner.exitCode(run.pid) !== undefined;
      const active = this.store.activeRuns(this.project).filter((run) => run.state === "running" || run.state === "stopping");
      const fresh = async (): Promise<ProcessSnapshot | null> => {
        if (active.every(known)) return null; // nothing to read for
        try {
          return await this.readSnapshot(true);
        } catch (e) {
          console.warn(`[agents] ${this.project}: reading the process table for the shutdown failed: ${message(e)}`);
          return null;
        }
      };
      const first = await fresh();
      const t = this.tickOn(first ?? new ProcessSnapshot([], this.probes.clock.now(), this.probes.self, this.settings.pidStartToleranceSeconds));
      const own = active.filter(
        (run) => !exited(run) && (known(run) || (first !== null && reconcileRun(run, first, false).kind === "adopted")),
      );
      const recordSignal = (run: AgentRun, signal: "SIGTERM" | "SIGKILL", at: number) =>
        this.record(
          "stopped_for_shutdown",
          {
            agent: run.agent,
            task: run.task,
            runId: run.id,
            summary: `${signal} to ${run.agent}'s run ${short(run.id)} on ${run.task} (process group ${run.pgid ?? run.pid}) for the server's shutdown`,
            evidence: ["agents.on_restart: stop"],
            data: { pid: run.pid ?? null, pgid: run.pgid ?? null, signal },
          },
          at,
        );
      for (const run of own) {
        if (run.state === "running") {
          await this.stopRun(run, "server_shutdown", "the server is shutting down (agents.on_restart: stop)", [], t);
        } else if (run.pid !== undefined) {
          // Already stopping (hung, failover): its reason stays for the next server
          this.probes.spawner.kill(run.pid, "SIGTERM");
        }
        await recordSignal(run, "SIGTERM", t.now);
      }
      const until = t.now + Math.min(this.settings.stopGraceSeconds * 1000, maxWaitMs);
      let alive = own;
      /** The latest reading of the table: an adopted run is SIGKILLed only when it shows the run's process */
      let reading = first;
      while (alive.length > 0 && this.probes.clock.now() < until) {
        await this.probes.clock.sleep(Math.min(SHUTDOWN_POLL_MS, until - this.probes.clock.now()));
        if (!alive.every(known)) reading = await fresh();
        alive = alive.filter((run) => {
          if (exited(run)) return false;
          if (known(run) || reading === null) return true; // unread: alive until a reading says otherwise
          return run.pid !== undefined && reading.isAlive(run.pid, run.pidStartedAt);
        });
      }
      // A run that looked alive only because the table couldn't be read is not proven its run's process: no SIGKILL
      const unproven = reading === null ? alive.filter((run) => !known(run)) : [];
      alive = alive.filter((run) => !unproven.includes(run));
      for (const run of unproven) {
        console.warn(
          `[agents] ${this.project}: no SIGKILL to pid ${run.pid} (run ${short(run.id)}): the process table couldn't be read to prove it the run's`,
        );
      }
      for (const run of alive) {
        if (run.pid === undefined) continue;
        this.probes.spawner.kill(run.pid, "SIGKILL");
        run.killed = true;
        run.detail = `${run.detail} (SIGKILL: still running when the shutdown's wait ended)`;
        this.store.saveRun(run);
        await recordSignal(run, "SIGKILL", this.probes.clock.now());
      }
      if (own.length > 0) {
        console.log(`[agents] ${this.project}: stopped ${own.length} run(s) for the shutdown, ${alive.length} with SIGKILL`);
      }
      return { signalled: own.length, killed: alive.length };
    });
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
  /** Tool sign-in checks (src/server/ai/): a tool signed out on this machine starts no run here */
  tools?: ToolReadiness;
}

/**
 * All projects' agents services. The store (data/agents.db) is opened only
 * when at least one project enables the module.
 */
/** How other modules start agent runs, in-process (AgentsManager has it). */
export interface AgentRuns {
  requestRun(project: string, input: RunRequest): Promise<AgentRunView>;
}

export class AgentsManager implements SupervisedAgents, AgentRuns {
  private services = new Map<string, AgentsService>();
  private problems = new Map<string, string[]>();
  private configs = new Map<string, ProjectConfig>();
  private store: AgentsStore | null = null;
  private probes: AgentProbes | null = null;
  private decisions: DecisionInbox | null;
  private fallbackInbox: DecisionInbox | null = null;
  /** Per project: stop following its answers */
  private stopFollowing = new Map<string, () => void>();
  private producer: DecisionProducer | null = null;
  /** useEvidenceUpdates(): off by default */
  private evidenceUpdates = false;
  /** "started" between start() and stop(); a reload never runs once "stopped" */
  private phase: "loaded" | "started" | "stopped" = "loaded";

  constructor(private options: AgentsManagerOptions) {
    this.decisions = options.decisions ?? null;
  }

  private readyFacts: ((project: string) => ReadyFactsSource | undefined) | null = null;

  /** Where the ready guard reads a project's PRs from (the review module's host); set before load(). */
  useReadyFacts(facts: (project: string) => ReadyFactsSource | undefined): void {
    this.readyFacts = facts;
  }

  /** Raise decisions through `inbox` instead (a stand-in for the Decision Inbox, in tests). */
  setDecisionInbox(inbox: DecisionInbox): void {
    this.decisions = inbox;
  }

  /**
   * Ask through the Decision Inbox (src/server/decisions/; mountDecisions
   * calls this for its producers) and follow the answers: each service gets
   * its project's answers (AgentsService.followAnswer), also those given
   * while the server was down. A decision the inbox refuses goes to the
   * project's inbox file instead.
   */
  useDecisions(decisions: DecisionProducer): void {
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    this.producer = decisions;
    this.decisions = new ProducerDecisions(decisions, this.fileInbox(), { evidenceUpdates: this.evidenceUpdates });
    for (const [project, service] of this.services) this.follow(project, service);
  }

  /**
   * Re-evaluate the evidence of decisions this module raised (a provider-limit decision's cause cleared once
   * its reset time passed: AgentsService.refreshCauses). Off until the decision policies turn it on
   * (src/server/decisions/policies/, data/server.yaml decision_policies.enabled); off, no decision's evidence
   * changes after it was raised.
   */
  useEvidenceUpdates(on: boolean): void {
    this.evidenceUpdates = on;
    if (this.producer) this.decisions = new ProducerDecisions(this.producer, this.fileInbox(), { evidenceUpdates: on });
  }

  private follow(project: string, service: AgentsService): void {
    if (!this.producer) return;
    this.stopFollowing.set(project, this.producer.onResolved(DECISION_MODULE, (r) => service.followAnswer(r), { project }));
  }

  private getProbes(): AgentProbes {
    this.probes ??= this.options.probes ?? systemAgentProbes();
    return this.probes;
  }

  private fileInbox(): DecisionInbox {
    const probes = this.getProbes();
    this.fallbackInbox ??= new InboxFileDecisions((project) => this.configs.get(project)?.inbox_file, probes.fs, probes.clock);
    return this.fallbackInbox;
  }

  private inbox(): DecisionInbox {
    return this.decisions ?? this.fileInbox();
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
          tools: this.options.tools,
          readyFacts: () => this.readyFacts?.(entry.name),
        }),
      );
    }
  }

  start(): string[] {
    this.phase = "started";
    for (const service of this.services.values()) service.start();
    return [...this.services.keys()];
  }

  /** A method, so a check after an await reads the phase again (stop() may have run meanwhile). */
  private inPhase(phase: "loaded" | "started" | "stopped"): boolean {
    return this.phase === phase;
  }

  /**
   * Apply a project's new config (src/server/reload/): its service stops as
   * on shutdown (the tick or action in progress finishes; the agents keep
   * running), then the new one starts and re-adopts them by pid from the
   * store, as after a restart. Other projects are not touched. A service
   * that fails to start is stopped and removed before the error is thrown.
   */
  async reloadProject(entry: ProjectEntry): Promise<void> {
    if (this.inPhase("stopped")) return;
    this.stopFollowing.get(entry.name)?.();
    this.stopFollowing.delete(entry.name);
    const old = this.services.get(entry.name);
    if (old) {
      await old.stop();
      old.dispose();
    }
    if (this.inPhase("stopped")) return;
    this.services.delete(entry.name);
    this.problems.delete(entry.name);
    this.configs.delete(entry.name);
    this.load([entry]);
    const next = this.services.get(entry.name);
    if (!next) return;
    // The runs go on in the same store: their in-memory run variables go on with them
    if (old) next.adoptModuleVariables(old);
    try {
      this.follow(entry.name, next);
      if (this.inPhase("started")) next.start();
    } catch (e) {
      this.stopFollowing.get(entry.name)?.();
      this.stopFollowing.delete(entry.name);
      await next.stop();
      next.dispose();
      this.services.delete(entry.name);
      throw e;
    }
  }

  /**
   * Stop every service, wait for work in progress, then close the store. The server's own shutdown is `planned`:
   * a project with agents.on_restart: stop then stops its runs too, waiting on them SHUTDOWN_RUN_WAIT_MS at most.
   */
  async stop(options: { planned?: boolean } = {}): Promise<void> {
    this.phase = "stopped";
    for (const stop of this.stopFollowing.values()) stop();
    this.stopFollowing.clear();
    await Promise.all([...this.services.values()].map((service) => service.stop()));
    if (options.planned) {
      await Promise.all(
        [...this.services.values()].map((service) =>
          service.stopRunsForShutdown(SHUTDOWN_RUN_WAIT_MS).catch((e) => {
            console.error(`[agents] ${service.project}: stopping the runs for the shutdown failed:`, e);
          }),
        ),
      );
    }
    for (const service of this.services.values()) service.dispose();
    this.services.clear();
    this.store?.close();
    this.store = null;
  }

  get(project: string): AgentsService | undefined {
    return this.services.get(project);
  }

  /**
   * Start a run from another module (the scheduler, the planner): the
   * in-process way, AgentRuns. Over HTTP only the owner may start runs.
   */
  requestRun(project: string, input: RunRequest): Promise<AgentRunView> {
    const service = this.services.get(project);
    if (!service) return Promise.reject(new AgentsError(404, `The agents module is off for ${project}`));
    return service.requestRun(input);
  }

  getStore(): AgentsStore | null {
    return this.store;
  }

  /**
   * For the watchdog (SupervisedAgents): an agent with an active run here is
   * this module's to recover, so the watchdog's agent_hung and orphan_claim
   * leave it alone.
   */
  supervisedReason(project: string, agent: string): string | null {
    if (!this.services.has(project) || !this.store) return null;
    const run = this.store.activeRunForAgent(project, agent);
    return run ? `run ${run.id.slice(0, 8)} on ${run.task} is ${run.state}` : null;
  }

  /** For the Dragons view: the agents with an active run in `project` (none when the module is off for it). */
  managedRuns(project: string): Map<string, ManagedRunInfo> {
    return this.services.get(project)?.managedRuns() ?? new Map();
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
