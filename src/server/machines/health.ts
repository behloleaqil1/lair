/**
 * Machine health checker
 *
 * Checks if machines are reachable:
 * - Local machines: always up
 * - SSH machines: runs health check command via SSH
 *
 * Results are cached with configurable TTL (default 60s)
 */
import { spawn } from "child_process";
import type {
  MachineConfig,
  MachineHealthResult,
  SSHMachineConfig,
} from "../../shared/types.js";
import { buildHealthCheckCommand, isSSHMachine } from "./ssh.js";

const DEFAULT_CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  result: MachineHealthResult;
  expiresAt: number;
}

/**
 * Health checker with caching
 */
export class MachineHealthChecker {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTTL: number;

  constructor(cacheTTLMs: number = DEFAULT_CACHE_TTL_MS) {
    this.cacheTTL = cacheTTLMs;
  }

  /**
   * Check machine health, using cached result if available
   */
  async check(
    machineId: string,
    machine: MachineConfig,
    forceRefresh: boolean = false
  ): Promise<MachineHealthResult> {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.getCached(machineId);
      if (cached) {
        return cached;
      }
    }

    // Perform the check
    const result = await this.performCheck(machineId, machine);

    // Cache the result
    this.cache.set(machineId, {
      result,
      expiresAt: Date.now() + this.cacheTTL,
    });

    return result;
  }

  /**
   * Get cached result if still valid
   */
  getCached(machineId: string): MachineHealthResult | undefined {
    const entry = this.cache.get(machineId);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(machineId);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Invalidate cache for a machine
   */
  invalidate(machineId: string): void {
    this.cache.delete(machineId);
  }

  /**
   * Invalidate all cached results
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Perform the actual health check
   */
  private async performCheck(
    machineId: string,
    machine: MachineConfig
  ): Promise<MachineHealthResult> {
    const checkedAt = new Date().toISOString();

    // Local machines are always up
    if (machine.type === "local") {
      return {
        machineId,
        up: true,
        checkedAt,
      };
    }

    // SSH machines need a connection test
    if (!isSSHMachine(machine)) {
      return {
        machineId,
        up: false,
        checkedAt,
        error: "Invalid SSH configuration: missing host, user, or key",
      };
    }

    return this.checkSSH(machineId, machine, checkedAt);
  }

  /**
   * Check SSH machine health by running the health check command
   */
  private checkSSH(
    machineId: string,
    machine: SSHMachineConfig,
    checkedAt: string
  ): Promise<MachineHealthResult> {
    return new Promise((resolve) => {
      const args = buildHealthCheckCommand(machine);

      // Timeout is connect_timeout + 2 seconds for command execution
      const timeout = ((machine.connect_timeout ?? 4) + 2) * 1000;

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const proc = spawn("ssh", args, {
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        resolve({
          machineId,
          up: false,
          checkedAt,
          error: `SSH error: ${err.message}`,
        });
      });

      proc.on("close", (code) => {
        if (timedOut) {
          resolve({
            machineId,
            up: false,
            checkedAt,
            error: `SSH timeout after ${timeout / 1000}s`,
          });
          return;
        }

        if (code === 0 && stdout.startsWith("up")) {
          // Parse uptime from output (second line)
          const lines = stdout.trim().split("\n");
          const uptime = lines.length > 1 ? lines[1].trim() : undefined;

          resolve({
            machineId,
            up: true,
            checkedAt,
            uptime,
          });
        } else {
          resolve({
            machineId,
            up: false,
            checkedAt,
            error: stderr.trim() || `SSH exited with code ${code}`,
          });
        }
      });

      // Manual timeout handling (in case spawn timeout doesn't work as expected)
      setTimeout(() => {
        if (!proc.killed) {
          timedOut = true;
          proc.kill();
        }
      }, timeout);
    });
  }
}

/**
 * Check all machines in a config and return results
 */
export async function checkAllMachines(
  machines: Record<string, MachineConfig>,
  checker: MachineHealthChecker,
  forceRefresh: boolean = false
): Promise<Map<string, MachineHealthResult>> {
  const results = new Map<string, MachineHealthResult>();

  // Check all machines in parallel
  const checks = Object.entries(machines).map(async ([id, machine]) => {
    const result = await checker.check(id, machine, forceRefresh);
    results.set(id, result);
  });

  await Promise.all(checks);
  return results;
}

/**
 * Get online machines for a specific lane
 */
export function getOnlineMachinesForLane(
  machines: Record<string, MachineConfig>,
  healthResults: Map<string, MachineHealthResult>,
  lane: string
): string[] {
  return Object.entries(machines)
    .filter(([id, machine]) => {
      // Machine must handle this lane
      if (!machine.runners?.includes(lane as "heavy" | "light" | "remote")) {
        return false;
      }
      // Machine must be online
      const health = healthResults.get(id);
      return health?.up === true;
    })
    .map(([id]) => id);
}
