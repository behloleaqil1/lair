/**
 * The dashboard's own read routes (src/server/dashboard/): which modules a
 * project turns on (the nav shows only those sections), the detail of one
 * gate, and the owner-only log tails and test output. Shared by the server
 * and the client.
 */
import type { PlacementJob } from "./placement-types.js";
import type { CauseKind, TriageClass } from "./triage-types.js";

/** What a project's YAML turns on. The nav shows a section only when its module is on. */
export interface ModuleFlags {
  /** agents.enabled: Lair supervises the agents' runs */
  agents: boolean;
  /** agents.fill.enabled: Lair starts runs from a tasks file */
  fill: boolean;
  /** review.enabled: risk tiers, required reviews and policy merge */
  review: boolean;
  /** triage.enabled */
  triage: boolean;
  /** placement.enabled */
  placement: boolean;
  /** pipelines: names at least one pipeline */
  pipelines: boolean;
  /** delivery.enabled */
  delivery: boolean;
  /** watchdog.enabled */
  watchdog: boolean;
  /** processes: names at least one process */
  processes: boolean;
  /** github: is set (pull requests come from the git host) */
  github: boolean;
  /** machines: names at least one machine */
  machines: boolean;
  /** lair-node machines are registered with this server */
  nodes: boolean;
}

export interface DashboardModules {
  project: string;
  readOnly: boolean;
  /** Why the project's config could not be read (every module is then off) */
  error: string | null;
  modules: ModuleFlags;
}

/** A step's result, from a gate log or a pipeline run. */
export type GateStepState = "passed" | "failed" | "skipped" | "running" | "timed_out" | "pending";

export interface GateStepView {
  name: string;
  state: GateStepState;
  /** null when the log does not say */
  durationSeconds: number | null;
  exitCode?: number;
  /** A pipeline step: its lane and where it ran */
  lane?: string;
  where?: string;
  error?: string;
}

/** One cause of a failure as triage classified it: no log lines, no test output. */
export interface GateCauseSummary {
  class: TriageClass;
  rule: string;
  confidence: "high" | "low";
  kind: CauseKind;
  step: string | null;
  testCount: number;
  /** The cause in one bounded line (its type and message) */
  summary: string;
}

export interface GateTriageSummary {
  recordId: string;
  verdict: TriageClass | null;
  blocking: boolean;
  resolution: string | null;
  retries: number;
  causes: GateCauseSummary[];
}

export interface GatePlacementSummary {
  mode: "observe" | "act" | null;
  /** Placement's view of this job while it is queued or running */
  job: PlacementJob | null;
  /** The machine of the job's lane, when placement knows the lane */
  machine: string | null;
}

/**
 * A gate: a request of the project's own gate queue (gates_dir), or a run of
 * one of Lair's pipelines. Open to every caller: no log lines, no test output.
 */
export interface GateDetailView {
  id: string;
  project: string;
  /** queue: the project's gate queue (gates_dir); pipeline: a Lair pipeline run; triage: a result only triage has */
  source: "queue" | "pipeline" | "triage";
  /** queued, running, passed, failed, error, cancelled, or a request suffix (superseded, stuck, ...) */
  status: string;
  lane: string | null;
  priority: number | null;
  track: string | null;
  sha: string | null;
  base: string | null;
  branch: string | null;
  /** Where it runs or ran (placement's lane machine, or the pipeline's runners) */
  machine: string | null;
  pipeline: string | null;
  /** The Lair pipeline run (its jobs, attempts and Cancel are under /api/pipelines/runs/:id) */
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  rc: number | null;
  currentStep: string | null;
  steps: GateStepView[];
  failedSteps: string[];
  triage: GateTriageSummary | null;
  placement: GatePlacementSummary | null;
  /** A log exists: the owner can read its tail (GET /api/dashboard/gates/:id/output) */
  hasLog: boolean;
}

/** The end of a log, bounded in lines, bytes and line length. */
export interface LogTailView {
  /** The file's name, never its path */
  file: string;
  lines: string[];
  /** Earlier lines were left out */
  truncated: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FailingTest {
  /** The test's id for a re-check (a pytest node id, else `<suite>#<name>`) */
  id: string;
  suite: string;
  name: string;
  file: string | null;
  /** The failure's message, one bounded line */
  message: string;
  class: TriageClass | null;
  step: string | null;
}

/** Owner only: a gate's log tail and its failing tests. */
export interface GateOutputView {
  id: string;
  log: LogTailView | null;
  tests: FailingTest[];
  /** More tests failed than are listed */
  testsTruncated: boolean;
  /** triage: the reports and console output triage read; log: this log's console output; null: none found */
  testsFrom: "triage" | "log" | null;
  /** The log lines that show each cause (bounded) */
  evidence: string[];
}

/** Owner only: an agent's log tail. */
export interface AgentLogView {
  agent: string;
  /** run: the log of the agents module's latest run of it; dragon: its newest log in agents_dir */
  source: "run" | "dragon" | null;
  runId: string | null;
  log: LogTailView | null;
}
