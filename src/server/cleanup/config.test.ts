import { describe, it, expect } from "vitest";
import { parseCleanupConfig, getConfiguredRoots, type CleanupSettings } from "./config.js";

describe("parseCleanupConfig", () => {
  it("returns defaults when config is undefined", () => {
    const result = parseCleanupConfig(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.mode).toBe("observe");
    expect(result.settings.intervalSeconds).toBe(3600);
    expect(result.settings.maxEntriesPerCycle).toBe(50);
    expect(result.settings.worktrees.repos).toEqual([]);
    expect(result.settings.retention).toEqual([]);
  });

  it("returns defaults when config is empty object", () => {
    const result = parseCleanupConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings.enabled).toBe(false);
  });

  it("parses a complete config", () => {
    const result = parseCleanupConfig({
      enabled: true,
      mode: "act",
      interval_seconds: 1800,
      max_entries_per_cycle: 100,
      max_seconds_per_cycle: 300,
      worktrees: {
        repos: ["/Users/dev/project"],
        after_merge: true,
        min_idle_hours: 48,
      },
      retention: [
        {
          path: "/Users/dev/project/work/gates/snapshots",
          keep_days: 2,
          kind: "worktree",
          skip_if_referenced: ["/Users/dev/project/work/gates/queue/*.req"],
        },
        {
          path: "/Users/dev/project/work/gates/results",
          keep_days: 30,
          kind: "file",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.settings).toEqual({
      enabled: true,
      mode: "act",
      intervalSeconds: 1800,
      maxEntriesPerCycle: 100,
      maxSecondsPerCycle: 300,
      worktrees: {
        repos: ["/Users/dev/project"],
        afterMerge: true,
        minIdleHours: 48,
      },
      retention: [
        {
          path: "/Users/dev/project/work/gates/snapshots",
          keepDays: 2,
          kind: "worktree",
          skipIfReferenced: ["/Users/dev/project/work/gates/queue/*.req"],
        },
        {
          path: "/Users/dev/project/work/gates/results",
          keepDays: 30,
          kind: "file",
          skipIfReferenced: [],
        },
      ],
    });
  });

  it("rejects relative repo paths", () => {
    const result = parseCleanupConfig({
      worktrees: {
        repos: ["./project"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toContain("cleanup.worktrees.repos[0]: must be an absolute path");
  });

  it("rejects relative retention paths", () => {
    const result = parseCleanupConfig({
      retention: [
        {
          path: "work/gates/snapshots",
          keep_days: 2,
          kind: "dir",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toContain("cleanup.retention[0].path: must be an absolute path");
  });

  it("rejects paths starting with dash", () => {
    const result = parseCleanupConfig({
      worktrees: {
        repos: ["-rf /"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors.some((e) => e.includes("must not start with '-'"))).toBe(true);
  });

  it("rejects duplicate retention paths", () => {
    const result = parseCleanupConfig({
      retention: [
        { path: "/a/b", keep_days: 1, kind: "file" },
        { path: "/a/b", keep_days: 2, kind: "dir" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toContain("cleanup.retention[1].path: /a/b is already configured");
  });

  it("rejects enabled without any work to do", () => {
    const result = parseCleanupConfig({
      enabled: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors.some((e) => e.includes("no worktree repos and no retention entries"))).toBe(
      true,
    );
  });

  it("allows enabled with only worktrees", () => {
    const result = parseCleanupConfig({
      enabled: true,
      worktrees: {
        repos: ["/a/b"],
        after_merge: true,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("allows enabled with only retention", () => {
    const result = parseCleanupConfig({
      enabled: true,
      retention: [{ path: "/a/b", keep_days: 1, kind: "file" }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid glob patterns", () => {
    const result = parseCleanupConfig({
      retention: [
        {
          path: "/a/b",
          keep_days: 1,
          kind: "file",
          skip_if_referenced: ["/a//b"],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors.some((e) => e.includes("invalid glob pattern"))).toBe(true);
  });

  it("rejects invalid mode", () => {
    const result = parseCleanupConfig({
      mode: "delete",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = parseCleanupConfig({
      retention: [{ path: "/a", keep_days: 1, kind: "symlink" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects interval below minimum", () => {
    const result = parseCleanupConfig({
      interval_seconds: 30,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects max_entries_per_cycle below minimum", () => {
    const result = parseCleanupConfig({
      max_entries_per_cycle: 0,
    });
    expect(result.ok).toBe(false);
  });
});

describe("getConfiguredRoots", () => {
  it("returns empty for disabled config", () => {
    const settings: CleanupSettings = {
      enabled: false,
      mode: "observe",
      intervalSeconds: 3600,
      maxEntriesPerCycle: 50,
      maxSecondsPerCycle: 600,
      worktrees: { repos: [], afterMerge: true, minIdleHours: 24 },
      retention: [],
    };
    expect(getConfiguredRoots(settings)).toEqual([]);
  });

  it("returns repos and retention paths", () => {
    const settings: CleanupSettings = {
      enabled: true,
      mode: "observe",
      intervalSeconds: 3600,
      maxEntriesPerCycle: 50,
      maxSecondsPerCycle: 600,
      worktrees: { repos: ["/a", "/b"], afterMerge: true, minIdleHours: 24 },
      retention: [
        { path: "/c", keepDays: 1, kind: "file", skipIfReferenced: [] },
        { path: "/a", keepDays: 2, kind: "dir", skipIfReferenced: [] },
      ],
    };
    const roots = getConfiguredRoots(settings);
    expect(roots).toHaveLength(3);
    expect(roots).toContain("/a");
    expect(roots).toContain("/b");
    expect(roots).toContain("/c");
  });
});
