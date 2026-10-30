/**
 * M1 Core types for lair-server.
 * Nodes, jobs, tasks, scheduler, events.
 */

// ============ NODE TYPES ============

/** Node capacity reported by lair-node */
export interface NodeCapacity {
  cores: number;
  ramMb: number;
  diskGb: number;
  gpuCount: number;
  containerRuntime: "docker" | "podman" | "colima" | "none";
}

/** Node status */
export type NodeStatus = "online" | "offline" | "draining";

/** Registered node */
export interface Node {
  id: string;
  name: string;
  status: NodeStatus;
  capacity: NodeCapacity;
  usedCapacity: { cores: number; ramMb: number };
  activeJobs: number;
  lastHeartbeat: string; // ISO timestamp
  registeredAt: string;
  version?: string;
  os?: string;
  arch?: string;
}

/** Node registration request from lair-node */
export interface NodeRegistration {
  name: string;
  capacity: NodeCapacity;
  version?: string;
  os?: string;
  arch?: string;
}

/** Node heartbeat from lair-node */
export interface NodeHeartbeat {
  nodeId: string;
  usedCapacity: { cores: number; ramMb: number };
  activeJobs: number;
  timestamp: string;
}

// ============ TASK TYPES ============

/** Task types */
export type TaskType = "build" | "review" | "gate" | "dev-check" | "deploy" | "custom";

/** Task status */
export type TaskStatus = "queued" | "assigned" | "running" | "completed" | "failed" | "cancelled";

/** Task priority (higher = more urgent) */
export type TaskPriority = 0 | 1 | 2 | 3 | 4 | 5;

/** A task waiting to be executed */
export interface Task {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  title: string;
  description?: string;
  // Assignment
  assignedNode?: string;
  assignedAgent?: string;
  jobId?: string;
  // Requirements
  requirements?: TaskRequirements;
  // Timing
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  // Result
  result?: TaskResult;
  // Metadata
  metadata?: Record<string, unknown>;
}

/** Task requirements for scheduling */
export interface TaskRequirements {
  minCores?: number;
  minRamMb?: number;
  gpu?: boolean;
  containerRuntime?: "docker" | "podman" | "any";
  nodeId?: string; // Pin to specific node
  adapter?: string; // Required agent adapter
}

/** Task result */
export interface TaskResult {
  success: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  artifacts?: string[];
  duration?: number; // ms
}

/** Request to create a task */
export interface CreateTaskRequest {
  type: TaskType;
  priority?: TaskPriority;
  title: string;
  description?: string;
  requirements?: TaskRequirements;
  metadata?: Record<string, unknown>;
}

// ============ JOB TYPES ============

/** Job status */
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** A job assigned to a node */
export interface Job {
  id: string;
  taskId: string;
  nodeId: string;
  agentId?: string;
  status: JobStatus;
  // Timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  // Resource allocation
  allocatedCores: number;
  allocatedRamMb: number;
  // Result
  exitCode?: number;
  output?: string;
  error?: string;
}

/** Job assignment sent to node */
export interface JobAssignment {
  jobId: string;
  taskId: string;
  task: Task;
  allocatedCores: number;
  allocatedRamMb: number;
}

/** Job result from node */
export interface JobResult {
  jobId: string;
  nodeId: string;
  status: "completed" | "failed";
  exitCode?: number;
  output?: string;
  error?: string;
  duration?: number;
}

// ============ SCHEDULER TYPES ============

/** Scheduler state */
export interface SchedulerState {
  running: boolean;
  totalCapacity: { cores: number; ramMb: number };
  usedCapacity: { cores: number; ramMb: number };
  queuedTasks: number;
  runningJobs: number;
  activeAgents: number;
  maxAgents: number; // computed from capacity
  nodesOnline: number;
  nodesTotal: number;
  lastTickAt?: string;
}

/** Scheduler config */
export interface SchedulerConfig {
  tickIntervalMs: number;
  nodeTimeoutMs: number;
  defaultTaskCores: number;
  defaultTaskRamMb: number;
  maxAgentsPerNode: number;
}

// ============ EVENT TYPES ============

/** Event types for the event bus */
export type EventType =
  | "node.registered"
  | "node.heartbeat"
  | "node.offline"
  | "node.online"
  | "task.created"
  | "task.assigned"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "job.created"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "scheduler.tick"
  // Decision Inbox (src/server/decisions/)
  | "decision.raised"
  | "decision.answered"
  | "decision.expired"
  | "decision.withdrawn"
  // Watchdog (src/server/watchdog/)
  | "slo.breached"
  | "slo.recovered"
  | "playbook.started"
  | "playbook.succeeded"
  | "playbook.failed"
  | "escalation.created"
  // Delivery (src/server/delivery/)
  | "delivery.started"
  | "delivery.finished"
  | "delivery.held"
  | "delivery.released"
  | "delivery.crash_loop"
  | "delivery.crash_loop_cleared"
  // Gate pipelines and their executors (src/server/gates/)
  | "pipeline.run.started"
  | "pipeline.job.fallback"
  | "pipeline.run.completed"
  // A module needs a human decision (the Decision Inbox listens)
  | "decision.needed"
  // Reviews and policy merge (src/server/review/)
  | "review.submitted"
  | "review.invalidated"
  | "review.assignment_requested"
  | "review.decision_requested"
  | "review.merged"
  | "review.merge_refused"
  // Agents (src/server/agents/)
  | "agent.run.requested"
  | "agent.run.started"
  | "agent.run.ended"
  | "agent.claim.released"
  | "agent.lock.broken"
  | "agent.recovery"
  | "agent.failover"
  | "agent.budget.warning"
  | "agent.budget.exceeded"
  | "agents.fill_started"
  | "agents.fill_held"
  // Gate results, for triage: {project, result: GateResult, reports?, context?}
  | "gate.completed"
  // Triage (src/server/triage/)
  | "triage.classified"
  | "triage.recheck_requested"
  // Re-checks for an existing gate system: {project, recheck, ...}
  | "triage.recheck_would"
  | "triage.recheck_queued"
  | "triage.recheck_resolved"
  | "triage.recheck_escalated"
  | "triage.routed"
  | "triage.task_created"
  | "triage.decision_requested"
  | "triage.incident_opened"
  | "triage.incident_resolved"
  | "triage.culprit_found"
  | "triage.revert_requested"
  // Live config reload (src/server/reload/): {project, file, module} / {project, file, error}
  | "config.reloaded"
  | "config.invalid"
  // The owner's Restart (src/server/restart/)
  | "server.restarting"
  | "server.update_failed"
  // Placement (src/server/placement/)
  | "placement.moved"
  | "placement.would_move"
  | "placement.move_failed"
  | "placement.machine_up"
  | "placement.machine_down"
  | "placement.job_held"
  | "placement.machine_stopped_under_job"
  // Cloud machines (src/server/cloud/): {project, limit, spend, reason}
  | "cloud.guard_tripped"
  // The owner cleared the trip: {project, trippedAt, limit, spend, by (owner session id), note}
  | "cloud.trip_cleared"
  // Planner (src/server/planner/)
  | "planner.changed"
  | "planner.run_started"
  | "planner.run_finished"
  | "planner.proposals_pending"
  | "planner.blocked"
  | "planner.tasks_file_restored"
  | "planner.verifier_started"
  | "planner.verifier_finished"
  // Bus (src/server/bus/)
  | "bus.report"
  | "bus.message";

/** Event stored in the database */
export interface Event {
  id: string;
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ============ AGENT RUN TYPES ============

/** Agent run status */
export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "stopped";

/** An agent run (sandbox session) */
export interface AgentRun {
  id: string;
  nodeId: string;
  jobId?: string;
  taskId?: string;
  adapter: string;
  status: AgentRunStatus;
  // Timing
  startedAt: string;
  completedAt?: string;
  // Resource usage
  peakRamMb?: number;
  cpuSeconds?: number;
  // Result
  exitCode?: number;
  output?: string;
}

// ============ WEBSOCKET NODE PROTOCOL ============

/** Message from server to node */
export interface ServerToNodeMessage {
  type: "job.assign" | "job.cancel" | "ping" | "shutdown";
  payload?: JobAssignment | { jobId: string };
}

/** Message from node to server */
export interface NodeToServerMessage {
  type: "register" | "heartbeat" | "job.started" | "job.completed" | "job.failed" | "job.progress" | "pong";
  payload?: NodeRegistration | NodeHeartbeat | JobResult | { jobId: string; progress: string };
}

// ============ API TYPES ============

/** List nodes response */
export interface ListNodesResponse {
  nodes: Node[];
  scheduler: SchedulerState;
}

/** List jobs response */
export interface ListJobsResponse {
  jobs: Job[];
  total: number;
}

/** List tasks response */
export interface ListTasksResponse {
  tasks: Task[];
  total: number;
}
