/**
 * Host services store: in-memory state for services, with optional persistence.
 *
 * The store tracks each service's state, probe results, start attempts, and
 * decisions raised. State is keyed by "machine:service".
 */
import type { ProbeResult, ServiceState, StoredServiceState, ServiceStatus, ServiceConfig } from "./types.js";

function key(machine: string, name: string): string {
  return `${machine}:${name}`;
}

export class HostServicesStore {
  private states = new Map<string, StoredServiceState>();

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
    };
    this.states.set(key(machine, name), state);
    return state;
  }

  /** Get or create state for a service. */
  getOrInit(machine: string, name: string): StoredServiceState {
    return this.get(machine, name) ?? this.init(machine, name);
  }

  /** Record a probe result. */
  recordProbe(machine: string, name: string, result: ProbeResult): StoredServiceState {
    const state = this.getOrInit(machine, name);
    state.lastProbe = result;
    if (result.up) {
      state.state = "up";
      state.lastUpAt = result.checkedAt;
      state.startAttempts = 0;
      state.decisionId = null; // Decision is moot once service is up
    } else if (state.state === "starting") {
      // A probe that fails after a start: still "starting" until next regular probe
    } else if (state.startAttempts >= 1) {
      state.state = "failing";
    } else {
      state.state = "down";
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
}
