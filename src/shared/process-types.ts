/**
 * Lair Process Manager - Shared Types
 */

export type RestartPolicy = "always" | "on-failure" | "never";
export type ProcessStatus = "running" | "stopped" | "starting" | "stopping" | "failed" | "unhealthy";
export type HealthCheckType = "file_modified" | "http" | "tcp" | "command" | "none";
export type HealthAction = "restart" | "alert" | "none";

export interface HealthCheckConfig {
  type: HealthCheckType;
  // For file_modified
  path?: string;
  // For http
  url?: string;
  // For tcp
  host?: string;
  port?: number;
  // For command
  command?: string[];
  // Common
  interval: number;      // ms between checks
  timeout: number;       // ms before considered unhealthy
  action: HealthAction;
  retries?: number;      // failures before action (default 3)
}

export interface ProcessConfig {
  id: string;
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  restart: RestartPolicy;
  restartDelay: number;          // ms before restart
  maxRestarts: number;           // -1 = unlimited
  backoffMultiplier: number;     // exponential backoff
  maxBackoff: number;            // max ms between restarts
  healthCheck?: HealthCheckConfig;
  logMaxLines: number;
  logFile?: string;              // optional disk log
  autostart: boolean;            // start when Lair starts
  dependsOn?: string[];          // start after these processes
}

export interface LogLine {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProcessMetrics {
  startCount: number;
  restartCount: number;
  lastStarted?: string;
  lastStopped?: string;
  lastHealthCheck?: string;
  healthCheckFailures: number;
  uptimeMs: number;
}

export interface ProcessState {
  id: string;
  name: string;
  status: ProcessStatus;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  exitSignal?: string;
  healthy: boolean;
  restartCount: number;
  lastRestartReason?: string;
  metrics: ProcessMetrics;
  config: ProcessConfig;
}

export interface ProcessListResponse {
  processes: ProcessState[];
  supervisorRunning: boolean;
}

export interface ProcessLogsResponse {
  id: string;
  logs: LogLine[];
  hasMore: boolean;
}

// Default config values
export const DEFAULT_PROCESS_CONFIG: Partial<ProcessConfig> = {
  restart: "on-failure",
  restartDelay: 1000,
  maxRestarts: 10,
  backoffMultiplier: 2,
  maxBackoff: 300000,  // 5 minutes
  logMaxLines: 10000,
  autostart: false,
};

export const DEFAULT_HEALTH_CHECK: Partial<HealthCheckConfig> = {
  interval: 30000,     // 30 seconds
  timeout: 60000,      // 1 minute
  action: "alert",
  retries: 3,
};
