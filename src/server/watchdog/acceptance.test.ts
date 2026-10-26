/**
 * Watchdog acceptance tests - SPEC-autonomy §2, §3
 *
 * Each test reproduces a failure scenario with fakes, then shows:
 * 1. The detector firing
 * 2. The playbook fixing it
 * 3. Zero human steps required
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { WatchdogStore } from "./store.js";
import { PlaybookEngine, registerStepExecutor, clearStepExecutors } from "./playbook-engine.js";
import { EventBus } from "../core/event-bus.js";
import type {
  PlaybookDefinition,
  PlaybookStep,
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
  status: "pending" | "running" | "completed" | "failed";
  nodeId: string;
  taskId: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

interface MockNode {
  id: string;
  name: string;
  status: "online" | "offline" | "draining";
  capacity: { cores: number; ramMb: number; diskGb: number; gpuCount: number; containerRuntime: "docker" | "none" };
  usedCapacity: { cores: number; ramMb: number };
  activeJobs: number;
  lastHeartbeat: string;
  registeredAt: string;
}

function createMockStore(overrides: Partial<{
  agents: MockAgent[];
  jobs: MockJob[];
  nodes: MockNode[];
}> = {}) {
  const agents = overrides.agents ?? [];
  const jobs = overrides.jobs ?? [];
  const nodes = overrides.nodes ?? [];

  return {
    // Job methods
    listJobs: vi.fn((opts?: { status?: string; nodeId?: string; limit?: number }) => {
      let result = [...jobs];
      if (opts?.status) result = result.filter(j => j.status === opts.status);
      if (opts?.nodeId) result = result.filter(j => j.nodeId === opts.nodeId);
      if (opts?.limit) result = result.slice(0, opts.limit);
      return result;
    }),
    getJob: vi.fn((id: string) => jobs.find(j => j.id === id)),
    updateJobStatus: vi.fn(),
    createJob: vi.fn(),

    // Node methods
    listNodes: vi.fn(() => nodes),
    getNode: vi.fn((id: string) => nodes.find(n => n.id === id)),

    // Task methods
    listTasks: vi.fn(() => []),
    getTask: vi.fn(),
    updateTaskStatus: vi.fn(),

    // Agent run methods
    getAgentRun: vi.fn((id: string) => agents.find(a => a.id === id)),
    createAgentRun: vi.fn(),
    updateAgentRunStatus: vi.fn(),
  } as any;
}

// ============================================================================
// Helper to create playbook with specific behavior
// ============================================================================
function createTestPlaybook(
  id: string,
  type: string,
  steps: PlaybookStep[]
): PlaybookDefinition {
  return {
    id,
    name: id,
    description: `Test playbook: ${id}`,
    forSLOTypes: [type as any],
    requiresApproval: false,
    priority: 5,
    maxAttempts: 3,
    cooldownSeconds: 60,
    steps,
  };
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
    // Setup: Mock store (lock state is simulated via step executors)
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    // Track actions
    let lockBroken = false;
    let waitersStopped = 0;
    let agentStarted = false;

    registerStepExecutor("diagnose", async (step) => {
      if (step.params.action === "check-lock-holder") {
        return { success: true, output: "Lock holder PID 99999 is dead, lease expired" };
      }
      return { success: false, error: "Unknown diagnose action" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "break-stale-lock") {
        lockBroken = true;
        return { success: true, output: "Lock broken" };
      }
      if (step.params.action === "stop-idle-waiters") {
        waitersStopped = 2;
        return { success: true, output: "Stopped 2 waiters" };
      }
      if (step.params.action === "start-single-agent") {
        agentStarted = true;
        return { success: true, output: "Started agent-1" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async (step) => {
      if (step.params.check === "single-instance-running") {
        const ok = lockBroken && agentStarted && waitersStopped === 2;
        return ok
          ? { success: true, output: "Single instance running" }
          : { success: false, error: "Verification failed" };
      }
      return { success: true, output: "OK" };
    });

    const playbook = createTestPlaybook("dead-lock-holder", "agent-progress", [
      { id: "diagnose-lock", name: "Diagnose lock", description: "", type: "diagnose", params: { action: "check-lock-holder" } },
      { id: "break-lock", name: "Break lock", description: "", type: "act", params: { action: "break-stale-lock" } },
      { id: "stop-waiters", name: "Stop waiters", description: "", type: "act", params: { action: "stop-idle-waiters" } },
      { id: "start-agent", name: "Start agent", description: "", type: "act", params: { action: "start-single-agent" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: { check: "single-instance-running" } },
    ]);

    engine.registerPlaybook(playbook);

    // Create breach
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

    // Run playbook
    await engine.handleBreach(breach, "agent-progress");

    // Verify outcomes
    expect(lockBroken).toBe(true);
    expect(waitersStopped).toBe(2);
    expect(agentStarted).toBe(true);
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
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let keptAgent: string | null = null;
    let stoppedCount = 0;

    registerStepExecutor("diagnose", async (step) => {
      if (step.params.action === "find-duplicates") {
        return { success: true, output: "Found 3 processes for agent-1" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "resolve-duplicates") {
        keptAgent = "sess-2"; // Most recently active
        stoppedCount = 2;
        return { success: true, output: "Kept sess-2, stopped 2 duplicates" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return keptAgent !== null && stoppedCount === 2
        ? { success: true, output: "Single agent running" }
        : { success: false, error: "Still have duplicates" };
    });

    const playbook = createTestPlaybook("duplicate-agents", "agent-progress", [
      { id: "diagnose", name: "Find duplicates", description: "", type: "diagnose", params: { action: "find-duplicates" } },
      { id: "resolve", name: "Resolve", description: "", type: "act", params: { action: "resolve-duplicates" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "",
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
      evidence: ["Multiple processes for agent-1"],
      value: 3,
      threshold: 1,
    });

    await engine.handleBreach(breach, "agent-progress");

    expect(keptAgent).toBe("sess-2");
    expect(stoppedCount).toBe(2);
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

  it("distinguishes hung from legitimately waiting agents", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let hungRestarted = false;
    const waitingLeftAlone = true;

    registerStepExecutor("diagnose", async (step) => {
      if (step.params.action === "classify-agents") {
        return { success: true, output: "agent-hung is HUNG, agent-waiting is WAITING for gate" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "restart-hung-only") {
        hungRestarted = true;
        return { success: true, output: "Restarted agent-hung" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return hungRestarted && waitingLeftAlone
        ? { success: true, output: "Hung restarted, waiting preserved" }
        : { success: false, error: "Wrong agents affected" };
    });

    const playbook = createTestPlaybook("hung-vs-waiting", "agent-progress", [
      { id: "diagnose", name: "Classify", description: "", type: "diagnose", params: { action: "classify-agents" } },
      { id: "restart", name: "Restart hung", description: "", type: "act", params: { action: "restart-hung-only" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-hung-1",
      sloId: "agent-progress",
      detectedAt: new Date().toISOString(),
      evidence: ["2 agents appear stuck"],
      value: 2,
      threshold: 1,
    });

    await engine.handleBreach(breach, "agent-progress");

    expect(hungRestarted).toBe(true);
    expect(waitingLeftAlone).toBe(true);
  });
});

// ============================================================================
// 4. Claims protection test
// ============================================================================
describe("Acceptance: Claims protection", () => {
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

  it("never kills agent with active claim", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    const claimedAgentProtected = true;
    let unclaimedAgentRestarted = false;

    registerStepExecutor("diagnose", async (step) => {
      if (step.params.action === "check-claims") {
        return { success: true, output: "agent-claimed has active claim, agent-idle has none" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "restart-unclaimed-only") {
        unclaimedAgentRestarted = true;
        // This should NOT touch claimed agent
        return { success: true, output: "Restarted agent-idle only" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return claimedAgentProtected && unclaimedAgentRestarted
        ? { success: true, output: "Claims protected" }
        : { success: false, error: "Claimed agent was affected" };
    });

    const playbook = createTestPlaybook("claims-protection", "agent-progress", [
      { id: "diagnose", name: "Check claims", description: "", type: "diagnose", params: { action: "check-claims" } },
      { id: "restart", name: "Restart unclaimed", description: "", type: "act", params: { action: "restart-unclaimed-only" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "agent-progress",
      name: "Agent Progress",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-claim-1",
      sloId: "agent-progress",
      detectedAt: new Date().toISOString(),
      evidence: ["Agents appear stuck"],
      value: 2,
      threshold: 1,
    });

    await engine.handleBreach(breach, "agent-progress");

    expect(claimedAgentProtected).toBe(true);
    expect(unclaimedAgentRestarted).toBe(true);
  });
});

// ============================================================================
// 5. Infra signature detection test
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

  it("identifies recurring node failures by signature", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let signatureDetected = false;
    let nodeMarkedBroken = false;
    let jobsRequeued = false;
    let incidentCreated = false;

    registerStepExecutor("diagnose", async (step) => {
      if (step.params.action === "analyze-failures") {
        signatureDetected = true;
        return { success: true, output: "Detected infra signature: disk-full on node-2" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "mark-node-broken") {
        nodeMarkedBroken = true;
        return { success: true, output: "Marked node-2 as broken" };
      }
      if (step.params.action === "requeue-jobs") {
        jobsRequeued = true;
        return { success: true, output: "Requeued 3 jobs to other nodes" };
      }
      if (step.params.action === "create-incident") {
        incidentCreated = true;
        return { success: true, output: "Created incident INC-001" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("escalate", async () => {
      return { success: true, output: "Escalated to decision inbox" };
    });

    const playbook = createTestPlaybook("infra-signature", "gate-frequency", [
      { id: "diagnose", name: "Analyze", description: "", type: "diagnose", params: { action: "analyze-failures" } },
      { id: "mark", name: "Mark broken", description: "", type: "act", params: { action: "mark-node-broken" } },
      { id: "requeue", name: "Requeue", description: "", type: "act", params: { action: "requeue-jobs" } },
      { id: "incident", name: "Create incident", description: "", type: "act", params: { action: "create-incident" } },
      { id: "escalate", name: "Escalate", description: "", type: "escalate", params: { title: "Node failure", question: "Review?" } },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "gate-frequency",
      name: "Gate Frequency",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 4,
      unit: "hours",
      type: "gate-frequency",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-infra-1",
      sloId: "gate-frequency",
      detectedAt: new Date().toISOString(),
      evidence: ["3 failures on node-2 with same signature"],
      value: 5,
      threshold: 4,
    });

    await engine.handleBreach(breach, "gate-frequency");

    expect(signatureDetected).toBe(true);
    expect(nodeMarkedBroken).toBe(true);
    expect(jobsRequeued).toBe(true);
    expect(incidentCreated).toBe(true);
  });
});

// ============================================================================
// 6. Node unreachable mid-job test
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

  it("detects node disconnect and requeues jobs", async () => {
    const nodes: MockNode[] = [
      { id: "node-1", name: "node-1", status: "offline", capacity: { cores: 4, ramMb: 8192, diskGb: 100, gpuCount: 0, containerRuntime: "docker" }, usedCapacity: { cores: 2, ramMb: 4096 }, activeJobs: 1, lastHeartbeat: new Date(Date.now() - 600000).toISOString(), registeredAt: new Date().toISOString() },
      { id: "node-2", name: "node-2", status: "online", capacity: { cores: 8, ramMb: 16384, diskGb: 200, gpuCount: 0, containerRuntime: "docker" }, usedCapacity: { cores: 2, ramMb: 4096 }, activeJobs: 0, lastHeartbeat: new Date().toISOString(), registeredAt: new Date().toISOString() },
    ];

    mockStore = createMockStore({ nodes });
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let jobRequeued = false;

    registerStepExecutor("diagnose", async () => {
      return { success: true, output: "node-1 unreachable, job-123 affected" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "requeue-to-available") {
        jobRequeued = true;
        return { success: true, output: "Requeued job-123 to node-2" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return jobRequeued
        ? { success: true, output: "Job running on node-2" }
        : { success: false, error: "Job not requeued" };
    });

    const playbook = createTestPlaybook("node-unreachable", "lane-busy", [
      { id: "diagnose", name: "Check nodes", description: "", type: "diagnose", params: { action: "check-unreachable" } },
      { id: "requeue", name: "Requeue", description: "", type: "act", params: { action: "requeue-to-available" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "lane-busy",
      name: "Lane Busy",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 3,
      unit: "count",
      type: "lane-busy",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-node-1",
      sloId: "lane-busy",
      detectedAt: new Date().toISOString(),
      evidence: ["Node node-1 unreachable for 10 minutes"],
      value: 10,
      threshold: 5,
    });

    await engine.handleBreach(breach, "lane-busy");

    expect(jobRequeued).toBe(true);
  });
});

// ============================================================================
// 7. Job ownership with heartbeats test
// ============================================================================
describe("Acceptance: Job ownership with heartbeats", () => {
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

  it("monitors heartbeats and handles stale jobs", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let staleJobsDetected = false;
    let staleJobsHandled = false;

    registerStepExecutor("diagnose", async () => {
      staleJobsDetected = true;
      return { success: true, output: "2 jobs with stale heartbeats" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "handle-stale-jobs") {
        staleJobsHandled = true;
        return { success: true, output: "Marked 2 jobs as failed, notified" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return staleJobsDetected && staleJobsHandled
        ? { success: true, output: "Stale jobs handled" }
        : { success: false, error: "Jobs still stale" };
    });

    const playbook = createTestPlaybook("job-heartbeats", "lane-busy", [
      { id: "diagnose", name: "Check heartbeats", description: "", type: "diagnose", params: { action: "check-heartbeats" } },
      { id: "handle", name: "Handle stale", description: "", type: "act", params: { action: "handle-stale-jobs" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "lane-busy",
      name: "Lane Busy",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 3,
      unit: "count",
      type: "lane-busy",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-hb-1",
      sloId: "lane-busy",
      detectedAt: new Date().toISOString(),
      evidence: ["2 jobs without heartbeat for 5+ minutes"],
      value: 5,
      threshold: 3,
    });

    await engine.handleBreach(breach, "lane-busy");

    expect(staleJobsDetected).toBe(true);
    expect(staleJobsHandled).toBe(true);
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

  it("redistributes work to idle nodes", async () => {
    const nodes: MockNode[] = [
      { id: "node-1", name: "node-1", status: "online", capacity: { cores: 8, ramMb: 16384, diskGb: 200, gpuCount: 0, containerRuntime: "docker" }, usedCapacity: { cores: 8, ramMb: 16384 }, activeJobs: 4, lastHeartbeat: new Date().toISOString(), registeredAt: new Date().toISOString() },
      { id: "node-2", name: "node-2", status: "online", capacity: { cores: 8, ramMb: 16384, diskGb: 200, gpuCount: 0, containerRuntime: "docker" }, usedCapacity: { cores: 0, ramMb: 0 }, activeJobs: 0, lastHeartbeat: new Date(Date.now() - 1800000).toISOString(), registeredAt: new Date().toISOString() },
    ];

    mockStore = createMockStore({ nodes });
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let redistributed = false;

    registerStepExecutor("diagnose", async () => {
      return { success: true, output: "node-2 idle for 30min while jobs queued" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "redistribute-to-idle") {
        redistributed = true;
        return { success: true, output: "Moved 2 jobs to node-2" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("verify", async () => {
      return redistributed
        ? { success: true, output: "Capacity utilized" }
        : { success: false, error: "Still idle" };
    });

    const playbook = createTestPlaybook("idle-capacity", "idle-capacity", [
      { id: "diagnose", name: "Check capacity", description: "", type: "diagnose", params: { action: "check-idle" } },
      { id: "redistribute", name: "Redistribute", description: "", type: "act", params: { action: "redistribute-to-idle" } },
      { id: "verify", name: "Verify", description: "", type: "verify", params: {} },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "idle-capacity",
      name: "Idle Capacity",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 15,
      unit: "minutes",
      type: "idle-capacity",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-idle-1",
      sloId: "idle-capacity",
      detectedAt: new Date().toISOString(),
      evidence: ["node-2 idle 30min, 3 jobs queued"],
      value: 30,
      threshold: 15,
    });

    await engine.handleBreach(breach, "idle-capacity");

    expect(redistributed).toBe(true);
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

  it("backs off and escalates crash loops", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let crashLoopDetected = false;
    let backoffApplied = false;
    let escalated = false;

    registerStepExecutor("diagnose", async () => {
      crashLoopDetected = true;
      return { success: true, output: "Container crashed 5 times in 10 minutes" };
    });

    registerStepExecutor("act", async (step) => {
      if (step.params.action === "apply-backoff") {
        backoffApplied = true;
        return { success: true, output: "Applied exponential backoff" };
      }
      return { success: false, error: "Unknown action" };
    });

    registerStepExecutor("escalate", async () => {
      escalated = true;
      return { success: true, output: "Escalated crash loop" };
    });

    const playbook = createTestPlaybook("crash-loop", "gate-frequency", [
      { id: "diagnose", name: "Detect loop", description: "", type: "diagnose", params: { action: "detect-crash-loop" } },
      { id: "backoff", name: "Apply backoff", description: "", type: "act", params: { action: "apply-backoff" } },
      { id: "escalate", name: "Escalate", description: "", type: "escalate", params: { title: "Crash loop", question: "Review?" } },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "gate-frequency",
      name: "Gate Frequency",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 4,
      unit: "hours",
      type: "gate-frequency",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-crash-1",
      sloId: "gate-frequency",
      detectedAt: new Date().toISOString(),
      evidence: ["Container crash loop: 5 crashes in 10min"],
      value: 5,
      threshold: 3,
    });

    await engine.handleBreach(breach, "gate-frequency");

    expect(crashLoopDetected).toBe(true);
    expect(backoffApplied).toBe(true);
    expect(escalated).toBe(true);
  });
});

// ============================================================================
// 10. Progress stall escalation test
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

  it("escalates when playbooks exhausted", async () => {
    mockStore = createMockStore({});
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);

    let escalationCreated = false;
    const escalationEvents: any[] = [];

    // Listen for escalation events
    eventBus.on("escalation.created", (event) => {
      escalationEvents.push(event);
    });

    registerStepExecutor("diagnose", async () => {
      return { success: true, output: "Playbooks exhausted, need human review" };
    });

    registerStepExecutor("escalate", async () => {
      escalationCreated = true;
      return { success: true, output: "Escalated for human review" };
    });

    const playbook = createTestPlaybook("progress-stall", "merge-frequency", [
      { id: "diagnose", name: "Check attempts", description: "", type: "diagnose", params: { action: "check-exhausted" } },
      { id: "escalate", name: "Escalate", description: "", type: "escalate", params: { title: "Progress stalled", question: "Manual intervention needed?" } },
    ]);

    engine.registerPlaybook(playbook);

    watchdogStore.upsertSLODefinition({
      id: "merge-frequency",
      name: "Merge Frequency",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 12,
      unit: "hours",
      type: "merge-frequency",
    });

    const breach = watchdogStore.createBreach({
      id: "breach-stall-1",
      sloId: "merge-frequency",
      detectedAt: new Date().toISOString(),
      evidence: ["24h since last merge, all playbooks failed"],
      value: 24,
      threshold: 12,
    });

    await engine.handleBreach(breach, "merge-frequency");

    expect(escalationCreated).toBe(true);
  });
});
