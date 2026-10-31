/**
 * Host services types (duty D13): per-machine services with probe and start.
 *
 * A host service is a process that must be running on a machine for certain
 * work (pipeline jobs, gates) to succeed: a container engine, a tunnel
 * daemon. The module probes each service every interval, starts it when it
 * is down (act mode, with a growing backoff), holds the pipeline lanes that
 * need it while it is not up (act mode), and raises one decision per outage
 * that it cannot fix.
 */

/** A configured service on one machine. */
export interface ServiceConfig {
  /** Display name, e.g. "docker" */
  name: string;
  /** argv to probe: exit 0 within probe_timeout_seconds = up */
  probe: string[];
  /** argv to start (act mode only); the start may return before the service is up */
  start: string[];
  /** Pipeline lanes, pipelines or `<pipeline>.<lane>` jobs that need this service */
  neededBy: string[];
}

/**
 * A service's observed state.
 * - up: the last probe exited 0 in time
 * - down: the last probe failed (non-zero exit, could not run, too much output)
 * - unknown: the last probe timed out: Lair cannot tell, so it never starts it
 * - starting: Lair ran the start command and is inside start_grace_seconds
 * - failing: Lair gave up starting it (max_start_attempts without a stable recovery)
 */
export type ServiceState = "up" | "down" | "unknown" | "starting" | "failing";

/** What one probe found. Never holds the probe's output: it can carry tokens or host names. */
export interface ProbeResult {
  up: boolean;
  /** Exit code; -1 when the probe could not run, timed out, wrote too much or was stopped */
  code: number;
  /** Killed by probe_timeout_seconds: the state is unknown, never up */
  timedOut: boolean;
  checkedAt: string;
}

/** The last start command Lair ran for a service. */
export interface StartResult {
  at: string;
  /** Exit code; null while it runs (or when Lair stopped during it), -1 when it could not run or timed out */
  code: number | null;
  timedOut: boolean;
}

/** Why a decision was raised for an outage (the evidence code of host-services.service_down). */
export type EscalationCode = "start_failed" | "flapping" | "not_started" | "probe_timeout";

/**
 * A service's state, kept in data/host-services/<project>.json so the backoff,
 * the start count and the open decision survive a restart or a reload.
 */
export interface StoredServiceState {
  machine: string;
  name: string;
  state: ServiceState;
  lastProbe: ProbeResult | null;
  /** When a probe last passed */
  lastUpAt: string | null;
  /** When the current run of passing probes began (null while not up) */
  upSince: string | null;
  /** When the current outage began: the first failed probe after up (null while up) */
  outageStartedAt: string | null;
  /** Failed probes since the last stable recovery (a brief "up" does not reset it) */
  failedProbes: number;
  /** Starts since the last stable recovery (a brief "up" does not reset it): drives the backoff */
  starts: number;
  lastStart: StartResult | null;
  /** The service came up after one of these starts and went down again before it was stable */
  recoveredAfterStart: boolean;
  /** One decision was raised for this outage (cleared by a stable recovery or a "retry" answer) */
  escalated: boolean;
  /** The open decision's id, or null */
  decisionId: string | null;
}

/** A service's status, as the read routes show it. */
export interface ServiceStatus {
  machine: string;
  name: string;
  state: ServiceState;
  lastProbe: ProbeResult | null;
  lastUpAt: string | null;
  upSince: string | null;
  outageStartedAt: string | null;
  failedProbes: number;
  starts: number;
  lastStart: StartResult | null;
  /** When act mode may start it next; null when no start is waiting */
  nextStartAt: string | null;
  /** The lanes this service holds now (enforced in act mode only) */
  holds: string[];
  /** The open decision's id, or null */
  decisionId: string | null;
}

/** Summary of one tick for a machine's services. */
export interface TickSummary {
  machine: string;
  at: string;
  services: number;
  up: number;
  down: number;
  started: number;
  decisions: number;
}

/** Module configuration (parsed from the project's host_services block). */
export interface HostServicesSettings {
  enabled: boolean;
  mode: "observe" | "act";
  /** Probe interval in seconds (default 60) */
  intervalSeconds: number;
  /** Probe timeout in seconds (default 15) */
  probeTimeoutSeconds: number;
  /** Start command timeout in seconds (default 30) */
  startTimeoutSeconds: number;
  /** Wait after a start before the re-probe in the same tick (default 10) */
  startDelaySeconds: number;
  /** After a start, how long the service may take to come up before it counts as down again (default 120) */
  startGraceSeconds: number;
  /** The longest wait between starts; the wait doubles from start_grace_seconds (default 1800) */
  backoffMaxSeconds: number;
  /** How long a service must stay up before its counts reset and its decision is withdrawn (default 300) */
  stableSeconds: number;
  /** Starts without a stable recovery before Lair stops and raises a decision (default 3) */
  maxStartAttempts: number;
  /** Failed probes with no start path (observe, read_only, timed out) before a decision (default 5) */
  escalateAfterProbes: number;
  /** Services per machine */
  machines: Map<string, ServiceConfig[]>;
}

/** A lane that a service which is not up holds. */
export interface LaneHold {
  lane: string;
  reason: string;
  /** When the outage that holds it began */
  heldAt: string;
  service: string;
  machine: string;
  /** Act mode: pipeline jobs of the lane wait. Observe mode: reported only */
  enforced: boolean;
}

export const DECISION_MODULE = "host-services";
