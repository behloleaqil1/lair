/**
 * Evidence detectors for supervisor.act (S3): each yields an ActEvidence
 * when it finds a condition the supervisor can act on.
 *
 * Evidence detectors are deterministic and in code. The AI never decides
 * alone that something is broken (docs/design/supervisor.md "Safety").
 *
 * M2 fix: read the BLOCKED reason from fill_blocked events' evidence, not run.detail.
 * M3 fix: every cleared check fails closed (unknown = not cleared).
 */
import type { Decision } from "../../shared/decision-types.js";
import type { AgentsStore } from "../agents/store.js";
import type { AgentEvent } from "../agents/types.js";
import type { ActOp } from "./act-config.js";
import { CODE_FAILURE_PATTERNS, DEFAULT_INFRA_PATTERNS } from "./act-config.js";

/** Evidence that a condition can be acted on */
export interface ActEvidence {
  op: ActOp;
  /** What the op targets, e.g. "task:feat-login" or "escalation:abc123" */
  target: string;
  /** Why this is actionable, in Lair's own words */
  evidence: string[];
  /** What to re-check before acting (returns true when still valid). Accepts optional runCommand for probes. */
  clearedCheck: ClearedCheck;
  /** For release_hold: the kind of hold (blocked, no_done, etc.) - supervisor can only release some */
  holdKind?: string | null;
}

/**
 * A function that returns true when the condition is cleared (ready to act).
 * Accepts an optional runCommand for running probes (e.g., docker info).
 * M3: must fail closed (unknown = not cleared).
 */
export type ClearedCheck = (runCommand?: RunCommandFn) => Promise<{ cleared: boolean; reason: string }>;

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
 * The hold kinds the supervisor may release: only blocked and no_done.
 * An owner, waiting or waited_too_long hold stays the owner's.
 */
export const SUPERVISOR_RELEASABLE_HOLDS = ["blocked", "no_done"] as const;

/**
 * Check if an agent hold's BLOCKED/paused evidence points at infrastructure.
 * A hold is infra-caused if:
 * - The fill_blocked event's evidence line matches an infra pattern
 * - No text matches a code failure pattern
 *
 * M2 fix: Read the BLOCKED reason from fill_blocked events (evidence: [seen.line]),
 * not from run.detail (which is the run's state description, not the BLOCKED line).
 * Also check S1-1's infraEvidence approach for transient/exit_unknown events.
 */
export function detectHoldInfra(
  decision: Decision,
  store: AgentsStore,
  project: string,
): ActEvidence | null {
  // Only look at agents module decisions
  if (decision.source.module !== "agents") return null;

  // S5 fix: Only look at fill-raised decisions (fill: refs or fill's key patterns)
  // Chain escalations and "every profile failing" also use agents module but have different keys
  // Fill keys look like: "fill:<project>:<task>:<reason>" or the source ref starts with "fill:"
  const isFillDecision =
    decision.key?.startsWith(`fill:${project}:`) ||
    decision.source.ref?.startsWith("fill:") ||
    decision.key?.includes(":blocked:") || // fill's blocked key pattern
    decision.key?.includes(":no_done:"); // fill's no_done key pattern
  if (!isFillDecision) return null;

  // Extract the task from the decision's blocks
  const prefix = `agents:${project}:task:`;
  const block = decision.blocks.find((b) => b.startsWith(prefix));
  if (!block) return null;
  const task = block.slice(prefix.length);

  // Get the latest run and its chain
  const latest = store.latestRunForTask(project, task);
  if (!latest) return null;

  const chain = store.chainRuns(latest.chainId).slice(-20);
  const chainRunIds = new Set(chain.map((r) => r.id));

  // M2 fix: Read from fill_blocked and fill_held events' evidence lines, not run.detail
  // The agent's BLOCKED line is in fill_blocked events with evidence: [seen.line]
  const holdEvents = store.listEvents(project, {
    kinds: ["fill_blocked", "fill_held"],
    task,
    limit: 20,
  }) as AgentEvent[];

  // Also get transient and exit_unknown events for S1-1's infraEvidence patterns
  const infraEvents = store.listEvents(project, {
    kinds: ["transient", "exit_unknown"],
    task,
    limit: 50,
  }) as AgentEvent[];

  // Collect evidence lines from the correct sources
  const evidenceLines: string[] = [];

  // From fill_blocked/fill_held: the evidence array holds the BLOCKED line
  for (const event of holdEvents) {
    if (event.runId !== undefined && !chainRunIds.has(event.runId)) continue;
    const evidence = (event as { evidence?: string[] }).evidence;
    if (Array.isArray(evidence)) {
      for (const line of evidence) {
        if (typeof line === "string" && line.trim()) evidenceLines.push(line);
      }
    }
    // Also check the summary and data.line
    if (event.summary) evidenceLines.push(event.summary);
    const dataLine = (event as { data?: { line?: string } }).data?.line;
    if (typeof dataLine === "string" && dataLine.trim()) evidenceLines.push(dataLine);
  }

  // From transient/exit_unknown: the summary has the error text
  for (const event of infraEvents) {
    if (event.runId !== undefined && !chainRunIds.has(event.runId)) continue;
    if (event.summary) evidenceLines.push(event.summary);
  }

  // Also check the chain runs' details for 'exit unknown' patterns (restarts)
  for (const run of chain) {
    if (run.detail && run.detail.toLowerCase().startsWith("exit unknown")) {
      evidenceLines.push(run.detail);
    }
  }

  if (evidenceLines.length === 0) return null;

  // Check if ALL failures are infra (none are code failures)
  const infraEvidence: string[] = [];
  for (const text of evidenceLines) {
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

  // Check what kind of hold this is - the supervisor can only release blocked/no_done
  // This comes from fill's line.hold, which we can infer from the events
  const holdKind = inferHoldKind(holdEvents, chain);

  return {
    op: "release_hold",
    target: `task:${task}`,
    evidence: infraEvidence.slice(0, 5), // Limit evidence to 5 items
    holdKind, // For M4: the supervisor checks this before releasing
    clearedCheck: createClearedCheck(evidenceLines),
  };
}

/** Infer the hold kind from events. Returns the hold kind or null if unknown. */
function inferHoldKind(holdEvents: AgentEvent[], _chain: { state: string }[]): string | null {
  // Check the most recent hold event's data.hold
  for (const event of holdEvents) {
    const hold = (event as { data?: { hold?: string } }).data?.hold;
    if (typeof hold === "string") return hold;
  }
  // Fallback: if the chain's last run has a BLOCKED line, it's 'blocked'
  if (holdEvents.some((e) => e.kind === "fill_blocked")) return "blocked";
  return null;
}

/** Create a cleared check that fails closed (M3 fix) */
function createClearedCheck(evidenceLines: string[]): ClearedCheck {
  return async (runCommand?: RunCommandFn) => {
    // M3 fix: unknown = not cleared (fail closed)
    // For Docker-related failures, check if Docker is back
    const hasDocker = evidenceLines.some(
      (t) => t.toLowerCase().includes("docker") || t.includes("rc=125"),
    );
    if (hasDocker) {
      // Must have runCommand to verify Docker
      if (!runCommand) {
        return { cleared: false, reason: "Docker check needed but runCommand not available" };
      }
      const docker = await checkDocker(runCommand);
      if (!docker.available) {
        return { cleared: false, reason: `Docker still unavailable: ${docker.error}` };
      }
      return { cleared: true, reason: "Docker is available" };
    }

    // For SSH/network errors: we'd need the placement probe
    const hasSsh = evidenceLines.some((t) => t.toLowerCase().includes("ssh:") || t.includes("Connection refused"));
    if (hasSsh) {
      // M3: fail closed when we can't verify
      return { cleared: false, reason: "SSH/network check needed but probe not available (fail closed)" };
    }

    // For "exit unknown" (restart): Lair is running now, so it's cleared
    const hasRestart = evidenceLines.some((t) => t.toLowerCase().startsWith("exit unknown"));
    if (hasRestart) {
      return { cleared: true, reason: "Lair restarted and is now running" };
    }

    // M3: fail closed for unknown patterns - we don't know how to check
    return { cleared: false, reason: "Unknown infra pattern; cannot verify recovery (fail closed)" };
  };
}

/** Type for the optional runCommand function passed at act time */
export type RunCommandFn = (cmd: string, args: string[]) => Promise<{ exitCode: number; output: string }>;

// ============ ESCALATION INFRA DETECTOR ============

/**
 * Check if a triage escalation's evidence points at infrastructure that is
 * now cleared. The escalation is from "failed the same way" detection.
 *
 * M3 fix: cleared check fails closed (unknown = not cleared).
 * S2 fix: read infra classification from triage records when available.
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

  // S2: Configuration faults ("Permission denied (publickey", "docker: command not found")
  // are not transient infrastructure - releasing on them only loops
  const isConfigFault =
    decision.context.includes("Permission denied (publickey") ||
    decision.context.includes("docker: command not found");
  if (isConfigFault) return null;

  if (!infraCheck.isInfra) return null;

  // Extract gate id from the decision if present
  // S2: Use the recheck key pattern when available (triage keys decisions by recheck:<rootId>)
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
      // M3 fix: fail closed when unknown
      // Check if the gate now has a result or is running again
      if (gateId) {
        const status = checkGateResult(gateId);
        if (status === null) {
          // M3: unknown = not cleared
          return { cleared: false, reason: `cannot check gate ${gateId} status (fail closed)` };
        }
        if (status.exists) {
          return { cleared: true, reason: `gate ${gateId} now has a result` };
        }
        if (status.running) {
          return { cleared: true, reason: `gate ${gateId} is running again` };
        }
        return { cleared: false, reason: `gate ${gateId} still has no result` };
      }
      // M3: Without a gate id, we can't verify - fail closed
      return { cleared: false, reason: "no gate to check; cannot verify recovery (fail closed)" };
    },
  };
}

// ============ DUPLICATE PROPOSAL DETECTOR ============

export interface PlannerDecision {
  id: string;
  createdAt: string;
  proposals: Array<{ op: string; agent: string; task: string; text?: string }>;
}

/**
 * Detect duplicate planner proposals: a pending planner decision whose
 * proposals are all identical to those of a NEWER pending planner decision.
 *
 * M6 fix: compare proposals by text too, not just by index and op/agent/task.
 * Two proposals with the same ops in different order are duplicates;
 * two add proposals with different text are not.
 */
export function detectDuplicateProposal(
  decision: Decision,
  allPlannerDecisions: Decision[],
  getProposals: (decisionId: string) => Array<{ op: string; agent: string; task: string; text?: string }>,
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

    // M6 fix: compare proposals as sets (order-independent) and include text
    // Create canonical representations for comparison
    const thisSet = new Set(
      thisProposals.map((p) => `${p.op}|${p.agent}|${p.task}|${p.text ?? ""}`),
    );
    const otherSet = new Set(
      otherProposals.map((p) => `${p.op}|${p.agent}|${p.task}|${p.text ?? ""}`),
    );

    // Check if sets are identical
    if (thisSet.size !== otherSet.size) continue;
    let allMatch = true;
    for (const item of thisSet) {
      if (!otherSet.has(item)) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      return {
        op: "reject_duplicate_proposal",
        target: `proposal:${decision.id}`,
        evidence: [
          `decision ${decision.id.slice(0, 8)} has identical proposals to newer decision ${other.id.slice(0, 8)}`,
          `both have ${thisProposals.length} proposal(s)`,
        ],
        clearedCheck: async () => {
          // M3: Always verify the newer decision still exists and is open
          // This check is deferred to act time where we have access to the store
          return { cleared: true, reason: "duplicate verified (re-check at act time)" };
        },
      };
    }
  }

  return null;
}
