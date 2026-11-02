/**
 * Agents module internals: the stored run, claim and event records. Times
 * are milliseconds from the service's Clock; the API views
 * (src/shared/agents-types.ts) carry ISO strings.
 */
import type {
  AgentEventKind,
  AgentEventView,
  AgentProfile,
  AgentRunState,
  AgentRunView,
  ClaimView,
  RunOrigin,
  SessionMode,
  StopReason,
} from "../../shared/agents-types.js";

/** Task ids: they reach argv placeholders and file names, so no shell characters and no leading dash. */
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}$/;

/** A task id: TASK_ID, no leading "/", and no "." or ".." path segment. */
export function isValidTaskId(task: unknown): task is string {
  return (
    typeof task === "string" &&
    TASK_ID.test(task) &&
    !task.startsWith("/") &&
    !task.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/**
 * Where the queue file stood when a task's chain was requested: its size,
 * and a hash of the bytes just before that point (so a rewritten file is
 * noticed). Fill matches done_pattern against the lines written after it.
 */
export interface QueueMark {
  offset: number;
  /** sha256 (hex) of the up to 256 bytes before `offset` */
  tail: string;
}

export const ACTIVE_STATES: readonly AgentRunState[] = ["queued", "waiting_lock", "running", "stopping"];

export function isActive(state: AgentRunState): boolean {
  return ACTIVE_STATES.includes(state);
}

/** What a run waits on, in ms. */
export interface StoredLockWait {
  lock: string;
  path: string;
  holderPid: number | null;
  holderStartedAt: number | null;
  holderAlive: boolean;
  since: number;
  detail: string;
}

export interface FailoverInfo {
  kind: "rate_limit" | "provider_error";
  line: string;
  /** The line is a transient error (agents.transient_patterns): waited out, not failed over */
  transient?: boolean;
}

export interface AgentRun {
  id: string;
  project: string;
  task: string;
  agent: string;
  /** The task card: what the agent is asked to do */
  prompt: string;
  /** The model the request asked for (overrides the agent's own) */
  requestModel?: string;
  /** The module run variables the chain was requested with, by name (their values are only in memory) */
  variableNames?: string[];
  /** The requesting module's prompt is the whole task: no default_instructions before it (RunRequest.ownPrompt) */
  ownPrompt?: boolean;
  chainId: string;
  previousRunId?: string;
  attempt: number;
  profileIndex: number;
  profile: AgentProfile;
  sessionId: string;
  sessionMode: SessionMode;
  sameSessionRestarts: number;
  freshSessions: number;
  startRetries: number;
  launchFailures: number;
  /** Failovers so far in this chain (capped by failover.max_failovers) */
  failovers?: number;
  /** Written into the prompt file of a fresh session or a fallback run */
  resumeSummary?: string;
  state: AgentRunState;
  detail: string;
  stopReason?: StopReason;
  stopDetail?: string;
  stopEvidence?: string[];
  stopRequestedAt?: number;
  killed?: boolean;
  failover?: FailoverInfo;
  waitingLock?: StoredLockWait;
  pid?: number;
  /** Process group id (for signalling the agent and its children) */
  pgid?: number;
  pidStartedAt?: number;
  /** A fingerprint of the start command as `ps` shows it (reconcile.ts: noted when a live pid shows another one) */
  commandFingerprint?: string;
  requestedAt: number;
  notBefore: number;
  /** When the current attempt to start began (budget and profile waits don't count) */
  launchingSince?: number;
  spawnedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  logPath?: string;
  /** Bytes of the log already read for usage */
  logOffset: number;
  promptFile?: string;
  lastError?: string;
  /** What started the chain, when it was agents.fill (kept by every attempt) */
  origin?: RunOrigin;
  /** The queue file when the chain was requested (kept by every attempt) */
  queueMark?: QueueMark;
  /**
   * Transient retries the chain has used (agents.transient_max_retries):
   * kept by every attempt, so an agent's own output can't buy endless ones
   */
  transientRetries?: number;
  /** How the run ended (set with its end state): what the AI spend record classifies it by */
  endKind?: RunEndKind;
  /** It ended while no Lair server watched its process (its exit status is lost): its end is its log's last write */
  exitUnseen?: boolean;
  /** Bytes of the prompt file Lair wrote for it (the resume summary included) */
  contextBytes?: number;
}

/**
 * How a run ended: "completed" (exit 0, or its own queue line once its exit status was lost), else why it failed.
 * The failed kinds are the AI spend record's no_result reasons (docs/design/ai-spend.md §4.2).
 */
export type RunEndKind =
  | "completed"
  | "hung"
  | "crashed"
  | "dead_on_start"
  | "never_started"
  | "rate_limit"
  | "provider_error"
  | "unreachable"
  | "exit_unknown"
  | "lost"
  | "vars_lost"
  | "lost_claim"
  | "stopped";

/** A run whose AI spend row is owed (it ended while agents.spend was on). */
export interface SpendPending {
  runId: string;
  endedAt: number;
  attempts: number;
}

/** One ended run's AI spend record (agents_spend, docs/design/ai-spend.md §4.3): numbers, ids and enums only. */
export interface SpendRow {
  runId: string;
  project: string;
  agent: string;
  task: string;
  chainId: string;
  origin: RunOrigin | "other";
  adapter: string;
  provider: string;
  model: string | null;
  startedAt: number | null;
  endedAt: number;
  runtimeS: number;
  class: "productive" | "idle" | "no_result" | "unclassified";
  reason: string;
  sessionMode: SessionMode;
  reload: boolean;
  lairRestart: boolean;
  /** reported: the adapter reported tokens and cost; requests: request lines only; none: nothing (never estimated) */
  usageSource: "reported" | "requests" | "none";
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  /** Tokens as the budgets count them (input + cache write + output; usage_patterns' total), null when not reported */
  tokens: number | null;
  requests: number | null;
  turns: number | null;
  cost: number | null;
  contextBytes: number;
  pr: number | null;
  headSha: string | null;
  blockerKey: string | null;
  backfilled: boolean;
  usageRecorded: boolean;
}

export interface Claim {
  project: string;
  task: string;
  runId: string;
  agent: string;
  ownerPid: number;
  ownerStartedAt: number;
  claimedAt: number;
}

export interface AgentEvent {
  id: string;
  project: string;
  kind: AgentEventKind;
  agent?: string;
  task?: string;
  runId?: string;
  subject?: string;
  summary: string;
  evidence: string[];
  data: Record<string, unknown>;
  /** One event per key: a condition is recorded (and raised) once */
  dedupeKey?: string;
  at: number;
}

export interface UsageRecord {
  project: string;
  agent?: string;
  provider: string;
  runId?: string;
  tokens: number;
  cost: number;
  at: number;
  reason?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOpt = (ms: number | undefined) => (ms === undefined ? undefined : iso(ms));

export function runView(run: AgentRun): AgentRunView {
  return {
    id: run.id,
    project: run.project,
    task: run.task,
    agent: run.agent,
    chainId: run.chainId,
    previousRunId: run.previousRunId,
    attempt: run.attempt,
    profileIndex: run.profileIndex,
    profile: run.profile,
    sessionId: run.sessionId,
    sessionMode: run.sessionMode,
    sameSessionRestarts: run.sameSessionRestarts,
    freshSessions: run.freshSessions,
    startRetries: run.startRetries,
    state: run.state,
    detail: run.detail,
    stopReason: run.stopReason,
    waitingLock: run.waitingLock
      ? {
          lock: run.waitingLock.lock,
          path: run.waitingLock.path,
          holderPid: run.waitingLock.holderPid,
          holderStartedAt: run.waitingLock.holderStartedAt === null ? null : iso(run.waitingLock.holderStartedAt),
          holderAlive: run.waitingLock.holderAlive,
          since: iso(run.waitingLock.since),
          detail: run.waitingLock.detail,
        }
      : undefined,
    pid: run.pid,
    pidStartedAt: isoOpt(run.pidStartedAt),
    requestedAt: iso(run.requestedAt),
    notBefore: iso(run.notBefore),
    spawnedAt: isoOpt(run.spawnedAt),
    endedAt: isoOpt(run.endedAt),
    exitCode: run.exitCode,
    logPath: run.logPath,
    lastError: run.lastError,
    origin: run.origin,
  };
}

export function claimView(claim: Claim, alive: boolean | null): ClaimView {
  return {
    task: claim.task,
    runId: claim.runId,
    agent: claim.agent,
    ownerPid: claim.ownerPid,
    ownerStartedAt: iso(claim.ownerStartedAt),
    ownerAlive: alive,
    claimedAt: iso(claim.claimedAt),
  };
}

export function eventView(event: AgentEvent): AgentEventView {
  return {
    id: event.id,
    kind: event.kind,
    agent: event.agent,
    task: event.task,
    runId: event.runId,
    subject: event.subject,
    summary: event.summary,
    evidence: event.evidence,
    data: event.data,
    at: iso(event.at),
  };
}
