/**
 * Gate executor.
 * Runs gate pipeline steps and collects results.
 */
import { randomUUID } from "crypto";
import type {
  GatePipeline,
  GateStep,
  GateResult,
  GateStepResult,
} from "../../shared/policy-types.js";
import { computeAffectedSteps, computePipelineVersion } from "./pipeline-config.js";

/** Options for running a gate */
export interface RunGateOptions {
  /** Pipeline to run */
  pipeline: GatePipeline;
  /** Commit SHA to test */
  commitSha: string;
  /** Branch name */
  branch: string;
  /** Project identifier */
  projectId: string;
  /** Node running the gate */
  nodeId: string;
  /** Changed files (for scope computation) */
  changedFiles: string[];
  /** Working directory */
  workDir: string;
  /** Execute command function (injected for testing) */
  executeCommand: (command: string, options: ExecuteOptions) => Promise<ExecuteResult>;
  /** Stops the run: steps not started yet are skipped and the result is "error" */
  signal?: AbortSignal;
}

/** Options for command execution */
export interface ExecuteOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** The step's argv (no shell), when the step has one */
  argv?: string[];
  /** The step's name */
  step?: string;
  /** Aborted when the run is cancelled */
  signal?: AbortSignal;
}

/** Result of command execution */
export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a gate pipeline and collect results.
 */
export async function runGate(options: RunGateOptions): Promise<GateResult> {
  const {
    pipeline,
    commitSha,
    branch,
    projectId,
    nodeId,
    changedFiles,
    workDir,
    executeCommand,
    signal,
  } = options;

  const gateId = `gate-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const pipelineVersion = computePipelineVersion(pipeline);

  // Compute which steps to run based on changed files
  const selectedSteps = computeAffectedSteps(pipeline, changedFiles);

  // Get the step configs for selected steps
  const stepsToRun = pipeline.steps.filter(s => selectedSteps.includes(s.name));

  const stepResults: GateStepResult[] = [];
  let overallStatus: "passed" | "failed" | "error" = "passed";
  let aborted = false;
  let cancelled = false;

  // Check overall timeout
  const overallTimeoutMs = pipeline.timeoutSeconds * 1000;
  const overallDeadline = Date.now() + overallTimeoutMs;

  // Run each step in order
  for (const step of stepsToRun) {
    // Check overall timeout
    if (Date.now() >= overallDeadline) {
      stepResults.push({
        name: step.name,
        status: "timed_out",
        error: "Pipeline timeout exceeded",
      });
      overallStatus = "failed";
      aborted = true;
      break;
    }

    if (!aborted && signal?.aborted) {
      cancelled = true;
      aborted = true;
      overallStatus = "error";
    }

    if (aborted) {
      stepResults.push({
        name: step.name,
        status: "skipped",
        error: cancelled ? "Pipeline cancelled" : "Previous step failed",
      });
      continue;
    }

    const stepResult = await runStep(step, {
      workDir,
      executeCommand,
      remainingTimeMs: Math.max(0, overallDeadline - Date.now()),
      signal,
    });

    stepResults.push(stepResult);

    if (stepResult.status === "failed" || stepResult.status === "timed_out") {
      overallStatus = "failed";
      if (!step.continueOnFailure) {
        aborted = true;
      }
    }
  }

  // Mark any remaining steps as skipped
  const executedStepNames = new Set(stepResults.map(r => r.name));
  for (const stepName of selectedSteps) {
    if (!executedStepNames.has(stepName)) {
      stepResults.push({
        name: stepName,
        status: "skipped",
        error: aborted ? "Pipeline aborted" : "Step not executed",
      });
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

  return {
    id: gateId,
    pipelineId: pipeline.id,
    commitSha,
    branch,
    projectId,
    nodeId,
    status: overallStatus,
    steps: stepResults,
    selectedSteps,
    durationMs,
    startedAt,
    completedAt,
    pipelineVersion,
  };
}

/**
 * Run a single gate step.
 */
async function runStep(
  step: GateStep,
  options: {
    workDir: string;
    executeCommand: (command: string, options: ExecuteOptions) => Promise<ExecuteResult>;
    remainingTimeMs: number;
    signal?: AbortSignal;
  }
): Promise<GateStepResult> {
  const { workDir, executeCommand, remainingTimeMs, signal } = options;

  const stepStartedAt = new Date().toISOString();
  const timeoutMs = Math.min(step.timeoutSeconds * 1000, remainingTimeMs);

  try {
    const result = await executeCommand(step.command, {
      cwd: workDir,
      timeoutMs,
      env: step.env,
      argv: step.argv,
      step: step.name,
      signal,
    });

    const stepCompletedAt = new Date().toISOString();

    if (result.timedOut) {
      return {
        name: step.name,
        status: "timed_out",
        durationMs: result.durationMs,
        output: truncateOutput(result.stdout + result.stderr),
        error: `Step timed out after ${step.timeoutSeconds}s`,
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
      };
    }

    const passed = result.exitCode === 0;

    return {
      name: step.name,
      status: passed ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: truncateOutput(result.stdout + result.stderr),
      error: passed ? undefined : `Exit code ${result.exitCode}`,
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    };
  } catch (error) {
    return {
      name: step.name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      startedAt: stepStartedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Truncate output to last N lines.
 */
function truncateOutput(output: string, maxLines = 100): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }
  return `... (${lines.length - maxLines} lines truncated)\n` + lines.slice(-maxLines).join("\n");
}

/**
 * Validate a gate result has all required fields.
 * Used before accepting a result.
 */
export function validateGateResult(result: GateResult, pipeline: GatePipeline): string[] {
  const errors: string[] = [];

  // Check required fields
  if (!result.id) errors.push("Missing gate ID");
  if (!result.pipelineId) errors.push("Missing pipeline ID");
  if (!result.commitSha) errors.push("Missing commit SHA");
  if (!result.nodeId) errors.push("Missing node ID");
  if (!result.startedAt) errors.push("Missing startedAt");
  if (!result.completedAt) errors.push("Missing completedAt");
  if (!result.pipelineVersion) errors.push("Missing pipeline version");

  // Check pipeline ID matches
  if (result.pipelineId !== pipeline.id) {
    errors.push(`Pipeline ID mismatch: expected ${pipeline.id}, got ${result.pipelineId}`);
  }

  // Check pipeline version matches
  const expectedVersion = computePipelineVersion(pipeline);
  if (result.pipelineVersion !== expectedVersion) {
    errors.push(`Pipeline version mismatch: expected ${expectedVersion}, got ${result.pipelineVersion}`);
  }

  // Check that all selected steps have results
  const resultStepNames = new Set(result.steps.map(s => s.name));
  for (const stepName of result.selectedSteps) {
    if (!resultStepNames.has(stepName)) {
      errors.push(`Missing result for selected step: ${stepName}`);
    }
  }

  // Check that step names are valid
  const pipelineStepNames = new Set(pipeline.steps.map(s => s.name));
  for (const step of result.steps) {
    if (!pipelineStepNames.has(step.name)) {
      errors.push(`Unknown step in result: ${step.name}`);
    }
  }

  // A passed result must have every selected step passed. Steps outside the
  // scope are not selected, so they have no result at all; a "skipped" step
  // means it never ran (runGate only skips after an abort), and an
  // all-skipped or empty result proves nothing ran.
  if (result.status === "passed") {
    for (const step of result.steps) {
      if (step.status !== "passed") {
        errors.push(`Result marked as passed but step "${step.name}" has status "${step.status}"`);
      }
    }
    if (!result.steps.some(s => s.status === "passed")) {
      errors.push("Result marked as passed but no step passed");
    }
  }

  return errors;
}
