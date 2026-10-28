/**
 * Worktree enumeration and removability checks.
 */
import * as path from "path";
import type {
  Clock,
  FileSystem,
  CommandRunner,
  GitHost,
  WorktreeInfo,
} from "./probes.js";
import { parseWorktreeList, getWorktreeHeadMtime } from "./probes.js";
import type { WorktreesSettings } from "./config.js";

/** Why a worktree can or cannot be removed */
export interface WorktreeCandidate {
  path: string;
  branch: string | null;
  head: string;
  removable: boolean;
  reason: string;
  pr?: { number: number; state: "open" | "merged" | "closed" };
  lastModifiedMs?: number;
  isMain: boolean;
}

/** Interface for checking agent claims */
export interface AgentClaims {
  hasActiveRunAt(project: string, worktreePath: string): Promise<boolean>;
}

/** List worktrees for a repository */
export async function listWorktrees(
  cmd: CommandRunner,
  repoPath: string,
): Promise<WorktreeInfo[]> {
  const result = await cmd.run("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
    timeout: 10000,
  });
  if (result.code !== 0) {
    throw new Error(`git worktree list failed: ${result.stderr}`);
  }
  return parseWorktreeList(result.stdout);
}

/** Get the main worktree path for a repository */
export async function getMainWorktree(
  cmd: CommandRunner,
  repoPath: string,
): Promise<string> {
  const worktrees = await listWorktrees(cmd, repoPath);
  // The main worktree is listed first and doesn't have "worktree" in its gitdir
  // Actually, we can check: the main worktree's .git is a directory, linked ones have a .git file
  // For simplicity, assume the repo path itself is the main worktree
  // Or we can look for the one without a gitdir file
  const main = worktrees.find((w) => w.path === repoPath);
  return main?.path ?? repoPath;
}

/** Check if a worktree has uncommitted or untracked changes */
export async function hasChanges(
  cmd: CommandRunner,
  worktreePath: string,
): Promise<boolean> {
  const result = await cmd.run(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: worktreePath, timeout: 30000 },
  );
  if (result.code !== 0) {
    // Can't check, assume dirty
    return true;
  }
  return result.stdout.trim().length > 0;
}

/** Check if all commits on a branch are on the remote */
export async function isFullyPushed(
  cmd: CommandRunner,
  worktreePath: string,
  head: string,
  remoteBranch: string,
): Promise<boolean> {
  // Check if the head commit is reachable from the remote branch
  const result = await cmd.run(
    "git",
    ["branch", "-r", "--contains", head],
    { cwd: worktreePath, timeout: 30000 },
  );
  if (result.code !== 0) {
    return false;
  }
  // Check if any remote branch contains the commit
  return result.stdout.includes(remoteBranch) || result.stdout.trim().length > 0;
}

/** Parse github owner/repo from a git remote URL */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  // https://github.com/owner/repo
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

/** Get the origin remote URL */
export async function getOriginUrl(
  cmd: CommandRunner,
  repoPath: string,
): Promise<string | null> {
  const result = await cmd.run("git", ["remote", "get-url", "origin"], {
    cwd: repoPath,
    timeout: 5000,
  });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Check if a worktree is removable.
 */
export async function checkWorktreeRemovability(
  fsys: FileSystem,
  cmd: CommandRunner,
  clock: Clock,
  gitHost: GitHost,
  agents: AgentClaims,
  project: string,
  worktree: WorktreeInfo,
  mainWorktreePath: string,
  settings: WorktreesSettings,
  originUrl: string | null,
): Promise<WorktreeCandidate> {
  const base: WorktreeCandidate = {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    removable: false,
    reason: "",
    isMain: worktree.path === mainWorktreePath,
  };

  // Never remove the main worktree
  if (base.isMain) {
    return { ...base, reason: "main worktree" };
  }

  // Only process worktrees with branches for after_merge cleanup
  if (!worktree.branch) {
    return { ...base, reason: "detached HEAD (handled by retention only)" };
  }

  if (!settings.afterMerge) {
    return { ...base, reason: "after_merge is disabled" };
  }

  // Check if PR is merged or closed
  if (originUrl) {
    const github = parseGithubRemote(originUrl);
    if (github) {
      const pr = await gitHost.getPrByBranch(github.owner, github.repo, worktree.branch);
      base.pr = pr ?? undefined;

      if (!pr) {
        return { ...base, reason: "no PR found for branch" };
      }

      if (pr.state === "open") {
        return { ...base, reason: "PR is still open" };
      }
    }
  }

  // Check for uncommitted changes
  const dirty = await hasChanges(cmd, worktree.path);
  if (dirty) {
    return { ...base, reason: "has uncommitted or untracked changes" };
  }

  // Check if fully pushed
  const pushed = await isFullyPushed(cmd, worktree.path, worktree.head, `origin/${worktree.branch}`);
  if (!pushed) {
    return { ...base, reason: "commits not on remote" };
  }

  // Check for active agent runs
  const hasRun = await agents.hasActiveRunAt(project, worktree.path);
  if (hasRun) {
    return { ...base, reason: "active agent run" };
  }

  // Check idle time
  const headMtime = await getWorktreeHeadMtime(fsys, worktree.path);
  if (headMtime !== null) {
    base.lastModifiedMs = headMtime;
    const idleMs = clock.now() - headMtime;
    const idleHours = idleMs / (1000 * 60 * 60);
    if (idleHours < settings.minIdleHours) {
      return {
        ...base,
        reason: `modified ${idleHours.toFixed(1)}h ago (min: ${settings.minIdleHours}h)`,
      };
    }
  }

  // All checks passed
  const prInfo = base.pr ? ` (PR #${base.pr.number} ${base.pr.state})` : "";
  return {
    ...base,
    removable: true,
    reason: `eligible for removal${prInfo}`,
  };
}

/**
 * Get all worktree candidates for a repository.
 */
export async function getWorktreeCandidates(
  fsys: FileSystem,
  cmd: CommandRunner,
  clock: Clock,
  gitHost: GitHost,
  agents: AgentClaims,
  project: string,
  repoPath: string,
  settings: WorktreesSettings,
): Promise<WorktreeCandidate[]> {
  const worktrees = await listWorktrees(cmd, repoPath);
  const mainPath = await getMainWorktree(cmd, repoPath);
  const originUrl = await getOriginUrl(cmd, repoPath);

  const candidates: WorktreeCandidate[] = [];
  for (const wt of worktrees) {
    const candidate = await checkWorktreeRemovability(
      fsys,
      cmd,
      clock,
      gitHost,
      agents,
      project,
      wt,
      mainPath,
      settings,
      originUrl,
    );
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Remove a worktree using git worktree remove.
 */
export async function removeWorktree(
  cmd: CommandRunner,
  repoPath: string,
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await cmd.run("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoPath,
    timeout: 60000,
  });
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || "unknown error" };
  }
  return { ok: true };
}

/**
 * Prune stale worktree entries.
 */
export async function pruneWorktrees(
  cmd: CommandRunner,
  repoPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await cmd.run("git", ["worktree", "prune"], {
    cwd: repoPath,
    timeout: 30000,
  });
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || "unknown error" };
  }
  return { ok: true };
}
