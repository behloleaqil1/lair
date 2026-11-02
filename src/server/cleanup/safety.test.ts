import { describe, it, expect, beforeEach } from "vitest";
import { checkPathSafety, isInsidePath, isGitRepoRoot } from "./safety.js";
import type { FileSystem } from "./probes.js";

function createFakeFs(): FileSystem & {
  files: Map<string, { isDir: boolean; isSymlink: boolean; target?: string; mtimeMs: number }>;
} {
  const files = new Map<
    string,
    { isDir: boolean; isSymlink: boolean; target?: string; mtimeMs: number }
  >();

  return {
    files,
    exists: async (p) => files.has(p),
    stat: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      // Follow symlinks
      if (f.isSymlink && f.target) {
        const target = files.get(f.target);
        if (!target) throw new Error(`ENOENT: ${f.target}`);
        return { mtimeMs: target.mtimeMs, isDirectory: target.isDir, isSymbolicLink: false };
      }
      return { mtimeMs: f.mtimeMs, isDirectory: f.isDir, isSymbolicLink: f.isSymlink };
    },
    lstat: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: f.mtimeMs, isDirectory: f.isDir, isSymbolicLink: f.isSymlink };
    },
    realpath: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      if (f.isSymlink && f.target) {
        const target = files.get(f.target);
        if (!target) throw new Error(`ENOENT: ${f.target}`);
        return f.target;
      }
      return p;
    },
    readdir: async () => [],
    readFile: async () => "",
    rm: async () => {},
    unlink: async () => {},
    glob: async () => [],
  };
}

describe("isInsidePath", () => {
  it("returns true for child path", () => {
    expect(isInsidePath("/a/b/c", "/a/b")).toBe(true);
    expect(isInsidePath("/a/b/c/d", "/a")).toBe(true);
  });

  it("returns false for equal paths", () => {
    expect(isInsidePath("/a/b", "/a/b")).toBe(false);
    expect(isInsidePath("/a/b/", "/a/b")).toBe(false);
  });

  it("returns false for sibling paths", () => {
    expect(isInsidePath("/a/c", "/a/b")).toBe(false);
  });

  it("returns false for parent paths", () => {
    expect(isInsidePath("/a", "/a/b")).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(isInsidePath("/a/b/c", "/a/b/")).toBe(true);
    expect(isInsidePath("/a/b/c/", "/a/b")).toBe(true);
  });

  it("rejects path prefix tricks", () => {
    // /a/bb is not inside /a/b
    expect(isInsidePath("/a/bb", "/a/b")).toBe(false);
    expect(isInsidePath("/a/b-extra", "/a/b")).toBe(false);
  });
});

describe("checkPathSafety", () => {
  let fsys: ReturnType<typeof createFakeFs>;

  beforeEach(() => {
    fsys = createFakeFs();
  });

  it("rejects relative paths", async () => {
    const result = await checkPathSafety(fsys, "relative/path", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is not absolute");
  });

  it("rejects system directories", async () => {
    fsys.files.set("/", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is a system directory");
  });

  it("rejects home directory", async () => {
    const home = process.env.HOME || "/home/user";
    fsys.files.set(home, { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, home, [home]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is the home directory");
  });

  it("rejects non-existent paths", async () => {
    const result = await checkPathSafety(fsys, "/myroot/missing", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path does not exist");
  });

  it("rejects paths outside configured roots", async () => {
    fsys.files.set("/other/path", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/other/path", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toContain("outside configured roots");
  });

  it("rejects the configured root itself", async () => {
    // Use a non-system directory path (not in FORBIDDEN_PATHS like /root which is a system dir)
    fsys.files.set("/myproject", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/myproject", ["/myproject"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is a configured root");
  });

  it("accepts paths inside configured roots", async () => {
    fsys.files.set("/myroot/subdir", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/myroot/subdir", ["/myroot"]);
    expect(result.safe).toBe(true);
    if (!result.safe) throw new Error("expected safe");
    expect(result.realPath).toBe("/myroot/subdir");
  });

  it("accepts paths inside any of multiple roots", async () => {
    fsys.files.set("/myroot2/file", { isDir: false, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/myroot2/file", ["/myroot1", "/myroot2"]);
    expect(result.safe).toBe(true);
  });

  it("rejects symlinks pointing outside roots", async () => {
    fsys.files.set("/outside/target", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/myroot/link", {
      isDir: false,
      isSymlink: true,
      target: "/outside/target",
      mtimeMs: 0,
    });
    const result = await checkPathSafety(fsys, "/myroot/link", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toContain("symlink target");
    expect(result.violation.reason).toContain("outside configured roots");
  });

  it("accepts symlinks pointing inside roots", async () => {
    fsys.files.set("/myroot/target", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/myroot/link", {
      isDir: false,
      isSymlink: true,
      target: "/myroot/target",
      mtimeMs: 0,
    });
    const result = await checkPathSafety(fsys, "/myroot/link", ["/myroot"]);
    expect(result.safe).toBe(true);
    if (!result.safe) throw new Error("expected safe");
    expect(result.realPath).toBe("/myroot/target");
  });

  it("rejects broken symlinks", async () => {
    fsys.files.set("/myroot/link", {
      isDir: false,
      isSymlink: true,
      target: "/myroot/missing",
      mtimeMs: 0,
    });
    // realpath will throw because target doesn't exist
    const origRealpath = fsys.realpath;
    fsys.realpath = async (p) => {
      if (p === "/myroot/link") throw new Error("ENOENT");
      return origRealpath(p);
    };
    const result = await checkPathSafety(fsys, "/myroot/link", ["/myroot"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("symlink target does not exist");
  });
});

describe("isGitRepoRoot", () => {
  let fsys: ReturnType<typeof createFakeFs>;

  beforeEach(() => {
    fsys = createFakeFs();
  });

  it("returns true for directory with .git dir (main repo)", async () => {
    fsys.files.set("/repo", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/repo/.git", { isDir: true, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/repo")).toBe(true);
  });

  it("returns false for worktree with .git file (linked worktree)", async () => {
    // Linked worktrees have a .git FILE that points to the main repo's gitdir
    // These are safe to remove, so isGitRepoRoot returns false
    fsys.files.set("/worktree", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/worktree/.git", { isDir: false, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/worktree")).toBe(false);
  });

  it("returns false for directory without .git", async () => {
    fsys.files.set("/notrepo", { isDir: true, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/notrepo")).toBe(false);
  });
});
