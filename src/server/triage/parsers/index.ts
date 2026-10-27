/**
 * Evidence parsers and the step that turns one gate result into causes.
 *
 * Machine-readable reports (JUnit XML) are parsed first; then the output of
 * every failed step is read by the first console parser that recognises it
 * (Gradle, vitest, jest, pytest). A console cause whose tests a report
 * already explains is dropped (the report is richer), but its "Caused by"
 * chain is kept for a report trace that has none (a cut JUnit XML trace); a
 * context failure without any gets the chain of its step's output. Follower
 * context failures in other reports join the first context failure (their
 * cause). A failed step that nothing explains becomes one "step" cause with
 * its exit code and the error lines of its output, so a failure is never just
 * a log tail.
 *
 * Parsers are pluggable: pass your own list (TriageManager's `parsers`).
 */
import type { GateResult, GateStepResult } from "../../../shared/policy-types.js";
import type { FailureCause, TestRef } from "../../../shared/triage-types.js";
import { MAX_EVIDENCE, absorbFollowers, boundedLines, causedByChain, clip, groupFailures, mergeCauses } from "../text.js";
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
  const lines = boundedLines(step.output ?? "")
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

/** At most this many "Caused by" lines are taken from a console for one cause */
const MAX_CHAIN = 20;

/**
 * A test or context failure whose trace has no "Caused by" chain gets the one
 * the console shows for its tests; a context failure without that gets the
 * chain in its step's output (or, naming no step, the first failed step's
 * that has one). The root cause is then the chain's last link, which is what
 * the classifier reads. Its signature stays the report's.
 */
function withChains(causes: FailureCause[], byTest: Map<string, string[]>, failed: GateStepResult[]): FailureCause[] {
  const stepChains = new Map<string, string[]>();
  const chainOf = (step: GateStepResult): string[] => {
    let chain = stepChains.get(step.name);
    if (!chain) {
      chain = causedByChain(boundedLines(step.output ?? "")).slice(0, MAX_CHAIN);
      stepChains.set(step.name, chain);
    }
    return chain;
  };
  for (const cause of causes) {
    if (cause.causedBy.length > 0 || (cause.kind !== "test" && cause.kind !== "context")) continue;
    let chain = cause.tests.map((t) => byTest.get(t.key)).find((c): c is string[] => c !== undefined && c.length > 0);
    if (!chain && cause.kind === "context") {
      for (const step of failed) {
        if (cause.step !== undefined && step.name !== cause.step) continue;
        const found = chainOf(step);
        if (found.length > 0) {
          chain = found;
          break;
        }
      }
    }
    if (!chain) continue;
    cause.causedBy = chain.slice(0, MAX_CHAIN);
    cause.rootCause = cause.causedBy[cause.causedBy.length - 1];
    cause.evidence = [
      ...cause.evidence,
      ...cause.causedBy.slice(-2).map((c) => `Caused by (from the console output): ${c}`),
    ].slice(0, MAX_EVIDENCE);
  }
  return causes;
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
    const name = report.name ?? "(unnamed)";
    try {
      const lines = boundedLines(report.content);
      const parser = report.format
        ? parsers.find((p) => p.id === report.format)
        : (parsers.find((p) => p.source === "report" && p.detect(report.content, lines)) ??
          parsers.find((p) => p.detect(report.content, lines)));
      if (!parser) {
        notes.push(`report ${name}: no parser recognises it`);
        continue;
      }
      const out = parser.parse(report.content, { step: report.step ?? onlyStep, contextPatterns: options.contextPatterns });
      used.add(parser.id);
      reportCauses.push(...out.causes);
      passed.push(...out.passed);
      flaky.push(...out.flaky);
    } catch (e) {
      notes.push(`report ${name}: could not be read (${clip(e instanceof Error ? e.message : String(e), 200)})`);
    }
  }

  const covered = new Set(reportCauses.flatMap((c) => c.tests.map((t) => t.key)));
  /** The "Caused by" chain the console shows for a test a report explains */
  const consoleChains = new Map<string, string[]>();
  const consoleCauses: FailureCause[] = [];
  const consoleParsers = parsers.filter((p) => p.source === "console");
  for (const step of failed) {
    const output = step.output ?? "";
    if (!output.trim()) continue;
    let out: ReturnType<EvidenceParser["parse"]>;
    try {
      const lines = boundedLines(output);
      const parser = consoleParsers.find((p) => p.detect(output, lines));
      if (!parser) continue;
      out = parser.parse(output, { step: step.name, contextPatterns: options.contextPatterns });
      used.add(parser.id);
    } catch (e) {
      notes.push(`step ${step.name}: its output could not be read (${clip(e instanceof Error ? e.message : String(e), 200)})`);
      continue;
    }
    for (const cause of out.causes) {
      if (cause.tests.length > 0 && cause.tests.every((t) => covered.has(t.key))) {
        // A report explains these tests, but its trace may lack the "Caused by" chain the console shows
        if (cause.causedBy.length > 0) for (const t of cause.tests) if (!consoleChains.has(t.key)) consoleChains.set(t.key, cause.causedBy);
        continue;
      }
      if (cause.kind === "build" && reportCauses.some((c) => c.step === step.name)) continue;
      consoleCauses.push(cause);
    }
    passed.push(...out.passed);
    flaky.push(...out.flaky);
  }

  if (result.status === "passed") {
    return { causes: [], passed, flaky, parsers: [...used], notes };
  }

  const causes = withChains(absorbFollowers(mergeCauses([...reportCauses, ...consoleCauses])), consoleChains, failed);
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
