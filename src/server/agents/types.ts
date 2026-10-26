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
  SessionMode,
  StopReason,
} from "../../shared/agents-types.js";

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
  pidStartedAt?: number;
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
