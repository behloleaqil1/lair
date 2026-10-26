/**
 * Tests for BusStorage
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BusStorage } from "./storage.js";

describe("BusStorage", () => {
  let tempDir: string;
  let storage: BusStorage;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-bus-test-"));
    storage = new BusStorage("test-project", tempDir);
    await storage.init();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("database initialization", () => {
    it("creates database file", () => {
      expect(existsSync(join(tempDir, "test-project.db"))).toBe(true);
    });

    it("can close and reopen", async () => {
      storage.upsertAgent("kiro-A", "Alpha Dragon");
      storage.close();

      const storage2 = new BusStorage("test-project", tempDir);
      await storage2.init();

      const agent = storage2.getAgent("kiro-A");
      expect(agent?.display_name).toBe("Alpha Dragon");
      storage2.close();
    });
  });

  describe("agent operations", () => {
    it("upserts and retrieves agent", () => {
      storage.upsertAgent("kiro-A", "Alpha Dragon");
      const agent = storage.getAgent("kiro-A");

      expect(agent).not.toBeNull();
      expect(agent?.id).toBe("kiro-A");
      expect(agent?.display_name).toBe("Alpha Dragon");
      expect(agent?.last_seen).toBeDefined();
    });

    it("updates last_seen on upsert", async () => {
      storage.upsertAgent("kiro-A");
      const first = storage.getAgent("kiro-A")?.last_seen;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      storage.upsertAgent("kiro-A");
      const second = storage.getAgent("kiro-A")?.last_seen;

      expect(second).not.toBe(first);
    });

    it("preserves display_name on update without name", () => {
      storage.upsertAgent("kiro-A", "Alpha Dragon");
      storage.upsertAgent("kiro-A"); // No display name

      const agent = storage.getAgent("kiro-A");
      expect(agent?.display_name).toBe("Alpha Dragon");
    });

    it("returns null for nonexistent agent", () => {
      expect(storage.getAgent("nonexistent")).toBeNull();
    });

    it("lists all agents", () => {
      storage.upsertAgent("kiro-A", "Alpha");
      storage.upsertAgent("kiro-B", "Beta");

      const agents = storage.getAllAgents();
      expect(agents.length).toBe(2);
    });
  });

  describe("claim operations", () => {
    it("allows first claim", () => {
      const result = storage.tryClaim("task-1", "kiro-A");

      expect(result.success).toBe(true);
      expect(result.owner).toBe("kiro-A");
    });

    it("returns owner on duplicate claim by same agent", () => {
      storage.tryClaim("task-1", "kiro-A");
      const result = storage.tryClaim("task-1", "kiro-A");

      expect(result.success).toBe(true);
      expect(result.owner).toBe("kiro-A");
    });

    it("rejects claim when another agent owns task", () => {
      storage.tryClaim("task-1", "kiro-A");
      const result = storage.tryClaim("task-1", "kiro-B");

      expect(result.success).toBe(false);
      expect(result.owner).toBe("kiro-A");
    });

    it("allows claim after release", () => {
      storage.tryClaim("task-1", "kiro-A");
      storage.releaseClaim("task-1", "kiro-A");

      const result = storage.tryClaim("task-1", "kiro-B");
      expect(result.success).toBe(true);
      expect(result.owner).toBe("kiro-B");
    });

    it("returns agent claims", () => {
      storage.tryClaim("task-1", "kiro-A");
      storage.tryClaim("task-2", "kiro-A");
      storage.tryClaim("task-3", "kiro-B");

      const claims = storage.getAgentClaims("kiro-A");
      expect(claims).toContain("task-1");
      expect(claims).toContain("task-2");
      expect(claims).not.toContain("task-3");
    });

    it("release returns false if not owner", () => {
      storage.tryClaim("task-1", "kiro-A");
      const released = storage.releaseClaim("task-1", "kiro-B");

      expect(released).toBe(false);
    });

    it("release returns false if task not claimed", () => {
      const released = storage.releaseClaim("unclaimed-task", "kiro-A");
      expect(released).toBe(false);
    });
  });

  describe("concurrent claims (within same database instance)", () => {
    it("handles sequential claims correctly - same instance", () => {
      // sql.js provides atomicity within a single Database instance
      // Multiple calls to tryClaim on the same storage should be atomic

      // First claim wins
      const result1 = storage.tryClaim("contested-task", "agent-0");
      expect(result1.success).toBe(true);
      expect(result1.owner).toBe("agent-0");

      // Subsequent claims fail
      for (let i = 1; i < 20; i++) {
        const result = storage.tryClaim("contested-task", `agent-${i}`);
        expect(result.success).toBe(false);
        expect(result.owner).toBe("agent-0");
      }
    });

    it("each task can only have one active owner", () => {
      // Claim multiple tasks
      storage.tryClaim("task-A", "agent-1");
      storage.tryClaim("task-B", "agent-2");
      storage.tryClaim("task-C", "agent-1");

      // Verify ownership
      const claims = storage.getAllActiveClaims();
      expect(claims.length).toBe(3);

      const taskA = claims.find((c) => c.task === "task-A");
      const taskB = claims.find((c) => c.task === "task-B");
      const taskC = claims.find((c) => c.task === "task-C");

      expect(taskA?.owner_id).toBe("agent-1");
      expect(taskB?.owner_id).toBe("agent-2");
      expect(taskC?.owner_id).toBe("agent-1");

      // Try to steal task-A
      const stealResult = storage.tryClaim("task-A", "agent-3");
      expect(stealResult.success).toBe(false);
      expect(stealResult.owner).toBe("agent-1");
    });
  });

  describe("report operations", () => {
    it("creates report and returns id", () => {
      const id = storage.createReport(
        "kiro-A",
        "DONE",
        "task-1",
        "completed the task",
        "gate-123",
        42,
        "abc1234"
      );

      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("gets latest reports by task", () => {
      storage.createReport("kiro-A", "WAITING", "task-1", "submitted");
      storage.createReport("kiro-A", "DONE", "task-1", "completed");
      storage.createReport("kiro-B", "BLOCKED", "task-2", "stuck");

      const reports = storage.getLatestReportsByTask();

      expect(reports.size).toBe(2);
      expect(reports.get("task-1")?.kind).toBe("DONE");
      expect(reports.get("task-2")?.kind).toBe("BLOCKED");
    });
  });

  describe("message operations", () => {
    it("sends message and returns id", () => {
      const id = storage.sendMessage("kiro-A", "orchestrator", "hello");

      expect(typeof id).toBe("string");
      expect(id.length).toBe(8);
    });

    it("retrieves unread messages and marks as read", () => {
      storage.sendMessage("owner", "kiro-A", "message 1");
      storage.sendMessage("orchestrator", "kiro-A", "message 2");
      storage.sendMessage("owner", "kiro-B", "for B");

      const messages = storage.getUnreadMessages("kiro-A");

      expect(messages.length).toBe(2);

      // Second fetch should be empty (marked as read)
      const messages2 = storage.getUnreadMessages("kiro-A");
      expect(messages2.length).toBe(0);
    });

    it("acknowledges message", () => {
      const id = storage.sendMessage("owner", "kiro-A", "hello");
      storage.getUnreadMessages("kiro-A"); // Mark as read

      const acked = storage.ackMessage(id, "kiro-A", "understood");
      expect(acked).toBe(true);

      const msg = storage.getMessage(id);
      expect(msg?.ack_at).not.toBeNull();
      expect(msg?.ack_note).toBe("understood");
    });

    it("rejects ack for wrong agent", () => {
      const id = storage.sendMessage("owner", "kiro-A", "hello");

      const acked = storage.ackMessage(id, "kiro-B", "trying to ack");
      expect(acked).toBe(false);
    });

    it("respects priority in unread order", () => {
      storage.sendMessage("owner", "kiro-A", "low priority", 1);
      storage.sendMessage("owner", "kiro-A", "high priority", 10);
      storage.sendMessage("owner", "kiro-A", "medium priority", 5);

      const messages = storage.getUnreadMessages("kiro-A");

      expect(messages[0].text).toBe("high priority");
      expect(messages[1].text).toBe("medium priority");
      expect(messages[2].text).toBe("low priority");
    });
  });
});

describe("BusStorage schema validation", () => {
  let tempDir: string;
  let storage: BusStorage;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-bus-test-"));
    storage = new BusStorage("test-project", tempDir);
    await storage.init();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles empty task gracefully via DB constraints", () => {
    // The database allows empty strings (validation at zod level in tools)
    // This test verifies the storage layer doesn't crash
    storage.tryClaim("", "kiro-A");
    const claims = storage.getAgentClaims("kiro-A");
    expect(claims).toContain("");
  });

  it("handles special characters in messages", () => {
    const specialText = 'Test "quotes" and `backticks` and $variables and ${template}';
    const id = storage.sendMessage("owner", "kiro-A", specialText);
    const msg = storage.getMessage(id);
    expect(msg?.text).toBe(specialText);
  });

  it("handles unicode in messages", () => {
    const unicodeText = "Test with emoji 🐉 and CJK 龙 and Arabic تنين";
    const id = storage.sendMessage("owner", "kiro-A", unicodeText);
    const msg = storage.getMessage(id);
    expect(msg?.text).toBe(unicodeText);
  });
});
