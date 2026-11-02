/**
 * Tests for the bus mirror (text file output).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { BusMirror } from "./mirror.js";

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
    it("appends report to queue file", async () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      const files = await mirror.mirrorReport(
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

    it("includes gate_id, pr, sha, and bus id when provided", async () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      await mirror.mirrorReport(
        "worker-b",
        "WAITING",
        "feat-billing",
        "Waiting for gate",
        "2026-10-28T15:00:00.000Z",
        "gate-abc123",
        42,
        "deadbeef",
        123
      );

      const content = readFileSync(queueFile, "utf-8");
      expect(content).toContain("[gate-abc123]");
      expect(content).toContain("PR #42");
      expect(content).toContain("[deadbee]"); // truncated to 7 chars
      expect(content).toContain("[bus:123]");
    });

    it("omits bus id marker when not provided", async () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      await mirror.mirrorReport(
        "worker-a",
        "DONE",
        "feat-search",
        "Task completed",
        "2026-10-28T14:31:00.000Z"
      );

      const content = readFileSync(queueFile, "utf-8");
      expect(content).not.toContain("[bus:");
    });

    it("creates parent directories", async () => {
      const queueFile = join(tempDir, "nested", "deep", "queue.md");
      const mirror = new BusMirror({ queueFile });

      await mirror.mirrorReport("worker-a", "PROGRESS", "task-1", "Working", "2026-10-28T16:00:00.000Z");

      expect(existsSync(queueFile)).toBe(true);
    });

    it("sanitizes control characters", async () => {
      const queueFile = join(tempDir, "queue.md");
      const mirror = new BusMirror({ queueFile });

      await mirror.mirrorReport(
        "worker\x00bad",
        "DONE",
        "task\nwith\rnewlines",
        "Summary\x1b[31mwith\x1b[0m ANSI",
        "2026-10-28T17:00:00.000Z"
      );

      const content = readFileSync(queueFile, "utf-8");
      // Lines end with newline, but no other control chars or ANSI escapes
      // eslint-disable-next-line no-control-regex
      expect(content.trimEnd()).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(content).not.toContain("\x1b");
      // Newlines in input replaced with spaces and collapsed
      expect(content).toContain("task with newlines");
    });

    it("returns empty array when no queueFile configured", async () => {
      const mirror = new BusMirror({});

      const files = await mirror.mirrorReport(
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
    it("appends orchestrator messages to inbox file", async () => {
      const inboxFile = join(tempDir, "inbox.md");
      const mirror = new BusMirror({ inboxFile });

      const files = await mirror.mirrorMessage(
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

    it("appends agent messages to mailbox directory", async () => {
      const mailDir = join(tempDir, "mail");
      const mirror = new BusMirror({ mailDir });

      const files = await mirror.mirrorMessage(
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

    it("does not write agent mailbox for orchestrator or owner recipients", async () => {
      const mailDir = join(tempDir, "mail");
      const mirror = new BusMirror({ mailDir });

      await mirror.mirrorMessage("msg-1", "worker-a", "orchestrator", "To orchestrator", "2026-10-28T16:00:00.000Z");
      await mirror.mirrorMessage("msg-2", "worker-a", "owner", "To owner", "2026-10-28T16:01:00.000Z");

      // Neither orchestrator.md nor owner.md should be created
      expect(existsSync(join(mailDir, "orchestrator.md"))).toBe(false);
      expect(existsSync(join(mailDir, "owner.md"))).toBe(false);
    });

    it("returns empty array when no mirror paths configured", async () => {
      const mirror = new BusMirror({});

      const files = await mirror.mirrorMessage(
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
    it("creates wake file if it does not exist", async () => {
      const wakeFile = join(tempDir, "wake");
      const mirror = new BusMirror({});

      await mirror.touchWake(wakeFile);

      expect(existsSync(wakeFile)).toBe(true);
    });

    it("updates mtime if wake file exists", async () => {
      const wakeFile = join(tempDir, "wake");
      const mirror = new BusMirror({});
      const fs = await import("fs");

      // Create file and wait a bit
      await mirror.touchWake(wakeFile);
      const stat1 = fs.statSync(wakeFile);
      const mtime1 = stat1.mtimeMs;

      // Wait a small amount and touch again
      await new Promise((r) => setTimeout(r, 50));
      await mirror.touchWake(wakeFile);

      const stat2 = fs.statSync(wakeFile);
      const mtime2 = stat2.mtimeMs;

      expect(mtime2).toBeGreaterThan(mtime1);
    });
  });

  describe("mailbox file names (owner send to any recipient)", () => {
    it("writes no mailbox file for a recipient that isn't a plain name: no '/', no '..', no leading '-'", async () => {
      const mailDir = join(tempDir, "mail");
      const mirror = new BusMirror({ mailDir });
      for (const to of ["../escape", "../../etc/x", "sub/agent", "a..b", "-rf", "with space", ""]) {
        expect(await mirror.mirrorMessage("msg-1", "owner", to, "hello", "2026-10-28T16:00:00.000Z"), to).toEqual([]);
      }
      expect(existsSync(mailDir)).toBe(false);
      expect(existsSync(join(tempDir, "escape.md"))).toBe(false);
      expect(readdirSync(tempDir)).toEqual([]);

      // A plain agent id still gets its mailbox
      expect(await mirror.mirrorMessage("msg-2", "owner", "worker-a", "hello", "2026-10-28T16:00:00.000Z")).toEqual([join(mailDir, "worker-a.md")]);
    });
  });

  describe("asynchronous, serialised writes", () => {
    it("concurrent mirrors of one file land whole and in call order, never interleaved", async () => {
      const queueFile = join(tempDir, "nested", "queue.md");
      const mirror = new BusMirror({ queueFile });
      const other = new BusMirror({ queueFile }); // a rebuilt bus service writes the same file
      const big = "x".repeat(1900);
      const writes = Array.from({ length: 60 }, (_, i) =>
        (i % 2 === 0 ? mirror : other).mirrorReport("worker-a", "PROGRESS", `task-${i}`, `${i} ${big}`, "2026-10-28T16:00:00.000Z", undefined, undefined, undefined, i + 1),
      );
      // Nothing is written while the calls return: the writes are asynchronous
      expect(existsSync(queueFile)).toBe(false);
      const results = await Promise.all(writes);
      expect(results.every((files) => files.length === 1 && files[0] === queueFile)).toBe(true);
      const lines = readFileSync(queueFile, "utf-8").split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(60);
      lines.forEach((line, i) => expect(line).toMatch(new RegExp(`^- PROGRESS task-${i} by worker-a 16:00Z: ${i} x{1900} \\[bus:${i + 1}\\]$`)));
    });

    it("a failed write resolves with no files and doesn't stop the next one", async () => {
      // The queue file's parent is a file: mkdir fails
      writeFileSync(join(tempDir, "blocker"), "");
      const bad = new BusMirror({ queueFile: join(tempDir, "blocker", "queue.md") });
      expect(await bad.mirrorReport("worker-a", "DONE", "t", "s", "2026-10-28T16:00:00.000Z")).toEqual([]);
      const good = new BusMirror({ queueFile: join(tempDir, "queue.md") });
      expect(await good.mirrorReport("worker-a", "DONE", "t", "s", "2026-10-28T16:00:00.000Z")).toEqual([join(tempDir, "queue.md")]);
    });
  });
});

describe("the event loop (Lair #245)", () => {
  it("no source of the server's bus module calls a synchronous fs or child-process function (the store's one-time directory creation excepted)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
    expect(sources).toEqual(expect.arrayContaining(["mirror.ts", "service.ts", "wiring.ts", "store.ts"]));
    for (const file of sources) {
      const code = readFileSync(join(here, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const calls = code.match(/\b\w+Sync\s*\(/g) ?? [];
      if (file === "store.ts") {
        // better-sqlite3 opens the database synchronously: its directory is made once, when the project's store is first opened
        expect(calls, file).toEqual(["existsSync(", "mkdirSync("]);
        expect(code, file).toMatch(/if \(!existsSync\(dir\)\) \{\s*mkdirSync\(dir, \{ recursive: true \}\);\s*\}/);
      } else {
        expect(calls, file).toEqual([]);
        expect(code, file).not.toMatch(/from "fs";|from "node:fs";|from "child_process";|from "node:child_process";/);
      }
    }
  });
});
