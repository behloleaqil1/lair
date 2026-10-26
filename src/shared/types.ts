// Shared types for Lair

export interface ProjectConfig {
  name: string;
  repo: string;
  github: string;
  queue_file: string;
  agents_dir: string;
  gates_dir: string;
  status_cmd?: string;
  machines: Record<string, MachineConfig>;
  orchestrator?: {
    launchd_label?: string;
  };
  // Phase 2: Control commands
  read_only?: boolean;
  allow_direct_assign?: boolean;
  inbox_file?: string;
  outbox_file?: string;
  backlog_file?: string;
  ask_cmd?: string[];
  tick_now_cmd?: string[];
  pause_cmd?: string[];
  resume_cmd?: string[];
  agent_run_cmd?: string[];
  agent_stop_cmd?: string[];
  agent_release_cmd?: string[];
  gate_submit_cmd?: string[];
  gate_stuck_cmd?: string[];
  merge_cmd?: string[];
  merge_bar?: MergeBarConfig;
  // Process manager
  processes?: Record<string, ProcessConfigYaml>;
  // Phase 4: Dragon management
  dragons?: Record<string, Omit<DragonConfig, "id">>;
  available_models?: AIModel[];
  default_instructions?: string;
  gate_runner?: GateRunnerConfig;
  // Phase 4: Dragon commands
  dragon_start_cmd?: string[];
  dragon_stop_cmd?: string[];
  dragon_release_cmd?: string[];
  /**
   * Directory for the prompt files written when a dragon is started from the
   * dashboard (passed to dragon_start_cmd as {prompt_file}). Relative paths
   * resolve against the Lair working directory. Default: data/prompts
   */
  prompts_dir?: string;
  /**
   * Progress watchdog (src/server/watchdog/). Validated by
   * parseWatchdogConfig; see docs/configuration.md#watchdog
   */
  watchdog?: Record<string, unknown>;
  /**
   * Delivery environments (src/server/delivery/). Validated by
   * parseDeliveryConfig; see docs/configuration.md#delivery
   */
  delivery?: Record<string, unknown>;
  /**
   * Gate pipelines and where they run (src/server/gates/). Validated by
   * parsePipelineConfig; see docs/configuration.md#gate-pipelines
   */
  pipelines?: Record<string, unknown>;
  executors?: Record<string, unknown>;
  /**
   * Reviews and policy merge (src/server/review/). Validated by
   * parseReviewConfig; see docs/configuration.md#reviews-and-policy-merge
   */
  review?: Record<string, unknown>;
  /**
   * Agent runs: claims, locks, recovery, failover and budgets
   * (src/server/agents/). Validated by parseAgentsConfig; see
   * docs/configuration.md#agents
   */
  agents?: Record<string, unknown>;
}

// Process configuration as it appears in YAML (before defaults applied)
export interface ProcessConfigYaml {
  name?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  restart?: "always" | "on-failure" | "never";
  restart_delay?: number;
  max_restarts?: number;
  backoff_multiplier?: number;
  max_backoff?: number;
  health_check?: {
    type: "file_modified" | "http" | "tcp" | "command" | "none";
    path?: string;
    url?: string;
    host?: string;
    port?: number;
    command?: string[];
    interval?: number;
    timeout?: number;
    action?: "restart" | "alert" | "none";
    retries?: number;
  };
  log_max_lines?: number;
  log_file?: string;
  autostart?: boolean;
  depends_on?: string[];
}

export interface MergeBarConfig {
  required_steps: string[];
  require_review: boolean;
}

export interface MachineConfig {
  name: string;
  type: "local" | "ssh";
  runners: GateLane[];
  // SSH-specific fields (required when type is 'ssh')
  host?: string;
  user?: string;
  key?: string;
  connect_timeout?: number; // seconds, default 4
  // Optional paths on the remote machine
  work_dir?: string;
  gate_script?: string;
  kiro_cli?: string; // path to kiro-cli on remote (for remote dragon execution)
  // Sync method for worktrees
  sync?: "rsync" | "git" | "none";
  // Legacy field (deprecated, use host/user/key instead)
  ssh_cmd?: string;
}

// Machine with validated SSH fields (type narrowing)
export interface SSHMachineConfig extends MachineConfig {
  type: "ssh";
  host: string;
  user: string;
  key: string;
  connect_timeout: number;
}

// Health check result
export interface MachineHealthResult {
  machineId: string;
  up: boolean;
  checkedAt: string; // ISO timestamp
  uptime?: string; // from 'uptime' command output
  error?: string;
}

// Dragon config in project YAML (phase 4)
export interface DragonConfig {
  id: string; // e.g. "kiro-A" or "aider-1": letter first, then letters, digits, _ or -, max 64 (isValidDragonId)
  name: string; // Display name (e.g., "Smaug")
  model: string; // AI model ID (e.g., "claude-opus-4.5")
  machine: string; // Machine ID to run on
  instructions: string; // Standing instructions for this dragon
  adapter?: string; // Agent adapter ID (e.g., "kiro", "aider") - defaults to "kiro"
}

// Available AI model definition
export interface AIModel {
  id: string;
  name: string;
  description?: string;
}

// Gate runner config (phase 4)
export interface GateRunnerConfig {
  enabled: boolean;
  poll_interval?: number; // seconds, default 5
  sync_method?: "rsync" | "git" | "none";
  rsync_exclude?: string[];
}

// Queue line types
export type QueueLineType =
  | "WAITING"
  | "DONE"
  | "BLOCKED"
  | "PROGRESS"
  | "TICK"
  | "ORCHESTRATOR"
  | "OTHER";

export interface QueueLine {
  raw: string;
  type: QueueLineType;
  timestamp?: string;
  agent?: string;
  task?: string;
  gateId?: string;
  message: string;
}

// Dragon/Agent types
export interface Dragon {
  id: string;
  name: string;
  task: string;
  running: boolean;
  lastLogTime?: string;
  lastLogLine?: string;
  stats?: DragonStats;
  // Config-derived fields (phase 4)
  model?: string; // AI model ID from dragon config
  machine?: string; // Machine ID from dragon config
  instructions?: string; // Standing instructions from dragon config
  adapter?: string; // Agent adapter ID (e.g., 'kiro', 'aider')
}

export interface DragonStats {
  doneCount: number;
  waitingCount: number;
  blockedCount: number;
  gatesSubmitted: number;
  gatesPassed: number;
  gatesFailed: number;
  firstTimePassRate: number;
  earlyStops: number;
}

// Gate types
export type GateLane = "heavy" | "light" | "remote";
export type GateStatus = "queued" | "running" | "completed" | "superseded";

export interface Gate {
  id: string;
  lane: GateLane;
  priority: number;
  status: GateStatus;
  branch?: string;
  track?: string;
  headSha?: string;
  startTime?: string;
  currentStep?: string;
  rc?: number;
  failedStep?: string;
  age?: number; // in seconds
}

export interface GateResult {
  id: string;
  rc: number;
  log?: string;
  failedSteps?: string[];
  duration?: number;
}

// PR types
export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  updatedAt: string;
  latestGate?: Gate;
  mergeReady: boolean;
}

// Machine types
export interface MachineStatus {
  name: string;
  type: "local" | "ssh";
  up: boolean;
  lastCheck?: string;
  runners?: RunnerStatus[];
  lastGateTime?: string;
}

export interface RunnerStatus {
  lane: GateLane;
  pid?: number;
  running: boolean;
}

// Overview types
export interface Problem {
  type:
    | "stale_run"
    | "no_runner"
    | "duplicate_gate"
    | "silent_agent"
    | "status_cmd";
  severity: "warning" | "error";
  message: string;
  details?: string;
}

export interface OverviewData {
  project: string;
  mainHead: string;
  mainDate: string;
  localStackHead?: string;
  recentMerges: MergedPR[];
  problems: Problem[];
  agentCounts: { running: number; idle: number };
  gateCounts: { queued: number; running: number };
}

export interface MergedPR {
  number: number;
  title: string;
  mergedAt: string;
}

// Orchestrator types
export interface OrchestratorStatus {
  tickLines: QueueLine[];
  stopFileExists: boolean;
  launchdLoaded: boolean;
}

// API response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

// Phase 2: Command bar and controls types
export type CommandMode = "ask" | "instruct" | "task";

export interface InboxItem {
  id: string;
  timestamp: string;
  text: string;
  status: "pending" | "answered";
  reply?: OutboxReply;
}

export interface OutboxReply {
  id: string;
  timestamp: string;
  agent: string;
  text: string;
}

export interface AskSession {
  id: string;
  question: string;
  startTime: string;
  status: "running" | "completed" | "failed";
  output?: string;
  error?: string;
}

export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string[];
  timestamp: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  command: string[];
  exitCode: number;
  outputTail: string;
  user?: string;
}

export interface BacklogItem {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  assigned?: string;
}

export interface MergeBarStatus {
  prNumber: number;
  headSha: string;
  checks: MergeBarCheck[];
  canMerge: boolean;
  reason?: string;
}

export interface MergeBarCheck {
  name: string;
  passed: boolean;
  details?: string;
}

export interface ControlsStatus {
  readOnly: boolean;
  orchestratorPaused: boolean;
  tickRunning: boolean;
}

// Phase 3: Fleet bus types
export type ReportKind = "WAITING" | "DONE" | "BLOCKED" | "PROGRESS" | "TICK";

export interface TaskStatus {
  task: string;
  owner: string | null;
  last_report: {
    kind: ReportKind;
    summary: string;
    time: string;
    gate_id?: string;
    pr?: number;
    sha?: string;
  } | null;
}

export interface BoardAgent {
  id: string;
  display_name: string | null;
  claims: string[];
  last_seen: string;
}

export interface BoardOutput {
  tasks: TaskStatus[];
  agents: BoardAgent[];
}

export interface BusSendResult {
  success: boolean;
  message_id: string;
  to: string;
}

// Phase 4: Dragon management types (chunk 3)

/** Dragon management config returned by the dragon/config endpoint */
export interface DragonManagementConfig {
  dragons?: Record<string, DragonConfig>;
  available_models?: AvailableModel[];
  available_adapters?: AgentAdapter[];
  default_instructions?: string;
  dragon_start_cmd?: string[];
  dragon_stop_cmd?: string[];
  dragon_release_cmd?: string[];
}

/** Available AI model for dragon selection (alias for AIModel) */
export type AvailableModel = AIModel;

/** Request to start a dragon */
export interface DragonStartRequest {
  dragonId: string;
  task: string;
  prompt: string;
  model?: string; // override dragon's default model
  extraInstructions?: string;
}

/** Request to stop a dragon */
export interface DragonStopRequest {
  dragonId: string;
}

// Phase 4: Agent adapter system (chunk 7)

/** Status reporting method for an agent adapter */
export type AdapterStatusMethod = "file" | "stdout" | "mcp";

/**
 * Agent adapter - describes how to start, stop, and monitor any AI coding agent.
 * Each adapter defines the command templates and status reporting method.
 */
export interface AgentAdapter {
  /** Unique adapter ID, e.g., 'kiro', 'aider', 'claude-code' */
  id: string;
  /** Display name for the adapter */
  name: string;
  /** Command template to start the agent (with {variable} placeholders) */
  start_cmd: string;
  /** Command template to stop the agent */
  stop_cmd: string;
  /** How the agent reports status */
  status_method: AdapterStatusMethod;
  // For file-based status:
  /** Path to queue/status file (relative to project root) */
  queue_file?: string;
  /** Path to log directory (relative to project root) */
  log_dir?: string;
  // For stdout-based status:
  /** Regex pattern to match JSON status lines in stdout */
  status_pattern?: string;
  // For MCP:
  /** MCP endpoint (e.g., 'stdio') */
  mcp_endpoint?: string;
  // Session management:
  /** Environment variable for session ID */
  session_id_env?: string;
  /** Flag to resume a session, with {session_id} placeholder */
  resume_flag?: string;
}

/**
 * Project terminology customization - rename 'dragons' to whatever fits the project.
 */
export interface ProjectTerminology {
  /** Singular noun for agents, e.g., 'dragon', 'worker', 'agent' */
  agent_singular: string;
  /** Plural noun for agents, e.g., 'dragons', 'workers', 'agents' */
  agent_plural: string;
  /** Name for the orchestrator, e.g., 'orchestrator', 'coordinator' */
  orchestrator: string;
}

/** Validation result for adapter config */
export interface AdapterValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Result of building a command from an adapter template */
export interface AdapterCommandResult {
  command: string[];
  warnings: string[];
}


// Phase 6: WebSocket types

/** WebSocket channel types */
export type WSChannel =
  | "dragons"
  | "gates"
  | "machines"
  | "orchestrator"
  | `logs:${string}`;

/** Client-to-server message */
export interface WSClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channels?: string[];
}

/** Server-to-client message */
export interface WSServerMessage {
  type:
    | "connected"
    | "subscribed"
    | "unsubscribed"
    | "update"
    | "error"
    | "pong";
  sessionId?: string;
  channel?: string;
  channels?: string[];
  data?: unknown;
  error?: string;
  timestamp: string;
}

/** Dragon update event data */
export interface DragonUpdateData {
  id: string;
  event: "status_change" | "log_line" | "task_change";
  running?: boolean;
  task?: string;
  lastLogLine?: string;
  lastLogTime?: string;
}

/** Gate update event data */
export interface GateUpdateData {
  id: string;
  event: "queued" | "started" | "completed" | "step_change";
  lane?: string;
  rc?: number;
  currentStep?: string;
  duration?: number;
}

/** Machine update event data */
export interface MachineUpdateData {
  name: string;
  event: "health_change" | "runner_change";
  up?: boolean;
  runners?: Array<{ lane: string; running: boolean }>;
}

/** Log line event data */
export interface LogLineData {
  dragonId: string;
  line: string;
  timestamp: string;
}
