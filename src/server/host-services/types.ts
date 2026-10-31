/**
 * Host services types (duty D13): per-machine services with probe and start.
 *
 * A host service is a process that must be running on a machine for certain
 * work (gates, pipelines) to succeed: Docker, a tunnel daemon, etc. The
 * module probes each service periodically, starts it when down (in act mode),
 * and holds the lanes that need it while it is unavailable.
 */

/** A configured service on one machine. */
export interface ServiceConfig {
  /** Display name, e.g. "docker" */
  name: string;
  /** argv to probe: exit 0 = up */
  probe: string[];
  /** argv to start (act mode only); the start is async (returns before the service is up) */
  start: string[];
  /** Lanes or pipelines that need this service (hold them while it is down) */
  neededBy: string[];
}

/** A service's observed state. */
export type ServiceState = "up" | "down" | "starting" | "failing";

/** The result of a service probe. */
export interface ProbeResult {
  up: boolean;
  /** The probe's exit code */
  code: number;
  /** Probe stderr/stdout (first 500 chars) */
  output: string;
  checkedAt: string;
}

/** A service's current status. */
export interface ServiceStatus {
  machine: string;
  name: string;
  state: ServiceState;
  lastProbe: ProbeResult | null;
  /** When the service was last known up */
  lastUpAt: string | null;
  /** When the service was last started (act mode) */
  lastStartAt: string | null;
  /** Current start attempts since the last time it was up */
  startAttempts: number;
  /** The lanes/pipelines held while this service is down */
  holds: string[];
  /** When a decision was raised for this outage (null if none yet) */
  decisionRaisedAt: string | null;
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

/** State stored per service across restarts. */
export interface StoredServiceState {
  machine: string;
  name: string;
  state: ServiceState;
  lastUpAt: string | null;
  lastStartAt: string | null;
  startAttempts: number;
  /** The outage's open decision id, or null */
  decisionId: string | null;
  /** Last probe result */
  lastProbe: ProbeResult | null;
  /** When the current outage started (first failed probe after up); null if up */
  outageStartedAt: string | null;
  /**
   * Consecutive failures in this outage; resets only after the service has
   * stayed up for `stableWindowMs`. A flapping service (up briefly then down
   * again) keeps its failure count so the backoff grows.
   */
  consecutiveFailures: number;
  /** When the service first came up in this recovery; null if currently down */
  recoveryStartedAt: string | null;
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
  /** Delay between start and next probe in seconds (default 10) */
  startDelaySeconds: number;
  /** Max start attempts before raising a decision (default 3) */
  maxStartAttempts: number;
  /** Services per machine */
  machines: Map<string, ServiceConfig[]>;
}

/** What the host-services module tells placement/fill about held lanes. */
export interface LaneHold {
  lane: string;
  reason: string;
  heldAt: string;
  service: string;
  machine: string;
}

export const DECISION_MODULE = "host-services";
