import { describe, it, expect, beforeEach } from "vitest";
import { checkRetentionEntry, getRetentionCandidates } from "./retention.js";
import type { Clock, FileSystem } from "./probes.js";
import type { RetentionEntry } from "./config.js";

function createFakeFs(): FileSystem & {
  files: Map<string, { isDir: boolean; isSymlink: boolean; mtimeMs: number; content?: string }>;
  globs: Map<string, string[]>;
} {
  const files = new Map<
    string,
    { isDir: boolean; isSymlink: boolean; mtimeMs: number; content?: string }
  >();
  const globs = new Map<string, string[]>();

  return {
    files,
    globs,
    exists: async (p) => files.has(p),
    stat: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: f.mtimeMs, isDirectory: f.isDir, isSymbolicLink: f.isSymlink };
    },
    lstat: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: f.mtimeMs, isDirectory: f.isDir, isSymbolicLink: f.isSymlink };
    },
    realpath: async (p) => p,
    readdir: async (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name && !entries.includes(name)) {
            entries.push(name);
          }
        }
      }
      return entries;
    },
    readFile: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f.content ?? "";
    },
    rm: async () => {},
    unlink: async () => {},
    glob: async (pattern) => globs.get(pattern) ?? [],
  };
}

describe("checkRetentionEntry", () => {
  let fsys: ReturnType<typeof createFakeFs>;
  let clock: Clock;
  const now = Date.now();

  beforeEach(() => {
    fsys = createFakeFs();
    clock = { now: () => now };
  });

  it("marks old unused file as removable", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    fsys.files.set("/results/old.log", { isDir: false, isSymlink: false, mtimeMs: oldTime });

    const rule: RetentionEntry = {
      path: "/results",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const result = await checkRetentionEntry(fsys, clock, "/results/old.log", "old.log", rule);
    expect(result.removable).toBe(true);
    expect(result.reason).toContain("unused for");
  });

  it("keeps recent file", async () => {
    const recentTime = now - 2 * 24 * 60 * 60 * 1000; // 2 days ago
    fsys.files.set("/results/new.log", { isDir: false, isSymlink: false, mtimeMs: recentTime });

    const rule: RetentionEntry = {
      path: "/results",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const result = await checkRetentionEntry(fsys, clock, "/results/new.log", "new.log", rule);
    expect(result.removable).toBe(false);
    expect(result.reason).toContain("used 2.0 days ago");
  });

  it("keeps referenced entry", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;
    fsys.files.set("/snapshots/gate-abc", { isDir: true, isSymlink: false, mtimeMs: oldTime });
    fsys.files.set("/queue/gate-abc.req.run", {
      isDir: false,
      isSymlink: false,
      mtimeMs: now,
      content: "gate-abc",
    });
    fsys.globs.set("/queue/*.req.run", ["/queue/gate-abc.req.run"]);

    const rule: RetentionEntry = {
      path: "/snapshots",
      keepDays: 2,
      kind: "dir",
      skipIfReferenced: ["/queue/*.req.run"],
    };

    const result = await checkRetentionEntry(fsys, clock, "/snapshots/gate-abc", "gate-abc", rule);
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("referenced by active work");
  });

  it("removes old unreferenced entry", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;
    fsys.files.set("/snapshots/gate-xyz", { isDir: true, isSymlink: false, mtimeMs: oldTime });
    fsys.files.set("/queue/gate-abc.req.run", {
      isDir: false,
      isSymlink: false,
      mtimeMs: now,
      content: "gate-abc", // Different gate
    });
    fsys.globs.set("/queue/*.req.run", ["/queue/gate-abc.req.run"]);

    const rule: RetentionEntry = {
      path: "/snapshots",
      keepDays: 2,
      kind: "dir",
      skipIfReferenced: ["/queue/*.req.run"],
    };

    const result = await checkRetentionEntry(fsys, clock, "/snapshots/gate-xyz", "gate-xyz", rule);
    expect(result.removable).toBe(true);
  });

  it("handles non-existent entry", async () => {
    const rule: RetentionEntry = {
      path: "/results",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const result = await checkRetentionEntry(fsys, clock, "/results/missing.log", "missing.log", rule);
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("does not exist");
  });
});

describe("getRetentionCandidates", () => {
  let fsys: ReturnType<typeof createFakeFs>;
  let clock: Clock;
  const now = Date.now();

  beforeEach(() => {
    fsys = createFakeFs();
    clock = { now: () => now };
  });

  it("returns all matching entries", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;
    const recentTime = now - 2 * 24 * 60 * 60 * 1000;

    fsys.files.set("/results", { isDir: true, isSymlink: false, mtimeMs: now });
    fsys.files.set("/results/old.log", { isDir: false, isSymlink: false, mtimeMs: oldTime });
    fsys.files.set("/results/new.log", { isDir: false, isSymlink: false, mtimeMs: recentTime });
    fsys.files.set("/results/subdir", { isDir: true, isSymlink: false, mtimeMs: oldTime });

    const rule: RetentionEntry = {
      path: "/results",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const candidates = await getRetentionCandidates(fsys, clock, rule);
    // Should only include files, not the subdirectory
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.path)).toContain("/results/old.log");
    expect(candidates.map((c) => c.path)).toContain("/results/new.log");
  });

  it("skips symlinks", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;

    fsys.files.set("/results", { isDir: true, isSymlink: false, mtimeMs: now });
    fsys.files.set("/results/link", { isDir: false, isSymlink: true, mtimeMs: oldTime });

    const rule: RetentionEntry = {
      path: "/results",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const candidates = await getRetentionCandidates(fsys, clock, rule);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].removable).toBe(false);
    expect(candidates[0].reason).toContain("symlink");
  });

  it("matches directories for dir kind", async () => {
    const oldTime = now - 10 * 24 * 60 * 60 * 1000;

    fsys.files.set("/snapshots", { isDir: true, isSymlink: false, mtimeMs: now });
    fsys.files.set("/snapshots/gate-abc", { isDir: true, isSymlink: false, mtimeMs: oldTime });
    fsys.files.set("/snapshots/gate-xyz", { isDir: true, isSymlink: false, mtimeMs: oldTime });
    fsys.files.set("/snapshots/readme.txt", { isDir: false, isSymlink: false, mtimeMs: oldTime });

    const rule: RetentionEntry = {
      path: "/snapshots",
      keepDays: 7,
      kind: "dir",
      skipIfReferenced: [],
    };

    const candidates = await getRetentionCandidates(fsys, clock, rule);
    // Should only include directories, not the file
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.path)).toContain("/snapshots/gate-abc");
    expect(candidates.map((c) => c.path)).toContain("/snapshots/gate-xyz");
  });

  it("handles empty directory", async () => {
    fsys.files.set("/empty", { isDir: true, isSymlink: false, mtimeMs: now });

    const rule: RetentionEntry = {
      path: "/empty",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const candidates = await getRetentionCandidates(fsys, clock, rule);
    expect(candidates).toHaveLength(0);
  });

  it("handles missing directory", async () => {
    const rule: RetentionEntry = {
      path: "/missing",
      keepDays: 7,
      kind: "file",
      skipIfReferenced: [],
    };

    const candidates = await getRetentionCandidates(fsys, clock, rule);
    expect(candidates).toHaveLength(0);
  });
});
