/**
 * Retention entry enumeration and reference checks.
 */
import * as path from "path";
import type { Clock, FileSystem, CommandRunner } from "./probes.js";
import { getWorktreeHeadMtime } from "./probes.js";
import type { RetentionEntry } from "./config.js";

/** A candidate for removal under a retention rule */
export interface RetentionCandidate {
  path: string;
  entryPath: string; // The retention rule's path
  kind: "worktree" | "dir" | "file";
  removable: boolean;
  reason: string;
  lastUsedMs: number;
  sizeBytes: number;
}

/**
 * Get the "last used" time for an entry.
 * For worktrees: the gitdir HEAD's mtime (last checkout).
 * For dirs/files: the entry's mtime.
 */
async function getLastUsed(
  fsys: FileSystem,
  entryPath: string,
  kind: "worktree" | "dir" | "file",
): Promise<number> {
  if (kind === "worktree") {
    const headMtime = await getWorktreeHeadMtime(fsys, entryPath);
    if (headMtime !== null) {
      return headMtime;
    }
  }

  try {
    const stat = await fsys.stat(entryPath);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Estimate directory size by counting entries (accurate size would be slow).
 */
async function estimateSize(
  fsys: FileSystem,
  entryPath: string,
  kind: "worktree" | "dir" | "file",
): Promise<number> {
  if (kind === "file") {
    // Can't get size from our interface, estimate
    return 4096;
  }

  try {
    const entries = await fsys.readdir(entryPath);
    // Rough estimate: 4KB per entry
    return entries.length * 4096;
  } catch {
    return 0;
  }
}

/**
 * Check if an entry name appears in any reference file.
 */
async function isReferenced(
  fsys: FileSystem,
  entryName: string,
  skipPatterns: string[],
): Promise<boolean> {
  for (const pattern of skipPatterns) {
    try {
      const files = await fsys.glob(pattern);
      for (const file of files) {
        const content = await fsys.readFile(file);
        if (content.includes(entryName)) {
          return true;
        }
      }
    } catch {
      // Glob or read failed, continue
    }
  }
  return false;
}

/**
 * Check if an entry is removable under a retention rule.
 */
export async function checkRetentionEntry(
  fsys: FileSystem,
  clock: Clock,
  entryPath: string,
  entryName: string,
  rule: RetentionEntry,
): Promise<RetentionCandidate> {
  const base: RetentionCandidate = {
    path: entryPath,
    entryPath: rule.path,
    kind: rule.kind,
    removable: false,
    reason: "",
    lastUsedMs: 0,
    sizeBytes: 0,
  };

  // Check existence
  const exists = await fsys.exists(entryPath);
  if (!exists) {
    return { ...base, reason: "does not exist" };
  }

  // Get last used time
  const lastUsed = await getLastUsed(fsys, entryPath, rule.kind);
  base.lastUsedMs = lastUsed;

  // Check age
  const ageMs = clock.now() - lastUsed;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < rule.keepDays) {
    return {
      ...base,
      reason: `used ${ageDays.toFixed(1)} days ago (keep: ${rule.keepDays} days)`,
    };
  }

  // Check references
  if (rule.skipIfReferenced.length > 0) {
    const referenced = await isReferenced(fsys, entryName, rule.skipIfReferenced);
    if (referenced) {
      return { ...base, reason: "referenced by active work" };
    }
  }

  // Estimate size
  base.sizeBytes = await estimateSize(fsys, entryPath, rule.kind);

  return {
    ...base,
    removable: true,
    reason: `unused for ${ageDays.toFixed(1)} days`,
  };
}

/**
 * Get all retention candidates under a retention rule's path.
 */
export async function getRetentionCandidates(
  fsys: FileSystem,
  clock: Clock,
  rule: RetentionEntry,
): Promise<RetentionCandidate[]> {
  const candidates: RetentionCandidate[] = [];

  try {
    const entries = await fsys.readdir(rule.path);
    for (const entry of entries) {
      const entryPath = path.join(rule.path, entry);
      
      // Check if entry type matches the rule
      try {
        const stat = await fsys.lstat(entryPath);
        
        // Skip symlinks
        if (stat.isSymbolicLink) {
          candidates.push({
            path: entryPath,
            entryPath: rule.path,
            kind: rule.kind,
            removable: false,
            reason: "symlink (skipped)",
            lastUsedMs: stat.mtimeMs,
            sizeBytes: 0,
          });
          continue;
        }

        // For file rules, skip directories; for dir/worktree rules, skip files
        if (rule.kind === "file" && stat.isDirectory) {
          continue;
        }
        if ((rule.kind === "dir" || rule.kind === "worktree") && !stat.isDirectory) {
          continue;
        }
      } catch {
        continue;
      }

      const candidate = await checkRetentionEntry(fsys, clock, entryPath, entry, rule);
      candidates.push(candidate);
    }
  } catch {
    // Can't read the directory
  }

  return candidates;
}

/**
 * Remove a retention entry.
 */
export async function removeRetentionEntry(
  fsys: FileSystem,
  cmd: CommandRunner,
  entryPath: string,
  repoPath: string | null,
  kind: "worktree" | "dir" | "file",
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (kind === "worktree" && repoPath) {
      // Use git worktree remove
      const result = await cmd.run("git", ["worktree", "remove", "--force", entryPath], {
        cwd: repoPath,
        timeout: 60000,
      });
      if (result.code !== 0) {
        return { ok: false, error: result.stderr || "git worktree remove failed" };
      }
    } else if (kind === "file") {
      await fsys.unlink(entryPath);
    } else {
      // Directory
      await fsys.rm(entryPath, { recursive: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
