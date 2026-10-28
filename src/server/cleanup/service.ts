/**
 * Cleanup service: the tick loop that runs cleanup cycles.
 */
import type { Clock, FileSystem, CommandRunner, GitHost } from "./probes.js";
import type { CleanupSettings } from "./config.js";
import { getConfiguredRoots } from "./config.js";
import { checkPathSafety, isGitRepoRoot, type SafetyViolation } from "./safety.js";
import {
  getWorktreeCandidates,
  removeWorktree,
  pruneWorktrees,
  type AgentClaims,
  type WorktreeCandidate,
} from "./worktree.js";
import {
  getRetentionCandidates,
  removeRetentionEntry,
  type RetentionCandidate,
} from "./retention.js";
import { CleanupStore, type CleanupRemoval } from "./store.js";

export interface CleanupEvent {
  type: "cleanup.removed" | "cleanup.cycle" | "cleanup.safety_violation";
  project: string;
  data: unknown;
}

export interface EventEmitter {
  emit(event: CleanupEvent): void;
}

export interface AuditLogger {
  log(project: string, action: string, details: string): void;
}

/** Summary of what cleanup would or did remove */
export interface CleanupPending {
  worktrees: WorktreeCandidate[];
  retention: RetentionCandidate[];
  totalBytes: number;
  totalEntries: number;
}

/** Result of a cleanup cycle */
export interface CleanupCycleResult {
  cycleId: string;
  mode: "observe" | "act";
  entriesRemoved: number;
  bytesFreed: number;
  entriesSkipped: number;
  safetyViolations: SafetyViolation[];
  durationMs: number;
}

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private project: string,
    private settings: CleanupSettings,
    private fsys: FileSystem,
    private cmd: CommandRunner,
    private clock: Clock,
    private gitHost: GitHost,
    private agents: AgentClaims,
    private store: CleanupStore,
    private events: EventEmitter,
    private audit: AuditLogger,
  ) {}

  /** Start the cleanup service */
  start(): void {
    if (this.timer) return;
    if (!this.settings.enabled) return;

    // Mark any incomplete cycles from a previous run
    const incomplete = this.store.getIncompleteCycles(this.project);
    for (const cycle of incomplete) {
      this.store.markCycleIncomplete(cycle.id);
    }

    // Run immediately, then on interval
    this.runCycle().catch((err) => {
      console.error(`[cleanup] cycle error for ${this.project}:`, err);
    });

    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        console.error(`[cleanup] cycle error for ${this.project}:`, err);
      });
    }, this.settings.intervalSeconds * 1000);
  }

  /** Stop the cleanup service */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get what cleanup would remove (for dashboard) */
  async getPending(): Promise<CleanupPending> {
    const worktrees: WorktreeCandidate[] = [];
    const retention: RetentionCandidate[] = [];

    // Gather worktree candidates
    for (const repoPath of this.settings.worktrees.repos) {
      try {
        const candidates = await getWorktreeCandidates(
          this.fsys,
          this.cmd,
          this.clock,
          this.gitHost,
          this.agents,
          this.project,
          repoPath,
          this.settings.worktrees,
        );
        worktrees.push(...candidates.filter((c) => c.removable));
      } catch {
        // Skip repos we can't read
      }
    }

    // Gather retention candidates
    for (const rule of this.settings.retention) {
      try {
        const candidates = await getRetentionCandidates(this.fsys, this.clock, rule);
        retention.push(...candidates.filter((c) => c.removable));
      } catch {
        // Skip paths we can't read
      }
    }

    // Filter out already-removed paths
    const allPaths = [...worktrees.map((w) => w.path), ...retention.map((r) => r.path)];
    const alreadyRemoved = this.store.getRemovalsByPaths(this.project, allPaths);

    const filteredWorktrees = worktrees.filter((w) => !alreadyRemoved.has(w.path));
    const filteredRetention = retention.filter((r) => !alreadyRemoved.has(r.path));

    const totalBytes =
      filteredRetention.reduce((sum, r) => sum + r.sizeBytes, 0) +
      filteredWorktrees.length * 50 * 1024 * 1024; // Estimate 50MB per worktree

    return {
      worktrees: filteredWorktrees,
      retention: filteredRetention,
      totalBytes,
      totalEntries: filteredWorktrees.length + filteredRetention.length,
    };
  }

  /** Run a cleanup cycle */
  async runCycle(): Promise<CleanupCycleResult> {
    const startTime = this.clock.now();
    const cycle = this.store.startCycle(this.project, this.settings.mode);
    const roots = getConfiguredRoots(this.settings);

    let entriesRemoved = 0;
    let bytesFreed = 0;
    let entriesSkipped = 0;
    const safetyViolations: SafetyViolation[] = [];
    const prunedRepos = new Set<string>();

    const shouldStop = () => {
      if (entriesRemoved >= this.settings.maxEntriesPerCycle) return true;
      if (this.clock.now() - startTime > this.settings.maxSecondsPerCycle * 1000) return true;
      return false;
    };

    // Process worktrees
    for (const repoPath of this.settings.worktrees.repos) {
      if (shouldStop()) break;

      try {
        const candidates = await getWorktreeCandidates(
          this.fsys,
          this.cmd,
          this.clock,
          this.gitHost,
          this.agents,
          this.project,
          repoPath,
          this.settings.worktrees,
        );

        for (const candidate of candidates) {
          if (shouldStop()) break;
          if (!candidate.removable) {
            entriesSkipped++;
            continue;
          }

          // Check if already removed
          if (this.store.wasRemoved(this.project, candidate.path)) {
            continue;
          }

          // Safety check
          const safety = await checkPathSafety(this.fsys, candidate.path, roots);
          if (!safety.safe) {
            safetyViolations.push(safety.violation);
            this.events.emit({
              type: "cleanup.safety_violation",
              project: this.project,
              data: safety.violation,
            });
            continue;
          }

          // Check it's not a repo root
          if (await isGitRepoRoot(this.fsys, candidate.path)) {
            const violation = { path: candidate.path, reason: "is a git repository root" };
            safetyViolations.push(violation);
            this.events.emit({
              type: "cleanup.safety_violation",
              project: this.project,
              data: violation,
            });
            continue;
          }

          // Remove in act mode, record in both modes
          const estimatedBytes = 50 * 1024 * 1024; // 50MB estimate
          const removalRecord: Omit<CleanupRemoval, "id"> = {
            project: this.project,
            path: candidate.path,
            kind: "worktree",
            reason: candidate.reason,
            bytesFreed: estimatedBytes,
            removedAt: this.clock.now(),
          };

          if (this.settings.mode === "act") {
            const result = await removeWorktree(this.cmd, repoPath, candidate.path);
            if (result.ok) {
              this.store.recordRemoval(removalRecord);
              entriesRemoved++;
              bytesFreed += estimatedBytes;
              prunedRepos.add(repoPath);
              this.audit.log(
                this.project,
                "cleanup.remove",
                `worktree ${candidate.path}: ${candidate.reason}`,
              );
              this.events.emit({
                type: "cleanup.removed",
                project: this.project,
                data: removalRecord,
              });
            } else {
              entriesSkipped++;
            }
          } else {
            // Observe mode: just count
            entriesRemoved++;
            bytesFreed += estimatedBytes;
          }
        }
      } catch (err) {
        console.error(`[cleanup] error processing repo ${repoPath}:`, err);
      }
    }

    // Process retention entries
    for (const rule of this.settings.retention) {
      if (shouldStop()) break;

      try {
        const candidates = await getRetentionCandidates(this.fsys, this.clock, rule);

        for (const candidate of candidates) {
          if (shouldStop()) break;
          if (!candidate.removable) {
            entriesSkipped++;
            continue;
          }

          // Check if already removed
          if (this.store.wasRemoved(this.project, candidate.path)) {
            continue;
          }

          // Safety check
          const safety = await checkPathSafety(this.fsys, candidate.path, roots);
          if (!safety.safe) {
            safetyViolations.push(safety.violation);
            this.events.emit({
              type: "cleanup.safety_violation",
              project: this.project,
              data: safety.violation,
            });
            continue;
          }

          // For worktree kind, check it's not a repo root
          if (rule.kind === "worktree" && (await isGitRepoRoot(this.fsys, candidate.path))) {
            const violation = { path: candidate.path, reason: "is a git repository root" };
            safetyViolations.push(violation);
            continue;
          }

          const removalRecord: Omit<CleanupRemoval, "id"> = {
            project: this.project,
            path: candidate.path,
            kind: rule.kind,
            reason: candidate.reason,
            bytesFreed: candidate.sizeBytes,
            removedAt: this.clock.now(),
          };

          if (this.settings.mode === "act") {
            // Find the repo path for worktree entries
            const repoPath = rule.kind === "worktree" ? this.findRepoForPath(rule.path) : null;
            const result = await removeRetentionEntry(
              this.fsys,
              this.cmd,
              candidate.path,
              repoPath,
              rule.kind,
            );
            if (result.ok) {
              this.store.recordRemoval(removalRecord);
              entriesRemoved++;
              bytesFreed += candidate.sizeBytes;
              if (repoPath) prunedRepos.add(repoPath);
              this.audit.log(
                this.project,
                "cleanup.remove",
                `${rule.kind} ${candidate.path}: ${candidate.reason}`,
              );
              this.events.emit({
                type: "cleanup.removed",
                project: this.project,
                data: removalRecord,
              });
            } else {
              entriesSkipped++;
            }
          } else {
            entriesRemoved++;
            bytesFreed += candidate.sizeBytes;
          }
        }
      } catch (err) {
        console.error(`[cleanup] error processing retention ${rule.path}:`, err);
      }
    }

    // Prune worktrees for each affected repo (act mode only)
    if (this.settings.mode === "act") {
      for (const repoPath of prunedRepos) {
        await pruneWorktrees(this.cmd, repoPath);
      }
    }

    const durationMs = this.clock.now() - startTime;
    this.store.finishCycle(cycle.id, entriesRemoved, bytesFreed, entriesSkipped);

    const result: CleanupCycleResult = {
      cycleId: cycle.id,
      mode: this.settings.mode,
      entriesRemoved,
      bytesFreed,
      entriesSkipped,
      safetyViolations,
      durationMs,
    };

    this.events.emit({
      type: "cleanup.cycle",
      project: this.project,
      data: result,
    });

    return result;
  }

  private findRepoForPath(dirPath: string): string | null {
    // Find which configured repo contains this path
    for (const repo of this.settings.worktrees.repos) {
      if (dirPath.startsWith(repo + "/") || dirPath === repo) {
        return repo;
      }
    }
    return null;
  }
}
