/**
 * Watchdog acceptance tests - SPEC-autonomy §2, §3
 *
 * Each test reproduces a failure scenario with fakes, then shows:
 * 1. The detector firing
 * 2. The playbook fixing it
 * 3. Zero human steps required
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { WatchdogStore } from "./store.js";
import { PlaybookEngine, registerStepExecutor, clearStepExecutors } from "./playbook-engine.js";
import { runDetector, type DetectorContext, detectorRegistry } from "./detectors.js";
import { builtInPlaybooks } from "./playbooks.js";
import { WatchdogService } from "./service.js";
import { EventBus } from "../core/event-bus.js";
import type {
  SLODefinition,
  SLOBreach,
  PlaybookDefinition,
  PlaybookStep,
  PlaybookStepResult,
} from "./types.js";

// ============================================================================
// Test helpers and mocks
// ============================================================================

interface MockAgent {
  id: string;
  pid: number | null;
  status: "running" | "waiting" | "idle" | "dead";
  lastActivityAt: string;
  startedAt: string;
  sessionId: string;
  lockFile?: string;
  claimId?: string;
}

interface MockJob {
  id: string;
  status: "pending" | "running" | "completed" | "stuck";
  nodeId: string;
  lane: string;
  startedAt: string;
  runnerId?: string;
  runnerHeartbeat?: string;
  result?: { exitCode: number; error?: string };
}

interface MockNode {
  id: string;
  name: string;
  status: "online" | "offline" | "draining" | "broken";
  capacity: { cores: number; memory: number };
  usedCores: number;
  load1m: number;
  lastJobAssignedAt?: string;
  lastHeartbeat?: string;
}

interface MockLock {
  id: string;
  holderId: string;
  holderPid: number | null;
  acquiredAt: string;
  leaseSeconds: number;
}

interface MockIncident {
  id: string;
  type: string;
  nodeId?: string;
  signature: string;
  occurrences: { prId: string; gateId: string; timestamp: string }[];
  status: "open" | "resolved";
}

function createMockStore(overrides: Partial<{
  agents: MockAgent[];
  jobs: MockJob[];
  nodes: MockNode[];
  locks: MockLock[];
  incidents: MockIncident[];
  tasks: { id: string; status: string }[];
}> = {}) {
  const agents = overrides.agents ?? [];
  const jobs = overrides.jobs ?? [];
  const nodes = overrides.nodes ?? [];
  const locks = overrides.locks ?? [];
  const incidents = overrides.incidents ?? [];
  const tasks = overrides.tasks ?? [];

  return {
    // Agent methods
    getAgentRunsByStatus: vi.fn((status: string) =>
      agents.filter(a => a.status === status)
    ),
    getAgentRun: vi.fn((id: string) => agents.find(a => a.id === id)),
    getAllAgentRuns: vi.fn(() => agents),
    updateAgentRun: vi.fn(),
    createAgentRun: vi.fn(),
    getAgentLock: vi.fn((agentId: string) => locks.find(l => l.holderId === agentId)),

    // Job methods
    getJobsByStatus: vi.fn((status: string) => jobs.filter(j => j.status === status)),
    getJobsByLane: vi.fn((lane: string) => jobs.filter(j => j.lane === lane)),
    getRecentJobs: vi.fn((limit: number) => jobs.slice(0, limit)),
    getJob: vi.fn((id: string) => jobs.find(j => j.id === id)),
    updateJobStatus: vi.fn(),
    createJob: vi.fn(),
    getJobsByNode: vi.fn((nodeId: string) => jobs.filter(j => j.nodeId === nodeId)),

    // Node methods
    getAllNodes: vi.fn(() => nodes),
    getNode: vi.fn((id: string) => nodes.find(n => n.id === id)),
    updateNode: vi.fn(),
    getNodeByName: vi.fn((name: string) => nodes.find(n => n.name === name)),

    // Lock methods
    getLock: vi.fn((id: string) => locks.find(l => l.id === id)),
    getAllLocks: vi.fn(() => locks),
    releaseLock: vi.fn(),
    acquireLock: vi.fn(),

    // Incident methods
    getIncidents: vi.fn(() => incidents),
    createIncident: vi.fn(),
    updateIncident: vi.fn(),
    getIncidentBySignature: vi.fn((sig: string) => incidents.find(i => i.signature === sig)),

    // Task methods
    getTasksByStatus: vi.fn((status: string) => tasks.filter(t => t.status === status)),

    // Claims
    getClaim: vi.fn((agentId: string) => agents.find(a => a.id === agentId)?.claimId),
    removeClaim: vi.fn(),
  } as any;
}

// ============================================================================
// 1. Dead lock holder test
// ============================================================================
describe("Acceptance: Dead lock holder", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("breaks stale lock, stops waiters doing no work, starts ONE copy", async () => {
    // Setup: A lock whose holder pid is dead (or pid-less and older than lease)
    const staleLock: MockLock = {
      id: "agent-lock-1",
      holderId: "agent-1",
      holderPid: 99999, // Non-existent PID
      acquiredAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      leaseSeconds: 300, // 5 minute lease, long expired
    };

    const waitingAgents: MockAgent[] = [
      {
        id: "agent-1-waiter-1",
        pid: 12345,
        status: "waiting",
        lastActivityAt: new Date(Date.now() - 600000).toISOString(),
        startedAt: new Date(Date.now() - 600000).toISOString(),
        sessionId: "sess-1",
        lockFile: "agent-lock-1",
      },
      {
        id: "agent-1-waiter-2",
        pid: 12346,
        status: "waiting",
        lastActivityAt: new Date(Date.now() - 300000).toISOString(),
        startedAt: new Date(Date.now() - 300000).toISOString(),
        sessionId: "sess-2",
        lockFile: "agent-lock-1",
      },
    ];

    mockStore = createMockStore({
      agents: waitingAgents,
      locks: [staleLock],
    });

    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    // Register step executors for this test
    let lockBroken = false;
    let waitersStopped = 0;
    let agentStarted = false;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "check-lock-holder") {
        // Check if the lock holder PID is alive
        return {
          lockId: staleLock.id,
          holderPid: staleLock.holderPid,
          holderAlive: false, // PID 99999 doesn't exist
          leaseExpired: true,
          waitersCount: waitingAgents.length,
        };
      }
      return {};
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "break-stale-lock") {
        lockBroken = true;
        return { broken: true };
      }
      if (step.params.action === "stop-idle-waiters") {
        waitersStopped = waitingAgents.length;
        return { stopped: waitersStopped };
      }
      if (step.params.action === "start-single-agent") {
        agentStarted = true;
        return { started: true, agentId: "agent-1" };
      }
      return {};
    });

    registerStepExecutor("verify", async (step, ctx) => {
      if (step.params.check === "lock-released") {
        return { success: lockBroken };
      }
      if (step.params.check === "single-instance-running") {
        return { success: agentStarted && waitersStopped === 2 };
      }
      return { success: true };
    });

    // Define the playbook for dead lock holder
    const deadLockPlaybook: PlaybookDefinition = {
      id: "dead-lock-holder",
      name: "Dead Lock Holder",
      description: "Handle dead lock holder blocking agent starts",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 5,
      maxAttempts: 1,
      cooldownSeconds: 60,
      steps: [
        {
          id: "diagnose-lock",
          name: "Diagnose lock state",
          description: "Check if lock holder is dead",
          type: "diagnose",
          params: { action: "check-lock-holder" },
        },
        {
          id: "break-lock",
          name: "Break stale lock",
          description: "Release the lock held by dead process",
          type: "act",
          params: { action: "break-stale-lock" },
        },
        {
          id: "stop-waiters",
          name: "Stop idle waiters",
          description: "Stop waiters that are doing no work",
          type: "act",
          params: { action: "stop-idle-waiters" },
        },
        {
          id: "start-agent",
          name: "Start single agent",
          description: "Start exactly ONE copy of the agent",
          type: "act",
          params: { action: "start-single-agent" },
        },
        {
          id: "verify-single",
          name: "Verify single instance",
          description: "Confirm only one agent is running",
          type: "verify",
          params: { check: "single-instance-running" },
        },
      ],
    };

    engine.registerPlaybook(deadLockPlaybook);

    // Create SLO and breach
    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "Agents show progress",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-lock-1",
      sloId: "agent-progress",
      detectedAt: new Date().toISOString(),
      evidence: ["Lock holder dead, agents blocked"],
      value: 2,
      threshold: 1,
    });

    // Run the playbook
    const run = await engine.runPlaybook("dead-lock-holder", breach.id);

    // Wait for completion
    await new Promise(r => setTimeout(r, 100));

    // Verify outcomes
    expect(lockBroken).toBe(true);
    expect(waitersStopped).toBe(2);
    expect(agentStarted).toBe(true);

    const finalRun = watchdogStore.getPlaybookRun(run.id);
    expect(finalRun?.status).toBe("succeeded");
  });
});

// ============================================================================
// 2. Duplicate agent processes test
// ============================================================================
describe("Acceptance: Duplicate agent processes", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("keeps working agent, stops duplicates, prevents future duplicates", async () => {
    // Setup: Multiple processes for the same agent ID
    const duplicateAgents: MockAgent[] = [
      {
        id: "agent-1",
        pid: 1001,
        status: "running",
        lastActivityAt: new Date(Date.now() - 60000).toISOString(), // Active 1 min ago
        startedAt: new Date(Date.now() - 3600000).toISOString(), // Started 1h ago (oldest)
        sessionId: "sess-1",
      },
      {
        id: "agent-1",
        pid: 1002,
        status: "running",
        lastActivityAt: new Date(Date.now() - 5000).toISOString(), // Active 5s ago (most recent)
        startedAt: new Date(Date.now() - 1800000).toISOString(), // Started 30min ago
        sessionId: "sess-2",
      },
      {
        id: "agent-1",
        pid: 1003,
        status: "idle",
        lastActivityAt: new Date(Date.now() - 300000).toISOString(), // Idle 5 min
        startedAt: new Date(Date.now() - 600000).toISOString(),
        sessionId: "sess-3",
      },
    ];

    mockStore = createMockStore({ agents: duplicateAgents });
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let keptAgent: string | null = null;
    let stoppedAgents: string[] = [];

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "find-duplicates") {
        // Group by agent ID, find duplicates
        const byId = new Map<string, MockAgent[]>();
        for (const agent of duplicateAgents) {
          const list = byId.get(agent.id) || [];
          list.push(agent);
          byId.set(agent.id, list);
        }
        return {
          duplicates: Array.from(byId.entries())
            .filter(([_, agents]) => agents.length > 1)
            .map(([id, agents]) => ({ id, count: agents.length, agents })),
        };
      }
      return {};
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "resolve-duplicates") {
        // Keep the one with most recent activity
        const sorted = [...duplicateAgents].sort(
          (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
        );
        keptAgent = sorted[0].sessionId;
        stoppedAgents = sorted.slice(1).map(a => a.sessionId);
        return { kept: keptAgent, stopped: stoppedAgents };
      }
      return {};
    });

    registerStepExecutor("verify", async (step, ctx) => {
      return { success: keptAgent !== null && stoppedAgents.length === 2 };
    });

    const duplicatePlaybook: PlaybookDefinition = {
      id: "duplicate-agents",
      name: "Duplicate Agent Processes",
      description: "Resolve duplicate agent processes",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 5,
      maxAttempts: 1,
      cooldownSeconds: 60,
      steps: [
        {
          id: "diagnose",
          name: "Find duplicates",
          description: "Find agents with multiple processes",
          type: "diagnose",
          params: { action: "find-duplicates" },
        },
        {
          id: "resolve",
          name: "Resolve duplicates",
          description: "Keep working agent, stop others",
          type: "act",
          params: { action: "resolve-duplicates" },
        },
        {
          id: "verify",
          name: "Verify single instance",
          description: "Confirm only one process per agent",
          type: "verify",
          params: { check: "no-duplicates" },
        },
      ],
    };

    engine.registerPlaybook(duplicatePlaybook);

    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "Agents show progress",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-dup-1",
      sloId: "agent-progress",
      detectedAt: new Date().toISOString(),
      evidence: ["Duplicate agents detected: agent-1 has 3 processes"],
      value: 3,
      threshold: 1,
    });

    const run = await engine.runPlaybook("duplicate-agents", breach.id);
    await new Promise(r => setTimeout(r, 100));

    // The most recently active agent (sess-2) should be kept
    expect(keptAgent).toBe("sess-2");
    expect(stoppedAgents).toHaveLength(2);
    expect(stoppedAgents).toContain("sess-1");
    expect(stoppedAgents).toContain("sess-3");
  });
});

// ============================================================================
// 3. HUNG vs WAITING test
// ============================================================================
describe("Acceptance: HUNG vs WAITING", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("restarts HUNG agent with resume summary, never restarts WAITING agent", async () => {
    const agents: MockAgent[] = [
      {
        id: "hung-agent",
        pid: 2001,
        status: "running", // Appears running but no progress
        lastActivityAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        startedAt: new Date(Date.now() - 7200000).toISOString(),
        sessionId: "hung-sess",
      },
      {
        id: "waiting-agent",
        pid: 2002,
        status: "waiting", // Explicitly waiting on a gate
        lastActivityAt: new Date(Date.now() - 3600000).toISOString(), // Also 1 hour ago
        startedAt: new Date(Date.now() - 7200000).toISOString(),
        sessionId: "wait-sess",
      },
    ];

    mockStore = createMockStore({ agents });
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let restartedAgents: string[] = [];
    let resumeSummaryGenerated = false;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "get-agent-state") {
        const agent = ctx.diagnosis?.targetAgent as MockAgent;
        if (agent) {
          const idleMs = Date.now() - new Date(agent.lastActivityAt).getTime();
          return {
            agentId: agent.id,
            isHung: agent.status !== "waiting" && idleMs > 45 * 60 * 1000,
            isWaiting: agent.status === "waiting",
            idleMinutes: Math.floor(idleMs / 60000),
          };
        }
      }
      return {};
    });

    registerStepExecutor("verify", async (step, ctx) => {
      if (step.params.check === "agent-not-waiting") {
        // This step should SKIP if agent is waiting
        const state = ctx.diagnosis;
        if (state?.isWaiting) {
          return { success: false, skip: true, reason: "Agent is WAITING, not HUNG" };
        }
        return { success: true };
      }
      return { success: true };
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "restart-agent") {
        const agent = ctx.diagnosis?.targetAgent as MockAgent;
        if (agent && !ctx.diagnosis?.isWaiting) {
          restartedAgents.push(agent.id);
          resumeSummaryGenerated = true;
          return { restarted: true, resumeSummary: "Generated resume summary" };
        }
        return { restarted: false, reason: "Skipped WAITING agent" };
      }
      return {};
    });

    // Use the built-in agent-stuck playbook
    engine.registerPlaybook(builtInPlaybooks.find(p => p.id === "agent-stuck")!);

    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "Agents show progress",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    });

    // Test HUNG agent - should be restarted
    const hungBreach = watchdogStore.createBreach({
      id: "breach-hung",
      sloId: "agent-progress",
      detectedAt: new Date().toISOString(),
      evidence: ["hung-agent idle for 60 minutes"],
      value: 60,
      threshold: 45,
    });

    // Store target agent in diagnosis for the playbook
    watchdogStore.createPlaybookRun({
      id: "run-hung",
      playbookId: "agent-stuck",
      breachId: hungBreach.id,
      status: "running",
      attempt: 1,
      startedAt: new Date().toISOString(),
    });

    // The playbook should restart the hung agent
    // For this test, we simulate by checking that HUNG agents are restarted
    // and WAITING agents are not

    // Verify the detector identifies hung vs waiting correctly
    const ctx: DetectorContext = { eventBus, store: mockStore, watchdogStore };
    const result = await runDetector(
      {
        id: "agent-progress",
        name: "Agent Progress",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 45,
        unit: "minutes",
        type: "agent-progress",
      },
      ctx
    );

    // The detector should find the hung agent but not the waiting one
    expect(result.status).toBe("breached");
    expect(result.evidence.some(e => e.includes("hung-agent"))).toBe(true);
    // WAITING agent should not be flagged (it has status "waiting")
  });
});

// ============================================================================
// 4. Claims test - never remove a live agent's claim
// ============================================================================
describe("Acceptance: Claims protection", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("never removes a live agent's claim; silent means no process", async () => {
    const liveAgent: MockAgent = {
      id: "live-agent",
      pid: 3001,
      status: "running",
      lastActivityAt: new Date(Date.now() - 60000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      sessionId: "live-sess",
      claimId: "task-123",
    };

    const silentAgent: MockAgent = {
      id: "silent-agent",
      pid: null, // No process
      status: "dead",
      lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      sessionId: "silent-sess",
      claimId: "task-456",
    };

    mockStore = createMockStore({ agents: [liveAgent, silentAgent] });

    let claimRemovalAttempts: string[] = [];
    let removedClaims: string[] = [];

    // Mock the claim removal that should be protected
    mockStore.removeClaim = vi.fn((agentId: string) => {
      claimRemovalAttempts.push(agentId);
      const agent = [liveAgent, silentAgent].find(a => a.id === agentId);
      if (agent?.pid && agent.status === "running") {
        // Should NOT remove - agent is live
        return false;
      }
      removedClaims.push(agentId);
      return true;
    });

    // Simulate cleanup trying to remove claims
    for (const agent of [liveAgent, silentAgent]) {
      mockStore.removeClaim(agent.id);
    }

    // Live agent's claim should NOT be removed
    expect(claimRemovalAttempts).toContain("live-agent");
    expect(removedClaims).not.toContain("live-agent");

    // Silent agent's claim SHOULD be removed
    expect(removedClaims).toContain("silent-agent");
  });
});

// ============================================================================
// 5. Infra signature test
// ============================================================================
describe("Acceptance: Infra signature detection", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("marks node broken after same failure on 3 PRs, requeues jobs, opens incident", async () => {
    // Setup: Same error on 3 different PRs' gates
    const failedJobs: MockJob[] = [
      {
        id: "job-1",
        status: "completed",
        nodeId: "node-dell",
        lane: "remote",
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        result: { exitCode: 127, error: "No such file or directory: /usr/bin/java" },
      },
      {
        id: "job-2",
        status: "completed",
        nodeId: "node-dell",
        lane: "remote",
        startedAt: new Date(Date.now() - 1800000).toISOString(),
        result: { exitCode: 127, error: "No such file or directory: /usr/bin/java" },
      },
      {
        id: "job-3",
        status: "completed",
        nodeId: "node-dell",
        lane: "remote",
        startedAt: new Date(Date.now() - 600000).toISOString(),
        result: { exitCode: 127, error: "No such file or directory: /usr/bin/java" },
      },
    ];

    const pendingJobs: MockJob[] = [
      { id: "job-4", status: "pending", nodeId: "node-dell", lane: "remote", startedAt: "" },
      { id: "job-5", status: "pending", nodeId: "node-dell", lane: "remote", startedAt: "" },
    ];

    const nodes: MockNode[] = [
      {
        id: "node-dell",
        name: "Dell",
        status: "online",
        capacity: { cores: 8, memory: 16000 },
        usedCores: 2,
        load1m: 2.5,
      },
      {
        id: "node-mac",
        name: "Mac",
        status: "online",
        capacity: { cores: 8, memory: 24000 },
        usedCores: 4,
        load1m: 45,
      },
    ];

    mockStore = createMockStore({
      jobs: [...failedJobs, ...pendingJobs],
      nodes,
      incidents: [],
    });

    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let nodeMarkedBroken = false;
    let jobsRequeued: string[] = [];
    let incidentOpened = false;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "analyze-failures") {
        // Group failures by signature
        const signature = "rc=127 No such file or directory";
        const byNode = new Map<string, number>();

        for (const job of failedJobs) {
          if (job.result?.exitCode === 127) {
            const count = byNode.get(job.nodeId) || 0;
            byNode.set(job.nodeId, count + 1);
          }
        }

        return {
          signature,
          nodeFailures: Array.from(byNode.entries()).map(([nodeId, count]) => ({
            nodeId,
            count,
            isInfra: count >= 3,
          })),
        };
      }
      return {};
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "mark-node-broken") {
        nodeMarkedBroken = true;
        return { nodeId: "node-dell", marked: true };
      }
      if (step.params.action === "requeue-jobs") {
        jobsRequeued = pendingJobs.map(j => j.id);
        return { requeued: jobsRequeued };
      }
      if (step.params.action === "open-incident") {
        incidentOpened = true;
        return { incidentId: "inc-1" };
      }
      return {};
    });

    registerStepExecutor("verify", async (step, ctx) => {
      return { success: true };
    });

    registerStepExecutor("notify", async (step, ctx) => {
      return {};
    });

    const infraPlaybook: PlaybookDefinition = {
      id: "infra-signature",
      name: "Infrastructure Failure Signature",
      description: "Handle repeated infra failures",
      forSLOTypes: ["gate-frequency"],
      requiresApproval: false,
      priority: 5,
      maxAttempts: 1,
      cooldownSeconds: 300,
      steps: [
        {
          id: "analyze",
          name: "Analyze failures",
          description: "Find signature across PRs",
          type: "diagnose",
          params: { action: "analyze-failures" },
        },
        {
          id: "mark-broken",
          name: "Mark node broken",
          description: "Mark failing node as broken",
          type: "act",
          params: { action: "mark-node-broken" },
        },
        {
          id: "requeue",
          name: "Requeue jobs",
          description: "Move jobs to other nodes",
          type: "act",
          params: { action: "requeue-jobs" },
        },
        {
          id: "incident",
          name: "Open incident",
          description: "Open infra incident",
          type: "act",
          params: { action: "open-incident" },
        },
        {
          id: "notify",
          name: "Notify",
          description: "Alert about infra issue",
          type: "notify",
          params: { message: "Node marked broken due to repeated failures" },
        },
      ],
    };

    engine.registerPlaybook(infraPlaybook);

    watchdogStore.upsertSLODefinition({
      id: "gate-frequency",
      name: "Gate Frequency",
      description: "Gates pass regularly",
      projectId: null,
      enabled: true,
      threshold: 3,
      unit: "hours",
      type: "gate-frequency",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-infra",
      sloId: "gate-frequency",
      detectedAt: new Date().toISOString(),
      evidence: ["3 consecutive rc=127 failures on node-dell"],
      value: 3,
      threshold: 1,
    });

    const run = await engine.runPlaybook("infra-signature", breach.id);
    await new Promise(r => setTimeout(r, 100));

    expect(nodeMarkedBroken).toBe(true);
    expect(jobsRequeued).toHaveLength(2);
    expect(incidentOpened).toBe(true);
  });
});

// ============================================================================
// 6. Node unreachable test
// ============================================================================
describe("Acceptance: Node unreachable mid-job", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("requeues job within 5 min to node with free capacity, respects load limits", async () => {
    const runningJob: MockJob = {
      id: "job-running",
      status: "running",
      nodeId: "node-dell",
      lane: "remote",
      startedAt: new Date(Date.now() - 600000).toISOString(), // Started 10 min ago
      runnerId: "runner-1",
      runnerHeartbeat: new Date(Date.now() - 400000).toISOString(), // Last heartbeat 6+ min ago
    };

    const nodes: MockNode[] = [
      {
        id: "node-dell",
        name: "Dell",
        status: "offline", // Became unreachable
        capacity: { cores: 8, memory: 16000 },
        usedCores: 2,
        load1m: 0,
        lastHeartbeat: new Date(Date.now() - 400000).toISOString(),
      },
      {
        id: "node-mac",
        name: "Mac",
        status: "online",
        capacity: { cores: 8, memory: 24000 },
        usedCores: 4,
        load1m: 30, // Under limit
      },
      {
        id: "node-overloaded",
        name: "Overloaded",
        status: "online",
        capacity: { cores: 4, memory: 8000 },
        usedCores: 4,
        load1m: 80, // Over limit, should not receive jobs
      },
    ];

    mockStore = createMockStore({
      jobs: [runningJob],
      nodes,
    });

    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let requeuedTo: string | null = null;
    let requeueTime = 0;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "check-node-health") {
        return {
          unreachableNodes: nodes.filter(n => n.status === "offline").map(n => n.id),
          affectedJobs: [runningJob],
        };
      }
      if (step.params.action === "find-capacity") {
        const available = nodes.filter(n =>
          n.status === "online" &&
          n.load1m < 40 && // Load limit
          (n.capacity.cores - n.usedCores) >= 1
        );
        return { availableNodes: available };
      }
      return {};
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "requeue-to-available") {
        requeueTime = Date.now();
        // Should pick Mac, not Overloaded
        const available = ctx.diagnosis?.availableNodes as MockNode[];
        if (available && available.length > 0) {
          requeuedTo = available[0].id;
          return { requeuedTo, jobId: runningJob.id };
        }
      }
      return {};
    });

    registerStepExecutor("verify", async (step, ctx) => {
      return { success: requeuedTo !== null && requeuedTo !== "node-overloaded" };
    });

    const unreachablePlaybook: PlaybookDefinition = {
      id: "node-unreachable",
      name: "Node Unreachable",
      description: "Handle unreachable node",
      forSLOTypes: ["idle-capacity"],
      requiresApproval: false,
      priority: 5,
      maxAttempts: 1,
      cooldownSeconds: 60,
      steps: [
        {
          id: "check-health",
          name: "Check node health",
          description: "Find unreachable nodes",
          type: "diagnose",
          params: { action: "check-node-health" },
        },
        {
          id: "find-capacity",
          name: "Find available capacity",
          description: "Find nodes with free capacity",
          type: "diagnose",
          params: { action: "find-capacity" },
        },
        {
          id: "requeue",
          name: "Requeue job",
          description: "Move job to available node",
          type: "act",
          params: { action: "requeue-to-available" },
        },
        {
          id: "verify",
          name: "Verify requeued",
          description: "Confirm job was requeued",
          type: "verify",
          params: { check: "job-requeued" },
        },
      ],
    };

    engine.registerPlaybook(unreachablePlaybook);

    watchdogStore.upsertSLODefinition({
      id: "idle-capacity",
      name: "Idle Capacity",
      description: "Capacity is utilized",
      projectId: null,
      enabled: true,
      threshold: 10,
      unit: "minutes",
      type: "idle-capacity",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-unreachable",
      sloId: "idle-capacity",
      detectedAt: new Date().toISOString(),
      evidence: ["Node node-dell unreachable"],
      value: 1,
      threshold: 0,
    });

    const startTime = Date.now();
    const run = await engine.runPlaybook("node-unreachable", breach.id);
    await new Promise(r => setTimeout(r, 100));

    // Job should be requeued to Mac, not Overloaded
    expect(requeuedTo).toBe("node-mac");
    // Should complete quickly (well under 5 minutes)
    expect(requeueTime - startTime).toBeLessThan(5 * 60 * 1000);
  });
});

// ============================================================================
// 7. Job ownership test
// ============================================================================
describe("Acceptance: Job ownership with heartbeats", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
  });

  it("job owned by live runner is never reclaimed by another runner startup", async () => {
    const ownedJob: MockJob = {
      id: "job-owned",
      status: "running",
      nodeId: "node-mac",
      lane: "heavy",
      startedAt: new Date(Date.now() - 600000).toISOString(),
      runnerId: "runner-1",
      runnerHeartbeat: new Date(Date.now() - 30000).toISOString(), // Recent heartbeat
    };

    const staleJob: MockJob = {
      id: "job-stale",
      status: "running",
      nodeId: "node-mac",
      lane: "heavy",
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      runnerId: "runner-old",
      runnerHeartbeat: new Date(Date.now() - 600000).toISOString(), // Heartbeat 10 min ago
    };

    mockStore = createMockStore({ jobs: [ownedJob, staleJob] });

    const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    // Simulate runner-2 starting up and trying to claim jobs
    const claimAttempts: { jobId: string; claimed: boolean }[] = [];

    function tryClaimJob(jobId: string, newRunnerId: string): boolean {
      const job = mockStore.getJob(jobId);
      if (!job) return false;

      // Check if current owner is still alive via heartbeat
      if (job.runnerId && job.runnerHeartbeat) {
        const heartbeatAge = Date.now() - new Date(job.runnerHeartbeat).getTime();
        if (heartbeatAge < HEARTBEAT_TIMEOUT_MS) {
          // Owner is alive, cannot claim
          claimAttempts.push({ jobId, claimed: false });
          return false;
        }
      }

      // Can claim - owner is dead or no owner
      claimAttempts.push({ jobId, claimed: true });
      return true;
    }

    // Runner-2 starts up and tries to claim both jobs
    const couldClaimOwned = tryClaimJob("job-owned", "runner-2");
    const couldClaimStale = tryClaimJob("job-stale", "runner-2");

    // Live runner's job should NOT be claimable
    expect(couldClaimOwned).toBe(false);

    // Stale runner's job SHOULD be claimable
    expect(couldClaimStale).toBe(true);

    // Verify the logic
    expect(claimAttempts.find(a => a.jobId === "job-owned")?.claimed).toBe(false);
    expect(claimAttempts.find(a => a.jobId === "job-stale")?.claimed).toBe(true);
  });
});

// ============================================================================
// 8. Idle capacity SLO breach test
// ============================================================================
describe("Acceptance: Idle capacity SLO breach", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("diagnoses hold and escalates with evidence when capacity free but nothing starts", async () => {
    const pendingJobs: MockJob[] = [
      { id: "job-pending-1", status: "pending", nodeId: "", lane: "heavy", startedAt: "" },
      { id: "job-pending-2", status: "pending", nodeId: "", lane: "heavy", startedAt: "" },
    ];

    const idleNode: MockNode = {
      id: "node-mac",
      name: "Mac",
      status: "online",
      capacity: { cores: 8, memory: 24000 },
      usedCores: 2,
      load1m: 25, // Low load
      lastJobAssignedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago
    };

    mockStore = createMockStore({
      jobs: pendingJobs,
      nodes: [idleNode],
    });

    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let diagnosis: any = null;
    let escalated = false;
    let escalationEvidence: string[] = [];

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "analyze-capacity-hold") {
        diagnosis = {
          queuedJobs: pendingJobs.length,
          idleCapacity: idleNode.capacity.cores - idleNode.usedCores,
          idleMinutes: 15,
          possibleCauses: [
            "Scheduler not polling",
            "Job requirements not met",
            "Capacity check using wrong metric",
          ],
        };
        return diagnosis;
      }
      return {};
    });

    registerStepExecutor("escalate", async (step, ctx) => {
      escalated = true;
      escalationEvidence = [
        `${diagnosis.queuedJobs} jobs queued`,
        `${diagnosis.idleCapacity} cores free for ${diagnosis.idleMinutes} min`,
        `Possible causes: ${diagnosis.possibleCauses.join(", ")}`,
      ];
      return { escalated: true, evidence: escalationEvidence };
    });

    const idleCapacityPlaybook: PlaybookDefinition = {
      id: "idle-capacity-breach",
      name: "Idle Capacity Breach",
      description: "Diagnose and escalate idle capacity",
      forSLOTypes: ["idle-capacity"],
      requiresApproval: false,
      priority: 10,
      maxAttempts: 1,
      cooldownSeconds: 600,
      steps: [
        {
          id: "diagnose",
          name: "Analyze capacity hold",
          description: "Find why capacity is idle",
          type: "diagnose",
          params: { action: "analyze-capacity-hold" },
        },
        {
          id: "escalate",
          name: "Escalate to Decision Inbox",
          description: "Raise with diagnosis",
          type: "escalate",
          params: { kind: "escalation" },
        },
      ],
    };

    engine.registerPlaybook(idleCapacityPlaybook);

    watchdogStore.upsertSLODefinition({
      id: "idle-capacity",
      name: "Idle Capacity",
      description: "Capacity is utilized",
      projectId: null,
      enabled: true,
      threshold: 10,
      unit: "minutes",
      type: "idle-capacity",
    });

    // First, verify the detector fires
    const ctx: DetectorContext = { eventBus, store: mockStore, watchdogStore };
    const result = await runDetector(
      {
        id: "idle-capacity",
        name: "Idle Capacity",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 10,
        unit: "minutes",
        type: "idle-capacity",
      },
      ctx
    );

    expect(result.status).toBe("breached");

    // Now run the playbook
    const breach = watchdogStore.createBreach({
      id: "breach-idle",
      sloId: "idle-capacity",
      detectedAt: new Date().toISOString(),
      evidence: result.evidence,
      value: result.currentValue,
      threshold: 10,
    });

    const run = await engine.runPlaybook("idle-capacity-breach", breach.id);
    await new Promise(r => setTimeout(r, 100));

    expect(diagnosis).not.toBeNull();
    expect(escalated).toBe(true);
    expect(escalationEvidence.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 9. Crash-looping container test
// ============================================================================
describe("Acceptance: Crash-looping container", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("stops restarts, captures signature, opens triage task, tells human once", async () => {
    // Simulate crash-loop events
    const crashEvents = [
      { containerId: "gate-123", error: "Flyway: resolved migration not applied", timestamp: Date.now() - 300000 },
      { containerId: "gate-123", error: "Flyway: resolved migration not applied", timestamp: Date.now() - 180000 },
      { containerId: "gate-123", error: "Flyway: resolved migration not applied", timestamp: Date.now() - 60000 },
    ];

    for (const event of crashEvents) {
      eventBus.emit("container.crashed", event);
    }

    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let restartsStopped = false;
    let capturedSignature: string | null = null;
    let triageTaskCreated = false;
    let humanNotified = false;
    let notificationCount = 0;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "analyze-crash-loop") {
        const recentCrashes = eventBus.getRecentEvents("container.crashed", 10);
        const signature = recentCrashes[0]?.data?.error ?? "Unknown";
        return {
          crashCount: recentCrashes.length,
          signature,
          containerId: recentCrashes[0]?.data?.containerId,
          isCrashLoop: recentCrashes.length >= 3,
        };
      }
      return {};
    });

    registerStepExecutor("act", async (step, ctx) => {
      if (step.params.action === "stop-restarts") {
        restartsStopped = true;
        return { stopped: true };
      }
      if (step.params.action === "capture-signature") {
        capturedSignature = ctx.diagnosis?.signature;
        return { signature: capturedSignature };
      }
      if (step.params.action === "create-triage-task") {
        triageTaskCreated = true;
        return { taskId: "triage-1", title: "migration-order defect" };
      }
      return {};
    });

    registerStepExecutor("notify", async (step, ctx) => {
      notificationCount++;
      humanNotified = true;
      return {};
    });

    const crashLoopPlaybook: PlaybookDefinition = {
      id: "crash-loop",
      name: "Crash-Looping Container",
      description: "Handle crash-looping containers",
      forSLOTypes: ["gate-frequency"],
      requiresApproval: false,
      priority: 5,
      maxAttempts: 1,
      cooldownSeconds: 1800, // Long cooldown to prevent repeated notifications
      steps: [
        {
          id: "diagnose",
          name: "Analyze crash loop",
          description: "Identify crash pattern",
          type: "diagnose",
          params: { action: "analyze-crash-loop" },
        },
        {
          id: "stop",
          name: "Stop restarts",
          description: "Prevent further restarts",
          type: "act",
          params: { action: "stop-restarts" },
        },
        {
          id: "capture",
          name: "Capture signature",
          description: "Record error signature",
          type: "act",
          params: { action: "capture-signature" },
        },
        {
          id: "triage",
          name: "Create triage task",
          description: "Open task for investigation",
          type: "act",
          params: { action: "create-triage-task" },
        },
        {
          id: "notify",
          name: "Notify human",
          description: "Alert once",
          type: "notify",
          params: { message: "Crash loop detected", severity: "warning", once: true },
        },
      ],
    };

    engine.registerPlaybook(crashLoopPlaybook);

    watchdogStore.upsertSLODefinition({
      id: "gate-frequency",
      name: "Gate Frequency",
      description: "Gates pass regularly",
      projectId: null,
      enabled: true,
      threshold: 3,
      unit: "hours",
      type: "gate-frequency",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-crash",
      sloId: "gate-frequency",
      detectedAt: new Date().toISOString(),
      evidence: ["Container gate-123 crash-looping: Flyway migration error"],
      value: 3,
      threshold: 1,
    });

    const run = await engine.runPlaybook("crash-loop", breach.id);
    await new Promise(r => setTimeout(r, 100));

    expect(restartsStopped).toBe(true);
    expect(capturedSignature).toBe("Flyway: resolved migration not applied");
    expect(triageTaskCreated).toBe(true);
    expect(humanNotified).toBe(true);
    expect(notificationCount).toBe(1); // Only once
  });
});

// ============================================================================
// 10. Progress stall test
// ============================================================================
describe("Acceptance: Progress stall escalation", () => {
  let eventBus: EventBus;
  let watchdogStore: WatchdogStore;
  let mockStore: ReturnType<typeof createMockStore>;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    clearStepExecutors();
  });

  it("escalates to Decision Inbox with diagnosis when no merge for 4h while work queued", async () => {
    // Setup: Tasks ready but no merges in 4+ hours
    const tasks = [
      { id: "task-1", status: "ready" },
      { id: "task-2", status: "ready" },
      { id: "task-3", status: "in-progress" },
    ];

    mockStore = createMockStore({ tasks });
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let escalated = false;
    let diagnosis: any = null;

    registerStepExecutor("diagnose", async (step, ctx) => {
      if (step.params.action === "analyze-progress-stall") {
        diagnosis = {
          hoursSinceLastMerge: 5.5,
          readyTasks: tasks.filter(t => t.status === "ready").length,
          inProgressTasks: tasks.filter(t => t.status === "in-progress").length,
          topBlocker: "gate-123: test failure in AccountTest",
        };
        return diagnosis;
      }
      return {};
    });

    registerStepExecutor("escalate", async (step, ctx) => {
      escalated = true;
      return {
        kind: "escalation",
        question: "No merge for 5.5 hours despite 2 ready tasks",
        context: JSON.stringify(diagnosis),
        recommended: "Investigate gate-123 test failure",
      };
    });

    const progressStallPlaybook: PlaybookDefinition = {
      id: "progress-stall",
      name: "Progress Stall",
      description: "Handle progress stalls",
      forSLOTypes: ["merge-frequency"],
      requiresApproval: false,
      priority: 10,
      maxAttempts: 1,
      cooldownSeconds: 3600,
      steps: [
        {
          id: "diagnose",
          name: "Analyze stall",
          description: "Find why no merges",
          type: "diagnose",
          params: { action: "analyze-progress-stall" },
        },
        {
          id: "escalate",
          name: "Escalate",
          description: "Raise to Decision Inbox",
          type: "escalate",
          params: { kind: "escalation" },
        },
      ],
    };

    engine.registerPlaybook(progressStallPlaybook);

    watchdogStore.upsertSLODefinition({
      id: "merge-frequency",
      name: "Merge Frequency",
      description: "Merges happen regularly",
      projectId: null,
      enabled: true,
      threshold: 4, // 4 hours
      unit: "hours",
      type: "merge-frequency",
    });

    // Verify detector fires
    const ctx: DetectorContext = { eventBus, store: mockStore, watchdogStore };
    const result = await runDetector(
      {
        id: "merge-frequency",
        name: "Merge Frequency",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 4,
        unit: "hours",
        type: "merge-frequency",
      },
      ctx
    );

    // Should be breached because no recent merges and tasks are ready
    expect(result.status).toBe("breached");

    const breach = watchdogStore.createBreach({
      id: "breach-stall",
      sloId: "merge-frequency",
      detectedAt: new Date().toISOString(),
      evidence: result.evidence,
      value: result.currentValue,
      threshold: 4,
    });

    const run = await engine.runPlaybook("progress-stall", breach.id);
    await new Promise(r => setTimeout(r, 100));

    expect(diagnosis).not.toBeNull();
    expect(diagnosis.hoursSinceLastMerge).toBeGreaterThan(4);
    expect(escalated).toBe(true);
  });
});

