/**
 * Tests for infra monitor probes.
 */
import { describe, expect, it } from "vitest";
import { parseGateRequest, parsePid, findDuplicateSlots, type FileSystem, type FileEntry } from "./probes.js";

describe("parseGateRequest", () => {
  it("parses a queued request", () => {
    const result = parseGateRequest("heavy.1.20260302T110000Z-login-fix-abc1234-101.req");
    expect(result).toEqual({
      lane: "heavy",
      priority: 1,
      gateId: "20260302T110000Z-login-fix-abc1234-101",
      status: "queued",
    });
  });

  it("parses a running request", () => {
    const result = parseGateRequest("light.0.20260302T110000Z-search-fix-def5678-102.req.run");
    expect(result).toEqual({
      lane: "light",
      priority: 0,
      gateId: "20260302T110000Z-search-fix-def5678-102",
      status: "running",
    });
  });

  it("parses priority up to 99", () => {
    const result = parseGateRequest("heavy.99.20260302T110000Z-fix-abc-1.req");
    expect(result).toEqual({
      lane: "heavy",
      priority: 99,
      gateId: "20260302T110000Z-fix-abc-1",
      status: "queued",
    });
  });

  it("rejects invalid lane (starts with number)", () => {
    const result = parseGateRequest("1heavy.1.20260302T110000Z-fix-abc-1.req");
    expect(result).toBeNull();
  });

  it("rejects invalid priority (too high)", () => {
    const result = parseGateRequest("heavy.100.20260302T110000Z-fix-abc-1.req");
    expect(result).toBeNull();
  });

  it("rejects files without .req extension", () => {
    const result = parseGateRequest("heavy.1.20260302T110000Z-fix-abc-1.log");
    expect(result).toBeNull();
  });

  it("rejects other request states", () => {
    const result = parseGateRequest("heavy.1.20260302T110000Z-fix-abc-1.req.stuck");
    expect(result).toBeNull();
  });
});

describe("parsePid", () => {
  it("parses a simple pid", () => {
    expect(parsePid("12345\n")).toBe(12345);
  });

  it("parses pid with trailing content", () => {
    expect(parsePid("67890 extra stuff")).toBe(67890);
  });

  it("returns null for empty content", () => {
    expect(parsePid("")).toBeNull();
    expect(parsePid(null)).toBeNull();
  });

  it("returns null for non-numeric content", () => {
    expect(parsePid("not a pid")).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parsePid("0")).toBeNull();
  });

  it("returns null for negative numbers", () => {
    expect(parsePid("-123")).toBeNull();
  });
});

describe("findDuplicateSlots", () => {
  class FakeFileSystem implements FileSystem {
    private files = new Map<string, string>();
    private dirs = new Set<string>();

    addFile(path: string, content: string): void {
      this.files.set(path, content);
      // Add parent directory
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) this.dirs.add(dir);
    }

    stat(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number; ctimeMs: number } | null {
      if (this.files.has(path)) {
        return { isFile: true, isDirectory: false, mtimeMs: Date.now(), ctimeMs: Date.now() };
      }
      if (this.dirs.has(path)) {
        return { isFile: false, isDirectory: true, mtimeMs: Date.now(), ctimeMs: Date.now() };
      }
      return null;
    }

    readdir(dir: string): FileEntry[] {
      const entries: FileEntry[] = [];
      for (const [path] of this.files) {
        if (path.startsWith(dir + "/")) {
          const name = path.substring(dir.length + 1);
          if (!name.includes("/")) {
            entries.push({
              name,
              isFile: true,
              isDirectory: false,
              mtimeMs: Date.now(),
              ctimeMs: Date.now(),
            });
          }
        }
      }
      return entries;
    }

    read(path: string): string | null {
      return this.files.get(path) ?? null;
    }
  }

  it("detects duplicate runner slots", () => {
    const fs = new FakeFileSystem();
    fs.addFile("/gates/queue/runner-heavy.pid", "1001");
    fs.addFile("/gates/queue/runner-heavy-2.pid", "1002");
    fs.addFile("/gates/queue/runner-light.pid", "2001");

    const duplicates = findDuplicateSlots(fs, "/gates", ["heavy", "light"]);

    expect(duplicates).toEqual([
      { lane: "heavy", count: 2, pids: [1001, 1002] },
    ]);
  });

  it("ignores lanes with single runners", () => {
    const fs = new FakeFileSystem();
    fs.addFile("/gates/queue/runner-heavy.pid", "1001");
    fs.addFile("/gates/queue/runner-light.pid", "2001");

    const duplicates = findDuplicateSlots(fs, "/gates", ["heavy", "light"]);

    expect(duplicates).toEqual([]);
  });

  it("ignores files with invalid pids", () => {
    const fs = new FakeFileSystem();
    fs.addFile("/gates/queue/runner-heavy.pid", "1001");
    fs.addFile("/gates/queue/runner-heavy-2.pid", "invalid");

    const duplicates = findDuplicateSlots(fs, "/gates", ["heavy"]);

    expect(duplicates).toEqual([]);
  });

  it("handles empty queue directory", () => {
    const fs = new FakeFileSystem();
    const duplicates = findDuplicateSlots(fs, "/gates", ["heavy"]);
    expect(duplicates).toEqual([]);
  });
});
