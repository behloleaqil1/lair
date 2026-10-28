/**
 * Safety checks for the cleanup module. Every path is validated before removal.
 */
import * as path from "path";
import * as os from "os";
import type { FileSystem } from "./probes.js";

/** Paths that must never be removed */
const FORBIDDEN_PATHS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/private",
  "/cores",
]);

export interface SafetyViolation {
  path: string;
  reason: string;
}

export type SafetyResult =
  | { safe: true; realPath: string }
  | { safe: false; violation: SafetyViolation };

/**
 * Check if a path is safe for worktree removal.
 * This is simpler than the general path safety check because:
 * - Git has already verified this is a registered worktree
 * - We've already verified it's not the main worktree
 * - We just need to ensure it's not a system path
 */
export function checkWorktreeSafety(
  targetPath: string,
): SafetyResult {
  const home = os.homedir();

  // Must be absolute
  if (!path.isAbsolute(targetPath)) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is not absolute" },
    };
  }

  // Normalize the path
  const normalized = path.normalize(targetPath);

  // Check forbidden paths
  if (FORBIDDEN_PATHS.has(normalized)) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is a system directory" },
    };
  }

  // Check home directory
  if (normalized === home) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is the home directory" },
    };
  }

  return { safe: true, realPath: normalized };
}

/**
 * Check if a path is safe to remove. Returns the real path if safe.
 *
 * A path is safe when:
 * 1. It resolves to a real path (no broken symlinks)
 * 2. The real path is inside one of the configured roots
 * 3. It is not the root itself, /, $HOME, or a forbidden system path
 * 4. If it's a symlink, the target is also inside a configured root
 */
export async function checkPathSafety(
  fsys: FileSystem,
  targetPath: string,
  configuredRoots: string[],
): Promise<SafetyResult> {
  const home = os.homedir();

  // Must be absolute
  if (!path.isAbsolute(targetPath)) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is not absolute" },
    };
  }

  // Normalize the path
  const normalized = path.normalize(targetPath);

  // Check forbidden paths
  if (FORBIDDEN_PATHS.has(normalized)) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is a system directory" },
    };
  }

  // Check home directory
  if (normalized === home) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path is the home directory" },
    };
  }

  // Check if path exists
  const exists = await fsys.exists(targetPath);
  if (!exists) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path does not exist" },
    };
  }

  // Check if it's a symlink
  let realPath: string;
  try {
    const stat = await fsys.lstat(targetPath);
    if (stat.isSymbolicLink) {
      // Resolve the symlink
      try {
        realPath = await fsys.realpath(targetPath);
      } catch {
        return {
          safe: false,
          violation: { path: targetPath, reason: "symlink target does not exist" },
        };
      }

      // Check that the symlink target is inside a configured root
      const targetInRoot = configuredRoots.some((root) => isInsidePath(realPath, root));
      if (!targetInRoot) {
        return {
          safe: false,
          violation: {
            path: targetPath,
            reason: `symlink target ${realPath} is outside configured roots`,
          },
        };
      }
    } else {
      realPath = await fsys.realpath(targetPath);
    }
  } catch {
    return {
      safe: false,
      violation: { path: targetPath, reason: "cannot resolve path" },
    };
  }

  // Check the real path is inside a configured root
  const inRoot = configuredRoots.some((root) => isInsidePath(realPath, root));
  if (!inRoot) {
    return {
      safe: false,
      violation: {
        path: targetPath,
        reason: `path is outside configured roots (resolved to ${realPath})`,
      },
    };
  }

  // Check the real path is not a configured root itself
  for (const root of configuredRoots) {
    if (path.normalize(realPath) === path.normalize(root)) {
      return {
        safe: false,
        violation: { path: targetPath, reason: "path is a configured root" },
      };
    }
  }

  // Check for path traversal attempts
  if (normalized.includes("..")) {
    return {
      safe: false,
      violation: { path: targetPath, reason: "path contains traversal" },
    };
  }

  return { safe: true, realPath };
}

/**
 * Check if a path is inside a root directory.
 * Handles trailing slashes and normalization.
 */
export function isInsidePath(childPath: string, parentPath: string): boolean {
  // Normalize and strip trailing slashes for comparison
  let normalizedChild = path.normalize(childPath);
  let normalizedParent = path.normalize(parentPath);

  // Remove trailing slashes for consistent comparison
  if (normalizedChild.length > 1 && normalizedChild.endsWith("/")) {
    normalizedChild = normalizedChild.slice(0, -1);
  }
  if (normalizedParent.length > 1 && normalizedParent.endsWith("/")) {
    normalizedParent = normalizedParent.slice(0, -1);
  }

  // Must be strictly inside, not equal
  if (normalizedChild === normalizedParent) {
    return false;
  }

  // Add trailing slash to parent for proper prefix check
  const parentPrefix = normalizedParent + "/";

  return normalizedChild.startsWith(parentPrefix);
}

/**
 * Check if removing a path would be removing a git repository root.
 * A git repo root has a .git directory (main worktree) or .git file (linked worktree).
 */
export async function isGitRepoRoot(fsys: FileSystem, targetPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(targetPath, ".git");
    return await fsys.exists(gitPath);
  } catch {
    return false;
  }
}
