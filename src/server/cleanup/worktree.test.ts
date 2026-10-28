import { describe, it, expect, beforeEach } from "vitest";
import {
  parseGithubRemote,
  checkWorktreeRemovability,
} from "./worktree.js";
import type { Clock, FileSystem, CommandRunner, GitHost, WorktreeInfo } from "./probes.js";
import { parseWorktreeList } from "./probes.js";
import type { AgentClaims } from "./worktree.js";
import type { WorktreesSettings } from "./config.js";

describe("parseGithubRemote", () => {
  it("parses https URL", () => {
    const result = parseGithubRemote("https://github.com/owner/repo.git");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses https URL without .git", () => {
    const result = parseGithubRemote("https://github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses ssh URL", () => {
    const result = parseGithubRemote("git@github.com:owner/repo.git");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for non-github URL", () => {
    const result = parseGithubRemote("https://gitlab.com/owner/repo.git");
    expect(result).toBeNull();
  });
});

describe("parseWorktreeList", () => {
  it("parses porcelain output", () => {
    const output = `worktree /Users/dev/repo
HEAD abc123
branch refs/heads/main

worktree /Users/dev/repo-feature
HEAD def456
branch refs/heads/feature

worktree /Users/dev/repo-detached
HEAD 789abc
detached
`;

    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/Users/dev/repo", head: "abc123", branch: "main", bare: false },
      { path: "/Users/dev/repo-feature", head: "def456", branch: "feature", bare: false },
      { path: "/Users/dev/repo-detached", head: "789abc", branch: null, bare: false },
    ]);
  });

  it("handles bare worktree", () => {
    const output = `worktree /Users/dev/repo.git
bare
`;
    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/Users/dev/repo.git", head: "", branch: null, bare: true },
    ]);
  });
});

describe("checkWorktreeRemovability", () => {
  let fsys: FileSystem;
  let cmd: CommandRunner;
  let clock: Clock;
  let gitHost: GitHost;
  let agents: AgentClaims;
  const settings: WorktreesSettings = {
    repos: ["/repo"],
    afterMerge: true,
    minIdleHours: 24,
  };

  beforeEach(() => {
    fsys = {
      exists: async () => true,
      stat: async () => ({ mtimeMs: Date.now() - 48 * 60 * 60 * 1000, isDirectory: true, isSymbolicLink: false }),
      lstat: async () => ({ mtimeMs: Date.now() - 48 * 60 * 60 * 1000, isDirectory: true, isSymbolicLink: false }),
      realpath: async (p) => p,
      readdir: async () => [],
      readFile: async () => "",
      rm: async () => {},
      unlink: async () => {},
      glob: async () => [],
    };

    cmd = {
      run: async (c, args) => {
        // Default: status is clean, commits are pushed
        if (args.includes("status")) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args.includes("--contains")) {
          return { stdout: "origin/feature", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    };

    clock = {
      now: () => Date.now(),
    };

    gitHost = {
      getPrByBranch: async () => ({ number: 42, state: "merged", headSha: "abc123" }),
    };

    agents = {
      hasActiveRunAt: async () => false,
    };
  });

  it("never removes main worktree", async () => {
    const wt: WorktreeInfo = { path: "/repo", head: "abc", branch: "main", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("main worktree");
  });

  it("skips detached HEAD worktrees", async () => {
    const wt: WorktreeInfo = { path: "/repo-detached", head: "abc", branch: null, bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toContain("detached");
  });

  it("does not remove when after_merge is disabled", async () => {
    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      { ...settings, afterMerge: false },
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("after_merge is disabled");
  });

  it("does not remove when PR is open", async () => {
    gitHost.getPrByBranch = async () => ({ number: 42, state: "open", headSha: "abc" });
    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("PR is still open");
  });

  it("does not remove when there are uncommitted changes", async () => {
    cmd.run = async (c, args) => {
      if (args.includes("status")) {
        return { stdout: "M src/file.ts", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("has uncommitted or untracked changes");
  });

  it("does not remove when commits are not pushed", async () => {
    cmd.run = async (c, args) => {
      if (args.includes("status")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args.includes("--contains")) {
        return { stdout: "", stderr: "", code: 0 }; // No remote contains it
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("commits not on remote");
  });

  it("does not remove when agent run is active", async () => {
    agents.hasActiveRunAt = async () => true;
    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toBe("active agent run");
  });

  it("does not remove when modified within min_idle_hours", async () => {
    // Modified 2 hours ago, but min is 24
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    fsys.stat = async () => ({ mtimeMs: twoHoursAgo, isDirectory: true, isSymbolicLink: false });
    // Also need to mock reading the gitdir HEAD
    fsys.lstat = async () => ({ mtimeMs: twoHoursAgo, isDirectory: false, isSymbolicLink: false });
    fsys.readFile = async () => "gitdir: /repo/.git/worktrees/feature";

    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(false);
    expect(result.reason).toContain("modified");
    expect(result.reason).toContain("2.0h ago");
  });

  it("marks worktree as removable when all checks pass", async () => {
    // 48 hours ago
    const oldTime = Date.now() - 48 * 60 * 60 * 1000;
    fsys.stat = async () => ({ mtimeMs: oldTime, isDirectory: true, isSymbolicLink: false });
    fsys.lstat = async (p) => {
      if (p.endsWith("/.git")) {
        return { mtimeMs: oldTime, isDirectory: false, isSymbolicLink: false };
      }
      if (p.endsWith("/HEAD")) {
        return { mtimeMs: oldTime, isDirectory: false, isSymbolicLink: false };
      }
      return { mtimeMs: oldTime, isDirectory: true, isSymbolicLink: false };
    };
    fsys.readFile = async (p) => {
      if (p.endsWith("/.git")) {
        return "gitdir: /repo/.git/worktrees/feature";
      }
      return "";
    };

    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(true);
    expect(result.reason).toContain("eligible for removal");
    expect(result.pr).toEqual({ number: 42, state: "merged", headSha: "abc123" });
  });

  it("removes closed PR worktree", async () => {
    gitHost.getPrByBranch = async () => ({ number: 42, state: "closed", headSha: "abc" });
    const oldTime = Date.now() - 48 * 60 * 60 * 1000;
    fsys.stat = async () => ({ mtimeMs: oldTime, isDirectory: true, isSymbolicLink: false });
    fsys.lstat = async (p) => {
      if (p.endsWith("/HEAD")) {
        return { mtimeMs: oldTime, isDirectory: false, isSymbolicLink: false };
      }
      return { mtimeMs: oldTime, isDirectory: false, isSymbolicLink: false };
    };
    fsys.readFile = async () => "gitdir: /repo/.git/worktrees/feature";

    const wt: WorktreeInfo = { path: "/repo-feature", head: "abc", branch: "feature", bare: false };
    const result = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      "project",
      wt,
      "/repo",
      settings,
      "https://github.com/owner/repo.git",
    );
    expect(result.removable).toBe(true);
    expect(result.pr?.state).toBe("closed");
  });
});
