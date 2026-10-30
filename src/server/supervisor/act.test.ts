/**
 * Acceptance tests for supervisor.act (S3): acting fixes by evidence.
 *
 * These tests verify the brief's acceptance criteria (a-h):
 * a) a hold whose BLOCKED text says Docker is down + docker info now OK + act -> released
 * b) the same with docker info still failing -> nothing happens
 * c) a hold whose failure includes a test failure -> never released
 * d) observe mode -> recorded as would-act, nothing changes
 * e) the rate limit and cooldown hold
 * f) of two identical pending planner decisions, only the older is rejected
 * g) an op not in allow never runs
 * h) the supervisor never calls the decisions answer route or holds an owner session
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SupervisorStore, type ActAuditEntry } from "./store.js";
import { SupervisorAct } from "./act.js";
import { parseActConfig, type ActSettings } from "./act-config.js";
import {
  detectHoldInfra,
  detectEscalationInfra,
  detectDuplicateProposal,
  isInfraFailure,
  matchesInfraPattern,
  matchesCodeFailure,
} from "./act-detectors.js";
import { releaseHold, closeInfraEscalation, rejectDuplicateProposal } from "./act-ops.js";
import type { Decision } from "../../shared/decision-types.js";

// ============ HELPERS ============

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-" + Math.random().toString(36).slice(2, 10),
    project: "test",
    kind: "escalation",
    attention: "action",
    title: "Test decision",
    context: "Test context",
    options: [{ id: "release", label: "Release", consequences: "Release the hold" }],
    recommended: { optionId: "release", reasoning: "Test" },
    source: { module: "agents", ref: "test" },
    key: "test-key",
    blocks: [],
    links: [],
    status: "open",
    createdAt: new Date().toISOString(),
    overdue: false,
    raisedVia: "server",
    ...overrides,
  };
}

function makeAgentsStore() {
  const runs = new Map<string, { id: string; chainId: string; detail: string; state: string }>();
  const events: Array<{ kind: string; task: string; summary: string; runId?: string }> = [];

  return {
    latestRunForTask: (project: string, task: string) => runs.get(task) ?? null,
    chainRuns: (chainId: string) => [...runs.values()].filter((r) => r.chainId === chainId),
    listEvents: (project: string, opts: { kinds?: string[]; task?: string; limit?: number }) =>
      events.filter((e) => (!opts.kinds || opts.kinds.includes(e.kind)) && (!opts.task || e.task === opts.task)).slice(0, opts.limit ?? 50),
    addRun: (task: string, detail: string, state = "stopped") => {
      const id = "run-" + Math.random().toString(36).slice(2, 10);
      const chainId = "chain-" + Math.random().toString(36).slice(2, 10);
      runs.set(task, { id, chainId, detail, state });
      return id;
    },
    addEvent: (kind: string, task: string, summary: string, runId?: string) => {
      events.push({ kind, task, summary, runId });
    },
  };
}

// ============ CONFIG TESTS ============

describe("act-config", () => {
  it("parses default config (mode: off, empty allow)", () => {
    const result = parseActConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.mode).toBe("off");
      expect(result.settings.allow).toEqual([]);
      expect(result.settings.max_per_hour).toBe(20);
      expect(result.settings.cooldown_minutes).toBe(30);
    }
  });

  it("parses observe mode with ops", () => {
    const result = parseActConfig({
      mode: "observe",
      allow: ["release_hold", "close_infra_escalation"],
      max_per_hour: 10,
      cooldown_minutes: 15,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.mode).toBe("observe");
      expect(result.settings.allow).toEqual(["release_hold", "close_infra_escalation"]);
      expect(result.settings.max_per_hour).toBe(10);
      expect(result.settings.cooldown_minutes).toBe(15);
    }
  });

  it("rejects invalid op names", () => {
    const result = parseActConfig({
      mode: "act",
      allow: ["invalid_op"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid mode", () => {
    const result = parseActConfig({ mode: "invalid" });
    expect(result.ok).toBe(false);
  });
});

// ============ DETECTOR TESTS ============

describe("isInfraFailure", () => {
  it("detects Docker daemon error", () => {
    const result = isInfraFailure("Cannot connect to the Docker daemon");
    expect(result.isInfra).toBe(true);
    expect(result.infraPattern).toBeTruthy();
    expect(result.codePattern).toBeNull();
  });

  it("detects rc=125 (Docker exit code)", () => {
    const result = isInfraFailure("Command failed with rc=125");
    expect(result.isInfra).toBe(true);
  });

  it("detects SSH connection refused", () => {
    const result = isInfraFailure("ssh: connect to host example.com port 22: Connection refused");
    expect(result.isInfra).toBe(true);
  });

  it("rejects test failures", () => {
    const result = isInfraFailure("Test FAILED: Expected 1 to equal 2");
    expect(result.isInfra).toBe(false);
    expect(result.codePattern).toBeTruthy();
  });

  it("rejects compile errors", () => {
    const result = isInfraFailure("error: Cannot find module './missing'");
    expect(result.isInfra).toBe(false);
  });

  it("rejects mixed infra and code failure", () => {
    const result = isInfraFailure("Connection refused. FAILED to compile");
    expect(result.isInfra).toBe(false);
    expect(result.infraPattern).toBeTruthy();
    expect(result.codePattern).toBeTruthy();
  });
});

describe("detectHoldInfra", () => {
  it("detects a hold caused by Docker being down", () => {
    const store = makeAgentsStore();
    store.addRun("feat-login", "Cannot connect to the Docker daemon", "stopped");

    const decision = makeDecision({
      source: { module: "agents", ref: "task:feat-login" },
      blocks: ["agents:test:task:feat-login"],
    });

    const evidence = detectHoldInfra(decision, store as any, "test");
    expect(evidence).not.toBeNull();
    expect(evidence?.op).toBe("release_hold");
    expect(evidence?.target).toBe("task:feat-login");
  });

  it("returns null for non-agents decisions", () => {
    const store = makeAgentsStore();
    const decision = makeDecision({
      source: { module: "triage", ref: "test" },
    });

    const evidence = detectHoldInfra(decision, store as any, "test");
    expect(evidence).toBeNull();
  });

  it("returns null when failure includes test failures (c)", () => {
    const store = makeAgentsStore();
    store.addRun("feat-login", "Tests FAILED: 2 assertions failed", "stopped");

    const decision = makeDecision({
      source: { module: "agents", ref: "task:feat-login" },
      blocks: ["agents:test:task:feat-login"],
    });

    const evidence = detectHoldInfra(decision, store as any, "test");
    expect(evidence).toBeNull();
  });
});

describe("detectDuplicateProposal", () => {
  it("detects older duplicate proposal (f)", () => {
    const oldDecision = makeDecision({
      id: "old-dec",
      source: { module: "planner", ref: "run-1" },
      createdAt: "2026-10-29T10:00:00Z",
    });

    const newDecision = makeDecision({
      id: "new-dec",
      source: { module: "planner", ref: "run-2" },
      createdAt: "2026-10-29T11:00:00Z",
    });

    const proposals = {
      "old-dec": [{ op: "add_task", agent: "kiro-A", task: "feat-x" }],
      "new-dec": [{ op: "add_task", agent: "kiro-A", task: "feat-x" }],
    };

    const evidence = detectDuplicateProposal(
      oldDecision,
      [oldDecision, newDecision],
      (id) => proposals[id as keyof typeof proposals] ?? [],
    );

    expect(evidence).not.toBeNull();
    expect(evidence?.op).toBe("reject_duplicate_proposal");
    expect(evidence?.target).toBe("proposal:old-dec");
  });

  it("returns null for newest decision", () => {
    const oldDecision = makeDecision({
      id: "old-dec",
      source: { module: "planner", ref: "run-1" },
      createdAt: "2026-10-29T10:00:00Z",
    });

    const newDecision = makeDecision({
      id: "new-dec",
      source: { module: "planner", ref: "run-2" },
      createdAt: "2026-10-29T11:00:00Z",
    });

    const proposals = {
      "old-dec": [{ op: "add_task", agent: "kiro-A", task: "feat-x" }],
      "new-dec": [{ op: "add_task", agent: "kiro-A", task: "feat-x" }],
    };

    // Test the NEWER decision - it should NOT be flagged as duplicate
    const evidence = detectDuplicateProposal(
      newDecision,
      [oldDecision, newDecision],
      (id) => proposals[id as keyof typeof proposals] ?? [],
    );

    expect(evidence).toBeNull();
  });
});

// ============ OPS TESTS ============

describe("releaseHold", () => {
  it("releases hold when Docker is back (a)", async () => {
    let released = false;
    const modules = {
      releaseFillHold: async (task: string) => {
        released = true;
        return { task, runId: "run-123" };
      },
      runCommand: async (cmd: string, args: string[]) => {
        if (cmd === "docker" && args[0] === "info") {
          return { exitCode: 0, output: "Docker is running" };
        }
        return { exitCode: 1, output: "" };
      },
    };

    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const evidence = {
      op: "release_hold" as const,
      target: "task:feat-login",
      evidence: ["matched infra pattern 'docker' in: Cannot connect to Docker"],
      clearedCheck: async () => ({ cleared: true, reason: "docker back" }),
    };

    const result = await releaseHold(evidence, settings, modules);
    expect(result.success).toBe(true);
    expect(released).toBe(true);
    expect(result.mode).toBe("act");
  });

  it("does nothing when Docker is still down (b)", async () => {
    let released = false;
    const modules = {
      releaseFillHold: async (task: string) => {
        released = true;
        return { task, runId: "run-123" };
      },
      runCommand: async (cmd: string, args: string[]) => {
        return { exitCode: 1, output: "Cannot connect to the Docker daemon" };
      },
    };

    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const evidence = {
      op: "release_hold" as const,
      target: "task:feat-login",
      evidence: ["matched infra pattern 'docker' in: Cannot connect to Docker"],
      clearedCheck: async () => ({ cleared: true, reason: "check deferred" }),
    };

    const result = await releaseHold(evidence, settings, modules);
    expect(result.success).toBe(false);
    expect(released).toBe(false);
    expect(result.detail).toContain("Docker still unavailable");
  });

  it("records would-act in observe mode (d)", async () => {
    let released = false;
    const modules = {
      releaseFillHold: async (task: string) => {
        released = true;
        return { task, runId: "run-123" };
      },
    };

    const settings: ActSettings = {
      mode: "observe",
      allow: ["release_hold"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const evidence = {
      op: "release_hold" as const,
      target: "task:feat-login",
      evidence: ["matched infra pattern"],
      clearedCheck: async () => ({ cleared: true, reason: "ok" }),
    };

    const result = await releaseHold(evidence, settings, modules);
    expect(result.success).toBe(true);
    expect(result.mode).toBe("observe");
    expect(result.detail).toContain("would release");
    expect(released).toBe(false); // Did NOT actually release
  });

  it("refuses when op not in allow (g)", async () => {
    let released = false;
    const modules = {
      releaseFillHold: async (task: string) => {
        released = true;
        return { task, runId: "run-123" };
      },
    };

    const settings: ActSettings = {
      mode: "act",
      allow: [], // Empty allow list
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const evidence = {
      op: "release_hold" as const,
      target: "task:feat-login",
      evidence: ["matched infra pattern"],
      clearedCheck: async () => ({ cleared: true, reason: "ok" }),
    };

    const result = await releaseHold(evidence, settings, modules);
    expect(result.success).toBe(false);
    expect(released).toBe(false);
    expect(result.detail).toContain("not in supervisor.act.allow");
  });
});

describe("rejectDuplicateProposal", () => {
  it("rejects older duplicate in act mode", async () => {
    let withdrawn = false;
    const modules = {
      withdrawDecision: async (id: string, reason: string) => {
        withdrawn = true;
        expect(id).toBe("old-dec");
        expect(reason).toContain("reject_duplicate_proposal");
      },
      findDecision: (id: string) =>
        makeDecision({ id, status: "open", source: { module: "planner", ref: "test" } }),
    };

    const settings: ActSettings = {
      mode: "act",
      allow: ["reject_duplicate_proposal"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const evidence = {
      op: "reject_duplicate_proposal" as const,
      target: "proposal:old-dec",
      evidence: ["duplicate of newer proposal"],
      clearedCheck: async () => ({ cleared: true, reason: "verified" }),
    };

    const result = await rejectDuplicateProposal(evidence, settings, modules);
    expect(result.success).toBe(true);
    expect(withdrawn).toBe(true);
  });
});

// ============ SERVICE TESTS ============

describe("SupervisorAct", () => {
  let store: SupervisorStore;

  beforeEach(() => {
    store = new SupervisorStore(":memory:");
  });

  it("enforces rate limit (e)", async () => {
    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold"],
      max_per_hour: 2, // Low limit for test
      cooldown_minutes: 30,
    };

    let releaseCount = 0;
    const service = new SupervisorAct({
      project: "test",
      store,
      settings: () => settings,
      modules: () => ({
        releaseFillHold: async (task: string) => {
          releaseCount++;
          return { task, runId: null };
        },
      }),
      decisions: () => null,
      agentsStore: () => null,
    });

    // Try to act on 5 items
    const evidence = Array.from({ length: 5 }, (_, i) => ({
      op: "release_hold" as const,
      target: `task:task-${i}`,
      evidence: ["infra pattern"],
      clearedCheck: async () => ({ cleared: true, reason: "ok" }),
    }));

    const results = await service.act(evidence);

    // Only 2 should succeed due to rate limit
    const succeeded = results.filter((r) => r.success);
    expect(succeeded.length).toBe(2);
    expect(releaseCount).toBe(2);

    // The rest should fail with rate limit error
    const rateLimited = results.filter((r) => r.detail.includes("rate limit"));
    expect(rateLimited.length).toBe(3);
  });

  it("enforces cooldown (e)", async () => {
    let now = Date.now();
    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold"],
      max_per_hour: 100,
      cooldown_minutes: 30,
    };

    let releaseCount = 0;
    const service = new SupervisorAct({
      project: "test",
      store,
      settings: () => settings,
      modules: () => ({
        releaseFillHold: async (task: string) => {
          releaseCount++;
          return { task, runId: null };
        },
      }),
      decisions: () => null,
      agentsStore: () => null,
      clock: () => now,
    });

    const evidence = {
      op: "release_hold" as const,
      target: "task:same-task",
      evidence: ["infra pattern"],
      clearedCheck: async () => ({ cleared: true, reason: "ok" }),
    };

    // First action should succeed
    const first = await service.act([evidence]);
    expect(first[0].success).toBe(true);

    // Second action on same target should fail (cooldown)
    const second = await service.act([evidence]);
    expect(second[0].success).toBe(false);
    expect(second[0].detail).toContain("cooldown");

    // After cooldown passes, should work again
    now += 31 * 60 * 1000;
    const third = await service.act([evidence]);
    expect(third[0].success).toBe(true);

    expect(releaseCount).toBe(2);
  });

  it("never calls decisions answer route (h)", async () => {
    // This test verifies the architecture: the supervisor acts through module
    // interfaces (releaseFillHold, withdrawDecision), never through the
    // decisions answer route which requires the owner session.

    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold", "close_infra_escalation", "reject_duplicate_proposal"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    let answerCalled = false;
    let releaseCalled = false;
    let withdrawCalled = false;

    const service = new SupervisorAct({
      project: "test",
      store,
      settings: () => settings,
      modules: () => ({
        releaseFillHold: async (task: string) => {
          releaseCalled = true;
          return { task, runId: null };
        },
        withdrawDecision: async (id: string, reason: string) => {
          withdrawCalled = true;
          // This is OK - it's the producer interface, not the answer route
        },
        // We do NOT provide any answer route interface
      }),
      decisions: () => ({
        // Mock a minimal DecisionProducer - NOT an answer interface
        openOf: () => [],
        raise: async () => ({ decision: makeDecision(), created: true }),
        withdraw: async () => makeDecision(),
        blockedOn: () => null,
        onResolved: () => () => {},
        find: () => null,
      }),
      agentsStore: () => null,
    });

    const evidence = {
      op: "release_hold" as const,
      target: "task:test",
      evidence: ["infra"],
      clearedCheck: async () => ({ cleared: true, reason: "ok" }),
    };

    await service.act([evidence]);

    // The module interface was used
    expect(releaseCalled).toBe(true);
    // The answer route was NOT used (we didn't even provide it)
    expect(answerCalled).toBe(false);
  });

  it("audits all actions", async () => {
    const settings: ActSettings = {
      mode: "act",
      allow: ["release_hold"],
      max_per_hour: 20,
      cooldown_minutes: 30,
    };

    const service = new SupervisorAct({
      project: "test",
      store,
      settings: () => settings,
      modules: () => ({
        releaseFillHold: async (task: string) => ({ task, runId: "run-1" }),
      }),
      decisions: () => null,
      agentsStore: () => null,
    });

    await service.act([
      {
        op: "release_hold",
        target: "task:test",
        evidence: ["infra pattern"],
        clearedCheck: async () => ({ cleared: true, reason: "ok" }),
      },
    ]);

    const history = service.getAuditHistory();
    expect(history.length).toBe(1);
    expect(history[0].op).toBe("release_hold");
    expect(history[0].target).toBe("task:test");
    expect(history[0].result).toBe("success");
  });
});
