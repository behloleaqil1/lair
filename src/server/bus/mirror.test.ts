/**
 * Tests for the bus mirror (text file output).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BusMirror, type BusMirrorConfig } from "./mirror.js";

describe("BusMirror", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bus-mirror-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("mirrorReport", () => {
    it("appends report to queue file", () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      const files = mirror.mirrorReport(
        "worker-a",
        "DONE",
        "feat-search",
        "Task completed",
        "2026-10-28T14:30:00.000Z"
      );

      expect(files).toContain(queueFile);
      expect(existsSync(queueFile)).toBe(true);

      const content = readFileSync(queueFile, "utf-8");
      expect(content).toContain("DONE");
      expect(content).toContain("feat-search");
      expect(content).toContain("worker-a");
      expect(content).toContain("14:30Z:");
      expect(content).toContain("Task completed");
    });

    it("includes gate_id, pr, and sha when provided", () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      mirror.mirrorReport(
        "worker-b",
        "WAITING",
        "feat-billing",
        "Waiting for gate",
        "2026-10-28T15:00:00.000Z",
        "gate-abc123",
        42,
        "deadbeef"
      );

      const content = readFileSync(queueFile, "utf-8");
      expect(content).toContain("[gate-abc123]");
      expect(content).toContain("PR #42");
      expect(content).toContain("[deadbee]"); // truncated to 7 chars
    });

    it("creates parent directories", () => {
      const queueFile = join(tempDir, "nested", "deep", "queue.md");
      const mirror = new BusMirror({ queueFile });

      mirror.mirrorReport("worker-a", "PROGRESS", "task-1", "Working", "2026-10-28T16:00:00.000Z");

      expect(existsSync(queueFile)).toBe(true);
    });

    it("sanitizes control characters", () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      mirror.mirrorReport(
        "worker\x00bad",
        "DONE",
        "task\nwith\rnewlines",
        "Summary\x1b[31mwith\x1b[0m ANSI",
        "2026-10-28T17:00:00.000Z"
      );

      const content = readFileSync(queueFile, "utf-8");
      // No control chars, no ANSI escapes
      expect(content).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(content).not.toContain("\x1b");
      // Newlines replaced with spaces and collapsed
      expect(content).toContain("task with newlines");
    });

    it("returns empty array when no queueFile configured", () => {
      const mirror = new BusMirror({});

      const files = mirror.mirrorReport(
        "worker-a",
        "DONE",
        "task-1",
        "Done",
        "2026-10-28T18:00:00.000Z"
      );

      expect(files.length).toBe(0);
    });
  });

  describe("mirrorMessage", () => {
    it("appends orchestrator messages to inbox file", () => {
      const inboxFile = join(tempDir, "inbox.md");
      const mirror = new BusMirror({ inboxFile });

      const files = mirror.mirrorMessage(
        "msg-123",
        "worker-a",
        "orchestrator",
        "Requesting help",
        "2026-10-28T14:30:00.000Z"
      );

      expect(files).toContain(inboxFile);
      expect(existsSync(inboxFile)).toBe(true);

      const content = readFileSync(inboxFile, "utf-8");
      expect(content).toContain("MSG 14:30Z");
      expect(content).toContain("[msg-123]");
      expect(content).toContain("from worker-a:");
      expect(content).toContain("Requesting help");
    });

    it("appends agent messages to mailbox directory", () => {
      const mailDir = join(tempDir, "mail");
      const mirror = new BusMirror({ mailDir });

      const files = mirror.mirrorMessage(
        "msg-456",
        "owner",
        "worker-b",
        "New instructions",
        "2026-10-28T15:00:00.000Z"
      );

      const mailFile = join(mailDir, "worker-b.md");
      expect(files).toContain(mailFile);
      expect(existsSync(mailFile)).toBe(true);

      const content = readFileSync(mailFile, "utf-8");
      expect(content).toContain("MSG 15:00Z");
      expect(content).toContain("[msg-456]");
      expect(content).toContain("from owner:");
      expect(content).toContain("New instructions");
    });

    it("does not write agent mailbox for orchestrator or owner recipients", () => {
      const mailDir = join(tempDir, "mail");
      const mirror = new BusMirror({ mailDir });

      mirror.mirrorMessage("msg-1", "worker-a", "orchestrator", "To orchestrator", "2026-10-28T16:00:00.000Z");
      mirror.mirrorMessage("msg-2", "worker-a", "owner", "To owner", "2026-10-28T16:01:00.000Z");

      // Neither orchestrator.md nor owner.md should be created
      expect(existsSync(join(mailDir, "orchestrator.md"))).toBe(false);
      expect(existsSync(join(mailDir, "owner.md"))).toBe(false);
    });

    it("returns empty array when no mirror paths configured", () => {
      const mirror = new BusMirror({});

      const files = mirror.mirrorMessage(
        "msg-789",
        "owner",
        "worker-c",
        "Hello",
        "2026-10-28T17:00:00.000Z"
      );

      expect(files.length).toBe(0);
    });
  });

  describe("touchWake", () => {
    it("creates wake file if it does not exist", () => {
      const wakeFile = join(tempDir, "wake");
      const mirror = new BusMirror({});

      mirror.touchWake(wakeFile);

      expect(existsSync(wakeFile)).toBe(true);
    });

    it("updates mtime if wake file exists", async () => {
      const wakeFile = join(tempDir, "wake");
      const mirror = new BusMirror({});

      // Create file and wait a bit
      mirror.touchWake(wakeFile);
      const stat1 = require("fs").statSync(wakeFile);
      const mtime1 = stat1.mtimeMs;

      // Wait a small amount and touch again
      await new Promise((r) => setTimeout(r, 50));
      mirror.touchWake(wakeFile);

      const stat2 = require("fs").statSync(wakeFile);
      const mtime2 = stat2.mtimeMs;

      expect(mtime2).toBeGreaterThan(mtime1);
    });
  });
});
