/**
 * Tests for the bus store.
 *
 * Acceptance tests:
 * 1. 20 concurrent reports from 20 different run tokens -> 20 rows, none lost
 * 2. A message sent while another client is reading is in the next inbox()
 * 3. Token validation: invalid/revoked tokens refused
 * 10. Schema migration test (open, migrate, keep rows)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BusStore, getBusStore, closeBusStores, existingBusStore, openedBusStore } from "./store.js";
import { hashBusToken, newBusToken } from "./tokens.js";

describe("BusStore", () => {
  let tempDir: string;
  let store: BusStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-store-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new BusStore("test-project", dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  // ============ Token tests ============

  describe("tokens", () => {
    it("issues and validates a token", () => {
      const token = newBusToken();
      const tokenHash = hashBusToken(token);
      const now = Date.now();

      const binding = store.issueToken("worker-a", "run-1", tokenHash, now);
      expect(binding.project).toBe("test-project");
      expect(binding.agent).toBe("worker-a");
      expect(binding.runId).toBe("run-1");
      expect(binding.tokenHash).toBe(tokenHash);

      const validated = store.validateToken(tokenHash);
      expect(validated).not.toBeNull();
      expect(validated!.agent).toBe("worker-a");
    });

    it("refuses an invalid token hash", () => {
      const validated = store.validateToken("invalid-hash");
      expect(validated).toBeNull();
    });

    it("refuses a revoked token (ACCEPTANCE TEST 3 - identity)", () => {
      const token = newBusToken();
      const tokenHash = hashBusToken(token);
      const now = Date.now();

      store.issueToken("worker-a", "run-1", tokenHash, now);
      expect(store.validateToken(tokenHash)).not.toBeNull();

      store.revokeToken(tokenHash, now + 1000);
      expect(store.validateToken(tokenHash)).toBeNull();
    });

    it("revokes all tokens for a run", () => {
      const token1 = newBusToken();
      const token2 = newBusToken();
      const hash1 = hashBusToken(token1);
      const hash2 = hashBusToken(token2);
      const now = Date.now();

      store.issueToken("worker-a", "run-1", hash1, now);
      store.issueToken("worker-a", "run-1", hash2, now + 100);

      expect(store.validateToken(hash1)).not.toBeNull();
      expect(store.validateToken(hash2)).not.toBeNull();

      const revoked = store.revokeTokensForRun("run-1", now + 200);
      expect(revoked).toBe(2);

      expect(store.validateToken(hash1)).toBeNull();
      expect(store.validateToken(hash2)).toBeNull();
    });

    it("a token can't act as another agent (ACCEPTANCE TEST 3 - identity)", () => {
      const tokenA = newBusToken();
      const tokenB = newBusToken();
      const hashA = hashBusToken(tokenA);
      const hashB = hashBusToken(tokenB);
      const now = Date.now();

      store.issueToken("worker-a", "run-a", hashA, now);
      store.issueToken("worker-b", "run-b", hashB, now);

      const bindingA = store.validateToken(hashA);
      const bindingB = store.validateToken(hashB);

      expect(bindingA!.agent).toBe("worker-a");
      expect(bindingB!.agent).toBe("worker-b");

      // Token A cannot be used to validate as worker-b
      expect(bindingA!.agent).not.toBe("worker-b");
    });
  });

  // ============ Report tests ============

  describe("reports", () => {
    it("creates and retrieves a report", () => {
      const token = newBusToken();
      const tokenHash = hashBusToken(token);
      const now = Date.now();
      store.issueToken("worker-a", "run-1", tokenHash, now);

      const id = store.createReport("worker-a", "run-1", "DONE", "feat-search", "Task completed", now);
      expect(id).toBeGreaterThan(0);

      const report = store.getReport(id);
      expect(report).not.toBeNull();
      expect(report!.agent).toBe("worker-a");
      expect(report!.kind).toBe("DONE");
      expect(report!.task).toBe("feat-search");
      expect(report!.summary).toBe("Task completed");
    });

    it("handles 20 concurrent reports (ACCEPTANCE TEST 1)", async () => {
      const now = Date.now();
      const tokens: string[] = [];

      // Create 20 tokens for 20 runs
      for (let i = 0; i < 20; i++) {
        const token = newBusToken();
        tokens.push(hashBusToken(token));
        store.issueToken(`worker-${i}`, `run-${i}`, tokens[i], now);
      }

      // Create 20 reports concurrently
      const promises = tokens.map((tokenHash, i) =>
        Promise.resolve(store.createReport(`worker-${i}`, `run-${i}`, "PROGRESS", `task-${i}`, `Report ${i}`, now + i))
      );

      const ids = await Promise.all(promises);

      // Verify all 20 reports exist
      expect(ids.length).toBe(20);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(20); // None lost, all unique

      // Verify each report
      for (let i = 0; i < 20; i++) {
        const report = store.getReport(ids[i]);
        expect(report).not.toBeNull();
        expect(report!.agent).toBe(`worker-${i}`);
        expect(report!.task).toBe(`task-${i}`);
      }
    });

    it("gets latest report for a task", () => {
      const now = Date.now();
      store.createReport("worker-a", "run-1", "WAITING", "feat-search", "First", now);
      store.createReport("worker-a", "run-1", "PROGRESS", "feat-search", "Second", now + 100);
      store.createReport("worker-a", "run-1", "DONE", "feat-search", "Third", now + 200);

      const latest = store.getLatestReportForTask("feat-search");
      expect(latest).not.toBeNull();
      expect(latest!.kind).toBe("DONE");
      expect(latest!.summary).toBe("Third");
    });

    it("gets latest reports by task", () => {
      const now = Date.now();
      store.createReport("worker-a", "run-1", "DONE", "task-1", "Done 1", now);
      store.createReport("worker-b", "run-2", "WAITING", "task-2", "Waiting 2", now + 100);

      const byTask = store.getLatestReportsByTask();
      expect(byTask.size).toBe(2);
      expect(byTask.get("task-1")!.kind).toBe("DONE");
      expect(byTask.get("task-2")!.kind).toBe("WAITING");
    });
  });

  // ============ Message tests ============

  describe("messages", () => {
    it("sends and receives a message", () => {
      const now = Date.now();
      const id = store.sendMessage("owner", "worker-a", "Hello worker", 5, now);
      expect(id.length).toBeGreaterThan(0);

      const msg = store.getMessage(id);
      expect(msg).not.toBeNull();
      expect(msg!.fromId).toBe("owner");
      expect(msg!.toId).toBe("worker-a");
      expect(msg!.text).toBe("Hello worker");
      expect(msg!.readAt).toBeNull();
    });

    it("inbox marks messages as read", () => {
      const now = Date.now();
      const id = store.sendMessage("owner", "worker-a", "Message 1", 5, now);

      // First inbox call returns the message and marks it read
      const messages1 = store.getUnreadMessages("worker-a", now + 100);
      expect(messages1.length).toBe(1);
      expect(messages1[0].id).toBe(id);

      // Second inbox call returns empty (already read)
      const messages2 = store.getUnreadMessages("worker-a", now + 200);
      expect(messages2.length).toBe(0);

      // The message is marked as read
      const msg = store.getMessage(id);
      expect(msg!.readAt).not.toBeNull();
    });

    it("message sent while another reads is in next inbox (ACCEPTANCE TEST 2)", () => {
      const now = Date.now();

      // Worker-a reads inbox (empty)
      const empty = store.getUnreadMessages("worker-a", now);
      expect(empty.length).toBe(0);

      // Owner sends a message
      const id = store.sendMessage("owner", "worker-a", "New message", 5, now + 100);

      // Worker-a reads inbox again - sees the new message
      const messages = store.getUnreadMessages("worker-a", now + 200);
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe(id);
    });

    it("acknowledges a message", () => {
      const now = Date.now();
      const id = store.sendMessage("owner", "worker-a", "Please ack", 5, now);

      // Read it first
      store.getUnreadMessages("worker-a", now + 100);

      // Ack it
      const acked = store.ackMessage(id, "worker-a", "Done!", now + 200);
      expect(acked).toBe(true);

      const msg = store.getMessage(id);
      expect(msg!.ackAt).not.toBeNull();
      expect(msg!.ackNote).toBe("Done!");
    });

    it("cannot ack another agent's message (ACCEPTANCE TEST 5 - routing)", () => {
      const now = Date.now();
      const id = store.sendMessage("owner", "worker-a", "For worker-a only", 5, now);

      // Worker-b tries to ack
      const acked = store.ackMessage(id, "worker-b", "Intercepted!", now + 100);
      expect(acked).toBe(false);

      const msg = store.getMessage(id);
      expect(msg!.ackAt).toBeNull();
    });

    it("counts unread messages", () => {
      const now = Date.now();
      store.sendMessage("owner", "worker-a", "Message 1", 5, now);
      store.sendMessage("owner", "worker-a", "Message 2", 5, now + 100);
      store.sendMessage("owner", "worker-b", "For worker-b", 5, now + 200);

      expect(store.countUnread("worker-a")).toBe(2);
      expect(store.countUnread("worker-b")).toBe(1);
      expect(store.countUnread("worker-c")).toBe(0);
    });
  });

  // ============ Schema migration test ============

  describe("schema migration (ACCEPTANCE TEST 10)", () => {
    it("opens an existing database and preserves rows", () => {
      const dbPath = join(tempDir, "migrate-test.db");

      // Create a store and add data
      const store1 = new BusStore("test-project", dbPath);
      const now = Date.now();
      store1.issueToken("worker-a", "run-1", "hash-1", now);
      store1.createReport("worker-a", "run-1", "DONE", "task-1", "Test", now);
      store1.sendMessage("owner", "worker-a", "Hello", 5, now);
      store1.close();

      // Reopen the store (simulates restart)
      const store2 = new BusStore("test-project", dbPath);

      // Data should be preserved
      expect(store2.validateToken("hash-1")).not.toBeNull();
      expect(store2.getLatestReportForTask("task-1")).not.toBeNull();
      expect(store2.countUnread("worker-a")).toBe(1);

      store2.close();
    });
  });
});

describe("getBusStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-store-singleton-"));
  });

  afterEach(() => {
    closeBusStores();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("returns the same store for the same project", () => {
    const store1 = getBusStore("project-a", tempDir);
    const store2 = getBusStore("project-a", tempDir);
    expect(store1).toBe(store2);
  });

  it("returns different stores for different projects", () => {
    const store1 = getBusStore("project-a", tempDir);
    const store2 = getBusStore("project-b", tempDir);
    expect(store1).not.toBe(store2);
  });

  it("openedBusStore and existingBusStore never create a store: null for a project without one, the store once it exists", async () => {
    expect(openedBusStore("project-a", tempDir)).toBeNull();
    expect(await existingBusStore("project-a", tempDir)).toBeNull();
    expect(existsSync(join(tempDir, "bus"))).toBe(false);

    const created = getBusStore("project-a", tempDir);
    expect(openedBusStore("project-a", tempDir)).toBe(created);
    // A new process: nothing open, the file is there
    closeBusStores();
    expect(openedBusStore("project-a", tempDir)).toBeNull();
    const existing = await existingBusStore("project-a", tempDir);
    expect(existing).not.toBeNull();
    expect(openedBusStore("project-a", tempDir)).toBe(existing);
  });
});

describe("revokeTokensExcept (the sweep at start)", () => {
  let tempDir: string;
  let store: BusStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-store-sweep-"));
    store = new BusStore("test-project", join(tempDir, "bus.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("revokes every token of a run not in the active list and keeps the active runs' tokens", () => {
    store.issueToken("worker-a", "run-ended", "h-ended-1", 1);
    store.issueToken("worker-a", "run-ended", "h-ended-2", 2);
    store.issueToken("worker-b", "run-active", "h-active", 3);
    store.issueToken("worker-c", "run-gone", "h-gone", 4);
    expect(store.revokeTokensExcept(["run-active"], 10)).toBe(3);
    expect(store.validateToken("h-ended-1")).toBeNull();
    expect(store.validateToken("h-ended-2")).toBeNull();
    expect(store.validateToken("h-gone")).toBeNull();
    expect(store.validateToken("h-active")).toMatchObject({ runId: "run-active" });
    // Idempotent: nothing more to revoke
    expect(store.revokeTokensExcept(["run-active"], 11)).toBe(0);
    expect(store.revokeTokensExcept([], 12)).toBe(1);
    expect(store.validateToken("h-active")).toBeNull();
  });
});
