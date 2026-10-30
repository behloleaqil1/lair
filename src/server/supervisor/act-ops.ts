/**
 * Acting operations for supervisor.act (S3): each op goes through the owning
 * module's own function or route with that module's checks.
 *
 * docs/design/supervisor.md "Proposal ops": each op names the existing module
 * route that carries it out, with that route's checks.
 */
import type { Decision } from "../../shared/decision-types.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { ActOp, ActSettings } from "./act-config.js";
import type { ActEvidence } from "./act-detectors.js";
import { isInfraFailure, checkDocker } from "./act-detectors.js";

/** Result of attempting an acting op */
export interface ActResult {
  op: ActOp;
  target: string;
  success: boolean;
  /** What happened (used in audit) */
  detail: string;
  /** Evidence that led to the action */
  evidence: string[];
  /** Whether this was observe mode (would-act) or actual act */
  mode: "observe" | "act";
}

/** The modules the supervisor needs to perform acting ops */
export interface ActModules {
  /** Release a fill hold on a task (agents module) */
  releaseFillHold?: (task: string) => Promise<{ task: string; runId: string | null }>;
  /** Withdraw a decision (decisions module) */
  withdrawDecision?: (id: string, reason: string) => Promise<void>;
  /** Find an open decision by id */
  findDecision?: (id: string) => Decision | null;
  /** Run a command (for cleared checks) */
  runCommand?: (cmd: string, args: string[]) => Promise<{ exitCode: number; output: string }>;
  /** Check if a gate has a result or is running */
  checkGate?: (gateId: string) => { exists: boolean; running: boolean } | null;
}

// ============ RELEASE_HOLD ============

/**
 * release_hold: release an agent hold caused by infrastructure.
 * Uses the agents module's releaseFillHold, same as "Start it again".
 */
export async function releaseHold(
  evidence: ActEvidence,
  settings: ActSettings,
  modules: ActModules,
): Promise<ActResult> {
  const result: ActResult = {
    op: "release_hold",
    target: evidence.target,
    success: false,
    detail: "",
    evidence: evidence.evidence,
    mode: settings.mode === "act" ? "act" : "observe",
  };

  // Observe mode: record what would happen
  if (settings.mode !== "act") {
    result.success = true;
    result.detail = "would release hold (observe mode)";
    return result;
  }

  // Act mode: verify op is allowed
  if (!settings.allow.includes("release_hold")) {
    result.detail = "release_hold not in supervisor.act.allow";
    return result;
  }

  // Extract task from target
  const task = evidence.target.replace(/^task:/, "");
  if (!task) {
    result.detail = "invalid target: no task";
    return result;
  }

  // Re-validate evidence at act time
  const cleared = await evidence.clearedCheck();
  if (!cleared.cleared) {
    result.detail = `cleared check failed: ${cleared.reason}`;
    return result;
  }

  // Check Docker if evidence suggests Docker issue
  if (modules.runCommand && evidence.evidence.some((e) => e.toLowerCase().includes("docker"))) {
    const docker = await checkDocker(modules.runCommand);
    if (!docker.available) {
      result.detail = `Docker still unavailable: ${docker.error}`;
      return result;
    }
  }

  // Perform the release through the agents module
  if (!modules.releaseFillHold) {
    result.detail = "agents module not available";
    return result;
  }

  try {
    const released = await modules.releaseFillHold(task);
    result.success = true;
    result.detail = `released hold on task ${task}${released.runId ? ` (run ${released.runId.slice(0, 8)})` : ""}`;
  } catch (e) {
    result.detail = `release failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return result;
}

// ============ CLOSE_INFRA_ESCALATION ============

/**
 * close_infra_escalation: close a triage escalation as environment-fixed.
 * Withdraws the decision through the decisions module.
 */
export async function closeInfraEscalation(
  evidence: ActEvidence,
  settings: ActSettings,
  modules: ActModules,
): Promise<ActResult> {
  const result: ActResult = {
    op: "close_infra_escalation",
    target: evidence.target,
    success: false,
    detail: "",
    evidence: evidence.evidence,
    mode: settings.mode === "act" ? "act" : "observe",
  };

  // Observe mode: record what would happen
  if (settings.mode !== "act") {
    result.success = true;
    result.detail = "would close escalation (observe mode)";
    return result;
  }

  // Act mode: verify op is allowed
  if (!settings.allow.includes("close_infra_escalation")) {
    result.detail = "close_infra_escalation not in supervisor.act.allow";
    return result;
  }

  // Extract decision id from target
  const decisionId = evidence.target.replace(/^escalation:/, "");
  if (!decisionId) {
    result.detail = "invalid target: no decision id";
    return result;
  }

  // Re-validate evidence at act time
  const cleared = await evidence.clearedCheck();
  if (!cleared.cleared) {
    result.detail = `cleared check failed: ${cleared.reason}`;
    return result;
  }

  // Verify the decision still exists and is open
  if (modules.findDecision) {
    const decision = modules.findDecision(decisionId);
    if (!decision) {
      result.detail = "decision no longer exists";
      return result;
    }
    if (decision.status !== "open") {
      result.detail = `decision already ${decision.status}`;
      return result;
    }
    // Re-verify it's still an infra escalation
    const check = isInfraFailure(decision.context);
    if (!check.isInfra) {
      result.detail = "decision no longer appears to be infra (found code failure pattern)";
      return result;
    }
  }

  // Withdraw the decision
  if (!modules.withdrawDecision) {
    result.detail = "decisions module not available";
    return result;
  }

  try {
    await modules.withdrawDecision(decisionId, `resolved by supervisor (close_infra_escalation): ${evidence.evidence[0] ?? "infrastructure recovered"}`);
    result.success = true;
    result.detail = `closed escalation ${decisionId.slice(0, 8)} as environment-fixed`;
  } catch (e) {
    result.detail = `withdraw failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return result;
}

// ============ REJECT_DUPLICATE_PROPOSAL ============

/**
 * reject_duplicate_proposal: reject an older duplicate planner proposal.
 * Withdraws the decision through the planner's own mechanism.
 */
export async function rejectDuplicateProposal(
  evidence: ActEvidence,
  settings: ActSettings,
  modules: ActModules,
): Promise<ActResult> {
  const result: ActResult = {
    op: "reject_duplicate_proposal",
    target: evidence.target,
    success: false,
    detail: "",
    evidence: evidence.evidence,
    mode: settings.mode === "act" ? "act" : "observe",
  };

  // Observe mode: record what would happen
  if (settings.mode !== "act") {
    result.success = true;
    result.detail = "would reject duplicate proposal (observe mode)";
    return result;
  }

  // Act mode: verify op is allowed
  if (!settings.allow.includes("reject_duplicate_proposal")) {
    result.detail = "reject_duplicate_proposal not in supervisor.act.allow";
    return result;
  }

  // Extract decision id from target
  const decisionId = evidence.target.replace(/^proposal:/, "");
  if (!decisionId) {
    result.detail = "invalid target: no decision id";
    return result;
  }

  // Verify the decision still exists and is open
  if (modules.findDecision) {
    const decision = modules.findDecision(decisionId);
    if (!decision) {
      result.detail = "decision no longer exists";
      return result;
    }
    if (decision.status !== "open") {
      result.detail = `decision already ${decision.status}`;
      return result;
    }
  }

  // Withdraw the decision as rejected
  if (!modules.withdrawDecision) {
    result.detail = "decisions module not available";
    return result;
  }

  try {
    await modules.withdrawDecision(decisionId, `resolved by supervisor (reject_duplicate_proposal): ${evidence.evidence[0] ?? "duplicate of newer proposal"}`);
    result.success = true;
    result.detail = `rejected duplicate proposal ${decisionId.slice(0, 8)}`;
  } catch (e) {
    result.detail = `reject failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return result;
}

// ============ DISPATCHER ============

/** Execute an acting op based on its type */
export async function executeOp(
  evidence: ActEvidence,
  settings: ActSettings,
  modules: ActModules,
): Promise<ActResult> {
  switch (evidence.op) {
    case "release_hold":
      return releaseHold(evidence, settings, modules);
    case "close_infra_escalation":
      return closeInfraEscalation(evidence, settings, modules);
    case "reject_duplicate_proposal":
      return rejectDuplicateProposal(evidence, settings, modules);
  }
}
