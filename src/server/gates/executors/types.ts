/**
 * Executors run one job (one lane of a pipeline) and report how the attempt
 * ended. See docs/design/runners.md.
 */
import type { GateResult } from "../../../shared/policy-types.js";
import type {
  ExecutorId,
  PipelineArtifact,
  PipelineAttempt,
} from "../../../shared/pipeline-types.js";
import type { ExecuteResult } from "../gate-executor.js";
import type { LaneSettings, ProjectPipelineSettings } from "../project-pipelines.js";

/** Everything an executor needs to run one job */
export interface JobSpec {
  project: string;
  runId: string;
  jobId: string;
  pipeline: string;
  lane: LaneSettings;
  commitSha: string;
  branch?: string;
  /** The project's local repository */
  repoDir: string;
  settings: ProjectPipelineSettings;
  /** 1-based number of this attempt within the job */
  attemptNo: number;
  /** An earlier attempt of this job lost its runner (it gets one retry) */
  runnerLostBefore?: boolean;
}

/** How an attempt ended */
export type AttemptOutcome =
  | {
      kind: "completed";
      result: GateResult;
      where: string;
      log: string;
      artifacts: PipelineArtifact[];
      minutes: number;
      billedMinutes: number;
      ciRunId?: number;
      ciRunUrl?: string;
      /** Shown as the attempt's reason, e.g. a runner lost a second time */
      note?: string;
    }
  | {
      /** The runner was lost mid-run: run the job again (once), from the start */
      kind: "retry";
      reason: string;
      minutes?: number;
      billedMinutes?: number;
      ciRunId?: number;
      ciRunUrl?: string;
    }
  | {
      /**
       * Try the next executor: proven not to have run a step, or stopped
       * unfinished by Lair's own cancel (no result for the commit)
       */
      kind: "fallback";
      reason: string;
      /** Executors to mark unavailable for `unavailable_minutes` */
      markUnavailable?: ExecutorId[];
      minutes?: number;
      billedMinutes?: number;
      ciRunId?: number;
      ciRunUrl?: string;
    }
  | { kind: "error"; reason: string }
  | { kind: "cancelled"; reason: string }
  /** The server is stopping: the attempt stays in flight and resumes on restart */
  | { kind: "interrupted" };

/** Lets an executor record progress before it happens (so a restart can resume) */
export interface AttemptReporter {
  update(patch: Partial<Omit<PipelineAttempt, "executor" | "startedAt">>): void;
  /** Set (or clear, with undefined) why the job is waiting */
  wait(reason: string | undefined): void;
}

export interface JobControl {
  /** Aborted when the run is cancelled or the server stops */
  signal: AbortSignal;
  /** True when the run was cancelled (not a server stop) */
  isCancelled(): boolean;
}

export interface Executor {
  readonly id: ExecutorId;
  /**
   * Run the job. `resume` is an attempt that was in flight when the server
   * stopped (GitHub only): the executor finds and polls that run instead of
   * dispatching again.
   */
  run(
    job: JobSpec,
    reporter: AttemptReporter,
    control: JobControl,
    resume?: PipelineAttempt,
  ): Promise<AttemptOutcome>;
}

/** Runs an argv (never a shell). The only place local steps touch processes. */
export interface Spawner {
  run(
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<ExecuteResult>;
}

export type MemoryPressure = "normal" | "warn" | "critical" | "unknown";

export interface CapacitySample {
  cores: number;
  /** 1-minute load average */
  load1: number;
  totalRamMb: number;
  /** RAM available to new processes */
  freeRamMb: number;
  memoryPressure: MemoryPressure;
}

export interface CapacityProbe {
  sample(): Promise<CapacitySample>;
}

/** The fetch subset the GitHub client needs (globalThis.fetch fits) */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;
