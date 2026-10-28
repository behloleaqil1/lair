/**
 * The `cleanup:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#cleanup and docs/design/cleanup.md.
 */
import { z } from "zod";

/** A path argument: never read as an option, never empty */
const pathArg = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("-"), "must not start with '-'");

const WorktreesSchema = z
  .object({
    /** Paths to repositories whose worktrees are managed */
    repos: z.array(pathArg).default([]),
    /** Remove worktrees whose branch's PR is merged or closed */
    after_merge: z.boolean().default(true),
    /** Hours since last modification before a worktree is eligible */
    min_idle_hours: z.number().int().min(1).max(8760).default(24),
  })
  .strict();

const RetentionEntrySchema = z
  .object({
    /** Directory to scan */
    path: pathArg,
    /** Days to keep entries (based on last use, not mtime) */
    keep_days: z.number().int().min(1).max(3650),
    /** What the entries are */
    kind: z.enum(["worktree", "dir", "file"]),
    /** Glob patterns of files whose content names entries to keep */
    skip_if_referenced: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const CleanupSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** observe logs removals without executing; act removes */
    mode: z.enum(["observe", "act"]).default("observe"),
    /** Seconds between cleanup cycles */
    interval_seconds: z.number().int().min(60).max(86400).default(3600),
    /** Maximum entries removed per cycle (safety bound) */
    max_entries_per_cycle: z.number().int().min(1).max(1000).default(50),
    /** Maximum seconds per cycle before stopping */
    max_seconds_per_cycle: z.number().int().min(60).max(3600).default(600),
    /** Worktree cleanup settings */
    worktrees: WorktreesSchema.default({}),
    /** Retention rules for folders */
    retention: z.array(RetentionEntrySchema).default([]),
  })
  .strict();

type RawCleanup = z.infer<typeof CleanupSchema>;

export interface WorktreesSettings {
  repos: string[];
  afterMerge: boolean;
  minIdleHours: number;
}

export interface RetentionEntry {
  path: string;
  keepDays: number;
  kind: "worktree" | "dir" | "file";
  skipIfReferenced: string[];
}

export interface CleanupSettings {
  enabled: boolean;
  mode: "observe" | "act";
  intervalSeconds: number;
  maxEntriesPerCycle: number;
  maxSecondsPerCycle: number;
  worktrees: WorktreesSettings;
  retention: RetentionEntry[];
}

export type ParseResult =
  | { ok: true; settings: CleanupSettings }
  | { ok: false; errors: string[] };

function retentionErrors(index: number, entry: RawCleanup["retention"][number]): string[] {
  const at = `cleanup.retention[${index}]`;
  const errors: string[] = [];

  // Path must be absolute
  if (!entry.path.startsWith("/")) {
    errors.push(`${at}.path: must be an absolute path`);
  }

  // Skip patterns must be valid globs (basic check: no empty segments)
  for (let i = 0; i < entry.skip_if_referenced.length; i++) {
    const pattern = entry.skip_if_referenced[i];
    if (pattern.includes("//")) {
      errors.push(`${at}.skip_if_referenced[${i}]: invalid glob pattern (empty segment)`);
    }
  }

  return errors;
}

/** Validate a project's `cleanup:` block (undefined means disabled). */
export function parseCleanupConfig(raw: unknown): ParseResult {
  const parsed = CleanupSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `cleanup.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  // Validate repos are absolute paths
  for (let i = 0; i < value.worktrees.repos.length; i++) {
    const repo = value.worktrees.repos[i];
    if (!repo.startsWith("/")) {
      errors.push(`cleanup.worktrees.repos[${i}]: must be an absolute path`);
    }
  }

  // Validate retention entries
  for (let i = 0; i < value.retention.length; i++) {
    errors.push(...retentionErrors(i, value.retention[i]));
  }

  // Check for duplicate retention paths
  const seenPaths = new Set<string>();
  for (let i = 0; i < value.retention.length; i++) {
    const path = value.retention[i].path;
    if (seenPaths.has(path)) {
      errors.push(`cleanup.retention[${i}].path: ${path} is already configured`);
    }
    seenPaths.add(path);
  }

  // If enabled, must have something to clean
  if (value.enabled) {
    const hasWorktrees = value.worktrees.repos.length > 0 && value.worktrees.after_merge;
    const hasRetention = value.retention.length > 0;
    if (!hasWorktrees && !hasRetention) {
      errors.push(
        "cleanup: enabled is true but no worktree repos and no retention entries are configured",
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      intervalSeconds: value.interval_seconds,
      maxEntriesPerCycle: value.max_entries_per_cycle,
      maxSecondsPerCycle: value.max_seconds_per_cycle,
      worktrees: {
        repos: value.worktrees.repos,
        afterMerge: value.worktrees.after_merge,
        minIdleHours: value.worktrees.min_idle_hours,
      },
      retention: value.retention.map((entry) => ({
        path: entry.path,
        keepDays: entry.keep_days,
        kind: entry.kind,
        skipIfReferenced: entry.skip_if_referenced,
      })),
    },
  };
}

/**
 * Get all configured roots: repos from worktrees and paths from retention.
 * Used by safety checks.
 */
export function getConfiguredRoots(settings: CleanupSettings): string[] {
  const roots = new Set<string>();
  for (const repo of settings.worktrees.repos) {
    roots.add(repo);
  }
  for (const entry of settings.retention) {
    roots.add(entry.path);
  }
  return Array.from(roots);
}
