/**
 * Tests for Mirror (text file mirroring)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Mirror } from "./mirror.js";
import type { BusProjectConfig } from "./types.js";

describe("Mirror", () => {
  let tempDir: string;
  let config: BusProjectConfig;
  let mirror: Mirror;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-mirror-test-"));
    config = {
      name: "test-project",
      queue_file: join(tempDir, "queue.md"),
      inbox_file: join(tempDir, "inbox.md"),
      mail_dir: join(tempDir, "mail"),
      wake_file: join(tempDir, "wake"),
    };
    mirror = new Mirror(config);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("mirrorReport", () => {
    it("mirrors DONE report to queue file", () => {
      const mirrored = mirror.mirrorReport(
        "kiro-A",
        "DONE",
        "fix-login",
        "completed",
        "2026-10-24T14:35:00Z",
        "20261024T143500Z-fix-login-abc1234d-12345",
        42,
        "abc1234d"
      );

      expect(mirrored).toContain(config.queue_file);

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain("- DONE fix-login task by kiro-A 14:35Z:");
      expect(content).toContain("head abc1234");
      expect(content).toContain("gate 20261024T143500Z-fix-login-abc1234d-12345");
    });

    it("mirrors WAITING report to queue file", () => {
      mirror.mirrorReport(
        "kiro-B",
        "WAITING",
        "search-panel",
        "submitted to heavy lane PRI=1",
        "2026-10-24T15:20:00Z",
        "20261024T152000Z-search-panel-def5678e-23456"
      );

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain("- WAITING search-panel");
      expect(content).toContain("20261024T152000Z-search-panel-def5678e-23456");
      expect(content).toContain("by kiro-B 15:20Z");
    });

    it("mirrors BLOCKED report to queue file", () => {
      mirror.mirrorReport(
        "kiro-C",
        "BLOCKED",
        "build-config",
        "missing config file",
        "2026-10-24T16:05:00Z"
      );

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain(
        "- BLOCKED build-config by kiro-C 16:05Z: missing config file"
      );
    });

    it("mirrors PROGRESS report to queue file", () => {
      mirror.mirrorReport(
        "kiro-D",
        "PROGRESS",
        "refactoring",
        "3 of 8 files complete",
        "2026-10-24T17:00:00Z"
      );

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain(
        "- PROGRESS refactoring by kiro-D 17:00Z: 3 of 8 files complete"
      );
    });

    it("mirrors TICK report to queue file", () => {
      mirror.mirrorReport(
        "orchestrator",
        "TICK",
        "orchestrator",
        "all runners healthy, 2 gates queued",
        "2026-10-24T18:00:00Z"
      );

      const content = readFileSync(config.queue_file, "utf-8");
      expect(content).toContain(
        "- TICK 18:00Z: all runners healthy, 2 gates queued"
      );
    });

    it("creates queue file if it doesn't exist", () => {
      expect(existsSync(config.queue_file)).toBe(false);

      mirror.mirrorReport(
        "kiro-A",
        "DONE",
        "task",
        "done",
        "2026-10-24T12:00:00Z"
      );

      expect(existsSync(config.queue_file)).toBe(true);
    });

    it("appends to existing queue file", () => {
      mirror.mirrorReport("kiro-A", "DONE", "task-1", "done", "2026-10-24T12:00:00Z");
      mirror.mirrorReport("kiro-B", "DONE", "task-2", "done", "2026-10-24T13:00:00Z");

      const content = readFileSync(config.queue_file, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);
    });
  });

  describe("mirrorMessage", () => {
    it("mirrors message to orchestrator to inbox file", () => {
      const mirrored = mirror.mirrorMessage(
        "msg-123",
        "kiro-A",
        "orchestrator",
        "need help with task",
        "2026-10-24T14:30:00.000Z"
      );

      expect(mirrored).toContain(config.inbox_file);

      const content = readFileSync(config.inbox_file!, "utf-8");
      expect(content).toContain("- OWNER 2026-10-24 14:30:00Z [msg-123]:");
      expect(content).toContain("need help with task");
    });

    it("mirrors message to owner to inbox file", () => {
      mirror.mirrorMessage(
        "msg-456",
        "kiro-B",
        "owner",
        "question about requirements",
        "2026-10-24T15:00:00.000Z"
      );

      const content = readFileSync(config.inbox_file!, "utf-8");
      expect(content).toContain("- OWNER 2026-10-24 15:00:00Z [msg-456]:");
    });

    it("mirrors message to agent to their mailbox", () => {
      const mirrored = mirror.mirrorMessage(
        "msg-789",
        "owner",
        "kiro-A",
        "please prioritize task-1",
        "2026-10-24T16:00:00.000Z"
      );

      const expectedMailbox = join(config.mail_dir!, "kiro-A.md");
      expect(mirrored).toContain(expectedMailbox);

      const content = readFileSync(expectedMailbox, "utf-8");
      expect(content).toContain("- FROM owner 2026-10-24 16:00:00Z [msg-789]:");
      expect(content).toContain("please prioritize task-1");
    });

    it("creates mail directory if needed", () => {
      expect(existsSync(config.mail_dir!)).toBe(false);

      mirror.mirrorMessage(
        "msg-1",
        "owner",
        "kiro-A",
        "hello",
        "2026-10-24T12:00:00.000Z"
      );

      expect(existsSync(config.mail_dir!)).toBe(true);
    });
  });

  describe("touchWake", () => {
    it("creates wake file", () => {
      expect(existsSync(config.wake_file!)).toBe(false);

      mirror.touchWake();

      expect(existsSync(config.wake_file!)).toBe(true);
      const content = readFileSync(config.wake_file!, "utf-8");
      expect(content).toContain("woken at");
    });

    it("updates wake file on subsequent calls", async () => {
      mirror.touchWake();
      const first = readFileSync(config.wake_file!, "utf-8");

      await new Promise((r) => setTimeout(r, 10));

      mirror.touchWake();
      const second = readFileSync(config.wake_file!, "utf-8");

      expect(second).not.toBe(first);
    });
  });

  describe("shouldWake", () => {
    it("returns true for DONE report", () => {
      expect(mirror.shouldWake("DONE")).toBe(true);
    });

    it("returns true for BLOCKED report", () => {
      expect(mirror.shouldWake("BLOCKED")).toBe(true);
    });

    it("returns false for WAITING report", () => {
      expect(mirror.shouldWake("WAITING")).toBe(false);
    });

    it("returns false for PROGRESS report", () => {
      expect(mirror.shouldWake("PROGRESS")).toBe(false);
    });

    it("returns false for TICK report", () => {
      expect(mirror.shouldWake("TICK")).toBe(false);
    });

    it("returns true for message to orchestrator", () => {
      expect(mirror.shouldWake(undefined, "orchestrator")).toBe(true);
    });

    it("returns true for message from owner", () => {
      expect(mirror.shouldWake(undefined, undefined, "owner")).toBe(true);
    });

    it("returns false for message between agents", () => {
      expect(mirror.shouldWake(undefined, "kiro-B", "kiro-A")).toBe(false);
    });
  });
});

describe("Mirror without optional config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lair-mirror-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no queue_file", () => {
    const config: BusProjectConfig = {
      name: "test",
      queue_file: "", // Empty
    };
    const mirror = new Mirror(config);

    const mirrored = mirror.mirrorReport(
      "kiro-A",
      "DONE",
      "task",
      "done",
      "2026-10-24T12:00:00Z"
    );

    expect(mirrored).toEqual([]);
  });

  it("skips inbox when no inbox_file", () => {
    const config: BusProjectConfig = {
      name: "test",
      queue_file: join(tempDir, "queue.md"),
      // No inbox_file
    };
    const mirror = new Mirror(config);

    const mirrored = mirror.mirrorMessage(
      "msg-1",
      "kiro-A",
      "orchestrator",
      "hello",
      "2026-10-24T12:00:00Z"
    );

    expect(mirrored).toEqual([]);
  });

  it("skips mailbox when no mail_dir", () => {
    const config: BusProjectConfig = {
      name: "test",
      queue_file: join(tempDir, "queue.md"),
      // No mail_dir
    };
    const mirror = new Mirror(config);

    const mirrored = mirror.mirrorMessage(
      "msg-1",
      "owner",
      "kiro-A",
      "hello",
      "2026-10-24T12:00:00Z"
    );

    expect(mirrored).toEqual([]);
  });

  it("touchWake does nothing when no wake_file", () => {
    const config: BusProjectConfig = {
      name: "test",
      queue_file: join(tempDir, "queue.md"),
      // No wake_file
    };
    const mirror = new Mirror(config);

    // Should not throw
    mirror.touchWake();
  });
});
