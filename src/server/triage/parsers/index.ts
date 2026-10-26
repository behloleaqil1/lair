/**
 * Evidence parsers and the step that turns one gate result into causes.
 *
 * Machine-readable reports (JUnit XML) are parsed first; then the output of
 * every failed step is read by the first console parser that recognises it
 * (Gradle, vitest, jest, pytest). A console cause whose tests a report
 * already explains is dropped (the report is richer). A failed step that
 * nothing explains becomes one "step" cause with its exit code and the
 * error lines of its output, so a failure is never just a log tail.
 *
 * Parsers are pluggable: pass your own list (TriageManager's `parsers`).
 */
import type { GateResult, GateStepResult } from "../../../shared/policy-types.js";
import type { FailureCause, TestRef } from "../../../shared/triage-types.js";
import { cleanLog, clip, groupFailures, mergeCauses } from "../text.js";
import { gradleParser } from "./gradle.js";
import { jestParser, vitestParser } from "./js.js";
import { junitParser } from "./junit.js";
import { pytestParser } from "./pytest.js";
import type { EvidenceParser } from "./types.js";

export type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";
export { parseJUnit } from "./junit.js";
export { parseGradle } from "./gradle.js";
export { parseVitest, parseJest } from "./js.js";
export { parsePytest } from "./pytest.js";
export { parseXml } from "./xml.js";

/** Console parsers are tried in this order; the first that recognises a step's output reads it. */
export const BUILTIN_PARSERS: EvidenceParser[] = [junitParser, gradleParser, vitestParser, jestParser, pytestParser];

/** A machine-readable report sent with a gate result. */
export interface ReportInput {
  name?: string;
  /** A parser id (junit, ...); detected from the content when missing */
  format?: string;
  /** The step that wrote it; when missing and only one step failed, that step */
  step?: string;
  content: string;
}

export interface GateEvidence {
  causes: FailureCause[];
  passed: TestRef[];
  flaky: TestRef[];
  /** Which parsers read something */
  parsers: string[];
  notes: string[];
}

const ERRORISH = /error|fail|exception|fatal|killed|refused|timed? ?out|denied|cannot|could not|not found|panic/i;

function failedSteps(result: GateResult): GateStepResult[] {
  return result.steps.filter((s) => s.status === "failed" || s.status === "timed_out");
}

/** A failed step that no parser explains: its exit code and the error lines of its output. */
function stepCause(step: GateStepResult): FailureCause {
  const output = cleanLog(step.output ?? "");
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\.\.\. \(\d+ lines truncated\)$/.test(l));
  const errorLines = lines.filter((l) => ERRORISH.test(l));
  const shown = (errorLines.length > 0 ? errorLines.slice(-6) : lines.slice(-5)).map((l) => clip(l));
  const timedOut = step.status === "timed_out";
  const type = timedOut ? "timeout" : step.exitCode !== undefined ? `exit ${step.exitCode}` : "failed";
  const summary = timedOut
    ? `Step ${step.name} timed out${step.error ? ` (${step.error})` : ""}`
    : `Step ${step.name} failed${step.exitCode !== undefined ? ` with exit code ${step.exitCode}` : ""}`;
  const [cause] = groupFailures(
    [
      {
        kind: "step",
        type,
        message: errorLines[0] ?? summary,
        lines,
        parser: "exit",
        step: step.name,
        evidence: [summary, ...shown],
      },
    ],
    [],
  );
  return cause;
}

/** A failed result without a failed step: the runner itself failed. */
function runnerCause(result: GateResult): FailureCause {
  const [cause] = groupFailures(
    [
      {
        kind: "step",
        type: result.status,
        message: `The gate ended as ${result.status} without a failed step`,
        lines: [],
        parser: "runner",
        evidence: result.steps.map((s) => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`).slice(0, 8),
      },
    ],
    [],
  );
  return cause;
}

/** Turn a gate result and its reports into causes (empty for a passed result). */
export function parseGateEvidence(
  result: GateResult,
  reports: ReportInput[],
  options: { contextPatterns: RegExp[]; parsers?: EvidenceParser[] },
): GateEvidence {
  const parsers = options.parsers ?? BUILTIN_PARSERS;
  const failed = failedSteps(result);
  const onlyStep = failed.length === 1 ? failed[0].name : undefined;
  const reportCauses: FailureCause[] = [];
  const passed: TestRef[] = [];
  const flaky: TestRef[] = [];
  const used = new Set<string>();
  const notes: string[] = [];

  for (const report of reports) {
    const parser = report.format
      ? parsers.find((p) => p.id === report.format)
      : parsers.find((p) => p.source === "report" && p.detect(report.content)) ??
        parsers.find((p) => p.detect(report.content));
    if (!parser) {
      notes.push(`report ${report.name ?? "(unnamed)"}: no parser recognises it`);
      continue;
    }
    const out = parser.parse(report.content, { step: report.step ?? onlyStep, contextPatterns: options.contextPatterns });
    used.add(parser.id);
    reportCauses.push(...out.causes);
    passed.push(...out.passed);
    flaky.push(...out.flaky);
  }

  const covered = new Set(reportCauses.flatMap((c) => c.tests.map((t) => t.key)));
  const consoleCauses: FailureCause[] = [];
  const consoleParsers = parsers.filter((p) => p.source === "console");
  for (const step of failed) {
    const output = step.output ?? "";
    if (!output.trim()) continue;
    const parser = consoleParsers.find((p) => p.detect(output));
    if (!parser) continue;
    const out = parser.parse(output, { step: step.name, contextPatterns: options.contextPatterns });
    used.add(parser.id);
    for (const cause of out.causes) {
      if (cause.tests.length > 0 && cause.tests.every((t) => covered.has(t.key))) continue;
      if (cause.kind === "build" && reportCauses.some((c) => c.step === step.name)) continue;
      consoleCauses.push(cause);
    }
    passed.push(...out.passed);
    flaky.push(...out.flaky);
  }

  if (result.status === "passed") {
    return { causes: [], passed, flaky, parsers: [...used], notes };
  }

  const causes = mergeCauses([...reportCauses, ...consoleCauses]);
  // A report that names no step explains the failure on its own
  const unattributed = causes.some((c) => c.step === undefined);
  for (const step of failed) {
    if (causes.some((c) => c.step === step.name)) continue;
    if (unattributed && step.status !== "timed_out") {
      notes.push(`step ${step.name}: explained by a report that names no step`);
      continue;
    }
    causes.push(stepCause(step));
  }
  if (causes.length === 0) causes.push(runnerCause(result));
  return { causes, passed, flaky, parsers: [...used], notes };
}
