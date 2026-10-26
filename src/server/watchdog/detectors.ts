/**
 * SLO Detectors - monitors for each SLO type
 */
import type { EventBus } from "../core/event-bus.js";
import type { Store } from "../store/store.js";
import type { WatchdogStore } from "./store.js";
import type { SLODefinition, SLOType } from "./types.js";
import type { Job } from "../../shared/server-types.js";

/**
 * Context passed to detectors
 */
export interface DetectorContext {
  eventBus: EventBus;
  store: Store;
  watchdogStore: WatchdogStore;
}

/**
 * Detector result
 */
export interface DetectorResult {
  status: "healthy" | "warning" | "breached";
  currentValue: number;
  evidence: string[];
}

/**
 * Base interface for SLO detectors
 */
export interface SLODetector {
  /** SLO type this detector handles */
  type: SLOType;
  /** Check the SLO and return the result */
  check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult>;
}

/**
 * Merge frequency detector - checks time since last merge
 */
export const mergeFrequencyDetector: SLODetector = {
  type: "merge-frequency",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Get recent merge events
    const mergeEvents = ctx.eventBus.getRecentEvents("task.completed", 100)
      .filter(e => e.data.result === "merged");

    const now = Date.now();

    // Find the most recent merge
    let lastMergeTime = 0;
    for (const event of mergeEvents) {
      const eventTime = new Date(event.timestamp).getTime();
      if (eventTime > lastMergeTime) {
        lastMergeTime = eventTime;
      }
    }

    // Check if there are ready tasks (condition for this SLO)
    const tasks = ctx.store.listTasks({ status: "queued" });
    if (tasks.length === 0) {
      return {
        status: "healthy",
        currentValue: 0,
        evidence: ["No ready tasks, SLO not applicable"],
      };
    }

    const hoursSinceLastMerge = lastMergeTime === 0
      ? Infinity
      : (now - lastMergeTime) / (60 * 60 * 1000);

    if (hoursSinceLastMerge > slo.threshold) {
      return {
        status: "breached",
        currentValue: hoursSinceLastMerge,
        evidence: [
          `${hoursSinceLastMerge.toFixed(1)}h since last merge (threshold: ${slo.threshold}h)`,
          `${tasks.length} tasks ready`,
        ],
      };
    }

    if (hoursSinceLastMerge > slo.threshold * 0.8) {
      return {
        status: "warning",
        currentValue: hoursSinceLastMerge,
        evidence: [`${hoursSinceLastMerge.toFixed(1)}h since last merge, approaching threshold`],
      };
    }

    return {
      status: "healthy",
      currentValue: hoursSinceLastMerge,
      evidence: [`${hoursSinceLastMerge.toFixed(1)}h since last merge`],
    };
  },
};

/**
 * Gate frequency detector - checks time since last passing gate
 */
export const gateFrequencyDetector: SLODetector = {
  type: "gate-frequency",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Get recent job completions
    const jobs = ctx.store.listJobs({ limit: 100 });
    const completedJobs = jobs.filter((j): j is Job & { completedAt: string } =>
      j.status === "completed" && j.completedAt !== undefined
    );

    const now = Date.now();

    // Check if there are running jobs (condition for this SLO)
    const runningJobs = jobs.filter(j => j.status === "running");
    if (runningJobs.length === 0 && completedJobs.length === 0) {
      return {
        status: "healthy",
        currentValue: 0,
        evidence: ["No gates running, SLO not applicable"],
      };
    }

    // Find the most recent passing gate
    let lastPassingGateTime = 0;
    for (const job of completedJobs) {
      if (job.exitCode === 0) {
        const jobTime = new Date(job.completedAt).getTime();
        if (jobTime > lastPassingGateTime) {
          lastPassingGateTime = jobTime;
        }
      }
    }

    const hoursSinceLastPass = lastPassingGateTime === 0
      ? Infinity
      : (now - lastPassingGateTime) / (60 * 60 * 1000);

    if (hoursSinceLastPass > slo.threshold) {
      return {
        status: "breached",
        currentValue: hoursSinceLastPass,
        evidence: [
          `${hoursSinceLastPass.toFixed(1)}h since last passing gate (threshold: ${slo.threshold}h)`,
        ],
      };
    }

    if (hoursSinceLastPass > slo.threshold * 0.8) {
      return {
        status: "warning",
        currentValue: hoursSinceLastPass,
        evidence: [`${hoursSinceLastPass.toFixed(1)}h since last passing gate, approaching threshold`],
      };
    }

    return {
      status: "healthy",
      currentValue: hoursSinceLastPass,
      evidence: [`${hoursSinceLastPass.toFixed(1)}h since last passing gate`],
    };
  },
};

/**
 * Agent progress detector - checks for stuck agents
 *
 * Note: This detector requires agent run data that may not be available in all setups.
 * It checks for agents that have been idle for longer than the threshold without making progress.
 */
export const agentProgressDetector: SLODetector = {
  type: "agent-progress",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Use events to detect stuck agents - look for agents that haven't emitted activity
    const agentEvents = ctx.eventBus.getRecentEvents("task.started", 100);
    const completedEvents = ctx.eventBus.getRecentEvents("task.completed", 100);

    // Find tasks that started but haven't completed
    const completedTaskIds = new Set(completedEvents.map(e => e.data.taskId as string));
    const runningTasks = agentEvents.filter(e => !completedTaskIds.has(e.data.taskId as string));

    if (runningTasks.length === 0) {
      return {
        status: "healthy",
        currentValue: 0,
        evidence: ["No running agents"],
      };
    }

    const now = Date.now();
    const thresholdMs = slo.threshold * 60 * 1000; // minutes to ms
    const stuckAgents: string[] = [];

    for (const event of runningTasks) {
      const startTime = new Date(event.timestamp).getTime();
      const idleMs = now - startTime;

      if (idleMs > thresholdMs) {
        stuckAgents.push(`task ${event.data.taskId}: ${(idleMs / 60000).toFixed(0)}min since start`);
      }
    }

    if (stuckAgents.length > 0) {
      return {
        status: "breached",
        currentValue: stuckAgents.length,
        evidence: [
          `${stuckAgents.length} agent(s) potentially stuck (no progress > ${slo.threshold}min)`,
          ...stuckAgents,
        ],
      };
    }

    return {
      status: "healthy",
      currentValue: 0,
      evidence: [`${runningTasks.length} agents running, all showing progress`],
    };
  },
};

/**
 * Lane busy detector - checks for jammed lanes
 */
export const laneBusyDetector: SLODetector = {
  type: "lane-busy",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Get jobs grouped by lane using available method
    const jobs = ctx.store.listJobs({ limit: 500 });
    type JobWithTimes = Job & { startedAt: string; completedAt?: string };
    const lanes = new Map<string, { running: JobWithTimes[]; completed: JobWithTimes[] }>();

    for (const job of jobs) {
      // Jobs don't have metadata.lane in the current schema, use nodeId as proxy for lane
      const lane = job.nodeId ?? "default";
      if (!lanes.has(lane)) {
        lanes.set(lane, { running: [], completed: [] });
      }
      if (job.status === "running" && job.startedAt) {
        lanes.get(lane)!.running.push(job as JobWithTimes);
      } else if (job.status === "completed" && job.startedAt && job.completedAt) {
        lanes.get(lane)!.completed.push(job as JobWithTimes);
      }
    }

    const jammedLanes: string[] = [];
    const now = Date.now();

    for (const [lane, { running, completed }] of lanes) {
      if (running.length === 0) continue;

      // Calculate median job time for this lane
      const durations = completed
        .map(j => new Date(j.completedAt!).getTime() - new Date(j.startedAt).getTime());

      if (durations.length === 0) continue;

      durations.sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      const threshold = median * slo.threshold; // N× median

      for (const job of running) {
        const runningTime = now - new Date(job.startedAt).getTime();
        if (runningTime > threshold) {
          jammedLanes.push(`${lane}: job ${job.id} running ${(runningTime / 60000).toFixed(0)}min (${slo.threshold}× median = ${(threshold / 60000).toFixed(0)}min)`);
        }
      }
    }

    if (jammedLanes.length > 0) {
      return {
        status: "breached",
        currentValue: jammedLanes.length,
        evidence: [
          `${jammedLanes.length} lane(s) jammed`,
          ...jammedLanes,
        ],
      };
    }

    return {
      status: "healthy",
      currentValue: 0,
      evidence: ["All lanes flowing normally"],
    };
  },
};

/**
 * Idle capacity detector - checks for unused capacity
 */
export const idleCapacityDetector: SLODetector = {
  type: "idle-capacity",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Check if there's queued work
    const pendingJobs = ctx.store.listJobs({ status: "pending" });
    if (pendingJobs.length === 0) {
      return {
        status: "healthy",
        currentValue: 0,
        evidence: ["No queued jobs"],
      };
    }

    // Get nodes with free capacity
    const nodes = ctx.store.listNodes();
    const idleNodes: string[] = [];
    const now = Date.now();

    for (const node of nodes) {
      if (node.status !== "online") continue;

      const usedCores = node.usedCapacity.cores;
      const totalCores = node.capacity.cores;
      const freeCapacity = totalCores - usedCores;

      if (freeCapacity >= 1) {
        // Check how long this capacity has been idle based on last heartbeat
        const lastActivity = node.lastHeartbeat
          ? new Date(node.lastHeartbeat).getTime()
          : 0;
        const idleMinutes = (now - lastActivity) / 60000;

        if (idleMinutes > slo.threshold) {
          idleNodes.push(`${node.name}: ${freeCapacity} cores free for ${idleMinutes.toFixed(0)}min`);
        }
      }
    }

    if (idleNodes.length > 0) {
      return {
        status: "breached",
        currentValue: idleNodes.length,
        evidence: [
          `${idleNodes.length} node(s) with idle capacity while ${pendingJobs.length} jobs queued`,
          ...idleNodes,
        ],
      };
    }

    return {
      status: "healthy",
      currentValue: 0,
      evidence: [`Capacity being utilized, ${pendingJobs.length} jobs queued`],
    };
  },
};

/**
 * Branch green detector - checks if default branch is green
 */
export const branchGreenDetector: SLODetector = {
  type: "branch-green",

  async check(slo: SLODefinition, ctx: DetectorContext): Promise<DetectorResult> {
    // Look for branch status and job completion events
    const events = ctx.eventBus.getRecentEvents(undefined, 500);
    const relevantEvents = events.filter(
      e => e.type === "branch.status" || e.type === "job.completed"
    );

    // Find the most recent status for the default branch
    let branchGreen = true;
    let evidence: string[] = [];

    for (const event of relevantEvents.reverse()) {
      if (event.data.branch === "main" || event.data.branch === "master") {
        if (event.type === "job.completed" && event.data.type === "nightly") {
          branchGreen = event.data.exitCode === 0;
          evidence = [
            branchGreen
              ? "Default branch nightly passed"
              : `Default branch nightly failed: ${event.data.failedTests ?? "unknown failures"}`,
          ];
          break;
        }
      }
    }

    // If no status found, assume healthy (no data yet)
    if (evidence.length === 0) {
      return {
        status: "healthy",
        currentValue: 1,
        evidence: ["No branch status data available"],
      };
    }

    return {
      status: branchGreen ? "healthy" : "breached",
      currentValue: branchGreen ? 1 : 0,
      evidence,
    };
  },
};

/**
 * Registry of all detectors
 */
export const detectorRegistry: Map<SLOType, SLODetector> = new Map([
  ["merge-frequency", mergeFrequencyDetector],
  ["gate-frequency", gateFrequencyDetector],
  ["agent-progress", agentProgressDetector],
  ["lane-busy", laneBusyDetector],
  ["idle-capacity", idleCapacityDetector],
  ["branch-green", branchGreenDetector],
]);

/**
 * Run a detector for an SLO
 */
export async function runDetector(
  slo: SLODefinition,
  ctx: DetectorContext
): Promise<DetectorResult> {
  const detector = detectorRegistry.get(slo.type);
  if (!detector) {
    return {
      status: "healthy",
      currentValue: 0,
      evidence: [`No detector for SLO type: ${slo.type}`],
    };
  }
  return detector.check(slo, ctx);
}
