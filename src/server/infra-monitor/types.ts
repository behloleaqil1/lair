/**
 * Types of the infrastructure monitor (docs/configuration.md#infrastructure-monitor).
 *
 * The monitor watches the machines that run a project's gate lanes and the
 * jobs on them, and finds:
 * - machine_down: a machine has failed its probes for down_threshold_seconds
 *   while a job runs on it, or while jobs wait in its lanes;
 * - job_lost: a running request whose process group is gone;
 * - slot_overflow: more running requests in a lane than it has slots (two
 *   runners claiming one slot);
 * - dead_runner: jobs wait in a lane and none of its runner pid files names a
 *   live process.
 */

export type FindingType = "machine_down" | "job_lost" | "slot_overflow" | "dead_runner";

/** What the monitor knows about one machine, from its probes. */
export interface MachineView {
  id: string;
  /** null: not probed yet */
  up: boolean | null;
  /** Since when every probe round has failed (epoch ms), while it does */
  downSince: number | null;
  /** Since when every probe round has passed (epoch ms), while it does */
  upSince: number | null;
  lastProbeAt: number | null;
  /** The failing probe's error, one line (a timeout says so) */
  lastError: string | null;
  lanes: string[];
}

/** A running request the monitor watches. */
export interface JobView {
  id: string;
  lane: string;
  machine: string;
  /** The request's claim time (its ctime, epoch ms) */
  claimedAt: number;
  /** The machine answered its probes at least once while this job ran */
  machineSeenUp: boolean;
  /** The process group in the request's .pgid file, if there is one */
  pgid: number | null;
  /** null: no .pgid file (yet) */
  groupAlive: boolean | null;
}

/** A problem the monitor found. */
export interface InfraFinding {
  /** Dedupe key, also the notice's key: `<type>:<subject>` */
  key: string;
  type: FindingType;
  /** One line */
  summary: string;
  /** Evidence lines, one line each */
  evidence: string[];
  /** Flat facts for the notice's evidence */
  facts: Record<string, string | number | boolean | null>;
  machine: string | null;
  lane: string | null;
  /** Running jobs a machine_down finding is about (their re-queue candidates) */
  jobs: { id: string; lane: string }[];
}

export interface FindingView extends InfraFinding {
  /** When the monitor first reported it (epoch ms) */
  since: number;
  /** When its cause was last seen gone (epoch ms); the notice is withdrawn once it stays gone */
  clearingSince: number | null;
  /** The open notice in the Decision Inbox (act mode), or null */
  noticeId: string | null;
}

/** One job's re-queue, as the ledger keeps it across restarts. */
export interface RequeueRecord {
  project: string;
  id: string;
  from: string;
  to: string;
  attempts: number;
  /** running: started and not finished (a restart counts it as a failed attempt) */
  status: "running" | "moved" | "failed" | "gave_up";
  lastAttemptAt: number;
  /** When a failed re-queue may run again (epoch ms), or null */
  nextAttemptAt: number | null;
  lastError: string | null;
  /** The argv that ran */
  argv: string[];
}

/** A re-queue act mode would run now for a job of a down machine (observe mode shows it; nothing runs). */
export interface PlannedRequeue {
  id: string;
  from: string;
  to: string | null;
  argv: string[] | null;
  /** Why it can't run now, or null */
  reason: string | null;
}

export interface InfraMonitorTick {
  at: string;
  durationMs: number;
  machinesProbed: number;
  machinesDown: number;
  runningJobs: number;
  queuedJobs: number;
  findings: number;
  noticesRaised: number;
  noticesWithdrawn: number;
  requeues: number;
}

export interface InfraMonitorStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  /** Why act mode does nothing (observe mode, read_only project...), or null */
  actBlocked: string | null;
  intervalSeconds: number | null;
  lastTick: InfraMonitorTick | null;
  lastError: string | null;
  /** No tick finished for three intervals: the monitor is not watching */
  stale: boolean;
  machines: MachineView[];
  jobs: JobView[];
  findings: FindingView[];
  /** The re-queues act mode would run (or runs) for the current findings */
  plannedRequeues: PlannedRequeue[];
  /** The re-queues act mode ran, from the ledger */
  requeues: RequeueRecord[];
}
