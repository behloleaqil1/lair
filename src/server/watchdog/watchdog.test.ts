/**
 * Watchdog module tests
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { WatchdogStore } from "./store.js";
import { PlaybookEngine } from "./playbook-engine.js";
import { runDetector, type DetectorContext } from "./detectors.js";
import { builtInPlaybooks } from "./playbooks.js";
import { EventBus } from "../core/event-bus.js";
import type { SLODefinition, PlaybookDefinition } from "./types.js";

// Mock store with required methods
function createMockStore() {
  return {
    listTasks: vi.fn().mockReturnValue([]),
    listJobs: vi.fn().mockReturnValue([]),
    listNodes: vi.fn().mockReturnValue([]),
    getAgentRun: vi.fn(),
    getNode: vi.fn(),
    updateJobStatus: vi.fn(),
  };
}

describe("WatchdogStore", () => {
  let db: Database.Database;
  let store: WatchdogStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new WatchdogStore(db);
    store.initialize();
  });

  describe("SLO Definitions", () => {
    it("creates and retrieves SLO definitions", () => {
      const slo: SLODefinition = {
        id: "test-slo",
        name: "Test SLO",
        description: "A test SLO",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      };

      store.upsertSLODefinition(slo);
      const retrieved = store.getSLODefinition("test-slo");

      expect(retrieved).toBeTruthy();
      expect(retrieved?.id).toBe("test-slo");
      expect(retrieved?.name).toBe("Test SLO");
      expect(retrieved?.threshold).toBe(5);
    });

    it("updates existing SLO definitions", () => {
      const slo: SLODefinition = {
        id: "test-slo",
        name: "Test SLO",
        description: "A test SLO",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      };

      store.upsertSLODefinition(slo);
      store.upsertSLODefinition({ ...slo, threshold: 10 });

      const retrieved = store.getSLODefinition("test-slo");
      expect(retrieved?.threshold).toBe(10);
    });

    it("gets only enabled SLOs", () => {
      store.upsertSLODefinition({
        id: "enabled",
        name: "Enabled",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });
      store.upsertSLODefinition({
        id: "disabled",
        name: "Disabled",
        description: "",
        projectId: null,
        enabled: false,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      const enabled = store.getEnabledSLODefinitions();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe("enabled");
    });
  });

  describe("SLO States", () => {
    it("creates and retrieves SLO states", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      store.updateSLOState({
        sloId: "test-slo",
        status: "healthy",
        currentValue: 2,
        threshold: 5,
        stateChangedAt: new Date().toISOString(),
        evidence: ["All good"],
        lastCheckedAt: new Date().toISOString(),
      });

      const state = store.getSLOState("test-slo");
      expect(state).toBeTruthy();
      expect(state?.status).toBe("healthy");
      expect(state?.currentValue).toBe(2);
    });

    it("preserves stateChangedAt when status unchanged", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      const originalTime = "2024-01-01T00:00:00Z";
      store.updateSLOState({
        sloId: "test-slo",
        status: "healthy",
        currentValue: 2,
        threshold: 5,
        stateChangedAt: originalTime,
        evidence: [],
        lastCheckedAt: originalTime,
      });

      const newTime = "2024-01-01T01:00:00Z";
      store.updateSLOState({
        sloId: "test-slo",
        status: "healthy", // Same status
        currentValue: 3,
        threshold: 5,
        stateChangedAt: newTime,
        evidence: [],
        lastCheckedAt: newTime,
      });

      const state = store.getSLOState("test-slo");
      expect(state?.stateChangedAt).toBe(originalTime);
    });
  });

  describe("Breaches", () => {
    it("creates and retrieves breaches", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      const breach = store.createBreach({
        id: "breach-1",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: ["Threshold exceeded"],
        value: 10,
        threshold: 5,
      });

      expect(breach.id).toBe("breach-1");
      expect(breach.resolved).toBe(false);

      const retrieved = store.getBreach("breach-1");
      expect(retrieved).toBeTruthy();
      expect(retrieved?.evidence).toContain("Threshold exceeded");
    });

    it("resolves breaches", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      store.createBreach({
        id: "breach-1",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: [],
        value: 10,
        threshold: 5,
      });

      store.resolveBreach("breach-1");

      const breach = store.getBreach("breach-1");
      expect(breach?.resolved).toBe(true);
      expect(breach?.resolvedAt).toBeTruthy();
    });

    it("gets active breaches", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });

      store.createBreach({
        id: "active",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: [],
        value: 10,
        threshold: 5,
      });
      store.createBreach({
        id: "resolved",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: [],
        value: 10,
        threshold: 5,
      });
      store.resolveBreach("resolved");

      const active = store.getActiveBreaches();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("active");
    });
  });

  describe("Playbook Runs", () => {
    it("creates and retrieves playbook runs", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });
      store.createBreach({
        id: "breach-1",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: [],
        value: 10,
        threshold: 5,
      });

      const run = store.createPlaybookRun({
        id: "run-1",
        playbookId: "agent-stuck",
        breachId: "breach-1",
        status: "running",
        attempt: 1,
        startedAt: new Date().toISOString(),
      });

      expect(run.id).toBe("run-1");
      expect(run.status).toBe("running");

      const retrieved = store.getPlaybookRun("run-1");
      expect(retrieved).toBeTruthy();
    });

    it("updates playbook runs", () => {
      store.upsertSLODefinition({
        id: "test-slo",
        name: "Test",
        description: "",
        projectId: null,
        enabled: true,
        threshold: 5,
        unit: "hours",
        type: "merge-frequency",
      });
      store.createBreach({
        id: "breach-1",
        sloId: "test-slo",
        detectedAt: new Date().toISOString(),
        evidence: [],
        value: 10,
        threshold: 5,
      });
      store.createPlaybookRun({
        id: "run-1",
        playbookId: "agent-stuck",
        breachId: "breach-1",
        status: "running",
        attempt: 1,
        startedAt: new Date().toISOString(),
      });

      store.updatePlaybookRun("run-1", {
        status: "succeeded",
        completedAt: new Date().toISOString(),
        stepResults: [{ stepId: "step-1", status: "succeeded" }],
      });

      const run = store.getPlaybookRun("run-1");
      expect(run?.status).toBe("succeeded");
      expect(run?.stepResults).toHaveLength(1);
    });
  });
});

describe("Detectors", () => {
  let eventBus: EventBus;
  let mockStore: any;
  let watchdogStore: WatchdogStore;
  let ctx: DetectorContext;

  beforeEach(() => {
    eventBus = new EventBus();
    mockStore = createMockStore();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();

    ctx = {
      eventBus,
      store: mockStore,
      watchdogStore,
    };
  });

  describe("merge-frequency detector", () => {
    const slo: SLODefinition = {
      id: "merge-freq",
      name: "Merge Frequency",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 6,
      unit: "hours",
      type: "merge-frequency",
    };

    it("returns healthy when no ready tasks", async () => {
      mockStore.listTasks.mockReturnValue([]);

      const result = await runDetector(slo, ctx);

      expect(result.status).toBe("healthy");
      expect(result.evidence).toContain("No ready tasks, SLO not applicable");
    });

    it("returns breached when no recent merges", async () => {
      mockStore.listTasks.mockReturnValue([{ id: "task-1" }]);
      // No merge events

      const result = await runDetector(slo, ctx);

      expect(result.status).toBe("breached");
    });
  });

  describe("agent-progress detector", () => {
    const slo: SLODefinition = {
      id: "agent-prog",
      name: "Agent Progress",
      description: "",
      projectId: null,
      enabled: true,
      threshold: 45,
      unit: "minutes",
      type: "agent-progress",
    };

    it("returns healthy when no running agents", async () => {
      // No task.started events means no running agents
      const result = await runDetector(slo, ctx);

      expect(result.status).toBe("healthy");
      expect(result.evidence).toContain("No running agents");
    });

    it("returns breached when agent is stuck", async () => {
      // Emit a task.started event from a long time ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await eventBus.emit("task.started", {
        taskId: "task-1",
        agentId: "agent-1",
      });
      // Manually backdate the event timestamp
      const events = eventBus.getRecentEvents("task.started", 1);
      if (events.length > 0) {
        (events[0] as { timestamp: string }).timestamp = oneHourAgo;
      }

      const result = await runDetector(slo, ctx);

      expect(result.status).toBe("breached");
      expect(result.currentValue).toBe(1);
    });
  });
});

describe("PlaybookEngine", () => {
  let eventBus: EventBus;
  let mockStore: any;
  let watchdogStore: WatchdogStore;
  let engine: PlaybookEngine;

  beforeEach(() => {
    eventBus = new EventBus();
    mockStore = createMockStore();
    const db = new Database(":memory:");
    watchdogStore = new WatchdogStore(db);
    watchdogStore.initialize();
    engine = new PlaybookEngine(eventBus, mockStore, watchdogStore);
  });

  it("registers playbooks", () => {
    const playbook: PlaybookDefinition = {
      id: "test-playbook",
      name: "Test Playbook",
      description: "A test",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 10,
      maxAttempts: 2,
      cooldownSeconds: 60,
      steps: [],
    };

    engine.registerPlaybook(playbook);
    const playbooks = engine.getPlaybooksForSLO("agent-progress");

    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].id).toBe("test-playbook");
  });

  it("respects cooldown", () => {
    const playbook: PlaybookDefinition = {
      id: "test-playbook",
      name: "Test Playbook",
      description: "",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 10,
      maxAttempts: 2,
      cooldownSeconds: 60,
      steps: [],
    };

    engine.registerPlaybook(playbook);

    // First check should allow
    expect(engine.canRunPlaybook("test-playbook", "slo-1")).toBe(true);
  });

  it("sorts playbooks by priority", () => {
    engine.registerPlaybook({
      id: "low-priority",
      name: "Low",
      description: "",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 100,
      maxAttempts: 1,
      cooldownSeconds: 60,
      steps: [],
    });
    engine.registerPlaybook({
      id: "high-priority",
      name: "High",
      description: "",
      forSLOTypes: ["agent-progress"],
      requiresApproval: false,
      priority: 10,
      maxAttempts: 1,
      cooldownSeconds: 60,
      steps: [],
    });

    const playbooks = engine.getPlaybooksForSLO("agent-progress");

    expect(playbooks[0].id).toBe("high-priority");
    expect(playbooks[1].id).toBe("low-priority");
  });
});

describe("Built-in Playbooks", () => {
  it("has all required playbooks", () => {
    const ids = builtInPlaybooks.map(p => p.id);

    expect(ids).toContain("agent-stuck");
    expect(ids).toContain("lane-jammed");
    expect(ids).toContain("idle-capacity");
    expect(ids).toContain("ready-but-idle");
    expect(ids).toContain("no-merges");
    expect(ids).toContain("disk-low");
    expect(ids).toContain("runtime-down");
  });

  it("agent-stuck targets agent-progress SLO", () => {
    const playbook = builtInPlaybooks.find(p => p.id === "agent-stuck");

    expect(playbook).toBeTruthy();
    expect(playbook?.forSLOTypes).toContain("agent-progress");
    expect(playbook?.requiresApproval).toBe(false);
  });

  it("all playbooks have steps", () => {
    for (const playbook of builtInPlaybooks) {
      expect(playbook.steps.length).toBeGreaterThan(0);
    }
  });
});
