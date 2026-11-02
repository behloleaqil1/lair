/**
 * Tests for the bus service.
 *
 * Acceptance tests:
 * 4. whoami shows the run's task from the agents module's claims
 * 5. report for a task the run doesn't hold is refused (routing)
 * 6. send to another agent is refused; send to orchestrator/owner succeeds (routing)
 * 7. inbox returns unread messages in priority order
 * 8. ack succeeds only for your own messages (routing)
 * 9. board shows all tasks and their owners from the agents module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BusService } from "./service.js";
import { BusStore } from "./store.js";
import { newBusToken, hashBusToken, type BusTokenBinding } from "./tokens.js";

describe("BusService", () => {
  let tempDir: string;
  let store: BusStore;

  // Mock claims: task -> agent mapping
  let claims: Map<string, string>;

  // Mock: runId -> claimed task
  const getClaimedTask = (runId: string): string | null => {
    // Find the task claimed by the agent whose run is runId
    // For simplicity, we'll use a direct mapping
    return runTaskMap.get(runId) ?? null;
  };
  let runTaskMap: Map<string, string>;

  // Mock: all claims
  const getAllClaims = () => Array.from(claims.entries()).map(([task, agent]) => ({ task, agent }));

  // Mock: known agents
  const knownAgents = ["worker-a", "worker-b", "worker-c", "orchestrator", "owner"];
  const getKnownAgents = () => knownAgents;

  let service: BusService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-service-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new BusStore("test-project", dbPath);
    claims = new Map();
    runTaskMap = new Map();
    service = new BusService({
      store,
      getClaimedTask,
      getAllClaims,
      getKnownAgents,
    });
  });

  afterEach(() => {
    store.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  function issueToken(agent: string, runId: string): BusTokenBinding {
    const token = newBusToken();
    const tokenHash = hashBusToken(token);
    return store.issueToken(agent, runId, tokenHash, Date.now());
  }

  // ============ whoami tests ============

  describe("whoami", () => {
    it("shows agent identity (ACCEPTANCE TEST 4)", async () => {
      const binding = issueToken("worker-a", "run-1");

      const result = service.whoami(binding);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.agent).toBe("worker-a");
        expect(result.data.runId).toBe("run-1");
        expect(result.data.project).toBe("test-project");
        expect(result.data.task).toBeNull();
      }
    });

    it("shows claimed task from agents module (ACCEPTANCE TEST 4)", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "feat-search");

      const result = service.whoami(binding);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.task).toBe("feat-search");
      }
    });
  });

  // ============ report tests ============

  describe("report", () => {
    it("accepts report when run holds the task (ACCEPTANCE TEST 5)", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "feat-search");

      const result = await service.report(binding, "PROGRESS", "feat-search", "Working on it");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBeGreaterThan(0);
      }
    });

    it("refuses report when run does not hold the task (ACCEPTANCE TEST 5)", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "different-task");

      const result = await service.report(binding, "DONE", "feat-search", "Trying to report wrong task");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
        expect(result.error.message).toContain("different-task");
        expect(result.error.message).toContain("feat-search");
      }
    });

    it("refuses report when run holds no task (ACCEPTANCE TEST 5)", async () => {
      const binding = issueToken("worker-a", "run-1");
      // runTaskMap is empty, so run-1 holds no task

      const result = await service.report(binding, "DONE", "feat-search", "No task claimed");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
        expect(result.error.message).toContain("does not hold any task");
      }
    });

    it("stores report with all fields", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "feat-search");

      const result = await service.report(binding, "WAITING", "feat-search", "Waiting for gate", "gate-abc", 42, "abc123");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const report = store.getReport(result.data.id);
        expect(report).not.toBeNull();
        expect(report!.kind).toBe("WAITING");
        expect(report!.gateId).toBe("gate-abc");
        expect(report!.pr).toBe(42);
        expect(report!.sha).toBe("abc123");
      }
    });
  });

  // ============ send tests ============

  describe("send", () => {
    it("allows sending to orchestrator (ACCEPTANCE TEST 6)", async () => {
      const binding = issueToken("worker-a", "run-1");

      const result = await service.send(binding, "orchestrator", "Need help");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.to).toBe("orchestrator");
        expect(result.data.messageId.length).toBeGreaterThan(0);
      }
    });

    it("allows sending to owner (ACCEPTANCE TEST 6)", async () => {
      const binding = issueToken("worker-a", "run-1");

      const result = await service.send(binding, "owner", "Question for owner");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.to).toBe("owner");
      }
    });

    it("refuses sending to another agent (ACCEPTANCE TEST 6)", async () => {
      const binding = issueToken("worker-a", "run-1");

      const result = await service.send(binding, "worker-b", "Hello worker-b");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
        expect(result.error.message).toContain("only send to orchestrator or owner");
      }
    });

    it("sendFromOwner can send to any agent", async () => {
      const result = await service.sendFromOwner("worker-b", "Hello from owner", 8);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.to).toBe("worker-b");
      }

      // Verify the message exists
      const msg = store.getMessage(result.ok ? result.data.messageId : "");
      expect(msg).not.toBeNull();
      expect(msg!.fromId).toBe("owner");
      expect(msg!.priority).toBe(8);
    });
  });

  // ============ inbox tests ============

  describe("inbox", () => {
    it("returns unread messages in priority order (ACCEPTANCE TEST 7)", async () => {
      const binding = issueToken("worker-a", "run-1");
      const now = Date.now();

      // Send messages with different priorities
      store.sendMessage("owner", "worker-a", "Low priority", 2, now);
      store.sendMessage("owner", "worker-a", "High priority", 9, now + 100);
      store.sendMessage("owner", "worker-a", "Medium priority", 5, now + 200);

      const result = service.inbox(binding);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBe(3);
        // Should be sorted by priority DESC, then createdAt ASC
        expect(result.data[0].text).toBe("High priority");
        expect(result.data[0].priority).toBe(9);
        expect(result.data[1].text).toBe("Medium priority");
        expect(result.data[1].priority).toBe(5);
        expect(result.data[2].text).toBe("Low priority");
        expect(result.data[2].priority).toBe(2);
      }
    });

    it("only returns messages for this agent", async () => {
      const bindingA = issueToken("worker-a", "run-a");
      const bindingB = issueToken("worker-b", "run-b");
      const now = Date.now();

      store.sendMessage("owner", "worker-a", "For worker-a", 5, now);
      store.sendMessage("owner", "worker-b", "For worker-b", 5, now + 100);

      const resultA = service.inbox(bindingA);
      expect(resultA.ok).toBe(true);
      if (resultA.ok) {
        expect(resultA.data.length).toBe(1);
        expect(resultA.data[0].text).toBe("For worker-a");
      }

      const resultB = service.inbox(bindingB);
      expect(resultB.ok).toBe(true);
      if (resultB.ok) {
        expect(resultB.data.length).toBe(1);
        expect(resultB.data[0].text).toBe("For worker-b");
      }
    });
  });

  // ============ ack tests ============

  describe("ack", () => {
    it("succeeds for own messages (ACCEPTANCE TEST 8)", async () => {
      const binding = issueToken("worker-a", "run-1");
      const now = Date.now();

      const msgId = store.sendMessage("owner", "worker-a", "Ack me", 5, now);
      // Read first
      store.getUnreadMessages("worker-a", now + 100);

      const result = service.ack(binding, msgId, "Done!");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.messageId).toBe(msgId);
      }

      // Verify ack was recorded
      const msg = store.getMessage(msgId);
      expect(msg!.ackAt).not.toBeNull();
      expect(msg!.ackNote).toBe("Done!");
    });

    it("fails for another agent's message (ACCEPTANCE TEST 8)", async () => {
      const bindingA = issueToken("worker-a", "run-a");
      const now = Date.now();

      // Message for worker-b
      const msgId = store.sendMessage("owner", "worker-b", "For B only", 5, now);

      const result = service.ack(bindingA, msgId, "Trying to ack B's message");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("forbidden");
        expect(result.error.message).toContain("not for you");
      }
    });

    it("returns not_found for non-existent message", async () => {
      const binding = issueToken("worker-a", "run-1");

      const result = service.ack(binding, "non-existent-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("not_found");
      }
    });
  });

  // ============ board tests ============

  describe("board", () => {
    it("shows tasks and owners from agents module (ACCEPTANCE TEST 9)", async () => {
      const now = Date.now();

      // Set up claims (simulating agents module)
      claims.set("feat-search", "worker-a");
      claims.set("feat-billing", "worker-b");

      // Add some reports
      store.createReport("worker-a", "run-1", "PROGRESS", "feat-search", "Working", now);
      store.createReport("worker-b", "run-2", "WAITING", "feat-billing", "Waiting for review", now + 100);

      const result = service.board();
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Check tasks
        expect(result.data.tasks.length).toBe(2);
        const searchTask = result.data.tasks.find((t) => t.task === "feat-search");
        expect(searchTask).toBeDefined();
        expect(searchTask!.owner).toBe("worker-a");
        expect(searchTask!.lastReport?.kind).toBe("PROGRESS");

        const billingTask = result.data.tasks.find((t) => t.task === "feat-billing");
        expect(billingTask).toBeDefined();
        expect(billingTask!.owner).toBe("worker-b");
        expect(billingTask!.lastReport?.kind).toBe("WAITING");

        // Check agents
        expect(result.data.agents.length).toBe(knownAgents.length);
        const workerA = result.data.agents.find((a) => a.id === "worker-a");
        expect(workerA).toBeDefined();
        expect(workerA!.claims).toContain("feat-search");
      }
    });

    it("shows tasks with reports but no current owner", async () => {
      const now = Date.now();

      // A task was worked on but is now unclaimed
      store.createReport("worker-a", "run-1", "DONE", "completed-task", "Done", now);

      const result = service.board();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const task = result.data.tasks.find((t) => t.task === "completed-task");
        expect(task).toBeDefined();
        expect(task!.owner).toBeNull();
        expect(task!.lastReport?.kind).toBe("DONE");
      }
    });
  });

  // ============ sanitization tests ============

  describe("sanitization", () => {
    it("removes control characters from summary", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "feat-test");

      const result = await service.report(binding, "PROGRESS", "feat-test", "Line1\x00\x1bLine2\nLine3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const report = store.getReport(result.data.id);
        // Control chars replaced with space
        expect(report!.summary).not.toContain("\x00");
        expect(report!.summary).not.toContain("\x1b");
      }
    });

    it("truncates very long text", async () => {
      const binding = issueToken("worker-a", "run-1");
      runTaskMap.set("run-1", "feat-test");

      const longSummary = "x".repeat(15000);
      const result = await service.report(binding, "PROGRESS", "feat-test", longSummary);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const report = store.getReport(result.data.id);
        expect(report!.summary.length).toBeLessThanOrEqual(10000);
      }
    });
  });
});
