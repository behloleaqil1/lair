/**
 * Built-in playbooks (SPEC-autonomy §2)
 */
import type { PlaybookDefinition } from "./types.js";

/**
 * Agent stuck playbook - restart HUNG agents (never WAITING ones)
 */
export const agentStuckPlaybook: PlaybookDefinition = {
  id: "agent-stuck",
  name: "Agent Stuck",
  description: "Detects hung agents (no CPU, no output) and restarts them with a fresh session and resume summary. Never restarts WAITING agents.",
  forSLOTypes: ["agent-progress"],
  requiresApproval: false,
  priority: 10,
  maxAttempts: 2,
  cooldownSeconds: 300, // 5 minutes
  steps: [
    {
      id: "diagnose-agent",
      name: "Diagnose agent state",
      description: "Get the agent's current state and determine if it's HUNG or WAITING",
      type: "diagnose",
      params: { action: "get-agent-state" },
    },
    {
      id: "check-waiting",
      name: "Check if WAITING",
      description: "Skip restart if agent is WAITING (children busy, explicit WAITING)",
      type: "verify",
      params: { check: "agent-not-waiting" },
    },
    {
      id: "restart-agent",
      name: "Restart agent",
      description: "Restart the hung agent in a fresh session with resume summary",
      type: "act",
      params: { action: "restart-agent" },
    },
    {
      id: "wait-startup",
      name: "Wait for startup",
      description: "Wait for agent to start up",
      type: "wait",
      params: { seconds: 10 },
    },
    {
      id: "verify-running",
      name: "Verify agent running",
      description: "Check that the agent is now running",
      type: "verify",
      params: { check: "agent-running" },
    },
  ],
};

/**
 * Lane jammed playbook - clear stuck jobs and free the lane
 */
export const laneJammedPlaybook: PlaybookDefinition = {
  id: "lane-jammed",
  name: "Lane Jammed",
  description: "A job past its limit that made no progress is marked stuck, its work requeued on another node, and the lane freed.",
  forSLOTypes: ["lane-busy"],
  requiresApproval: false,
  priority: 10,
  maxAttempts: 3,
  cooldownSeconds: 600, // 10 minutes
  steps: [
    {
      id: "diagnose-lane",
      name: "Diagnose lane state",
      description: "Get jobs in the lane and identify the stuck one",
      type: "diagnose",
      params: { action: "get-lane-jobs" },
    },
    {
      id: "mark-stuck",
      name: "Mark job stuck",
      description: "Mark the offending job as stuck",
      type: "act",
      params: { action: "mark-job-stuck" },
    },
    {
      id: "requeue-work",
      name: "Requeue work",
      description: "Requeue the work to another node",
      type: "act",
      params: { action: "requeue-job" },
    },
    {
      id: "wait-requeue",
      name: "Wait for requeue",
      description: "Wait for the job to be picked up",
      type: "wait",
      params: { seconds: 5 },
    },
    {
      id: "verify-lane",
      name: "Verify lane flowing",
      description: "Check that the lane is no longer jammed",
      type: "verify",
      params: { check: "lane-flowing" },
    },
  ],
};

/**
 * Idle capacity playbook - move queued jobs to idle nodes
 */
export const idleCapacityPlaybook: PlaybookDefinition = {
  id: "idle-capacity",
  name: "Idle Capacity",
  description: "Queued jobs are moved to idle nodes. Wake sleeping runtimes through the node.",
  forSLOTypes: ["idle-capacity"],
  requiresApproval: false,
  priority: 10,
  maxAttempts: 2,
  cooldownSeconds: 120, // 2 minutes
  steps: [
    {
      id: "diagnose-capacity",
      name: "Diagnose node capacity",
      description: "Find nodes with free capacity",
      type: "diagnose",
      params: { action: "get-node-capacity" },
    },
    {
      id: "move-job",
      name: "Move job to idle node",
      description: "Move a queued job to an idle node",
      type: "act",
      params: { action: "move-job-to-node" },
    },
    {
      id: "wait-assignment",
      name: "Wait for assignment",
      description: "Wait for the job to be assigned",
      type: "wait",
      params: { seconds: 10 },
    },
    {
      id: "verify-capacity-used",
      name: "Verify capacity used",
      description: "Check that the idle capacity is now being used",
      type: "verify",
      params: { check: "node-healthy" },
    },
  ],
};

/**
 * Ready but idle playbook - start agents for ready tasks
 */
export const readyButIdlePlaybook: PlaybookDefinition = {
  id: "ready-but-idle",
  name: "Ready But Idle",
  description: "Ready tasks with no running agent are handed to the scheduler to start agents up to measured capacity.",
  forSLOTypes: ["merge-frequency"],
  forPattern: "tasks ready",
  requiresApproval: false,
  priority: 20,
  maxAttempts: 3,
  cooldownSeconds: 300, // 5 minutes
  steps: [
    {
      id: "diagnose-tasks",
      name: "Diagnose ready tasks",
      description: "Find ready tasks with no agent",
      type: "diagnose",
      params: { action: "get-ready-tasks" },
    },
    {
      id: "start-agent",
      name: "Start agent for task",
      description: "Request scheduler to start an agent for the task",
      type: "act",
      params: { action: "start-agent" },
    },
    {
      id: "wait-startup",
      name: "Wait for agent startup",
      description: "Wait for the agent to start",
      type: "wait",
      params: { seconds: 15 },
    },
    {
      id: "notify-started",
      name: "Notify agent started",
      description: "Log that an agent was started",
      type: "notify",
      params: { message: "Agent started for ready task", severity: "info" },
    },
  ],
};

/**
 * No merges playbook - runs failure triage on blocking PRs
 */
export const noMergesPlaybook: PlaybookDefinition = {
  id: "no-merges",
  name: "No Merges",
  description: "Runs failure triage on every open PR's latest gate and reports the top blocker.",
  forSLOTypes: ["merge-frequency"],
  requiresApproval: false,
  priority: 10,
  maxAttempts: 1,
  cooldownSeconds: 1800, // 30 minutes
  steps: [
    {
      id: "diagnose-prs",
      name: "Diagnose open PRs",
      description: "Get open PRs and their gate statuses",
      type: "diagnose",
      params: { action: "get-open-prs" },
    },
    {
      id: "triage-failures",
      name: "Triage failures",
      description: "Run failure triage on the latest gates",
      type: "act",
      params: { action: "triage-failures" },
    },
    {
      id: "report-blocker",
      name: "Report top blocker",
      description: "Report the top blocker to the activity feed",
      type: "notify",
      params: { message: "Top merge blocker identified", severity: "warning" },
    },
  ],
};

/**
 * Disk low playbook - garbage collect old files
 */
export const diskLowPlaybook: PlaybookDefinition = {
  id: "disk-low",
  name: "Disk Low",
  description: "GC old gate worktrees, scratch files, build outputs and dangling container images by age and size policy, then drain if still low.",
  forSLOTypes: ["idle-capacity"],
  forPattern: "disk",
  requiresApproval: false,
  priority: 5, // High priority - disk issues can cascade
  maxAttempts: 2,
  cooldownSeconds: 600, // 10 minutes
  steps: [
    {
      id: "diagnose-disk",
      name: "Diagnose disk usage",
      description: "Get disk usage breakdown",
      type: "diagnose",
      params: { action: "get-disk-usage" },
    },
    {
      id: "gc-worktrees",
      name: "GC worktrees",
      description: "Remove old gate worktrees",
      type: "act",
      params: { action: "gc-worktrees" },
    },
    {
      id: "gc-scratch",
      name: "GC scratch files",
      description: "Remove old scratch files",
      type: "act",
      params: { action: "gc-scratch" },
      continueOnFailure: true,
    },
    {
      id: "gc-images",
      name: "GC container images",
      description: "Remove dangling container images",
      type: "act",
      params: { action: "gc-images" },
      continueOnFailure: true,
    },
    {
      id: "verify-disk",
      name: "Verify disk space",
      description: "Check that disk usage is now acceptable",
      type: "verify",
      params: { check: "disk-space-ok" },
    },
    {
      id: "drain-if-needed",
      name: "Drain node if still low",
      description: "Drain the node if disk is still critically low",
      type: "act",
      params: { action: "drain-node-if-critical" },
      continueOnFailure: true,
    },
  ],
};

/**
 * Runtime down playbook - restart container engine or services
 */
export const runtimeDownPlaybook: PlaybookDefinition = {
  id: "runtime-down",
  name: "Runtime Down",
  description: "Restart the container engine or the node's services, then drain and reschedule.",
  forSLOTypes: ["idle-capacity", "gate-frequency"],
  forPattern: "runtime|docker|container",
  requiresApproval: false,
  priority: 5,
  maxAttempts: 2,
  cooldownSeconds: 300, // 5 minutes
  steps: [
    {
      id: "diagnose-runtime",
      name: "Diagnose runtime state",
      description: "Check which runtime is down",
      type: "diagnose",
      params: { action: "get-runtime-status" },
    },
    {
      id: "restart-runtime",
      name: "Restart runtime",
      description: "Restart the container engine",
      type: "act",
      params: { action: "restart-runtime", runtime: "docker" },
    },
    {
      id: "wait-runtime",
      name: "Wait for runtime",
      description: "Wait for the runtime to come back up",
      type: "wait",
      params: { seconds: 30 },
    },
    {
      id: "verify-runtime",
      name: "Verify runtime healthy",
      description: "Check that the runtime is now healthy",
      type: "verify",
      params: { check: "runtime-healthy" },
    },
    {
      id: "reschedule-jobs",
      name: "Reschedule jobs",
      description: "Reschedule any jobs that were affected",
      type: "act",
      params: { action: "reschedule-affected-jobs" },
      continueOnFailure: true,
    },
  ],
};

/**
 * All built-in playbooks
 */
export const builtInPlaybooks: PlaybookDefinition[] = [
  agentStuckPlaybook,
  laneJammedPlaybook,
  idleCapacityPlaybook,
  readyButIdlePlaybook,
  noMergesPlaybook,
  diskLowPlaybook,
  runtimeDownPlaybook,
];
