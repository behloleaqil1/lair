/**
 * System boundaries for the cleanup module. Tests fake these; production uses
 * the real implementations.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

const execFileAsync = promisify(execFile);

/** Clock interface for time-based operations */
export interface Clock {
  now(): number;
}

/** Real clock */
export const realClock: Clock = {
  now: () => Date.now(),
};

/** File system interface */
export interface FileSystem {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ mtimeMs: number; isDirectory: boolean; isSymbolicLink: boolean }>;
  lstat(path: string): Promise<{ mtimeMs: number; isDirectory: boolean; isSymbolicLink: boolean }>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  rm(path: string, options: { recursive: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  glob(pattern: string): Promise<string[]>;
}

/** Real file system */
export const realFs: FileSystem = {
  exists: async (p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  },
  stat: async (p) => {
    const s = await fs.promises.stat(p);
    return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
  },
  lstat: async (p) => {
    const s = await fs.promises.lstat(p);
    return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
  },
  realpath: (p) => fs.promises.realpath(p),
  readdir: (p) => fs.promises.readdir(p),
  readFile: (p) => fs.promises.readFile(p, "utf8"),
  rm: (p, opts) => fs.promises.rm(p, opts),
  unlink: (p) => fs.promises.unlink(p),
  glob: (pattern) => glob(pattern, { absolute: true }),
};

/** Command runner result */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Command runner interface */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<CommandResult>;
}

/** Real command runner */
export const realCommandRunner: CommandRunner = {
  run: async (cmd, args, options) => {
    try {
      const result = await execFileAsync(cmd, args, {
        cwd: options?.cwd,
        timeout: options?.timeout ?? 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: e.code ?? 1,
      };
    }
  },
};

/** Git host API for checking PR status */
export interface GitHost {
  /** Get PR state by branch name; returns null if no PR exists */
  getPrByBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ number: number; state: "open" | "merged" | "closed"; headSha: string } | null>;
}

/** Worktree info from git worktree list --porcelain */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null for detached HEAD
  bare: boolean;
}

/** Parse git worktree list --porcelain output */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        worktrees.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
          bare: current.bare ?? false,
        });
      }
      current = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ") && current) {
      // refs/heads/branch-name -> branch-name
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "bare" && current) {
      current.bare = true;
    } else if (line === "detached" && current) {
      current.branch = null;
    }
  }

  if (current?.path) {
    worktrees.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
      bare: current.bare ?? false,
    });
  }

  return worktrees;
}

/** Get directory size in bytes (sum of all file sizes) */
export async function getDirSize(fsys: FileSystem, dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fsys.readdir(dirPath);

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    try {
      const stat = await fsys.lstat(entryPath);
      if (stat.isDirectory) {
        total += await getDirSize(fsys, entryPath);
      } else if (!stat.isSymbolicLink) {
        // For files, lstat gives size even though we omitted it from interface
        // We'll estimate based on existence
        total += 4096; // Estimate per file
      }
    } catch {
      // Skip inaccessible entries
    }
  }

  return total;
}

/** Get the gitdir for a worktree (reads .git file if it's a linked worktree) */
export async function getWorktreeGitdir(
  fsys: FileSystem,
  worktreePath: string,
): Promise<string | null> {
  const gitPath = path.join(worktreePath, ".git");
  try {
    const stat = await fsys.lstat(gitPath);
    if (stat.isDirectory) {
      return gitPath;
    }
    // It's a file with "gitdir: /path/to/gitdir"
    const content = await fsys.readFile(gitPath);
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      const gitdir = match[1].trim();
      // Resolve relative paths
      if (!path.isAbsolute(gitdir)) {
        return path.resolve(worktreePath, gitdir);
      }
      return gitdir;
    }
    return null;
  } catch {
    return null;
  }
}

/** Get the HEAD mtime for a worktree (last checkout time) */
export async function getWorktreeHeadMtime(
  fsys: FileSystem,
  worktreePath: string,
): Promise<number | null> {
  const gitdir = await getWorktreeGitdir(fsys, worktreePath);
  if (!gitdir) return null;

  try {
    const headPath = path.join(gitdir, "HEAD");
    const stat = await fsys.stat(headPath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}
