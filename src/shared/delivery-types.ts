/**
 * Delivery types (src/server/delivery/, docs/design/autonomy.md §7), shared
 * with the client.
 *
 * An environment is a docker compose project. Lair reads its services'
 * containers (status, health, restart counts), brings it up and down,
 * deploys changed services after a merge and rolls them back when they
 * aren't healthy in time. A service a human stopped is held: Lair never
 * starts it until the human releases it. A service whose restart count keeps
 * rising is crash-looping: Lair stops restarting it and the watchdog's
 * crash_loop playbook picks it up.
 */

/** What the status shows for a service. */
export const SERVICE_STATES = ["running", "stopped", "unhealthy", "restarting"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/**
 * healthy / unhealthy / starting: from the service's health check;
 * none: running, and there is no check to ask (no Docker HEALTHCHECK);
 * unknown: not running
 */
export type HealthState = "healthy" | "unhealthy" | "starting" | "none" | "unknown";

/** One container of a service, from `docker compose ps` and `docker inspect`. */
export interface ContainerInfo {
  id: string;
  name: string;
  /** Docker's state: created, running, restarting, exited, paused, dead */
  state: string;
  /** Docker's status text, e.g. "Up 2 hours (healthy)", "Exited (1) 3 minutes ago" */
  status: string;
  exitCode: number;
  restartCount: number;
  /** The image the container runs (sha256:...) */
  imageId?: string;
  /** The image reference it was created from, e.g. "shop-local-api" */
  imageRef?: string;
  /** Docker's health status: healthy, unhealthy, starting, or "" without a HEALTHCHECK */
  health: string;
  /** Docker's State.Error, and the last failing health check output */
  error?: string;
}

/** Why a held service is held. Held services are never started by Lair. */
export type HoldSource = "service" | "environment";

export interface Hold {
  project: string;
  environment: string;
  service: string;
  reason: string;
  /** service: a per-service Down; environment: an environment Down (released by an environment Up) */
  source: HoldSource;
  heldAt: string;
}

/** A service whose restart count rose by max_restarts or more within window_minutes. */
export interface CrashLoop {
  project: string;
  environment: string;
  service: string;
  /** The container whose restarts rose most */
  container: string;
  restarts: number;
  maxRestarts: number;
  windowMinutes: number;
  since: string;
  /** Restart samples, for the watchdog's evidence */
  evidence: string[];
  errorLines: string[];
}

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  health: HealthState;
  /** One line on the health check, e.g. "GET http://localhost:8080/health: 503" */
  healthDetail: string;
  /** Restarts by Docker's restart policy, summed over the service's containers */
  restartCount: number;
  containers: ContainerInfo[];
  held: Hold | null;
  crashLoop: CrashLoop | null;
  /** The last error lines of its log (for a service that isn't running healthy) */
  lastErrorLines: string[];
  /** Has build: true, so a deploy can rebuild it */
  buildable: boolean;
}

export type OperationKind = "up" | "down" | "restart" | "deploy" | "release";
export type OperationStatus = "running" | "succeeded" | "failed" | "rolled_back";
export type RequestedBy = "human" | "auto";

export interface OperationStep {
  at: string;
  service?: string;
  /** e.g. up, stop, down, restart, tag, build, roll, wait, rollback, hold, release, skip, prepare */
  action: string;
  status: "succeeded" | "failed" | "skipped";
  argv?: string[];
  code?: number;
  output?: string;
  detail?: string;
}

/** One Up, Down, Restart, Deploy or Release, with every command it ran. */
export interface Operation {
  id: string;
  project: string;
  environment: string;
  kind: OperationKind;
  /** The services asked for; [] means the whole environment */
  services: string[];
  requestedBy: RequestedBy;
  reason?: string;
  /** Deploys after a merge: the commit deployed */
  sha?: string;
  status: OperationStatus;
  startedAt: string;
  completedAt?: string;
  steps: OperationStep[];
  error?: string;
}

export interface EnvironmentStatus {
  environment: string;
  composeProject: string;
  checkedAt: string | null;
  /** Reading the environment failed (docker compose ps exited non-zero, ...) */
  error: string | null;
  services: ServiceStatus[];
  /** The operation in progress, if any */
  operation: Operation | null;
  autoDeploy: { enabled: boolean; ref: string; lastSha: string | null; blocked: string | null };
}

export interface DeliveryProjectStatus {
  project: string;
  enabled: boolean;
  running: boolean;
  readOnly: boolean;
  /** Config errors: an invalid `delivery:` block is not loaded */
  errors: string[];
  lastError: string | null;
  environments: EnvironmentStatus[];
}
