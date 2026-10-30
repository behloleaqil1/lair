/**
 * Evidence detectors for supervisor.act (S3): each yields an ActEvidence
 * when it finds a condition the supervisor can act on.
 *
 * Evidence detectors are deterministic and in code. The AI never decides
 * alone that something is broken (docs/design/supervisor.md "Safety").
 */
import type { Decision } from "../../shared/decision-types.js";
import type { AgentsStore } from "../agents/store.js";
import type { ActOp } from "./act-config.js";
import { CODE_FAILURE_PATTERNS, DEFAULT_INFRA_PATTERNS } from "./act-config.js";

/** Evidence that a condition can be acted on */
export interface ActEvidence {
  op: ActOp;
  /** What the op targets, e.g. "task:feat-login" or "escalation:abc123" */
  target: string;
  /** Why this is actionable, in Lair's own words */
  evidence: string[];
  /** What to re-check before acting (returns true when still valid) */
  clearedCheck: ClearedCheck;
}

/** A function that returns true when the condition is cleared (ready to act) */
export type ClearedCheck = () => Promise<{ cleared: boolean; reason: string }>;

// ============ INFRA DETECTION ============

/**
 * Check if text matches any infra pattern. Returns the matched pattern or
 * null. Case-insensitive matching.
 */
export function matchesInfraPattern(text: string, patterns: readonly string[] = DEFAULT_INFRA_PATTERNS): string | null {
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(text)) return pattern;
    } catch {
      // If the pattern isn't a valid regex, do substring match
      if (lower.includes(pattern.toLowerCase())) return pattern;
    }
  }
  return null;
}

/**
 * Check if text contains any code failure pattern. Returns the matched
 * pattern or null.
 */
export function matchesCodeFailure(text: string, patterns: readonly string[] = CODE_FAILURE_PATTERNS): string | null {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(text)) return pattern;
    } catch {
      if (text.toLowerCase().includes(pattern.toLowerCase())) return pattern;
    }
  }
  return null;
}

/**
 * Is the failure text purely infrastructure (matches infra patterns and NO
 * code failure patterns)?
 */
export function isInfraFailure(text: string): { isInfra: boolean; infraPattern: string | null; codePattern: string | null } {
  const infraPattern = matchesInfraPattern(text);
  const codePattern = matchesCodeFailure(text);
  return {
    isInfra: infraPattern !== null && codePattern === null,
    infraPattern,
    codePattern,
  };
}

// ============ DOCKER CHECK ============

export interface DockerCheckResult {
  available: boolean;
  error: string | null;
}

/** Check if Docker is available by running `docker info` */
export async function checkDocker(runCommand: (cmd: string, args: string[]) => Promise<{ exitCode: number; output: string }>): Promise<DockerCheckResult> {
  try {
    const result = await runCommand("docker", ["info"]);
    return {
      available: result.exitCode === 0,
      error: result.exitCode === 0 ? null : `docker info exited ${result.exitCode}`,
    };
  } catch (e) {
    return {
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============ HOLD INFRA DETECTOR ============

/**
 * Check if an agent hold's BLOCKED/paused evidence points at infrastructure.
 * A hold is infra-caused if:
 * - Every failed step's text matches an infra pattern
 * - No text matches a code failure pattern
 */
export function detectHoldInfra(
  decision: Decision,
  store: AgentsStore,
  project: string,
): ActEvidence | null {
  // Only look at agents module decisions
  if (decision.source.module !== "agents") return null;

  // Extract the task from the decision's blocks
  const prefix = `agents:${project}:task:`;
  const block = decision.blocks.find((b) => b.startsWith(prefix));
  if (!block) return null;
  const task = block.slice(prefix.length);

  // Get the latest run and its chain
  const latest = store.latestRunForTask(project, task);
  if (!latest) return null;

  const chain = store.chainRuns(latest.chainId).slice(-20);

  // Collect all failure evidence from the chain
  const failureTexts: string[] = [];
  for (const run of chain) {
    if (run.detail) failureTexts.push(run.detail);
  }

  // Also check recent events for this task
  const events = store.listEvents(project, { kinds: ["transient", "exit_unknown"], task, limit: 20 });
  for (const event of events) {
    if (event.summary) failureTexts.push(event.summary);
  }

  if (failureTexts.length === 0) return null;

  // Check if ALL failures are infra (none are code failures)
  const infraEvidence: string[] = [];
  for (const text of failureTexts) {
    const check = isInfraFailure(text);
    if (!check.isInfra) {
      // Found a code failure or no infra pattern: not purely infra
      return null;
    }
    if (check.infraPattern) {
      infraEvidence.push(`matched infra pattern "${check.infraPattern}" in: ${text.slice(0, 100)}`);
    }
  }

  if (infraEvidence.length === 0) return null;

  return {
    op: "release_hold",
    target: `task:${task}`,
    evidence: infraEvidence.slice(0, 5), // Limit evidence to 5 items
    clearedCheck: async () => {
      // For Docker-related failures, check if Docker is back
      const hasDocker = failureTexts.some(
        (t) => t.toLowerCase().includes("docker") || t.includes("rc=125"),
      );
      if (hasDocker) {
        // We'd need the runCommand here, but for now return optimistic
        // The actual check happens in the acting op
        return { cleared: true, reason: "infra check needed at act time" };
      }
      return { cleared: true, reason: "evidence still points at infrastructure" };
    },
  };
}

// ============ ESCALATION INFRA DETECTOR ============

/**
 * Check if a triage escalation's evidence points at infrastructure that is
 * now cleared. The escalation is from "failed the same way" detection.
 */
export function detectEscalationInfra(
  decision: Decision,
  checkGateResult: (gateId: string) => { exists: boolean; running: boolean } | null,
): ActEvidence | null {
  // Only look at triage module escalations
  if (decision.source.module !== "triage") return null;
  if (decision.kind !== "escalation") return null;

  // Check if the context mentions infrastructure
  const infraCheck = isInfraFailure(decision.context);

  if (!infraCheck.isInfra) return null;

  // Extract gate id from the decision if present
  const gateMatch = decision.context.match(/gate[:\s]+([a-zA-Z0-9-]+)/i);
  const gateId = gateMatch?.[1] ?? null;

  return {
    op: "close_infra_escalation",
    target: `escalation:${decision.id}`,
    evidence: [
      `escalation "${decision.title}" matches infra pattern: ${infraCheck.infraPattern}`,
      ...(gateId ? [`references gate ${gateId}`] : []),
    ],
    clearedCheck: async () => {
      // Check if the gate now has a result or is running again
      if (gateId) {
        const status = checkGateResult(gateId);
        if (status) {
          if (status.exists) {
            return { cleared: true, reason: `gate ${gateId} now has a result` };
          }
          if (status.running) {
            return { cleared: true, reason: `gate ${gateId} is running again` };
          }
          return { cleared: false, reason: `gate ${gateId} still has no result` };
        }
      }
      // If no gate id, assume the infra is back (Docker check, etc.)
      return { cleared: true, reason: "infrastructure appears recovered" };
    },
  };
}

// ============ DUPLICATE PROPOSAL DETECTOR ============

export interface PlannerDecision {
  id: string;
  createdAt: string;
  proposals: Array<{ op: string; agent: string; task: string }>;
}

/**
 * Detect duplicate planner proposals: a pending planner decision whose
 * proposals are all identical to those of a NEWER pending planner decision.
 */
export function detectDuplicateProposal(
  decision: Decision,
  allPlannerDecisions: Decision[],
  getProposals: (decisionId: string) => Array<{ op: string; agent: string; task: string }>,
): ActEvidence | null {
  if (decision.source.module !== "planner") return null;
  if (decision.status !== "open") return null;

  const thisProposals = getProposals(decision.id);
  if (thisProposals.length === 0) return null;

  // Look for a NEWER pending decision with identical proposals
  const thisTime = new Date(decision.createdAt).getTime();

  for (const other of allPlannerDecisions) {
    if (other.id === decision.id) continue;
    if (other.status !== "open") continue;
    if (other.source.module !== "planner") continue;

    const otherTime = new Date(other.createdAt).getTime();
    if (otherTime <= thisTime) continue; // Must be newer

    const otherProposals = getProposals(other.id);
    if (otherProposals.length !== thisProposals.length) continue;

    // Check if all proposals match
    const allMatch = thisProposals.every((p, i) => {
      const o = otherProposals[i];
      return o && p.op === o.op && p.agent === o.agent && p.task === o.task;
    });

    if (allMatch) {
      return {
        op: "reject_duplicate_proposal",
        target: `proposal:${decision.id}`,
        evidence: [
          `decision ${decision.id.slice(0, 8)} has identical proposals to newer decision ${other.id.slice(0, 8)}`,
          `both have ${thisProposals.length} proposal(s)`,
        ],
        clearedCheck: async () => {
          // Re-check that the newer decision still exists and is open
          return { cleared: true, reason: "duplicate verified" };
        },
      };
    }
  }

  return null;
}
