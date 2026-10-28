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
    const result = await checkPathSafety(fsys, "relative/path", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is not absolute");
  });

  it("rejects system directories", async () => {
    fsys.files.set("/", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is a system directory");
  });

  it("rejects home directory", async () => {
    const home = process.env.HOME || "/Users/test";
    fsys.files.set(home, { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, home, [home]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is the home directory");
  });

  it("rejects non-existent paths", async () => {
    const result = await checkPathSafety(fsys, "/root/missing", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path does not exist");
  });

  it("rejects paths outside configured roots", async () => {
    fsys.files.set("/other/path", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/other/path", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toContain("outside configured roots");
  });

  it("rejects the configured root itself", async () => {
    fsys.files.set("/root", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/root", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toBe("path is a configured root");
  });

  it("accepts paths inside configured roots", async () => {
    fsys.files.set("/root/subdir", { isDir: true, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/root/subdir", ["/root"]);
    expect(result.safe).toBe(true);
    if (!result.safe) throw new Error("expected safe");
    expect(result.realPath).toBe("/root/subdir");
  });

  it("accepts paths inside any of multiple roots", async () => {
    fsys.files.set("/root2/file", { isDir: false, isSymlink: false, mtimeMs: 0 });
    const result = await checkPathSafety(fsys, "/root2/file", ["/root1", "/root2"]);
    expect(result.safe).toBe(true);
  });

  it("rejects symlinks pointing outside roots", async () => {
    fsys.files.set("/outside/target", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/root/link", {
      isDir: false,
      isSymlink: true,
      target: "/outside/target",
      mtimeMs: 0,
    });
    const result = await checkPathSafety(fsys, "/root/link", ["/root"]);
    expect(result.safe).toBe(false);
    if (result.safe) throw new Error("expected unsafe");
    expect(result.violation.reason).toContain("symlink target");
    expect(result.violation.reason).toContain("outside configured roots");
  });

  it("accepts symlinks pointing inside roots", async () => {
    fsys.files.set("/root/target", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/root/link", {
      isDir: false,
      isSymlink: true,
      target: "/root/target",
      mtimeMs: 0,
    });
    const result = await checkPathSafety(fsys, "/root/link", ["/root"]);
    expect(result.safe).toBe(true);
    if (!result.safe) throw new Error("expected safe");
    expect(result.realPath).toBe("/root/target");
  });

  it("rejects broken symlinks", async () => {
    fsys.files.set("/root/link", {
      isDir: false,
      isSymlink: true,
      target: "/root/missing",
      mtimeMs: 0,
    });
    // realpath will throw because target doesn't exist
    const origRealpath = fsys.realpath;
    fsys.realpath = async (p) => {
      if (p === "/root/link") throw new Error("ENOENT");
      return origRealpath(p);
    };
    const result = await checkPathSafety(fsys, "/root/link", ["/root"]);
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

  it("returns true for directory with .git dir", async () => {
    fsys.files.set("/repo", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/repo/.git", { isDir: true, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/repo")).toBe(true);
  });

  it("returns true for worktree with .git file", async () => {
    fsys.files.set("/worktree", { isDir: true, isSymlink: false, mtimeMs: 0 });
    fsys.files.set("/worktree/.git", { isDir: false, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/worktree")).toBe(true);
  });

  it("returns false for directory without .git", async () => {
    fsys.files.set("/notrepo", { isDir: true, isSymlink: false, mtimeMs: 0 });
    expect(await isGitRepoRoot(fsys, "/notrepo")).toBe(false);
  });
});
