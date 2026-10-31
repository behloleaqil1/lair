/**
 * Placement (src/server/placement/): which machine runs each queued job of a
 * project's own gate queue. Shared by the server's status route and the
 * Gates and Machines views.
 */

/** A machine's probe state: up only after `min_up_seconds` of passing probes. */
export type PlacementMachineState = "up" | "starting" | "down" | "unknown";

/** An on-demand machine's power state, from its state_cmd. */
export type OnDemandPowerState = "running" | "stopped" | "pending" | "stopping" | "unknown";

/** An on-demand machine's availability for placement. */
export type OnDemandAvailability = "available" | "unavailable";

export interface OnDemandStatus {
  /** The power state from state_cmd */
  powerState: OnDemandPowerState;
  /** Whether the machine is available for placement */
  availability: OnDemandAvailability;
  /** Why unavailable (guard refused, unknown state, command failed) */
  unavailableReason: string | null;
  /** Whether the guard allows starting the machine */
  guardOk: boolean;
  /** When state and guard were last checked (ISO) */
  lastCheckAt: string | null;
  /** Boot time added to estimates (seconds) */
  bootSeconds: number;
  /** Cost per hour (shown; breaks a tie between two equally good moves) */
  costPerHour: number | null;
  /** When touch_cmd last ran (a job was running there), and why it failed */
  lastTouchAt: string | null;
  touchError: string | null;
}

export interface PlacementMachine {
  id: string;
  state: PlacementMachineState;
  /** When the current run of passing probes began (ISO), while it passes */
  passingSince: string | null;
  /** When it counted as up (ISO), while it is up */
  upSince: string | null;
  /** When it last failed a probe after passing (ISO), while it is down */
  downSince: string | null;
  lastProbeAt: string | null;
  /** Why the last probe failed */
  lastError: string | null;
  /** The 1-minute load average, from load_cmd */
  load: number | null;
  cpus: number | null;
  /** load ÷ cpus (null without both) */
  utilization: number | null;
  /** max(1, utilization): how much slower a loaded machine runs jobs (1 when unknown) */
  factor: number;
  /** On-demand status, when this machine has on_demand configured */
  onDemand: OnDemandStatus | null;
}

export interface PlacementLane {
  name: string;
  machine: string;
  slots: number;
  /** Running jobs in the lane */
  inUse: number;
  queued: number;
  /** Per class with a limit: the limit and the running jobs of that class */
  limits: { class: string; limit: number; inUse: number }[];
  /** The lanes whose queue this lane's runner takes from (a pseudo-lane) */
  serves: string[];
}

export interface PlacementAdvice {
  to: string;
  /** How much sooner the job is expected to finish there (seconds) */
  gainSeconds: number;
  /** One line: "would move X heavy→remote: est. 52 min → 18 min; remote idle, mac load 3.1×" */
  explanation: string;
  /** A quiet re-check (prefer_quiet): placed by load, not by finish time */
  quiet: boolean;
  /** Its own lane never runs its class (a limit of 0 there): gainSeconds is 0, any lane that can is better */
  stuck: boolean;
  /** It goes back out of an on-demand lane that can't run it, and why (gainSeconds is 0) */
  back?: string;
}

export interface PlacementJob {
  id: string;
  lane: string;
  priority: number;
  status: "queued" | "running";
  /** The first class whose patterns match its command, or null */
  class: string | null;
  /** Expected start and finish (ISO); null when its machine is not up */
  expectedStart: string | null;
  expectedFinish: string | null;
  /** Why placement never moves it (taken by a serving lane, cool-down, machine down, ...) */
  held: string | null;
  /** The move placement makes (act) or would make (observe), when there is one */
  advice: PlacementAdvice | null;
}

export type PlacementMoveStatus = "moving" | "moved" | "failed" | "interrupted" | "gone" | "would_move";

export interface PlacementMove {
  id: string;
  gateId: string;
  from: string;
  to: string;
  mode: "observe" | "act";
  status: PlacementMoveStatus;
  gainSeconds: number;
  explanation: string;
  /** The argv that ran (or would run) */
  argv: string[] | null;
  error: string | null;
  at: string;
  completedAt: string | null;
}

export interface PlacementDuration {
  class: string;
  machine: string;
  /** Median of the recent samples (seconds) */
  medianSeconds: number;
  samples: number;
}

export interface PlacementTick {
  at: string;
  moves: number;
  wouldMoves: number;
  failures: number;
}

export interface PlacementStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  mode: "observe" | "act" | null;
  /** Why act mode is off (observe mode, read_only), or null */
  actBlocked: string | null;
  errors: string[];
  intervalSeconds: number | null;
  lastTick: PlacementTick | null;
  lastError: string | null;
  machines: PlacementMachine[];
  lanes: PlacementLane[];
  jobs: PlacementJob[];
  moves: PlacementMove[];
  durations: PlacementDuration[];
}
