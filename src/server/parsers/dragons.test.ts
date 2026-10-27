/**
 * Dragons parser unit tests
 */
import { describe, it, expect } from "vitest";
import {
  parseDragonsFile,
  parseOwnersFile,
  parseLogLastLine,
  isDragonRunning,
  matchLogsToDragons,
  getMostRecentLog,
  isLogSilent,
} from "./dragons.js";

describe("parseDragonsFile", () => {
  it("parses tab-separated dragons.txt", () => {
    const content = `# Test Dragons File
kiro-A\tSmaug\tfix-login PR, then db-migration
kiro-B\tSaphira\tsearch-panel UI
`;
    const dragons = parseDragonsFile(content);

    expect(dragons).toHaveLength(2);
    expect(dragons[0]).toEqual({
      id: "kiro-A",
      name: "Smaug",
      task: "fix-login PR, then db-migration",
    });
    expect(dragons[1]).toEqual({
      id: "kiro-B",
      name: "Saphira",
      task: "search-panel UI",
    });
  });

  it("handles space-separated fallback", () => {
    const content = "kiro-A Smaug fix-login";
    const dragons = parseDragonsFile(content);

    expect(dragons).toHaveLength(1);
    expect(dragons[0].id).toBe("kiro-A");
    expect(dragons[0].name).toBe("Smaug");
    expect(dragons[0].task).toBe("fix-login");
  });

  it("skips comments and empty lines", () => {
    const content = `# Comment
kiro-A\tSmaug\ttask

# Another comment
kiro-B\tSaphira\tanother
`;
    const dragons = parseDragonsFile(content);
    expect(dragons).toHaveLength(2);
  });

  it("defaults to unassigned for missing task", () => {
    const content = "kiro-A\tSmaug";
    const dragons = parseDragonsFile(content);

    expect(dragons[0].task).toBe("unassigned");
  });
});

describe("parseOwnersFile", () => {
  it("parses task ownership map", () => {
    const content = `search-panel\tkiro-B
pricing-page\tkiro-F
`;
    const owners = parseOwnersFile(content);

    expect(owners.get("search-panel")).toBe("kiro-B");
    expect(owners.get("pricing-page")).toBe("kiro-F");
  });

  it("skips comments", () => {
    const content = `# Ownership file
task-1\tkiro-A
`;
    const owners = parseOwnersFile(content);
    expect(owners.size).toBe(1);
  });
});

describe("parseLogLastLine", () => {
  it("extracts last meaningful line with timestamp", () => {
    const content = `[INFO] Starting session
[tool] Reading file
14:35:00 Completed fix for login bug
[DEBUG] Cleanup`;

    const result = parseLogLastLine(content);
    expect(result).not.toBeNull();
    expect(result!.time).toBe("14:35:00");
    expect(result!.line).toBe("14:35:00 Completed fix for login bug");
  });

  it("skips noise patterns", () => {
    const content = `Something meaningful
[INFO] Not this
[tool] Not this either
[DEBUG] Skip me
---
===`;

    const result = parseLogLastLine(content);
    expect(result).not.toBeNull();
    expect(result!.line).toBe("Something meaningful");
  });

  it("returns null for empty content", () => {
    expect(parseLogLastLine("")).toBeNull();
    expect(parseLogLastLine("[INFO] Only noise")).toBeNull();
  });

  it("truncates long lines", () => {
    const longLine = "x".repeat(300);
    const result = parseLogLastLine(longLine);
    expect(result!.line.length).toBe(200);
  });
});

describe("isDragonRunning", () => {
  it("detects running dragon by lock directory", () => {
    const dirs = ["kiro-A.running", "kiro-B.running"];
    expect(isDragonRunning(dirs, "kiro-A")).toBe(true);
    expect(isDragonRunning(dirs, "kiro-C")).toBe(false);
  });

  it("matches partial id in directory name", () => {
    const dirs = ["kiro-A-session-123"];
    expect(isDragonRunning(dirs, "kiro-A")).toBe(true);
  });
});

describe("matchLogsToDragons", () => {
  it("matches log files to dragon ids", () => {
    const logs = [
      "kiro-A-20261024T143500Z.log",
      "kiro-A-20261024T150000Z.log",
      "kiro-B-20261024T143500Z.log",
    ];
    const dragonIds = ["kiro-A", "kiro-B", "kiro-C"];

    const result = matchLogsToDragons(logs, dragonIds);

    expect(result.get("kiro-A")).toHaveLength(2);
    expect(result.get("kiro-B")).toHaveLength(1);
    expect(result.get("kiro-C")).toHaveLength(0);
  });

  it("handles full paths", () => {
    const logs = ["/path/to/kiro-A-20261024T143500Z.log"];
    const dragonIds = ["kiro-A"];

    const result = matchLogsToDragons(logs, dragonIds);
    expect(result.get("kiro-A")).toHaveLength(1);
  });
});

describe("getMostRecentLog", () => {
  it("returns most recent log file by name", () => {
    const logs = [
      "kiro-A-20261024T100000Z.log",
      "kiro-A-20261024T150000Z.log",
      "kiro-A-20261024T120000Z.log",
    ];

    const result = getMostRecentLog(logs);
    expect(result).toBe("kiro-A-20261024T150000Z.log");
  });

  it("returns null for empty array", () => {
    expect(getMostRecentLog([])).toBeNull();
  });
});

describe("isLogSilent", () => {
  it("never calls an unknown or unreadable time silent", () => {
    expect(isLogSilent(undefined)).toBe(false);
    expect(isLogSilent("")).toBe(false);
    expect(isLogSilent("not a time")).toBe(false);
    expect(isLogSilent("2026-13-45TXX")).toBe(false);
  });

  it("returns true for old ISO timestamp", () => {
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    expect(isLogSilent(oldTime, 45)).toBe(true);
  });

  it("returns false for recent ISO timestamp", () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    expect(isLogSilent(recentTime, 45)).toBe(false);
  });
});
