/**
 * Gate distribution service
 *
 * Selects machines for gate lanes using round-robin or least-recently-used (LRU) selection.
 * Builds on top of the machine mapper from machines/ module.
 */
import type {
  GateLane,
  MachineConfig,
  MachineHealthResult,
} from "../../shared/types.js";
import { LaneMachineMapper } from "../machines/mapper.js";

/**
 * Selection strategy for distributing gates
 */
export type SelectionStrategy = "round-robin" | "lru";

/**
 * Tracks gate execution history for LRU selection
 */
interface GateHistory {
  machineId: string;
  lane: GateLane;
  startTime: number;
  endTime?: number;
}

/**
 * Gate distribution service with multiple selection strategies
 */
export class GateDistributor {
  private mapper: LaneMachineMapper;
  private strategy: SelectionStrategy;
  private gateHistory: GateHistory[] = [];
  private maxHistorySize = 100;

  constructor(strategy: SelectionStrategy = "round-robin") {
    this.mapper = new LaneMachineMapper();
    this.strategy = strategy;
  }

  /**
   * Select a machine for a gate lane
   *
   * @param lane - The gate lane to assign
   * @param machines - All machine configs
   * @param healthResults - Current health check results
   * @returns Machine ID or null if no machine available
   */
  selectMachineForLane(
    lane: GateLane,
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>,
  ): string | null {
    // Get online machines for this lane
    const candidates = this.mapper.getMachinesForLane(
      lane,
      machines,
      healthResults,
    );

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Apply selection strategy
    if (this.strategy === "lru") {
      return this.selectLRU(lane, candidates);
    }

    // Default: round-robin (delegated to mapper)
    return this.mapper.selectMachine(lane, machines, healthResults) ?? null;
  }

  /**
   * Select machine using least-recently-used strategy
   * Picks the machine that hasn't run a gate for this lane the longest
   */
  private selectLRU(lane: GateLane, candidates: string[]): string {
    // Find the last usage time for each candidate
    const lastUsed = new Map<string, number>();

    for (const machineId of candidates) {
      lastUsed.set(machineId, 0); // Default: never used
    }

    // Scan history in reverse (most recent first)
    for (let i = this.gateHistory.length - 1; i >= 0; i--) {
      const entry = this.gateHistory[i];
      if (entry.lane === lane && candidates.includes(entry.machineId)) {
        // Only record if not already found (we want the most recent)
        if (lastUsed.get(entry.machineId) === 0) {
          lastUsed.set(entry.machineId, entry.startTime);
        }
      }
    }

    // Find the candidate with the oldest (smallest) last-used time
    let lruMachine = candidates[0];
    let lruTime = lastUsed.get(candidates[0]) ?? 0;

    for (const machineId of candidates) {
      const time = lastUsed.get(machineId) ?? 0;
      if (time < lruTime) {
        lruTime = time;
        lruMachine = machineId;
      }
    }

    return lruMachine;
  }

  /**
   * Record that a gate started on a machine
   */
  recordGateStart(machineId: string, lane: GateLane): void {
    this.gateHistory.push({
      machineId,
      lane,
      startTime: Date.now(),
    });

    // Trim history if too large
    if (this.gateHistory.length > this.maxHistorySize) {
      this.gateHistory = this.gateHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Record that a gate finished on a machine
   */
  recordGateEnd(machineId: string, lane: GateLane): void {
    // Find the most recent unfinished entry for this machine/lane
    for (let i = this.gateHistory.length - 1; i >= 0; i--) {
      const entry = this.gateHistory[i];
      if (
        entry.machineId === machineId &&
        entry.lane === lane &&
        entry.endTime === undefined
      ) {
        entry.endTime = Date.now();
        break;
      }
    }
  }

  /**
   * Get the number of currently running gates on a machine
   */
  getRunningGateCount(machineId: string): number {
    return this.gateHistory.filter(
      (h) => h.machineId === machineId && h.endTime === undefined,
    ).length;
  }

  /**
   * Get all online machines for a lane
   */
  getMachinesForLane(
    lane: GateLane,
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>,
  ): string[] {
    return this.mapper.getMachinesForLane(lane, machines, healthResults);
  }

  /**
   * Get lanes with no available machines
   */
  getUncoveredLanes(
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>,
  ): GateLane[] {
    return this.mapper.getUncoveredLanes(machines, healthResults);
  }

  /**
   * Reset distribution state (useful for testing)
   */
  reset(): void {
    this.mapper.reset();
    this.gateHistory = [];
  }

  /**
   * Set the selection strategy
   */
  setStrategy(strategy: SelectionStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Get the current selection strategy
   */
  getStrategy(): SelectionStrategy {
    return this.strategy;
  }
}

/**
 * Create a gate distributor with the specified strategy
 */
export function createGateDistributor(
  strategy: SelectionStrategy = "round-robin",
): GateDistributor {
  return new GateDistributor(strategy);
}
