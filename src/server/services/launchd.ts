/**
 * Service Manager - Platform-agnostic background service control
 * 
 * Lair is designed to be open-sourced and run on any platform.
 * This module provides an abstraction layer for managing background services
 * (orchestrator, gate runners) across different platforms:
 * 
 * - macOS: launchctl (LaunchAgent)
 * - Linux: systemd / supervisord
 * - Windows: Windows Services / NSSM
 * - Cross-platform: PM2 / Docker / shell scripts
 * 
 * The implementation is configured via the project YAML file's `service_manager` section.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { ProjectConfig } from "../../shared/types.js";

export type ServiceStatus = "running" | "stopped" | "unknown" | "not_configured";

export interface ServiceResult {
  success: boolean;
  message: string;
}

export interface ServiceManagerConfig {
  type: "launchd" | "systemd" | "pm2" | "command" | "relay";
  // For relay type (when Lair runs in Docker)
  relay_dir?: string;
  // For command type (custom shell commands)
  status_cmd?: string[];
  start_cmd?: string[];
  stop_cmd?: string[];
  restart_cmd?: string[];
}

/**
 * Get the service manager config from project config
 * Falls back to detecting the platform
 */
export function getServiceManagerConfig(config: ProjectConfig): ServiceManagerConfig | null {
  // Check if explicitly configured
  const sm = (config as ProjectConfig & { service_manager?: ServiceManagerConfig }).service_manager;
  if (sm) {
    return sm;
  }

  // Check for legacy orchestrator.launchd_label (backward compat)
  if (config.orchestrator?.launchd_label) {
    // Check if we're in Docker (relay mode)
    const inDocker = existsSync("/.dockerenv") || process.env.LAIR_HOST === "0.0.0.0";
    if (inDocker) {
      return {
        type: "relay",
        relay_dir: "/app/data",
      };
    }
    return { type: "launchd" };
  }

  return null;
}

/**
 * Base class for service managers
 */
abstract class ServiceManager {
  constructor(protected config: ProjectConfig) {}
  
  abstract getStatus(serviceName: string): Promise<ServiceStatus>;
  abstract start(serviceName: string): Promise<ServiceResult>;
  abstract stop(serviceName: string): Promise<ServiceResult>;
  abstract restart(serviceName: string): Promise<ServiceResult>;
  abstract isAvailable(): boolean;
}

/**
 * macOS LaunchAgent manager (native, runs directly on host)
 */
class LaunchdManager extends ServiceManager {
  private uid: string;

  constructor(config: ProjectConfig) {
    super(config);
    try {
      this.uid = execSync("id -u", { encoding: "utf-8" }).trim();
    } catch {
      this.uid = "501"; // Default macOS user ID
    }
  }

  isAvailable(): boolean {
    try {
      execSync("which launchctl", { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(serviceName: string): Promise<ServiceStatus> {
    try {
      const result = execSync(
        `launchctl print gui/${this.uid}/${serviceName} 2>&1`,
        { encoding: "utf-8", timeout: 5000 }
      );
      return result.includes("Could not find") ? "stopped" : "running";
    } catch {
      return "unknown";
    }
  }

  async start(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`launchctl kickstart gui/${this.uid}/${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service started" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to start" };
    }
  }

  async stop(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`launchctl kill SIGTERM gui/${this.uid}/${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service stopped" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to stop" };
    }
  }

  async restart(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`launchctl kickstart -k gui/${this.uid}/${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service restarted" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to restart" };
    }
  }
}

/**
 * Linux systemd manager
 */
class SystemdManager extends ServiceManager {
  isAvailable(): boolean {
    try {
      execSync("which systemctl", { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(serviceName: string): Promise<ServiceStatus> {
    try {
      const result = execSync(`systemctl --user is-active ${serviceName} 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return result.trim() === "active" ? "running" : "stopped";
    } catch {
      return "stopped";
    }
  }

  async start(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`systemctl --user start ${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service started" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to start" };
    }
  }

  async stop(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`systemctl --user stop ${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service stopped" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to stop" };
    }
  }

  async restart(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`systemctl --user restart ${serviceName}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { success: true, message: "Service restarted" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to restart" };
    }
  }
}

/**
 * PM2 process manager (cross-platform)
 */
class PM2Manager extends ServiceManager {
  isAvailable(): boolean {
    try {
      execSync("which pm2", { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(serviceName: string): Promise<ServiceStatus> {
    try {
      const result = execSync(`pm2 jlist 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const procs = JSON.parse(result);
      const proc = procs.find((p: { name: string }) => p.name === serviceName);
      if (!proc) return "stopped";
      return proc.pm2_env?.status === "online" ? "running" : "stopped";
    } catch {
      return "unknown";
    }
  }

  async start(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`pm2 start ${serviceName}`, { encoding: "utf-8", timeout: 10000 });
      return { success: true, message: "Service started" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to start" };
    }
  }

  async stop(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`pm2 stop ${serviceName}`, { encoding: "utf-8", timeout: 10000 });
      return { success: true, message: "Service stopped" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to stop" };
    }
  }

  async restart(serviceName: string): Promise<ServiceResult> {
    try {
      execSync(`pm2 restart ${serviceName}`, { encoding: "utf-8", timeout: 10000 });
      return { success: true, message: "Service restarted" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Failed to restart" };
    }
  }
}

/**
 * File-based relay manager (for when Lair runs in Docker)
 * Communicates with a host-side relay script that executes the actual commands
 */
class RelayManager extends ServiceManager {
  private relayDir: string;
  private cmdFile: string;
  private resultFile: string;

  constructor(config: ProjectConfig, relayDir: string) {
    super(config);
    this.relayDir = relayDir;
    this.cmdFile = join(relayDir, "service-cmd.txt");
    this.resultFile = join(relayDir, "service-cmd.result");
  }

  isAvailable(): boolean {
    // Relay is available if the relay dir exists and has the log file (daemon running)
    return existsSync(this.relayDir) && 
           (existsSync(join(this.relayDir, "service-relay.log")) || existsSync(this.cmdFile));
  }

  private async sendCommand(action: string, serviceName: string, timeoutMs = 5000): Promise<ServiceResult> {
    const command = `${action} ${serviceName}`;
    writeFileSync(this.cmdFile, command, "utf-8");

    const startTime = Date.now();
    const lastContent = existsSync(this.resultFile) ? readFileSync(this.resultFile, "utf-8") : "";

    return new Promise((resolve) => {
      const check = () => {
        if (Date.now() - startTime > timeoutMs) {
          resolve({ success: false, message: "Timeout waiting for relay" });
          return;
        }

        if (existsSync(this.resultFile)) {
          const content = readFileSync(this.resultFile, "utf-8").trim();
          if (content && content !== lastContent) {
            const colonIdx = content.indexOf(":");
            if (colonIdx > 0) {
              const rc = parseInt(content.slice(0, colonIdx), 10);
              const message = content.slice(colonIdx + 1);
              resolve({ success: rc === 0, message });
              return;
            }
          }
        }

        setTimeout(check, 100);
      };

      setTimeout(check, 100);
    });
  }

  async getStatus(serviceName: string): Promise<ServiceStatus> {
    const result = await this.sendCommand("status", serviceName);
    if (result.success) {
      return result.message as ServiceStatus;
    }
    return "unknown";
  }

  async start(serviceName: string): Promise<ServiceResult> {
    return this.sendCommand("start", serviceName);
  }

  async stop(serviceName: string): Promise<ServiceResult> {
    return this.sendCommand("stop", serviceName);
  }

  async restart(serviceName: string): Promise<ServiceResult> {
    return this.sendCommand("restart", serviceName);
  }
}

/**
 * Custom command manager (user-defined shell commands)
 */
class CommandManager extends ServiceManager {
  private smConfig: ServiceManagerConfig;

  constructor(config: ProjectConfig, smConfig: ServiceManagerConfig) {
    super(config);
    this.smConfig = smConfig;
  }

  isAvailable(): boolean {
    return !!(this.smConfig.status_cmd || this.smConfig.start_cmd);
  }

  private execCmd(cmd: string[] | undefined): ServiceResult {
    if (!cmd || cmd.length === 0) {
      return { success: false, message: "Command not configured" };
    }
    try {
      execSync(cmd.join(" "), { encoding: "utf-8", timeout: 30000 });
      return { success: true, message: "Command executed" };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : "Command failed" };
    }
  }

  async getStatus(_serviceName: string): Promise<ServiceStatus> {
    if (!this.smConfig.status_cmd) return "unknown";
    const result = this.execCmd(this.smConfig.status_cmd);
    return result.success ? "running" : "stopped";
  }

  async start(_serviceName: string): Promise<ServiceResult> {
    return this.execCmd(this.smConfig.start_cmd);
  }

  async stop(_serviceName: string): Promise<ServiceResult> {
    return this.execCmd(this.smConfig.stop_cmd);
  }

  async restart(_serviceName: string): Promise<ServiceResult> {
    if (this.smConfig.restart_cmd) {
      return this.execCmd(this.smConfig.restart_cmd);
    }
    // Fallback: stop then start
    await this.stop(_serviceName);
    return this.start(_serviceName);
  }
}

/**
 * Create appropriate service manager based on config and platform
 */
export function createServiceManager(config: ProjectConfig): ServiceManager | null {
  const smConfig = getServiceManagerConfig(config);
  
  if (!smConfig) {
    return null;
  }

  switch (smConfig.type) {
    case "launchd":
      return new LaunchdManager(config);
    case "systemd":
      return new SystemdManager(config);
    case "pm2":
      return new PM2Manager(config);
    case "relay":
      return new RelayManager(config, smConfig.relay_dir || "/app/data");
    case "command":
      return new CommandManager(config, smConfig);
    default:
      return null;
  }
}

/**
 * Auto-detect and create service manager based on platform
 */
export function autoDetectServiceManager(config: ProjectConfig): ServiceManager | null {
  // Check explicit config first
  const smConfig = getServiceManagerConfig(config);
  if (smConfig) {
    return createServiceManager(config);
  }

  // Auto-detect based on platform
  const platform = process.platform;

  if (platform === "darwin") {
    const mgr = new LaunchdManager(config);
    if (mgr.isAvailable()) return mgr;
  }

  if (platform === "linux") {
    const mgr = new SystemdManager(config);
    if (mgr.isAvailable()) return mgr;
  }

  // Try PM2 as fallback (cross-platform)
  const pm2 = new PM2Manager(config);
  if (pm2.isAvailable()) return pm2;

  return null;
}

// ============ Convenience exports for backward compatibility ============

let _cachedManager: ServiceManager | null = null;
let _cachedConfig: ProjectConfig | null = null;

function getManager(config: ProjectConfig): ServiceManager | null {
  if (_cachedConfig !== config) {
    _cachedManager = createServiceManager(config) || autoDetectServiceManager(config);
    _cachedConfig = config;
  }
  return _cachedManager;
}

export async function getServiceStatus(config: ProjectConfig, serviceName: string): Promise<ServiceStatus> {
  const mgr = getManager(config);
  if (!mgr) return "not_configured";
  return mgr.getStatus(serviceName);
}

export async function startService(config: ProjectConfig, serviceName: string): Promise<ServiceResult> {
  const mgr = getManager(config);
  if (!mgr) return { success: false, message: "Service manager not available" };
  return mgr.start(serviceName);
}

export async function stopService(config: ProjectConfig, serviceName: string): Promise<ServiceResult> {
  const mgr = getManager(config);
  if (!mgr) return { success: false, message: "Service manager not available" };
  return mgr.stop(serviceName);
}

export async function restartService(config: ProjectConfig, serviceName: string): Promise<ServiceResult> {
  const mgr = getManager(config);
  if (!mgr) return { success: false, message: "Service manager not available" };
  return mgr.restart(serviceName);
}

export function isServiceManagerAvailable(config: ProjectConfig): boolean {
  const mgr = getManager(config);
  return mgr?.isAvailable() ?? false;
}

// Legacy exports for backward compat
export const getLaunchdStatus = async (_label: string): Promise<ServiceStatus> => {
  // This requires config, so it's a stub - use getServiceStatus instead
  return "unknown";
};

export const startLaunchd = async (_label: string): Promise<ServiceResult> => {
  return { success: false, message: "Use startService with config" };
};

export const stopLaunchd = async (_label: string): Promise<ServiceResult> => {
  return { success: false, message: "Use stopService with config" };
};

export const restartLaunchd = async (_label: string): Promise<ServiceResult> => {
  return { success: false, message: "Use restartService with config" };
};

export const loadLaunchd = async (_label: string): Promise<ServiceResult> => {
  return { success: false, message: "Not implemented in new API" };
};

export const unloadLaunchd = async (_label: string): Promise<ServiceResult> => {
  return { success: false, message: "Not implemented in new API" };
};

export const isRelayAvailable = (): boolean => {
  return false; // Use isServiceManagerAvailable with config instead
};
