/**
 * Tests for lair-bus MCP server
 *
 * Note: These tests directly test the storage and mirror functionality
 * since testing the full MCP protocol requires a transport layer.
 * The MCP server structure is validated by typecheck.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BusStorage } from "./storage.js";
import { Mirror } from "./mirror.js";
import type { BusProjectConfig } from "./types.js";

describe("lair-bus integration tests", () => {
  let tempDir: string;
  let config: BusProjectConfig;
  let storage: BusStorage;
  let mirror: Mirror;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-bus-server-test-"));
    mkdirSync(join(tempDir, "data"), { recursive: true });
    mkdirSync(join(tempDir, "mail"), { recursive: true });

    config = {
      name: "test-project",
      queue_file: join(tempDir, "queue.md"),
      inbox_file: join(tempDir, "inbox.md"),
      mail_dir: join(tempDir, "mail"),
      wake_file: join(tempDir, "wake"),
    };

    // Create empty queue file
    writeFileSync(config.queue_file, "");

    storage = new BusStorage("test-project", join(tempDir, "data"));
    await storage.init();
    mirror = new Mirror(config);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("whoami behavior", () => {
    it("registers agent on upsert", () => {
      storage.upsertAgent("kiro-A", "Alpha Dragon");
      const agent = storage.getAgent("kiro-A");

      expect(agent?.id).toBe("kiro-A");
      expect(agent?.display_name).toBe("Alpha Dragon");
    });

    it("tracks agent claims", () => {
      storage.tryClaim("task-1", "kiro-A");
      storage.tryClaim("task-2", "kiro-A");

      const claims = storage.getAgentClaims("kiro-A");
      expect(claims).toContain("task-1");
      expect(claims).toContain("task-2");
    });
  });

  describe("claim behavior", () => {
    it("claims a task successfully", () => {
      const result = storage.tryClaim("my-task", "kiro-A");

      expect(result.success).toBe(true);
      expect(result.owner).toBe("kiro-A");
    });

    it("fails when another agent owns the task", () => {
      storage.tryClaim("contested-task", "kiro-B");
      const result = storage.tryClaim("contested-task", "kiro-A");

      expect(result.success).toBe(false);
      expect(result.owner).toBe("kiro-B");
    });
  });

  describe("release behavior", () => {
    it("releases owned task", () => {
      storage.tryClaim("my-task", "kiro-A");
      const released = storage.releaseClaim("my-task", "kiro-A");

      expect(released).toBe(true);
      expect(storage.getAgentClaims("kiro-A")).not.toContain("my-task");
    });

    it("fails to release task owned by another", () => {
      storage.tryClaim("not-mine", "kiro-B");
      const released = storage.releaseClaim("not-mine", "kiro-A");

      expect(released).toBe(false);
    });
  });

  describe("report behavior", () => {
    it("creates DONE report and mirrors to file", () => {
      const id = storage.createReport(
        "kiro-A",
        "DONE",
        "fix-bug",
        "bug fixed",
        "gate-123",
        42,
        "abc1234",
      );

      expect(id).toBeGreaterThan(0);

      // Mirror to file
      const now = new Date().toISOString();
      const mirrored = mirror.mirrorReport(
        "kiro-A",
        "DONE",
        "fix-bug",
        "bug fixed",
        now,
        "gate-123",
        42,
        "abc1234",
      );

      expect(mirrored).toContain(config.queue_file);

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain("DONE fix-bug");
      expect(content).toContain("kiro-A");
    });

    it("creates WAITING report", () => {
      const id = storage.createReport(
        "kiro-A",
        "WAITING",
        "new-feature",
        "gate submitted",
        "gate-456",
      );

      expect(id).toBeGreaterThan(0);
    });
  });

  describe("inbox and send behavior", () => {
    it("owner can send to agent", () => {
      const messageId = storage.sendMessage(
        "owner",
        "kiro-A",
        "please prioritize task-1",
      );

      expect(messageId).toHaveLength(8);

      // Agent receives the message
      const messages = storage.getUnreadMessages("kiro-A");
      expect(messages.length).toBe(1);
      expect(messages[0].from_id).toBe("owner");
      expect(messages[0].text).toBe("please prioritize task-1");
    });

    it("messages are marked as read after fetch", () => {
      storage.sendMessage("owner", "kiro-A", "message 1");
      storage.sendMessage("orchestrator", "kiro-A", "message 2");

      const first = storage.getUnreadMessages("kiro-A");
      expect(first.length).toBe(2);

      // Second fetch should be empty
      const second = storage.getUnreadMessages("kiro-A");
      expect(second.length).toBe(0);
    });
  });

  describe("ack behavior", () => {
    it("acknowledges received message", () => {
      const id = storage.sendMessage("owner", "kiro-A", "instruction");
      storage.getUnreadMessages("kiro-A"); // Mark as read

      const acked = storage.ackMessage(id, "kiro-A", "understood");
      expect(acked).toBe(true);

      const msg = storage.getMessage(id);
      expect(msg?.ack_note).toBe("understood");
    });

    it("fails to ack message meant for another agent", () => {
      const id = storage.sendMessage("owner", "kiro-B", "for B only");

      const acked = storage.ackMessage(id, "kiro-A");
      expect(acked).toBe(false);
    });
  });

  describe("board behavior", () => {
    it("returns task and agent overview", () => {
      // Set up some state
      storage.upsertAgent("kiro-A", "Alpha Dragon");
      storage.upsertAgent("kiro-B", "Beta Dragon");
      storage.tryClaim("task-1", "kiro-A");
      storage.tryClaim("task-2", "kiro-B");
      storage.createReport("kiro-A", "WAITING", "task-1", "submitted gate");
      storage.createReport("kiro-B", "DONE", "task-2", "completed");

      const claims = storage.getAllActiveClaims();
      const reports = storage.getLatestReportsByTask();
      const agents = storage.getAllAgents();

      expect(claims.length).toBe(2);
      expect(reports.size).toBe(2);
      expect(agents.length).toBe(2);

      const task1Claim = claims.find((c) => c.task === "task-1");
      expect(task1Claim?.owner_id).toBe("kiro-A");

      const task1Report = reports.get("task-1");
      expect(task1Report?.kind).toBe("WAITING");
    });
  });
});

describe("end-to-end workflow with two agents and orchestrator", () => {
  let tempDir: string;
  let config: BusProjectConfig;
  let storage: BusStorage;
  let mirror: Mirror;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-e2e-test-"));
    mkdirSync(join(tempDir, "data"), { recursive: true });
    mkdirSync(join(tempDir, "mail"), { recursive: true });

    config = {
      name: "e2e-project",
      queue_file: join(tempDir, "queue.md"),
      inbox_file: join(tempDir, "inbox.md"),
      mail_dir: join(tempDir, "mail"),
      wake_file: join(tempDir, "wake"),
    };

    writeFileSync(config.queue_file, "");

    storage = new BusStorage("e2e-project", join(tempDir, "data"));
    await storage.init();
    mirror = new Mirror(config);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("complete workflow: assign, claim, report, message, complete", async () => {
    // 1. Orchestrator sends assignment to agent A
    const assignId = storage.sendMessage(
      "orchestrator",
      "kiro-A",
      "Please work on feature-x",
    );
    expect(assignId).toHaveLength(8);

    // Mirror the message
    mirror.mirrorMessage(
      assignId,
      "orchestrator",
      "kiro-A",
      "Please work on feature-x",
      new Date().toISOString(),
    );

    // 2. Agent A checks inbox and claims task
    const inboxA = storage.getUnreadMessages("kiro-A");
    expect(inboxA.length).toBe(1);
    expect(inboxA[0].text).toBe("Please work on feature-x");

    // Acknowledge
    storage.ackMessage(inboxA[0].id, "kiro-A", "Starting now");

    // Claim
    const claimResult = storage.tryClaim("feature-x", "kiro-A");
    expect(claimResult.success).toBe(true);

    // 3. Agent B tries to claim same task (should fail)
    const claimB = storage.tryClaim("feature-x", "kiro-B");
    expect(claimB.success).toBe(false);
    expect(claimB.owner).toBe("kiro-A");

    // 4. Agent A reports progress
    storage.createReport("kiro-A", "PROGRESS", "feature-x", "50% complete");
    mirror.mirrorReport(
      "kiro-A",
      "PROGRESS",
      "feature-x",
      "50% complete",
      new Date().toISOString(),
    );

    // 5. Agent A reports waiting on gate
    storage.createReport(
      "kiro-A",
      "WAITING",
      "feature-x",
      "gate submitted",
      "20261024T120000Z-feature-x-abc123-1",
    );

    // 6. Agent A sends message to orchestrator about an issue
    storage.sendMessage(
      "kiro-A",
      "orchestrator",
      "Gate is taking longer than expected",
    );

    // Check orchestrator's inbox
    const orchInbox = storage.getUnreadMessages("orchestrator");
    expect(orchInbox.length).toBe(1);
    expect(orchInbox[0].from_id).toBe("kiro-A");

    // 7. Check the board state
    const claims = storage.getAllActiveClaims();
    const reports = storage.getLatestReportsByTask();

    const featureXClaim = claims.find((c) => c.task === "feature-x");
    expect(featureXClaim?.owner_id).toBe("kiro-A");

    const featureXReport = reports.get("feature-x");
    expect(featureXReport?.kind).toBe("WAITING");

    // 8. Agent A reports done and releases
    storage.createReport(
      "kiro-A",
      "DONE",
      "feature-x",
      "completed",
      "20261024T120000Z-feature-x-abc123-1",
      undefined,
      "def456",
    );

    storage.releaseClaim("feature-x", "kiro-A");

    // 9. Verify task is now available
    const claimB2 = storage.tryClaim("feature-x", "kiro-B");
    expect(claimB2.success).toBe(true);

    // 10. Check queue file has all the reports
    const queueContent = readFileSync(config.queue_file, "utf-8");
    expect(queueContent).toContain("PROGRESS");
  });
});

describe("send restrictions", () => {
  let tempDir: string;
  let storage: BusStorage;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-send-test-"));
    mkdirSync(join(tempDir, "data"), { recursive: true });

    storage = new BusStorage("test-project", join(tempDir, "data"));
    await storage.init();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("orchestrator can send to any agent", () => {
    // This is allowed - orchestrator to agent
    const id = storage.sendMessage("orchestrator", "kiro-A", "assignment");
    expect(id).toHaveLength(8);
  });

  it("owner can send to any agent", () => {
    // This is allowed - owner to agent
    const id = storage.sendMessage("owner", "kiro-B", "instruction");
    expect(id).toHaveLength(8);
  });

  it("agent can send to orchestrator", () => {
    // This is allowed - agent to orchestrator
    const id = storage.sendMessage("kiro-A", "orchestrator", "question");
    expect(id).toHaveLength(8);
  });

  it("agent can send to owner", () => {
    // This is allowed - agent to owner
    const id = storage.sendMessage("kiro-A", "owner", "status update");
    expect(id).toHaveLength(8);
  });

  // Note: The restriction that agents cannot send to other agents
  // is enforced in the MCP server layer, not in storage
  // Storage allows any message to be sent; the server applies ACL rules
});
