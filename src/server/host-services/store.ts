/**
 * Host services store: in-memory state for services, with optional persistence.
 *
 * The store tracks each service's state, probe results, start attempts, and
 * decisions raised. State is keyed by "machine:service".
 *
 * Backoff policy:
 * - `consecutiveFailures` counts failed probes since the last stable recovery
 * - Backoff = min(baseDelayMs * 2^(consecutiveFailures - 1), maxDelayMs)
 * - A recovery is stable only after the service has been up for `stableWindowMs`
 * - A brief recovery (up then down before stable) keeps the failure count
 * - This survives restarts when the store is persisted
 */
import type { ProbeResult, StoredServiceState, ServiceStatus, ServiceConfig } from "./types.js";

function key(machine: string, name: string): string {
  return `${machine}:${name}`;
}

/** Backoff configuration (in milliseconds). */
export interface BackoffConfig {
  /** Initial delay before the first retry (default 10s). */
  baseDelayMs: number;
  /** Maximum delay between retries (default 5 min). */
  maxDelayMs: number;
  /** How long the service must stay up before the failure count resets (default 2 min). */
  stableWindowMs: number;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 10_000,
  maxDelayMs: 300_000,
  stableWindowMs: 120_000,
};

export class HostServicesStore {
  private states = new Map<string, StoredServiceState>();
  private backoffConfig: BackoffConfig;

  constructor(backoffConfig: Partial<BackoffConfig> = {}) {
    this.backoffConfig = { ...DEFAULT_BACKOFF, ...backoffConfig };
  }

  /** Get all stored states. */
  all(): StoredServiceState[] {
    return [...this.states.values()];
  }

  /** Get state for a specific service, or null if not tracked. */
  get(machine: string, name: string): StoredServiceState | null {
    return this.states.get(key(machine, name)) ?? null;
  }

  /** Initialize or reset a service's state. */
  init(machine: string, name: string): StoredServiceState {
    const state: StoredServiceState = {
      machine,
      name,
      state: "down",
      lastUpAt: null,
      lastStartAt: null,
      startAttempts: 0,
      decisionId: null,
      lastProbe: null,
      outageStartedAt: null,
      consecutiveFailures: 0,
      recoveryStartedAt: null,
    };
    this.states.set(key(machine, name), state);
    return state;
  }

  /** Get or create state for a service. */
  getOrInit(machine: string, name: string): StoredServiceState {
    return this.get(machine, name) ?? this.init(machine, name);
  }

  /**
   * Record a probe result.
   * Returns the updated state.
   */
  recordProbe(machine: string, name: string, result: ProbeResult, nowMs: number): StoredServiceState {
    const state = this.getOrInit(machine, name);
    state.lastProbe = result;

    if (result.up) {
      const wasDown = state.state !== "up";
      state.state = "up";
      state.lastUpAt = result.checkedAt;
      state.startAttempts = 0;

      if (wasDown) {
        // Just came up: start the recovery window
        state.recoveryStartedAt = result.checkedAt;
        state.outageStartedAt = null;
      } else if (state.recoveryStartedAt) {
        // Already up: check if the recovery is stable
        const recoveryStart = Date.parse(state.recoveryStartedAt);
        if (nowMs - recoveryStart >= this.backoffConfig.stableWindowMs) {
          // Recovery is stable: reset the failure count
          state.consecutiveFailures = 0;
          state.recoveryStartedAt = null; // No longer tracking
        }
      }
    } else {
      // Probe failed
      const wasUp = state.state === "up";
      state.recoveryStartedAt = null; // Reset recovery tracking

      if (wasUp) {
        // Just went down: start the outage
        state.outageStartedAt = result.checkedAt;
      }

      state.consecutiveFailures++;

      if (state.state === "starting") {
        // A probe that fails after a start: transition to down or failing
        if (state.startAttempts >= 1) {
          state.state = "failing";
        } else {
          state.state = "down";
        }
      } else if (state.startAttempts >= 1) {
        state.state = "failing";
      } else {
        state.state = "down";
      }
    }
    return state;
  }

  /** Record a start attempt. */
  recordStart(machine: string, name: string, at: string): StoredServiceState {
    const state = this.getOrInit(machine, name);
    state.state = "starting";
    state.lastStartAt = at;
    state.startAttempts++;
    return state;
  }

  /** Record that a decision was raised for this service's outage. */
  recordDecision(machine: string, name: string, decisionId: string): StoredServiceState {
    const state = this.getOrInit(machine, name);
    state.decisionId = decisionId;
    return state;
  }

  /** Mark the decision as resolved (withdrawn or answered). */
  clearDecision(machine: string, name: string): void {
    const state = this.get(machine, name);
    if (state) state.decisionId = null;
  }

  /** Mark a service as failing (max attempts reached). */
  markFailing(machine: string, name: string): StoredServiceState {
    const state = this.getOrInit(machine, name);
    state.state = "failing";
    return state;
  }

  /**
   * Calculate the backoff delay in milliseconds.
   * Returns 0 if no delay is needed (either never failed or already waited).
   */
  backoffDelayMs(machine: string, name: string, nowMs: number): number {
    const state = this.get(machine, name);
    if (!state || state.consecutiveFailures === 0) return 0;
    if (!state.lastStartAt) return 0;

    const lastStart = Date.parse(state.lastStartAt);
    const delay = Math.min(
      this.backoffConfig.baseDelayMs * Math.pow(2, state.consecutiveFailures - 1),
      this.backoffConfig.maxDelayMs,
    );
    const elapsed = nowMs - lastStart;
    return Math.max(0, delay - elapsed);
  }

  /**
   * Check if a start is allowed (backoff has elapsed).
   */
  canStart(machine: string, name: string, nowMs: number): boolean {
    return this.backoffDelayMs(machine, name, nowMs) === 0;
  }

  /** Build a status view for a service. */
  status(machine: string, name: string, config: ServiceConfig): ServiceStatus {
    const state = this.get(machine, name);
    return {
      machine,
      name,
      state: state?.state ?? "down",
      lastProbe: state?.lastProbe ?? null,
      lastUpAt: state?.lastUpAt ?? null,
      lastStartAt: state?.lastStartAt ?? null,
      startAttempts: state?.startAttempts ?? 0,
      holds: state?.state !== "up" ? config.neededBy : [],
      decisionRaisedAt: state?.decisionId ? (state.lastStartAt ?? null) : null,
    };
  }

  /** Get all lanes currently held by down services on a machine. */
  heldLanes(machine: string, configs: ServiceConfig[]): Map<string, { service: string; reason: string }> {
    const holds = new Map<string, { service: string; reason: string }>();
    for (const config of configs) {
      const state = this.get(machine, config.name);
      if (state && state.state !== "up") {
        const reason = state.state === "failing"
          ? `${config.name} on ${machine} is failing (${state.startAttempts} start attempts)`
          : `${config.name} on ${machine} is ${state.state}`;
        for (const lane of config.neededBy) {
          // First service to hold a lane wins (for the message)
          if (!holds.has(lane)) {
            holds.set(lane, { service: config.name, reason });
          }
        }
      }
    }
    return holds;
  }

  /** Clear all state (for tests or reload). */
  clear(): void {
    this.states.clear();
  }

  /**
   * Export all states for persistence.
   * This is called by the persistence layer to save state across restarts.
   */
  export(): StoredServiceState[] {
    return this.all();
  }

  /**
   * Import states from persistence.
   * This is called on startup to restore state from a previous run.
   */
  import(states: StoredServiceState[]): void {
    for (const state of states) {
      this.states.set(key(state.machine, state.name), state);
    }
  }
}
