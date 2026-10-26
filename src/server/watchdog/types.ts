/**
 * Watchdog types (docs/design/autonomy.md §2).
 *
 * A detector reads probe data and reports findings. A finding with a new key
 * opens a breach; the breach stays open while the detector keeps reporting
 * that key. Playbooks (diagnose, act, verify) run against open breaches in
 * act mode; otherwise, or when every playbook is used up, the breach is
 * escalated once to the project's inbox.
 */

export const DETECTOR_IDS = [
  "lock_holder_dead",
  "duplicate_agent",
  "agent_hung",
  "orphan_claim",
  "infra_signature",
  "gate_owner_gone",
  "idle_capacity",
  "progress_stall",
  "crash_loop",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/**
 * Project-configured commands (watchdog.actions.<id>), and the placeholders
 * each one may use. {project} is available to all of them.
 */
export const ACTION_PLACEHOLDERS = {
  break_lock: ["lock", "lock_name", "pid"],
  stop_duplicate: ["agent", "pid", "keep_pid"],
  restart_agent: ["agent", "pid", "log"],
  release_claim: ["agent", "claim"],
  mark_lane_broken: ["lane", "signature", "gates"],
  requeue_gate: ["gate", "lane", "file", "pid"],
  fill_capacity: ["free", "ready", "queued", "running"],
  triage_stall: ["hours", "last_merge"],
  stop_container_restarts: ["container", "restarts"],
} as const satisfies Record<string, readonly string[]>;
export type ActionId = keyof typeof ACTION_PLACEHOLDERS;
export const ACTION_IDS = Object.keys(ACTION_PLACEHOLDERS) as ActionId[];

export const PLAYBOOK_IDS = [
  "stale_lock",
  "duplicate_agent",
  "agent_stuck",
  "orphan_claim",
  "lane_broken",
  "gate_owner_gone",
  "idle_capacity",
  "no_merges",
  "crash_loop",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

/** What a detector reports for one subject (an agent, a lock, a gate, ...). */
export interface Finding {
  detector: DetectorId;
  /** Stable identity, e.g. "agent_hung:worker-a"; one open breach per key */
  key: string;
  summary: string;
  evidence: string[];
  /** Placeholder values for the playbook's command */
  vars: Record<string, string>;
}

export type BreachStatus = "open" | "resolved";
/** cleared: the detector stopped reporting it; recovered: a playbook fixed it */
export type BreachResolution = "cleared" | "recovered";

export interface Breach {
  id: string;
  project: string;
  detector: DetectorId;
  key: string;
  summary: string;
  evidence: string[];
  vars: Record<string, string>;
  status: BreachStatus;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  resolution?: BreachResolution;
  escalatedAt?: string;
}

export type StepType = "diagnose" | "act" | "verify";

/**
 * How a verify step checks the result:
 * - recheck: run the detector again; passes when the breach key is gone
 * - agent_restarted: the breached pid is gone and the agent has a live process
 * - deferred: nothing to check right away; the breach closes when the
 *   detector stops reporting it, or is escalated after the last attempt
 */
export type VerifyCheck = "recheck" | "agent_restarted" | "deferred";

export interface PlaybookStep {
  id: string;
  type: StepType;
  /** act steps: the watchdog.actions.<id> command to run */
  action?: ActionId;
  /** verify steps */
  check?: VerifyCheck;
}

export interface PlaybookSettings {
  /** Per-playbook opt-in: act mode runs only playbooks with act: true */
  act: boolean;
  maxAttempts: number;
  cooldownMinutes: number;
  /** Wait before the verify step (agents take a moment to come back) */
  verifyDelaySeconds: number;
}

export interface PlaybookDefinition {
  id: PlaybookId;
  name: string;
  description: string;
  detector: DetectorId;
  /** Lower runs first when several playbooks handle one detector */
  priority: number;
  steps: PlaybookStep[];
  defaults: PlaybookSettings;
}

export interface CommandRecord {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface StepResult {
  stepId: string;
  type: StepType;
  status: "succeeded" | "failed" | "skipped" | "planned";
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  /** act steps: the command that ran */
  command?: CommandRecord;
  /** observe mode: the command the act step would run */
  plannedArgv?: string[];
}

export type RunMode = "act" | "observe";
export type RunStatus = "running" | "succeeded" | "failed" | "observed";
/**
 * recovered: verify passed; acted: the command ran, verify is deferred;
 * cleared: diagnose found the breach already gone; failed; observed
 */
export type RunOutcome = "recovered" | "acted" | "cleared" | "failed" | "observed";

export interface PlaybookRun {
  id: string;
  project: string;
  breachId: string;
  playbookId: PlaybookId;
  mode: RunMode;
  status: RunStatus;
  outcome?: RunOutcome;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  steps: StepResult[];
  error?: string;
}

export interface Escalation {
  id: string;
  project: string;
  breachId: string;
  createdAt: string;
  /** The inbox file written, or undefined when none is configured */
  file?: string;
  text: string;
  /**
   * Not written: the same breach key was escalated less than
   * watchdog.reescalate_minutes ago (a flapping breach)
   */
  suppressed?: boolean;
}

/** A crash loop delivery marked on one of its services' containers. */
export interface ContainerCrashLoop {
  container: string;
  service: string;
  environment: string;
  restarts: number;
  maxRestarts: number;
  windowMinutes: number;
  /** Restart samples and the container's last error lines */
  evidence: string[];
}

/**
 * Containers another module runs: delivery environments
 * (src/server/delivery/). The watchdog only reads them. Their crash loops
 * become crash_loop findings, and a container whose service a human holds is
 * left alone: no finding, and no command runs on it.
 */
export interface ContainerServices {
  /** True when the project has such containers (the crash_loop detector is active) */
  covers(project: string): boolean;
  crashLoops(project: string): ContainerCrashLoop[];
  /** Why the container must be left alone (its service is held), or null */
  heldReason(project: string, container: string): string | null;
}

export type SloState = "ok" | "breached" | "inactive" | "error";

/** One detector's state after the latest tick. */
export interface SloStatus {
  detector: DetectorId;
  state: SloState;
  openBreaches: number;
  detail: string;
  checkedAt: string;
}
