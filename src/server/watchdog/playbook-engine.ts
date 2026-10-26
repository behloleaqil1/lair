/**
 * Playbook Engine - executes recovery playbooks
 */
import type { EventBus } from "../core/event-bus.js";
import type { Store } from "../store/store.js";
import type { WatchdogStore } from "./store.js";
import type {
  PlaybookDefinition,
  PlaybookRun,
  PlaybookStep,
  PlaybookStepResult,
  SLOBreach,
  SLOType,
} from "./types.js";

/**
 * Context passed to playbook steps
 */
export interface PlaybookContext {
  eventBus: EventBus;
  store: Store;
  watchdogStore: WatchdogStore;
  breach: SLOBreach;
  run: PlaybookRun;
  diagnosis: Record<string, unknown>;
}

/**
 * Step executor function type
 */
export type StepExecutor = (
  step: PlaybookStep,
  ctx: PlaybookContext
) => Promise<{ success: boolean; output?: string; error?: string }>;

/**
 * Registry of step executors by type
 */
const stepExecutors = new Map<string, StepExecutor>();

/**
 * Register a step executor
 */
export function registerStepExecutor(type: string, executor: StepExecutor): void {
  stepExecutors.set(type, executor);
}

/**
 * Clear all step executors (for testing)
 */
export function clearStepExecutors(): void {
  stepExecutors.clear();
}

/**
 * Playbook Engine
 */
export class PlaybookEngine {
  private playbooks = new Map<string, PlaybookDefinition>();
  private cooldowns = new Map<string, number>(); // sloId -> last run timestamp

  constructor(
    private eventBus: EventBus,
    private store: Store,
    private watchdogStore: WatchdogStore
  ) {}

  /**
   * Register a playbook
   */
  registerPlaybook(playbook: PlaybookDefinition): void {
    this.playbooks.set(playbook.id, playbook);
    console.log(`[PlaybookEngine] Registered: ${playbook.id}`);
  }

  /**
   * Get playbooks for an SLO type, sorted by priority
   */
  getPlaybooksForSLO(type: SLOType): PlaybookDefinition[] {
    return Array.from(this.playbooks.values())
      .filter(p => p.forSLOTypes.includes(type))
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if a playbook can run (cooldown check)
   */
  canRunPlaybook(playbookId: string, sloId: string): boolean {
    const playbook = this.playbooks.get(playbookId);
    if (!playbook) return false;

    const key = `${playbookId}:${sloId}`;
    const lastRun = this.cooldowns.get(key);
    if (!lastRun) return true;

    const cooldownMs = playbook.cooldownSeconds * 1000;
    return Date.now() - lastRun > cooldownMs;
  }

  /**
   * Handle a breach by running appropriate playbooks
   */
  async handleBreach(breach: SLOBreach, sloType: SLOType): Promise<void> {
    const playbooks = this.getPlaybooksForSLO(sloType);
    if (playbooks.length === 0) {
      console.log(`[PlaybookEngine] No playbooks for SLO type: ${sloType}`);
      await this.escalateBreach(breach, "No playbooks available");
      return;
    }

    // Try playbooks in priority order
    for (const playbook of playbooks) {
      // Check cooldown
      if (!this.canRunPlaybook(playbook.id, breach.sloId)) {
        console.log(`[PlaybookEngine] ${playbook.id} on cooldown for ${breach.sloId}`);
        continue;
      }

      // Check if approval is required
      if (playbook.requiresApproval) {
        await this.requestApproval(breach, playbook);
        return;
      }

      // Check attempt count
      const previousRuns = this.watchdogStore.getRunsForBreach(breach.id)
        .filter(r => r.playbookId === playbook.id);
      if (previousRuns.length >= playbook.maxAttempts) {
        console.log(`[PlaybookEngine] ${playbook.id} exhausted attempts for breach ${breach.id}`);
        continue;
      }

      // Run the playbook
      const result = await this.runPlaybook(playbook, breach, previousRuns.length + 1);

      if (result.status === "succeeded") {
        // Mark breach resolved
        this.watchdogStore.resolveBreach(breach.id);
        await this.eventBus.emit("slo.recovered", {
          sloId: breach.sloId,
          breachId: breach.id,
          playbookId: playbook.id,
          runId: result.id,
        });
        return;
      }

      // Playbook failed, try next one
      console.log(`[PlaybookEngine] ${playbook.id} failed for breach ${breach.id}: ${result.error}`);
    }

    // All playbooks exhausted
    await this.escalateBreach(breach, "All playbooks exhausted");
  }

  /**
   * Run a playbook
   */
  async runPlaybook(
    playbook: PlaybookDefinition,
    breach: SLOBreach,
    attempt: number
  ): Promise<PlaybookRun> {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create the run
    let run = this.watchdogStore.createPlaybookRun({
      id: runId,
      playbookId: playbook.id,
      breachId: breach.id,
      status: "running",
      attempt,
      startedAt: now,
    });

    // Add run to breach
    this.watchdogStore.addPlaybookRunToBreach(breach.id, runId);

    // Update cooldown
    this.cooldowns.set(`${playbook.id}:${breach.sloId}`, Date.now());

    // Emit event
    await this.eventBus.emit("playbook.started", {
      playbookId: playbook.id,
      runId,
      breachId: breach.id,
      attempt,
    });

    // Create context
    const ctx: PlaybookContext = {
      eventBus: this.eventBus,
      store: this.store,
      watchdogStore: this.watchdogStore,
      breach,
      run,
      diagnosis: {},
    };

    // Execute steps
    const stepResults: PlaybookStepResult[] = [];
    let failed = false;

    for (const step of playbook.steps) {
      if (failed && !step.continueOnFailure) {
        stepResults.push({
          stepId: step.id,
          status: "skipped",
        });
        continue;
      }

      const result = await this.executeStep(step, ctx);
      stepResults.push(result);

      // Emit step event
      await this.eventBus.emit("playbook.step.completed", {
        playbookId: playbook.id,
        runId,
        stepId: step.id,
        succeeded: result.status === "succeeded",
        output: result.output,
        error: result.error,
      });

      if (result.status === "failed") {
        failed = true;
      }
    }

    // Update run
    const completedAt = new Date().toISOString();
    const status = failed ? "failed" : "succeeded";

    this.watchdogStore.updatePlaybookRun(runId, {
      status,
      completedAt,
      stepResults,
      diagnosis: ctx.diagnosis,
      error: failed ? "One or more steps failed" : undefined,
    });

    // Emit completion event
    await this.eventBus.emit(failed ? "playbook.failed" : "playbook.succeeded", {
      playbookId: playbook.id,
      runId,
      breachId: breach.id,
      succeeded: !failed,
      stepsCompleted: stepResults.filter(r => r.status === "succeeded").length,
      duration: new Date(completedAt).getTime() - new Date(now).getTime(),
    });

    return this.watchdogStore.getPlaybookRun(runId)!;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: PlaybookStep,
    ctx: PlaybookContext
  ): Promise<PlaybookStepResult> {
    const startedAt = new Date().toISOString();

    const executor = stepExecutors.get(step.type);
    if (!executor) {
      return {
        stepId: step.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: `No executor for step type: ${step.type}`,
      };
    }

    try {
      // Execute with timeout
      const timeoutMs = (step.timeoutSeconds ?? 60) * 1000;
      const result = await Promise.race([
        executor(step, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Step timed out")), timeoutMs)
        ),
      ]);

      return {
        stepId: step.id,
        status: result.success ? "succeeded" : "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        output: result.output,
        error: result.error,
      };
    } catch (error) {
      return {
        stepId: step.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Escalate a breach to the decision inbox
   */
  private async escalateBreach(breach: SLOBreach, reason: string): Promise<void> {
    await this.eventBus.emit("escalation.created", {
      escalationId: crypto.randomUUID(),
      breachId: breach.id,
      sloId: breach.sloId,
      severity: "high",
      title: `SLO breach requires attention: ${breach.sloId}`,
      reason,
      evidence: breach.evidence,
    });

    console.log(`[PlaybookEngine] Escalated breach ${breach.id}: ${reason}`);
  }

  /**
   * Request approval for a playbook
   */
  private async requestApproval(
    breach: SLOBreach,
    playbook: PlaybookDefinition
  ): Promise<void> {
    await this.eventBus.emit("decision.requested", {
      question: `Approve playbook "${playbook.name}" for SLO breach?`,
      context: `SLO ${breach.sloId} has been breached.\n\nEvidence:\n${breach.evidence.join("\n")}\n\nPlaybook "${playbook.name}" can attempt to fix this.`,
      options: ["approve", "reject", "escalate"],
      recommended: "approve",
      why: playbook.description,
      kind: "escalation",
      reversible: true,
      breachId: breach.id,
      playbookId: playbook.id,
    });
  }

  /**
   * Handle approval response
   */
  async handleApproval(
    breachId: string,
    playbookId: string,
    approved: boolean
  ): Promise<void> {
    const breach = this.watchdogStore.getBreach(breachId);
    const playbook = this.playbooks.get(playbookId);

    if (!breach || !playbook) return;

    if (approved) {
      const previousRuns = this.watchdogStore.getRunsForBreach(breachId)
        .filter(r => r.playbookId === playbookId);
      await this.runPlaybook(playbook, breach, previousRuns.length + 1);
    } else {
      await this.escalateBreach(breach, "Playbook rejected by user");
    }
  }
}

// ============ Built-in step executors ============

/**
 * Diagnose step - gather information
 */
registerStepExecutor("diagnose", async (step, ctx) => {
  // Diagnosis steps store info in ctx.diagnosis
  const action = step.params.action as string;

  switch (action) {
    case "get-agent-state": {
      const agentId = step.params.agentId as string;
      const run = ctx.store.getAgentRun(agentId);
      if (run) {
        ctx.diagnosis.agentState = run;
        return { success: true, output: `Agent ${agentId}: ${run.status}` };
      }
      return { success: false, error: `Agent ${agentId} not found` };
    }

    case "get-lane-jobs": {
      const lane = step.params.lane as string;
      const jobs = ctx.store.listJobs({ nodeId: lane });
      ctx.diagnosis.laneJobs = jobs;
      return { success: true, output: `Found ${jobs.length} jobs in lane ${lane}` };
    }

    case "get-node-capacity": {
      const nodeId = step.params.nodeId as string;
      const node = ctx.store.getNode(nodeId);
      if (node) {
        ctx.diagnosis.nodeCapacity = node;
        return { success: true, output: `Node ${nodeId}: ${node.capacity.cores} cores` };
      }
      return { success: false, error: `Node ${nodeId} not found` };
    }

    default:
      return { success: false, error: `Unknown diagnose action: ${action}` };
  }
});

/**
 * Act step - take action
 */
registerStepExecutor("act", async (step, ctx) => {
  const action = step.params.action as string;

  switch (action) {
    case "restart-agent": {
      const agentId = step.params.agentId as string ?? (ctx.diagnosis.agentState as { id?: string })?.id;
      if (!agentId) {
        return { success: false, error: "No agent ID specified" };
      }
      // Emit restart event - actual restart handled by agent module
      await ctx.eventBus.emit("agent.restart.requested", {
        agentId,
        reason: "Playbook: agent stuck",
        breachId: ctx.breach.id,
      });
      return { success: true, output: `Requested restart of agent ${agentId}` };
    }

    case "mark-job-stuck": {
      const jobId = step.params.jobId as string;
      if (!jobId) {
        return { success: false, error: "No job ID specified" };
      }
      // Mark job failed in store (stuck is not a valid JobStatus, use failed)
      ctx.store.updateJobStatus(jobId, "failed", { error: "Marked as stuck by playbook" });
      return { success: true, output: `Marked job ${jobId} as stuck` };
    }

    case "requeue-job": {
      const requeueJobId = step.params.jobId as string;
      const targetNode = step.params.targetNode as string;
      await ctx.eventBus.emit("job.requeue.requested", {
        jobId: requeueJobId,
        targetNode,
        reason: "Playbook: lane jammed",
      });
      return { success: true, output: `Requeued job ${requeueJobId}` };
    }

    case "move-job-to-node": {
      const moveJobId = step.params.jobId as string;
      const toNode = step.params.nodeId as string;
      await ctx.eventBus.emit("job.move.requested", {
        jobId: moveJobId,
        nodeId: toNode,
        reason: "Playbook: idle capacity",
      });
      return { success: true, output: `Moving job ${moveJobId} to node ${toNode}` };
    }

    case "start-agent": {
      const taskId = step.params.taskId as string;
      await ctx.eventBus.emit("task.start.requested", {
        taskId,
        reason: "Playbook: ready but idle",
      });
      return { success: true, output: `Requested start for task ${taskId}` };
    }

    case "gc-worktrees": {
      const nodeIdGc = step.params.nodeId as string;
      await ctx.eventBus.emit("node.gc.requested", {
        nodeId: nodeIdGc,
        type: "worktrees",
        reason: "Playbook: disk low",
      });
      return { success: true, output: `Requested worktree GC on node ${nodeIdGc}` };
    }

    case "restart-runtime": {
      const nodeIdRestart = step.params.nodeId as string;
      const runtime = step.params.runtime as string;
      await ctx.eventBus.emit("node.runtime.restart.requested", {
        nodeId: nodeIdRestart,
        runtime,
        reason: "Playbook: runtime down",
      });
      return { success: true, output: `Requested ${runtime} restart on node ${nodeIdRestart}` };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
});

/**
 * Verify step - check if action worked
 */
registerStepExecutor("verify", async (step, ctx) => {
  const check = step.params.check as string;

  switch (check) {
    case "agent-running": {
      const agentId = step.params.agentId as string ?? (ctx.diagnosis.agentState as { id?: string })?.id;
      if (!agentId) {
        return { success: false, error: "No agent ID to verify" };
      }
      const run = ctx.store.getAgentRun(agentId);
      if (run?.status === "running") {
        return { success: true, output: `Agent ${agentId} is running` };
      }
      return { success: false, error: `Agent ${agentId} not running: ${run?.status}` };
    }

    case "lane-flowing": {
      const lane = step.params.lane as string;
      const jobs = ctx.store.listJobs({ nodeId: lane });
      const stuck = jobs.filter(j => j.status === "failed" && j.error?.includes("stuck"));
      if (stuck.length === 0) {
        return { success: true, output: `Lane ${lane} is flowing` };
      }
      return { success: false, error: `Lane ${lane} still has ${stuck.length} stuck jobs` };
    }

    case "node-healthy": {
      const nodeId = step.params.nodeId as string;
      const node = ctx.store.getNode(nodeId);
      if (node?.status === "online") {
        return { success: true, output: `Node ${nodeId} is healthy` };
      }
      return { success: false, error: `Node ${nodeId} not healthy: ${node?.status}` };
    }

    default:
      return { success: false, error: `Unknown verify check: ${check}` };
  }
});

/**
 * Wait step - wait for a condition
 */
registerStepExecutor("wait", async (step, ctx) => {
  const seconds = (step.params.seconds as number) ?? 5;
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return { success: true, output: `Waited ${seconds}s` };
});

/**
 * Notify step - send a notification
 */
registerStepExecutor("notify", async (step, ctx) => {
  const message = step.params.message as string;
  const severity = (step.params.severity as string) ?? "info";

  await ctx.eventBus.emit("notification.sent", {
    message,
    severity,
    breachId: ctx.breach.id,
    playbookId: ctx.run.playbookId,
  });

  return { success: true, output: `Notification sent: ${message}` };
});

/**
 * Escalate step - raise to decision inbox
 */
registerStepExecutor("escalate", async (step, ctx) => {
  const title = step.params.title as string;
  const question = step.params.question as string;

  await ctx.eventBus.emit("decision.requested", {
    question,
    context: `${title}\n\nEvidence:\n${ctx.breach.evidence.join("\n")}\n\nDiagnosis:\n${JSON.stringify(ctx.diagnosis, null, 2)}`,
    options: step.params.options as string[] ?? ["acknowledge"],
    kind: "escalation",
    reversible: false,
    breachId: ctx.breach.id,
  });

  return { success: true, output: `Escalated: ${title}` };
});
