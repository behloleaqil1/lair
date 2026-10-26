/**
 * Fleet management types for M3.
 * Multi-machine management via SSH, scheduling, self-healing, and budgets.
 */

// ============ MACHINE TYPES ============

/** Machine type */
export type MachineType = "local" | "ssh";

/** Machine status */
export type MachineStatus = "online" | "offline" | "provisioning" | "error";

/** SSH machine connection config */
export interface SSHMachineConfig {
  host: string;
  port?: number;
  user: string;
  key: string;
  connect_timeout?: number;
}

/** Machine definition in config */
export interface Machine {
  id: string;
  name: string;
  type: MachineType;
  status: MachineStatus;
  ssh?: SSHMachineConfig;
  // Capabilities
  runners?: string[]; // e.g., ["heavy", "light", "remote"]
  maxAgents?: number;
  // State
  nodeId?: string; // ID of connected lair-node
  lastSeen?: string;
  error?: string;
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/** Request to add a machine */
export interface AddMachineRequest {
  name: string;
  type: MachineType;
  ssh?: SSHMachineConfig;
  runners?: string[];
  maxAgents?: number;
  installNode?: boolean; // Auto-install lair-node on the machine
}

/** Machine installation status */
export interface InstallationStatus {
  machineId: string;
  step: "connecting" | "checking" | "installing" | "configuring" | "starting" | "verifying" | "done" | "error";
  progress: number; // 0-100
  message: string;
  error?: string;
}

// ============ SELF-HEALING TYPES ============

/** Self-healing event types */
export type HealingEventType =
  | "node_offline"
  | "heartbeat_timeout"
  | "job_stuck"
  | "job_failed"
  | "node_recovered"
  | "job_rescheduled";

/** Self-healing event */
export interface HealingEvent {
  id: string;
  type: HealingEventType;
  timestamp: string;
  nodeId?: string;
  machineId?: string;
  jobId?: string;
  taskId?: string;
  message: string;
  action?: string;
  resolved: boolean;
  resolvedAt?: string;
}

/** Self-healing config */
export interface HealingConfig {
  enabled: boolean;
  heartbeatTimeoutMs: number; // Mark node offline after this
  stuckJobTimeoutMs: number; // Reschedule job after this
  maxRetries: number; // Max retries before giving up
  autoReschedule: boolean; // Auto-reschedule failed jobs
  autoRecover: boolean; // Auto-re-admit recovered nodes
}

// ============ BUDGET TYPES ============

/** Budget period */
export type BudgetPeriod = "hourly" | "daily" | "weekly" | "monthly";

/** Provider budget */
export interface ProviderBudget {
  provider: string; // e.g., "claude", "openai", "anthropic"
  maxCostPerPeriod: number; // e.g., 50.00
  period: BudgetPeriod;
  currentCost: number;
  periodStart: string;
  rateLimit?: number; // max requests per minute
  currentRate?: number; // current requests this minute
  paused: boolean; // budget exceeded
}

/** Global budget config */
export interface BudgetConfig {
  enabled: boolean;
  maxDailyCost: number;
  maxWeeklyCost?: number;
  maxMonthlyCost?: number;
  costPerAgentHour?: number; // For agent cost tracking
  providers: ProviderBudget[];
}

/** Budget status */
export interface BudgetStatus {
  totalCostToday: number;
  totalCostThisWeek: number;
  totalCostThisMonth: number;
  budgetRemaining: number;
  providers: ProviderBudget[];
  alerts: string[];
}

// ============ FLEET STATE ============

/** Fleet overview */
export interface FleetOverview {
  machines: Machine[];
  totalMachines: number;
  onlineMachines: number;
  totalCapacity: { cores: number; ramMb: number };
  usedCapacity: { cores: number; ramMb: number };
  healingEvents: HealingEvent[];
  budget: BudgetStatus;
}
