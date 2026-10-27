/**
 * A gate's detail for the dashboard, from what the modules already keep:
 * the project's own gate queue (gates_dir: the request, its result, the
 * steps its log names), a Lair pipeline run, triage's record of the result,
 * and placement's view of the job. Pure functions over those inputs; the
 * routes (routes.ts) fetch them.
 *
 * The open view (GateDetailView) carries no log line and no test output: a
 * log can hold anything a test printed. Those are in GateOutputView, which
 * the routes serve to the owner only.
 */
import { parseGateSteps } from "../parsers/gates.js";
import { parseGateEvidence } from "../triage/parsers/index.js";
import { DEFAULT_CONTEXT_PATTERNS } from "../triage/config.js";
import { tailLines } from "../services/log-tail.js";
import { redact } from "../delivery/redact.js";
import type { Gate } from "../../shared/types.js";
import type { PipelineRun, PipelineRunStep } from "../../shared/pipeline-types.js";
import type { GateResult as PolicyGateResult } from "../../shared/policy-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import type { FailureCause, TriageClass, TriageRecord } from "../../shared/triage-types.js";
import type {
  FailingTest,
  GateCauseSummary,
  GateDetailView,
  GateOutputView,
  GatePlacementSummary,
  GateStepState,
  GateStepView,
  GateTriageSummary,
  LogTailView,
} from "../../shared/dashboard-types.js";

/** At most this many failing tests are listed */
export const MAX_FAILING_TESTS = 100;
/** At most this many evidence lines */
export const MAX_EVIDENCE_LINES = 40;
/** Messages and evidence lines are cut to this many characters */
export const MAX_MESSAGE_LENGTH = 500;
/** At most this many causes are summarised */
const MAX_CAUSES = 20;

/** What the project's gate queue knows of a gate (DataService.getGateRecord, and its log's text). */
export interface QueueGateInput {
  gate: Gate | null;
  result: { rc: number; finishedAt: string } | null;
  logText: string | null;
}

/** The usual gate id: <UTC stamp>-<track>-<sha>-<n> */
const STRUCTURED_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([a-zA-Z0-9-]+)-([a-f0-9]+)-(\d+)$/;

function fromId(id: string): { startedAt: string | null; track: string | null; sha: string | null } {
  const m = STRUCTURED_ID.exec(id);
  if (!m) return { startedAt: null, track: null, sha: null };
  return { startedAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, track: m[7], sha: m[8] };
}

/** One line, cut to `max` characters, credentials of a known shape masked (delivery's redact()). */
function oneLine(text: string, max = MAX_MESSAGE_LENGTH): string {
  const flat = text.slice(0, max * 4).replace(/\s+/g, " ").trim();
  return redact(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

function causeText(cause: FailureCause): string {
  return oneLine(`${cause.type ? `${cause.type}: ` : ""}${cause.message}`);
}

/** The newest triage record of this gate (a result id, or any of `ids`). */
export function triageRecordFor(records: readonly TriageRecord[], ids: readonly string[]): TriageRecord | null {
  const wanted = new Set(ids);
  const matching = records.filter((r) => wanted.has(r.gateId));
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
}

/** Triage's verdict and causes, without evidence lines or test messages. */
export function triageSummary(record: TriageRecord | null): GateTriageSummary | null {
  if (!record) return null;
  const causes: GateCauseSummary[] = record.causes.slice(0, MAX_CAUSES).map((c) => ({
    class: c.verdict.class,
    rule: c.verdict.rule,
    confidence: c.verdict.confidence,
    kind: c.cause.kind,
    step: c.cause.step ?? null,
    testCount: c.cause.testCount,
    summary: causeText(c.cause),
  }));
  return {
    recordId: record.id,
    verdict: record.verdict ?? null,
    blocking: record.blocking,
    resolution: record.resolution ?? null,
    retries: record.retries,
    causes,
  };
}

/** Placement's view of the job, when placement is on for the project. */
export function placementSummary(
  status: PlacementStatus | null,
  id: string,
  lane: string | null,
): GatePlacementSummary | null {
  if (!status || !status.enabled) return null;
  const job = status.jobs.find((j) => j.id === id) ?? null;
  const laneName = job?.lane ?? lane;
  const machine = laneName ? (status.lanes.find((l) => l.name === laneName)?.machine ?? null) : null;
  return { mode: status.mode, job, machine };
}

/** A gate of the project's own queue: its request, result and the steps its log names. */
export function queueGateDetail(
  project: string,
  id: string,
  input: QueueGateInput,
  extra: { triage: TriageRecord | null; placement: PlacementStatus | null },
): GateDetailView {
  const log = input.logText ? parseGateSteps(input.logText) : null;
  const named = fromId(id);
  const gate = input.gate;
  const status = gate ? gate.status : input.result ? (input.result.rc === 0 ? "passed" : "failed") : "unknown";
  const lane = gate?.lane ?? log?.lane ?? null;
  const placement = placementSummary(extra.placement, id, lane);
  const steps: GateStepView[] = (log?.steps ?? []).map((s) => ({
    name: s.name,
    state: s.state,
    durationSeconds: s.durationSeconds,
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  }));
  return {
    id,
    project,
    source: "queue",
    status,
    lane,
    priority: gate?.priority ?? null,
    track: gate?.track ?? log?.track ?? named.track,
    sha: log?.sha ?? gate?.headSha ?? named.sha,
    base: log?.base ?? null,
    branch: gate?.branch ?? log?.branch ?? extra.triage?.branch ?? null,
    machine: placement?.machine ?? null,
    pipeline: null,
    runId: null,
    startedAt: gate?.startTime ?? log?.startedAt ?? named.startedAt,
    finishedAt: input.result?.finishedAt ?? null,
    rc: input.result?.rc ?? null,
    currentStep: status === "running" ? (log?.currentStep ?? gate?.currentStep ?? null) : null,
    steps,
    failedSteps: log?.failedSteps ?? [],
    triage: triageSummary(extra.triage),
    placement,
    hasLog: input.logText !== null,
  };
}

const PIPELINE_STEP_STATE: Record<PipelineRunStep["status"], GateStepState> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  timed_out: "timed_out",
  pending: "pending",
};

/** The ids a pipeline run is known by: the run's and its jobs' results'. */
export function pipelineIds(run: PipelineRun): string[] {
  return [run.id, ...run.jobs.flatMap((j) => (j.result ? [j.result.id] : []))];
}

/** The run a gate id names: the run itself, one of its jobs, or a job's result. */
export function findPipelineRun(runs: readonly PipelineRun[], id: string): PipelineRun | null {
  return runs.find((r) => r.id === id || r.jobs.some((j) => j.id === id || j.result?.id === id)) ?? null;
}

/** A run of one of Lair's pipelines. */
export function pipelineGateDetail(
  project: string,
  id: string,
  run: PipelineRun,
  extra: { triage: TriageRecord | null; placement: PlacementStatus | null },
): GateDetailView {
  const steps: GateStepView[] = run.steps.map((s) => ({
    name: s.name,
    state: PIPELINE_STEP_STATE[s.status] ?? "pending",
    durationSeconds: s.durationMs === undefined ? null : s.durationMs / 1000,
    lane: s.lane,
    ...(s.where ? { where: s.where } : {}),
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    ...(s.error ? { error: oneLine(s.error) } : {}),
  }));
  const places = [...new Set(run.jobs.map((j) => j.where).filter((w): w is string => typeof w === "string" && w !== ""))];
  const lanes = [...new Set(run.jobs.map((j) => j.lane))];
  const running = run.steps.find((s) => s.status === "pending" && run.status === "running");
  return {
    id,
    project,
    source: "pipeline",
    status: run.status,
    lane: lanes.length === 1 ? lanes[0] : lanes.length > 1 ? lanes.join(", ") : null,
    priority: null,
    track: null,
    sha: run.commitSha,
    base: null,
    branch: run.branch ?? extra.triage?.branch ?? null,
    machine: places.length > 0 ? places.join(", ") : null,
    pipeline: run.pipeline,
    runId: run.id,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.completedAt ?? null,
    rc: null,
    currentStep: running?.name ?? null,
    steps,
    failedSteps: steps.filter((s) => s.state === "failed" || s.state === "timed_out").map((s) => s.name),
    triage: triageSummary(extra.triage),
    placement: placementSummary(extra.placement, id, null),
    hasLog: run.jobs.some((j) => typeof j.log === "string" && j.log.length > 0),
  };
}

/** A result only triage has (a signed result from a node, say). */
export function triageGateDetail(project: string, id: string, record: TriageRecord): GateDetailView {
  return {
    id,
    project,
    source: "triage",
    status: record.status,
    lane: null,
    priority: null,
    track: null,
    sha: record.sha,
    base: record.baseSha ?? null,
    branch: record.branch,
    machine: null,
    pipeline: record.pipelineId || null,
    runId: null,
    startedAt: null,
    finishedAt: record.receivedAt,
    rc: null,
    currentStep: null,
    steps: record.failedSteps.map((name): GateStepView => ({ name, state: "failed", durationSeconds: null })),
    failedSteps: record.failedSteps,
    triage: triageSummary(record),
    placement: null,
    hasLog: false,
  };
}

// ============ OUTPUT (owner only) ============

function testsOf(causes: readonly { cause: FailureCause; class: TriageClass | null }[]): {
  tests: FailingTest[];
  truncated: boolean;
} {
  const tests: FailingTest[] = [];
  let total = 0;
  for (const { cause, class: cls } of causes) {
    total += Math.max(cause.testCount, cause.tests.length);
    for (const t of cause.tests) {
      if (tests.length >= MAX_FAILING_TESTS) break;
      tests.push({
        id: oneLine(t.id, 300),
        suite: oneLine(t.suite, 300),
        name: oneLine(t.name, 300),
        file: t.file ? oneLine(t.file, 300) : null,
        message: causeText(cause),
        class: cls,
        step: cause.step ?? null,
      });
    }
  }
  return { tests, truncated: total > tests.length };
}

function evidenceOf(causes: readonly FailureCause[]): string[] {
  const lines: string[] = [];
  for (const cause of causes) {
    for (const line of cause.evidence) {
      if (lines.length >= MAX_EVIDENCE_LINES) return lines;
      lines.push(oneLine(line));
    }
  }
  return lines;
}

/**
 * The failing tests a gate log's console output shows (Gradle, vitest,
 * jest, pytest), read with triage's own parsers, for a gate triage has no
 * record of. Only the failed steps are attributed: the whole tail goes to
 * the first one.
 */
export function causesFromLog(logText: string, failedSteps: readonly string[]): FailureCause[] {
  if (failedSteps.length === 0) return [];
  const result: PolicyGateResult = {
    id: "log",
    pipelineId: "",
    commitSha: "",
    branch: "",
    projectId: "",
    nodeId: "",
    status: "failed",
    steps: failedSteps.map((name, i) => ({ name, status: "failed" as const, ...(i === 0 ? { output: logText } : {}) })),
    selectedSteps: [...failedSteps],
    durationMs: 0,
    startedAt: "",
    completedAt: "",
    pipelineVersion: "",
  };
  const contextPatterns = DEFAULT_CONTEXT_PATTERNS.map((p) => new RegExp(p, "i"));
  const evidence = parseGateEvidence(result, [], { contextPatterns });
  // Only causes a parser read: a bare "step failed" cause has no test to list
  return evidence.causes.filter((c) => c.parser !== "exit" && c.parser !== "runner");
}

/** The owner's view of a gate's output: the log tail, and its failing tests with their messages. */
export function gateOutput(
  id: string,
  log: LogTailView | null,
  triage: TriageRecord | null,
  fallback: { logText: string | null; failedSteps: readonly string[] },
): GateOutputView {
  if (triage && triage.causes.length > 0) {
    const { tests, truncated } = testsOf(triage.causes.map((c) => ({ cause: c.cause, class: c.verdict.class })));
    return {
      id,
      log,
      tests,
      testsTruncated: truncated,
      testsFrom: "triage",
      evidence: evidenceOf(triage.causes.map((c) => c.cause)),
    };
  }
  const causes = fallback.logText ? causesFromLog(fallback.logText, fallback.failedSteps) : [];
  const { tests, truncated } = testsOf(causes.map((cause) => ({ cause, class: null })));
  return {
    id,
    log,
    tests,
    testsTruncated: truncated,
    testsFrom: tests.length > 0 ? "log" : null,
    evidence: evidenceOf(causes),
  };
}

/** A pipeline run's job logs (already redacted tails) as one bounded log view. */
export function pipelineLog(run: PipelineRun, lines: number): LogTailView | null {
  const jobs = run.jobs.filter((j) => typeof j.log === "string" && j.log.length > 0);
  if (jobs.length === 0) return null;
  const text = jobs
    .map((j) => `== ${j.lane}${j.where ? ` (${j.where})` : ""}\n${j.log ?? ""}`)
    .join("\n");
  const tail = tailLines(text, lines);
  return {
    file: `${run.pipeline} ${run.id}`,
    lines: tail.lines,
    truncated: tail.truncated,
    sizeBytes: Buffer.byteLength(text, "utf-8"),
    modifiedAt: run.completedAt ?? run.startedAt ?? run.createdAt,
  };
}
