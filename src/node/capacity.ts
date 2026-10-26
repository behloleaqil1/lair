/**
 * Capacity Measurement for lair-node
 *
 * Detects system resources: CPU cores, RAM, disk, container runtime, load average.
 * Reports capacity to the server periodically.
 */
import { platform, cpus, totalmem, freemem, loadavg, hostname } from "os";
import { execSync, spawnSync } from "child_process";
import { statfsSync } from "fs";
import type {
  NodeOS,
  ContainerRuntime,
  NodeCapacity,
} from "../shared/node-types.js";

/**
 * Detect the operating system type.
 */
export function detectOS(): NodeOS {
  const os = platform();
  switch (os) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      // Default to linux for unknown platforms
      console.warn(`Unknown platform "${os}", defaulting to linux`);
      return "linux";
  }
}

/**
 * Get the hostname of this machine.
 */
export function getHostname(): string {
  return hostname();
}

/**
 * Get the number of CPU cores.
 */
export function getCores(): number {
  return cpus().length;
}

/**
 * Get total RAM in megabytes.
 */
export function getTotalRamMb(): number {
  return Math.round(totalmem() / (1024 * 1024));
}

/**
 * Get available RAM in megabytes.
 */
export function getAvailableRamMb(): number {
  return Math.round(freemem() / (1024 * 1024));
}

/**
 * Get disk space for the root filesystem in gigabytes.
 */
export function getDiskSpace(): { totalGb: number; availableGb: number } {
  try {
    const os = detectOS();

    if (os === "windows") {
      // On Windows, use wmic or PowerShell
      try {
        const result = execSync(
          'powershell -Command "Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json"',
          { encoding: "utf-8", timeout: 5000 },
        );
        const data = JSON.parse(result);
        const usedBytes = data.Used || 0;
        const freeBytes = data.Free || 0;
        const totalBytes = usedBytes + freeBytes;
        return {
          totalGb: Math.round(totalBytes / (1024 * 1024 * 1024)),
          availableGb: Math.round(freeBytes / (1024 * 1024 * 1024)),
        };
      } catch {
        // Fallback: return estimates
        return { totalGb: 500, availableGb: 100 };
      }
    }

    // On Unix-like systems, use statfs
    const stats = statfsSync("/");
    const blockSize = stats.bsize;
    const totalBlocks = stats.blocks;
    const availableBlocks = stats.bavail;

    return {
      totalGb: Math.round((totalBlocks * blockSize) / (1024 * 1024 * 1024)),
      availableGb: Math.round(
        (availableBlocks * blockSize) / (1024 * 1024 * 1024),
      ),
    };
  } catch (error) {
    console.warn("Failed to get disk space:", error);
    return { totalGb: 0, availableGb: 0 };
  }
}

/**
 * Get load averages (1, 5, 15 minutes).
 */
export function getLoadAverages(): { load1: number; load5: number; load15: number } {
  const [load1, load5, load15] = loadavg();
  return {
    load1: Math.round(load1 * 100) / 100,
    load5: Math.round(load5 * 100) / 100,
    load15: Math.round(load15 * 100) / 100,
  };
}

/**
 * Detect available container runtime.
 */
export function detectContainerRuntime(): ContainerRuntime {
  // Check Docker
  if (isCommandAvailable("docker")) {
    // Verify Docker daemon is running
    try {
      execSync("docker info", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
      return "docker";
    } catch {
      // Docker installed but daemon not running
    }
  }

  // Check Podman
  if (isCommandAvailable("podman")) {
    try {
      execSync("podman info", { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
      return "podman";
    } catch {
      // Podman installed but not working
    }
  }

  // Check Colima (macOS)
  if (detectOS() === "darwin" && isCommandAvailable("colima")) {
    try {
      const result = execSync("colima status 2>&1", {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      if (result.includes("Running")) {
        return "colima";
      }
    } catch {
      // Colima not running
    }
  }

  return "none";
}

/**
 * Check if a command is available in PATH.
 */
function isCommandAvailable(command: string): boolean {
  try {
    const os = detectOS();
    if (os === "windows") {
      spawnSync("where", [command], { encoding: "utf-8", stdio: "pipe" });
      return true;
    } else {
      const result = spawnSync("which", [command], {
        encoding: "utf-8",
        stdio: "pipe",
      });
      return result.status === 0;
    }
  } catch {
    return false;
  }
}

/**
 * Measure current node capacity.
 */
export function measureCapacity(nodeId: string): NodeCapacity {
  const disk = getDiskSpace();
  const load = getLoadAverages();

  return {
    nodeId,
    cores: getCores(),
    ramMb: getTotalRamMb(),
    ramAvailableMb: getAvailableRamMb(),
    diskGb: disk.totalGb,
    diskAvailableGb: disk.availableGb,
    load1: load.load1,
    load5: load.load5,
    load15: load.load15,
    containerRuntime: detectContainerRuntime(),
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Get a snapshot of system info for registration.
 */
export function getSystemInfo(): {
  hostname: string;
  os: NodeOS;
  cores: number;
  ramMb: number;
  diskGb: number;
  containerRuntime: ContainerRuntime;
} {
  const disk = getDiskSpace();

  return {
    hostname: getHostname(),
    os: detectOS(),
    cores: getCores(),
    ramMb: getTotalRamMb(),
    diskGb: disk.totalGb,
    containerRuntime: detectContainerRuntime(),
  };
}
