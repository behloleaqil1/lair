/**
 * Watchdog module types (SPEC-autonomy §2)
 */

/**
 * An SLO definition - what to measure and thresholds
 */
export interface SLODefinition {
  /** Unique SLO ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this SLO measures */
  description: string;
  /** Project ID this SLO belongs to (null = global) */
  projectId: string | null;
  /** Whether this SLO is enabled */
  enabled: boolean;
  /** Threshold value (meaning depends on SLO type) */
  threshold: number;
  /** Unit for the threshold (hours, minutes, percentage, etc.) */
  unit: "hours" | "minutes" | "seconds" | "percentage" | "count";
  /** SLO type determines the detector logic */
  type: SLOType;
  /** When this condition must be met (for conditional SLOs) */
  condition?: string;
}

export type SLOType =
  | "merge-frequency"      // merge every N hours while tasks ready
  | "gate-frequency"       // passing gate every N hours while gates run
  | "agent-progress"       // agent shows progress every N minutes
  | "lane-busy"            // lane not busy > N× median
  | "idle-capacity"        // idle capacity used within N minutes
  | "branch-green";        // default branch is green

/**
 * Current state of an SLO
 */
export interface SLOState {
  /** SLO definition ID */
  sloId: string;
  /** Current status */
  status: "healthy" | "warning" | "breached";
  /** Current value being measured */
  currentValue: number;
  /** Threshold from definition */
  threshold: number;
  /** When the current state started */
  stateChangedAt: string;
  /** Evidence for current state */
  evidence: string[];
  /** Last check timestamp */
  lastCheckedAt: string;
}

/**
 * An SLO breach event
 */
export interface SLOBreach {
  /** Unique breach ID */
  id: string;
  /** SLO that was breached */
  sloId: string;
  /** When the breach was detected */
  detectedAt: string;
  /** Evidence at time of breach */
  evidence: string[];
  /** Current value when breached */
  value: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Playbook runs triggered by this breach */
  playbookRuns: string[];
  /** Whether this breach is resolved */
  resolved: boolean;
  /** When resolved */
  resolvedAt?: string;
}

/**
 * A playbook definition - how to respond to a breach
 */
export interface PlaybookDefinition {
  /** Unique playbook ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this playbook does */
  description: string;
  /** SLO types this playbook handles */
  forSLOTypes: SLOType[];
  /** Pattern to match against breach evidence (optional) */
  forPattern?: string;
  /** Whether owner approval is required */
  requiresApproval: boolean;
  /** Priority (lower = run first) */
  priority: number;
  /** Maximum attempts before escalating */
  maxAttempts: number;
  /** Cooldown between attempts in seconds */
  cooldownSeconds: number;
  /** Steps in this playbook */
  steps: PlaybookStep[];
}

/**
 * A single step in a playbook
 */
export interface PlaybookStep {
  /** Step ID (unique within playbook) */
  id: string;
  /** Step name */
  name: string;
  /** What this step does */
  description: string;
  /** Step type */
  type: PlaybookStepType;
  /** Step-specific parameters */
  params: Record<string, unknown>;
  /** Whether to continue on failure */
  continueOnFailure?: boolean;
  /** Timeout in seconds */
  timeoutSeconds?: number;
}

export type PlaybookStepType =
  | "diagnose"     // gather information
  | "act"          // take action
  | "verify"       // check if action worked
  | "escalate"     // raise to decision inbox
  | "wait"         // wait for a condition
  | "notify";      // send a notification

/**
 * A running or completed playbook execution
 */
export interface PlaybookRun {
  /** Unique run ID */
  id: string;
  /** Playbook being run */
  playbookId: string;
  /** Breach that triggered this run */
  breachId: string;
  /** Current status */
  status: PlaybookRunStatus;
  /** Attempt number (1-based) */
  attempt: number;
  /** When the run started */
  startedAt: string;
  /** When the run completed */
  completedAt?: string;
  /** Steps that have been executed */
  stepResults: PlaybookStepResult[];
  /** Diagnosis gathered during the run */
  diagnosis?: Record<string, unknown>;
  /** Error if failed */
  error?: string;
}

export type PlaybookRunStatus =
  | "pending"        // waiting to start
  | "running"        // currently executing
  | "succeeded"      // completed successfully
  | "failed"         // failed, may retry
  | "escalated"      // escalated to decision inbox
  | "cancelled";     // cancelled by user

/**
 * Result of a playbook step execution
 */
export interface PlaybookStepResult {
  /** Step ID */
  stepId: string;
  /** Status */
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  /** When the step started */
  startedAt?: string;
  /** When the step completed */
  completedAt?: string;
  /** Output from the step */
  output?: string;
  /** Error if failed */
  error?: string;
}

/**
 * Health summary for the UI
 */
export interface HealthSummary {
  /** Overall health status */
  overall: "healthy" | "warning" | "critical";
  /** SLO states by status */
  slosByStatus: {
    healthy: number;
    warning: number;
    breached: number;
  };
  /** Active breaches */
  activeBreaches: SLOBreach[];
  /** Recent playbook runs */
  recentPlaybookRuns: PlaybookRun[];
  /** Timestamp of this summary */
  generatedAt: string;
}
