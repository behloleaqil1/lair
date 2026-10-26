/**
 * Failure triage types (docs/design/autonomy.md §3), shared by the server
 * module (src/server/triage/) and the Triage view.
 *
 * A gate result is parsed into causes. Each cause gets a verdict (one of four
 * classes) with the evidence that decided it, and each class has an action.
 * A red default branch opens an incident, whose bisect finds the merge that
 * broke it.
 */

/** What a failure is, decided per cause. */
export const TRIAGE_CLASSES = ["infra", "pre-existing", "flaky", "code"] as const;
export type TriageClass = (typeof TRIAGE_CLASSES)[number];

/**
 * test: one or more tests failed with the same error;
 * context: a shared context or bootstrap failure, ONE cause for every test it failed;
 * build: a build or compile error outside any test;
 * step: a failed step with nothing more specific in its output.
 */
export type CauseKind = "test" | "context" | "build" | "step";

export interface TestRef {
  /** Class, file or module the test belongs to (what a re-check selects) */
  suite: string;
  name: string;
  /** Source file, when the report names it */
  file?: string;
  /** The test's id for a re-check: a pytest node id, else `<suite>#<name>` */
  id: string;
  /** Stable key used to compare runs and reports: `<short suite>#<name>` */
  key: string;
}

export interface SourceLocation {
  file: string;
  line?: number;
}

export interface FailureCause {
  /** Stable across runs: a hash of the kind, error type and normalised root cause */
  signature: string;
  kind: CauseKind;
  /** The gate step it came from */
  step?: string;
  /** The parser that found it: junit, gradle, vitest, jest, pytest or exit */
  parser: string;
  /** Error type of the outermost failure (an exception class, "exit 137", ...) */
  type?: string;
  message: string;
  /** The "Caused by" chain, outermost first */
  causedBy: string[];
  /** The deepest cause: the last of causedBy, else `type: message` */
  rootCause: string;
  /** Tests that failed with this cause; for a context failure, all of them (capped) */
  tests: TestRef[];
  /** How many tests failed with it */
  testCount: number;
  /** Source locations from stack frames and compiler errors, project code only */
  locations: SourceLocation[];
  /** The log lines that show it */
  evidence: string[];
}

export type Confidence = "high" | "low";

export interface Verdict {
  class: TriageClass;
  /** The rule that decided it, e.g. "infra-pattern:connection-timeout" */
  rule: string;
  confidence: Confidence;
  /** Why: the lines and facts the rule matched */
  evidence: string[];
  /** infra only: network, container, oom, runner, disk or load */
  infraKind?: string;
}

export interface ClassifiedCause {
  id: string;
  cause: FailureCause;
  verdict: Verdict;
}

/** gate: a normal gate run; recheck: an infra re-check; bisect: a bisect probe. */
export type ResultPurpose = "gate" | "recheck" | "bisect";

/**
 * trusted: from a server module in-process (the gate.completed event);
 * signed: a SignedGateResult over HTTP, verified against a trusted node key.
 */
export type ResultTrust = "trusted" | "signed";

/** One ingested gate result and its triage. */
export interface TriageRecord {
  id: string;
  project: string;
  gateId: string;
  /** The pipeline the result ran (GateResult.pipelineId): incidents and passes are per pipeline */
  pipelineId: string;
  trust: ResultTrust;
  sha: string;
  branch: string;
  baseSha?: string;
  /** The agent that authored the change (only from a trusted result) */
  agent?: string;
  pr?: number;
  purpose: ResultPurpose;
  /** The re-check this result answers */
  recheckId?: string;
  /** For a re-check result: the failure that was re-checked */
  originId?: string;
  status: "passed" | "failed" | "error";
  defaultBranch: boolean;
  /** The most severe class among the causes (code > infra > flaky > pre-existing) */
  verdict?: TriageClass;
  /** Whether this failure should block a merge */
  blocking: boolean;
  /** Why it stopped blocking, or what is still pending */
  resolution?: string;
  /** Re-checks requested for this failure (or for its origin) */
  retries: number;
  failedSteps: string[];
  changedFiles: string[];
  receivedAt: string;
  causes: ClassifiedCause[];
}

export type ActionKind =
  | "recheck"
  | "route"
  | "fix_task"
  | "flaky"
  | "ticket"
  | "quarantine"
  | "decision"
  | "incident"
  | "bisect"
  | "revert"
  | "unblock"
  | "note";

/**
 * done: carried out; recorded: kept in the store (and emitted as an event)
 * because no command is set; planned: observe mode, nothing ran; waiting: for
 * capacity; failed; skipped.
 */
export type ActionStatus = "done" | "recorded" | "planned" | "waiting" | "failed" | "skipped";

export interface TriageAction {
  id: string;
  project: string;
  recordId?: string;
  incidentId?: string;
  kind: ActionKind;
  status: ActionStatus;
  detail: string;
  /** The command that ran, or would run in observe mode */
  argv?: string[];
  output?: string;
  /** Who acted, for a human's action (an owner session id) */
  actor?: string;
  at: string;
}

export type RecheckPurpose = "infra" | "bisect";

/**
 * waiting_capacity: queued until there is capacity; dispatching: the
 * executor is being asked; requested: it accepted; planned: observe mode;
 * unavailable: no executor, or it refused; passed / failed: answered;
 * unproven: answered "passed" without showing the requested tests (or steps)
 * passing; expired: no answer in time; cancelled.
 */
export type RecheckStatus =
  | "waiting_capacity"
  | "dispatching"
  | "requested"
  | "planned"
  | "unavailable"
  | "passed"
  | "failed"
  | "unproven"
  | "expired"
  | "cancelled";

/** A re-check of ONLY the failed tests (or, without tests, the failed steps) at one commit. */
export interface Recheck {
  id: string;
  project: string;
  purpose: RecheckPurpose;
  /** infra: the failure being re-checked */
  recordId?: string;
  /** bisect: the incident */
  incidentId?: string;
  sha: string;
  branch: string;
  gateId: string;
  steps: string[];
  /** Test ids (see TestRef.id) */
  tests: string[];
  /** Test classes, files or modules */
  classes: string[];
  attempt: number;
  status: RecheckStatus;
  reason?: string;
  createdAt: string;
  requestedAt?: string;
  completedAt?: string;
  /** The result that answered it */
  answerId?: string;
  /** The run id the executor returned; an answer carries it (or this re-check's id) as its result id */
  runId?: string;
}

export interface TriageTask {
  id: string;
  project: string;
  /** fix: a pre-existing failure on the default branch; reliability: a flaky test */
  kind: "fix" | "reliability";
  key: string;
  title: string;
  body: string;
  status: "open" | "resolved";
  /** What the task command printed (an issue URL, a task id) */
  ref?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface FlakyTest {
  key: string;
  occurrences: number;
  lastAt: string;
  quarantinedAt?: string;
  /** The quarantine ends then (the reliability task's deadline) */
  quarantineUntil?: string;
  /** Passes in a row since the last failure (the quarantine ends after flaky.release_after_passes) */
  passes: number;
  ticketId?: string;
}

export type BisectStatus = "running" | "found" | "inconclusive" | "no_baseline" | "off" | "cancelled";

export interface BisectProbe {
  sha: string;
  recheckId?: string;
  /** A second run at the culprit, to see the same cause twice */
  confirm?: boolean;
  outcome: "pending" | "pass" | "fail" | "skip";
  /** Infrastructure failed this probe and the same commit was probed again */
  retried?: boolean;
  detail?: string;
}

export interface BisectState {
  status: BisectStatus;
  /** First-parent commits after the last green one, oldest first; the last is the red one */
  candidates: string[];
  /** Index of the newest known good candidate (-1: the last green commit) */
  good: number;
  /** Index of the oldest known bad candidate */
  bad: number;
  skipped: number[];
  probes: BisectProbe[];
  culprit?: string;
  /** Green before, red after, and the same cause twice at the culprit */
  proven: boolean;
  /** The commits that may have caused it, when it could not be narrowed to one */
  suspects?: string[];
  detail: string;
}

export type RevertStatus = "none" | "opening" | "opened" | "proposed" | "protected" | "failed" | "off";

export interface IncidentTarget {
  /** The narrowest failing set: test ids, classes and steps to run at each probe */
  tests: string[];
  keys: string[];
  classes: string[];
  steps: string[];
  signatures: string[];
}

/** The default branch is red, for one pipeline. */
export interface Incident {
  id: string;
  project: string;
  branch: string;
  /** The pipeline that went red; only its own green result resolves the incident */
  pipelineId: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt?: string;
  resolution?: string;
  redSha: string;
  lastGreenSha?: string;
  recordId: string;
  target: IncidentTarget;
  bisect: BisectState;
  revert: {
    status: RevertStatus;
    /** What the revert command printed (a PR URL) */
    ref?: string;
    detail?: string;
    /** Whether the culprit is a merge a human marked protected */
    protected?: boolean;
    /** Who asked for the revert, when a human did */
    by?: string;
  };
  decisionRef?: string;
}

export interface ProtectedMerge {
  sha: string;
  note: string;
  /** Who protected it (an owner session id) */
  by?: string;
  createdAt: string;
}

export interface TriageProjectStatus {
  project: string;
  enabled: boolean;
  mode: "observe" | "act" | null;
  /** Why commands don't run (observe mode, read_only), or null */
  actBlocked: string | null;
  errors: string[];
  defaultBranch: string | null;
  counts: {
    failures: number;
    blocking: number;
    byClass: Record<TriageClass, number>;
  };
  pendingRechecks: number;
  openTasks: number;
  quarantined: number;
  quarantineCap: number | null;
  /** The newest open incident on the default branch, else the latest one */
  incident: Incident | null;
  openIncidents: number;
  /** Which commands are configured (triage.commands.<id>) */
  commands: Record<string, boolean>;
  /** Node ids whose signed results are accepted over HTTP */
  trustedNodes: string[];
}
