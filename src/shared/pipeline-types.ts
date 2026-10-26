/**
 * Gate pipeline runs and their executors (docs/design/runners.md).
 * Shared by the server (src/server/gates/) and the Gates view.
 */
import type { GateResult } from "./policy-types.js";

/** Kinds of executor, in the order a project lists them (`executors.order`) */
export type ExecutorKind = "github" | "nodes" | "local";

/** A concrete executor a job can be sent to */
export type ExecutorId = "github-self-hosted" | "github-hosted" | "nodes" | "local";

/** One try of a job on one executor */
export type AttemptStatus =
  /** Not tried: unavailable, over budget, not allowed (see reason) */
  | "skipped"
  /** Recorded before the dispatch request is sent */
  | "dispatching"
  /** Accepted, waiting for a runner or for local capacity */
  | "queued"
  | "running"
  /** A cancel was requested; waiting for the CI run to confirm it */
  | "cancelling"
  /** The executor produced a result */
  | "completed"
  /** Proven not to have run any step; the job moved on to the next executor */
  | "fell_back"
  /** The server stopped while it ran locally; it never finished */
  | "interrupted"
  /** The run was cancelled */
  | "cancelled";

export interface PipelineAttempt {
  executor: ExecutorId;
  status: AttemptStatus;
  /** Why it was skipped or fell back, or what it is waiting for */
  reason?: string;
  startedAt: string;
  completedAt?: string;
  /** The id sent with the dispatch (CI run name), to find the run again */
  dispatchId?: string;
  ciRunId?: number;
  ciRunUrl?: string;
  where?: string;
  minutes?: number;
  billedMinutes?: number;
  /** The runner was lost mid-run; the job gets one more try */
  runnerLost?: boolean;
}

export type PipelineJobStatus =
  | "queued"
  /** No executor can take it right now, or local capacity is short */
  | "waiting"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

export type PipelineRunStatus = "queued" | "running" | "passed" | "failed" | "error" | "cancelled";

export interface PipelineArtifact {
  name: string;
  sizeBytes: number;
  expired: boolean;
}

/** One lane of a pipeline run, on one executor */
export interface PipelineJob {
  id: string;
  runId: string;
  lane: string;
  status: PipelineJobStatus;
  /** The executor that produced the result */
  executor?: ExecutorId;
  /** Where it ran, e.g. "local machine", "GitHub-hosted runner (ubuntu-latest)" */
  where?: string;
  /** Why the job is waiting */
  waitReason?: string;
  attempts: PipelineAttempt[];
  result?: GateResult;
  /** Redacted log tail */
  log?: string;
  artifacts: PipelineArtifact[];
  minutes: number;
  billedMinutes: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** A step of a run, with the lane and executor it ran on */
export interface PipelineRunStep {
  name: string;
  lane: string;
  status: "passed" | "failed" | "skipped" | "timed_out" | "pending";
  exitCode?: number;
  durationMs?: number;
  error?: string;
  executor?: ExecutorId;
  where?: string;
}

export interface PipelineRun {
  id: string;
  project: string;
  pipeline: string;
  commitSha: string;
  branch?: string;
  status: PipelineRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  minutes: number;
  billedMinutes: number;
  steps: PipelineRunStep[];
  jobs: PipelineJob[];
}

export interface ExecutorAvailability {
  executor: ExecutorId;
  available: boolean;
  reason?: string;
  /** Set when a refusal or a pickup timeout marked it unavailable */
  unavailableUntil?: string;
}

/** A Decision Inbox item this module asked for */
export interface RaisedDecision {
  id: string;
  key: string;
  kind: string;
  question: string;
  createdAt: string;
}

export interface PipelinesStatus {
  project: string;
  configured: boolean;
  errors: string[];
  readOnly: boolean;
  order: ExecutorKind[];
  pipelines: {
    name: string;
    lanes: { name: string; order: ExecutorKind[]; steps: string[] }[];
  }[];
  executors: ExecutorAvailability[];
  github: {
    repo: string | null;
    tokenEnv: string;
    tokenSet: boolean;
    visibility: string | null;
    workflowPath: string;
    runners: { name: string; status: string; busy: boolean; labels: string[] }[];
    warnings: string[];
  };
  minutes: {
    usedThisMonth: number;
    budget: number;
    periodStart: string;
  };
  decisions: RaisedDecision[];
}
