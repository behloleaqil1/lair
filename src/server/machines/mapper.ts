/**
 * Lane-to-machine mapper
 *
 * Maps gate lanes to available machines using round-robin selection
 */
import type { GateLane, MachineConfig, MachineHealthResult } from "../../shared/types.js";

/**
 * State for round-robin machine selection per lane
 */
export class LaneMachineMapper {
  // Track last used machine index per lane for round-robin
  private lastUsedIndex: Map<string, number> = new Map();

  /**
   * Select a machine for a given lane using round-robin among online machines
   *
   * @param lane - The gate lane to assign
   * @param machines - All machine configs
   * @param healthResults - Current health check results
   * @returns Machine ID or undefined if no machine available
   */
  selectMachine(
    lane: GateLane,
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>
  ): string | undefined {
    // Get online machines that handle this lane
    const candidates = this.getMachinesForLane(lane, machines, healthResults);

    if (candidates.length === 0) {
      return undefined;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Round-robin selection
    const lastIndex = this.lastUsedIndex.get(lane) ?? -1;
    const nextIndex = (lastIndex + 1) % candidates.length;
    this.lastUsedIndex.set(lane, nextIndex);

    return candidates[nextIndex];
  }

  /**
   * Get all online machines that handle a specific lane
   */
  getMachinesForLane(
    lane: GateLane,
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>
  ): string[] {
    return Object.entries(machines)
      .filter(([id, machine]) => {
        // Machine must handle this lane
        if (!machine.runners?.includes(lane)) {
          return false;
        }
        // Machine must be online
        const health = healthResults.get(id);
        return health?.up === true;
      })
      .map(([id]) => id);
  }

  /**
   * Get all lanes with no online machines (warnings)
   */
  getUncoveredLanes(
    machines: Record<string, MachineConfig>,
    healthResults: Map<string, MachineHealthResult>
  ): GateLane[] {
    // Collect all declared lanes
    const allLanes = new Set<GateLane>();
    for (const machine of Object.values(machines)) {
      for (const lane of machine.runners ?? []) {
        allLanes.add(lane);
      }
    }

    // Find lanes with no online machines
    const uncovered: GateLane[] = [];
    for (const lane of allLanes) {
      const available = this.getMachinesForLane(lane, machines, healthResults);
      if (available.length === 0) {
        uncovered.push(lane);
      }
    }

    return uncovered;
  }

  /**
   * Reset round-robin state (useful for testing)
   */
  reset(): void {
    this.lastUsedIndex.clear();
  }
}

/**
 * Validate machine/lane configuration
 */
export interface LaneValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateLaneConfig(
  machines: Record<string, MachineConfig>
): LaneValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check for duplicate lanes (allowed, just informational)
  const laneCount = new Map<string, number>();
  for (const [id, machine] of Object.entries(machines)) {
    for (const lane of machine.runners ?? []) {
      const count = (laneCount.get(lane) ?? 0) + 1;
      laneCount.set(lane, count);
    }

    // Check for machines with no runners
    if (!machine.runners || machine.runners.length === 0) {
      warnings.push(`Machine '${id}' has no runners configured`);
    }
  }

  // Note: lanes can be handled by multiple machines (for load balancing)

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
