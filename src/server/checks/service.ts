/**
 * Checks service: the core logic for running pre-gate checks.
 *
 * Agents request checks with their bus token. The service:
 * - Validates the request (token, selector, limits, run active, branch match)
 * - Queues the check
 * - Runs the guard before each run (not at request time)
 * - Runs the check when a slot is free
 * - Returns results through long-poll
 */
import type { EventBus } from "../core/event-bus.js";
import type { BusTokenBinding } from "../bus/tokens.js";
import {
  buildCommand,
  validateSelector,
  type CheckKindConfig,
  type ParsedChecksConfig,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_INFRASTRUCTURE,
  EXIT_GUARD_REFUSED,
} from "./config.js";
import { ChecksStore, type CheckRequest, type CheckStatus, LOG_TAIL_LINES, MAX_FAILING_TESTS } from "./store.js";
import { parseJUnitFailures } from "./junit.js";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  durationMs?: number;
  failingTests: string[];
  logTail: string;
}

export interface ChecksServiceOptions {
  store: ChecksStore;
  config: ParsedChecksConfig;
  events?: EventBus;
  spawner: CheckSpawner;
  guardRunner: GuardRunner;
  clock: Clock;
  fs: ChecksFs;
  /** The directory for check outputs (per-check subdirs are created here) */
  outputDir: string;
  /** The project's repository directory (commands run here) */
  repoDir: string;
  /** Validate that a sha is reachable from a branch on the remote */
  validateSha: (sha: string, branch: string) => Promise<boolean>;
  /** Check if a run is still active in the agents module */
  isRunActive?: (runId: string) => boolean;
  /** Get the task/branch for a run from the agents module */
  getRunInfo?: (runId: string) => { task: string; branch?: string } | null;
}

export interface CheckSpawner {
  spawn(
    argv: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<SpawnResult>;
  kill(checkId: string): void;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
}

export interface GuardRunner {
  run(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }>;
}

export interface Clock {
  now(): number;
}

export interface ChecksFs {
  readFile(path: string): string | null;
  readDir(path: string): string[] | null;
  exists(path: string): boolean;
  mkdir(path: string): void;
}

export type CheckError =
  | { code: "unauthorized"; message: string }
  | { code: "forbidden"; message: string }
  | { code: "not_found"; message: string }
  | { code: "bad_request"; message: string }
  | { code: "rate_limit"; message: string }
  | { code: "guard"; message: string }
  | { code: "disabled"; message: string };

export type CheckServiceResult<T> = { ok: true; data: T } | { ok: false; error: CheckError };

type Waiter = { resolve: (result: CheckResult) => void; timeout: NodeJS.Timeout };

/** Max waiters per check (long-poll limit) */
const MAX_WAITERS_PER_CHECK = 10;
/** Guard timeout in milliseconds */
const GUARD_TIMEOUT_MS = 30_000;
/** Branch name validation pattern: no .., no leading - */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Max refusals per agent per hour (prevent spam) */
const MAX_REFUSALS_PER_AGENT_HOUR = 100;

export class ChecksService {
  private store: ChecksStore;
  private config: ParsedChecksConfig;
  private events?: EventBus;
  private spawner: CheckSpawner;
  private guardRunner: GuardRunner;
  private clock: Clock;
  private fs: ChecksFs;
  private outputDir: string;
  private repoDir: string;
  private validateSha: (sha: string, branch: string) => Promise<boolean>;
  private isRunActive: (runId: string) => boolean;
  private getRunInfo: (runId: string) => { task: string; branch?: string } | null;
  private pollWaiters = new Map<string, Waiter[]>();
  /** Running check ids, for concurrency tracking after restart */
  private runningChecks = new Set<string>();

  constructor(options: ChecksServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.events = options.events;
    this.spawner = options.spawner;
    this.guardRunner = options.guardRunner;
    this.clock = options.clock;
    this.fs = options.fs;
    this.outputDir = options.outputDir;
    this.repoDir = options.repoDir;
    this.validateSha = options.validateSha;
    this.isRunActive = options.isRunActive ?? (() => true);
    this.getRunInfo = options.getRunInfo ?? (() => null);
  }

  isEnabled(): boolean {
    return this.config.kinds.size > 0;
  }

  /**
   * Start the service: reconcile running checks from a previous instance.
   * Called at server startup.
   */
  start(): void {
    const now = this.clock.now();
    // Mark any checks left running by a crash as infrastructure failures
    const runningCount = this.store.reconcileRunningChecks("server restarted", now);
    if (runningCount > 0 && this.events) {
      this.events.emit("check.reconciled", { project: this.store.project, count: runningCount });
    }
    // Process any queued checks
    for (const kind of this.config.kinds.keys()) {
      void this.processQueue(kind);
    }
  }

  /**
   * Stop the service: mark running checks as interrupted.
   */
  stop(): void {
    const now = this.clock.now();
    for (const id of this.runningChecks) {
      this.store.completeCheck(id, "infrastructure", undefined, [], "server stopping", now);
      this.spawner.kill(id);
    }
    this.runningChecks.clear();
    // Clear all waiters
    for (const [id, waiters] of this.pollWaiters) {
      const check = this.store.getCheck(id);
      if (check) {
        const result = this.toCheckResult(check);
        for (const w of waiters) {
          clearTimeout(w.timeout);
          w.resolve(result);
        }
      }
      this.pollWaiters.delete(id);
    }
  }

  async requestCheck(
    binding: BusTokenBinding,
    kind: string,
    sha: string,
    branch: string | undefined,
    tests: string[],
  ): Promise<CheckServiceResult<{ id: string }>> {
    const now = this.clock.now();

    if (!this.isEnabled()) {
      return { ok: false, error: { code: "disabled", message: "Checks module is not configured" } };
    }

    const kindConfig = this.config.kinds.get(kind);
    if (!kindConfig) {
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, "unknown kind", now);
      return { ok: false, error: { code: "bad_request", message: `Unknown check kind: ${kind}` } };
    }

    // Rate limit refusals per agent (before any validation that could be spammed)
    const hourAgo = now - 60 * 60 * 1000;
    const refusalCount = this.store.countAgentRefusals(binding.agent, hourAgo);
    if (refusalCount >= MAX_REFUSALS_PER_AGENT_HOUR) {
      // Don't record this one to prevent unbounded growth
      return { ok: false, error: { code: "rate_limit", message: "Too many refused requests" } };
    }

    // Verify the run is still active (not just "token not revoked")
    if (!this.isRunActive(binding.runId)) {
      const reason = "run is no longer active";
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "forbidden", message: reason } };
    }

    // Validate branch format
    if (branch !== undefined && !BRANCH_PATTERN.test(branch)) {
      const reason = "invalid branch name format";
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "bad_request", message: reason } };
    }

    // Check branch binding: the check's branch must match the run's task branch
    const runInfo = this.getRunInfo(binding.runId);
    if (runInfo?.branch && branch && runInfo.branch !== branch) {
      const reason = `branch "${branch}" does not match run's branch "${runInfo.branch}"`;
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "forbidden", message: reason } };
    }

    const selectorResult = validateSelector(tests, kindConfig.tests);
    if (!selectorResult.valid) {
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, selectorResult.reason, now);
      return { ok: false, error: { code: "bad_request", message: selectorResult.reason } };
    }

    // Check rate limits BEFORE validateSha (which runs git)
    const hourlyCount = this.store.countAgentHourly(binding.agent, kind, hourAgo);
    if (hourlyCount >= kindConfig.max_per_agent_per_hour) {
      const reason = `rate limit: ${hourlyCount}/${kindConfig.max_per_agent_per_hour} per hour`;
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "rate_limit", message: reason } };
    }

    if (kindConfig.budget.daily_limit) {
      const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
      const dailyCount = this.store.countDailyChecks(kind, dayStart);
      if (dailyCount >= kindConfig.budget.daily_limit) {
        const reason = `daily budget exceeded: ${dailyCount}/${kindConfig.budget.daily_limit}`;
        this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
        return { ok: false, error: { code: "rate_limit", message: reason } };
      }
    }

    // Validate sha is on the branch (now that rate limits passed)
    const effectiveBranch = branch ?? runInfo?.branch ?? "HEAD";
    const shaValid = await this.validateSha(sha, effectiveBranch);
    if (!shaValid) {
      const reason = `sha is not reachable from branch "${effectiveBranch}"`;
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "forbidden", message: reason } };
    }

    // Guard runs at run time, not request time (moved to runCheck)

    const id = this.store.createCheck(kind, binding.agent, binding.runId, sha, branch, tests, now);

    if (this.events) {
      this.events.emit("check.requested", {
        project: binding.project, id, kind, agent: binding.agent, sha, tests: tests.length,
      });
    }

    void this.processQueue(kind);
    return { ok: true, data: { id } };
  }

  /**
   * Get a check result, optionally with long-poll.
   * Token-bound: only the requesting agent or the owner can read it.
   */
  async getCheck(
    id: string,
    tokenBinding: BusTokenBinding | null,
    waitMs?: number,
  ): Promise<CheckServiceResult<CheckResult>> {
    if (!this.isEnabled()) {
      return { ok: false, error: { code: "disabled", message: "Checks module is not configured" } };
    }

    const check = this.store.getCheck(id);
    if (!check) {
      return { ok: false, error: { code: "not_found", message: `Check ${id} not found` } };
    }

    // If token provided, verify it matches the check's run/agent
    if (tokenBinding && (tokenBinding.runId !== check.runId || tokenBinding.agent !== check.agent)) {
      return { ok: false, error: { code: "forbidden", message: "Cannot read another agent's check" } };
    }

    if (!waitMs || (check.status !== "queued" && check.status !== "running")) {
      return { ok: true, data: this.toCheckResult(check) };
    }

    // Limit waiters per check
    const existingWaiters = this.pollWaiters.get(id) ?? [];
    if (existingWaiters.length >= MAX_WAITERS_PER_CHECK) {
      return { ok: true, data: this.toCheckResult(check) };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.pollWaiters.get(id);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.timeout === timeout);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.pollWaiters.delete(id);
        }
        const current = this.store.getCheck(id);
        resolve({ ok: true, data: this.toCheckResult(current ?? check) });
      }, waitMs);

      const waiters = this.pollWaiters.get(id) ?? [];
      waiters.push({ resolve: (r) => { clearTimeout(timeout); resolve({ ok: true, data: r }); }, timeout });
      this.pollWaiters.set(id, waiters);
    });
  }

  /**
   * List checks (owner only in routes).
   */
  listChecks(options: { kind?: string; agent?: string; sha?: string; status?: CheckStatus; limit?: number }): CheckRequest[] {
    if (!this.isEnabled()) return [];
    return this.store.listChecks(options);
  }

  /**
   * Get stats (owner only in routes).
   */
  getStats(): { total: number; byStatus: Record<CheckStatus, number>; byKind: Record<string, number> } {
    if (!this.isEnabled()) {
      return { total: 0, byStatus: { queued: 0, running: 0, pass: 0, fail: 0, infrastructure: 0, timeout: 0, guard: 0, refused: 0 }, byKind: {} };
    }
    const all = this.store.listChecks({ limit: 1000 });
    const byStatus: Record<CheckStatus, number> = { queued: 0, running: 0, pass: 0, fail: 0, infrastructure: 0, timeout: 0, guard: 0, refused: 0 };
    const byKind: Record<string, number> = {};
    for (const c of all) { byStatus[c.status]++; byKind[c.kind] = (byKind[c.kind] ?? 0) + 1; }
    return { total: all.length, byStatus, byKind };
  }

  /**
   * Check if a sha has a passing check of a given kind.
   */
  hasPassingCheck(kind: string, sha: string): boolean {
    if (!this.isEnabled()) return false;
    return this.store.hasPassingCheck(kind, sha);
  }

  private toCheckResult(check: CheckRequest): CheckResult {
    return {
      id: check.id,
      status: check.status,
      durationMs: check.durationMs,
      failingTests: check.failingTests,
      logTail: this.sanitizeLogTail(check.logTail),
    };
  }

  private sanitizeLogTail(log: string): string {
    // Replace code fences and potential prompt injection patterns
    return log
      .replace(/```/g, "'''")
      .replace(/<\/?[a-z_-]+[^>]*>/gi, (m) => `[${m.slice(1, -1).replace(/[<>]/g, "")}]`)
      .slice(-LOG_TAIL_LINES * 200);
  }

  private async processQueue(kind: string): Promise<void> {
    const kindConfig = this.config.kinds.get(kind);
    if (!kindConfig) return;
    // Use in-memory tracking for running count (survives restart reconciliation)
    const running = this.store.countRunning(kind);
    if (running >= kindConfig.max_concurrent) return;
    const next = this.store.getNextQueued(kind);
    if (!next) return;
    await this.runCheck(next, kindConfig);
    void this.processQueue(kind);
  }

  private async runCheck(check: CheckRequest, kindConfig: CheckKindConfig): Promise<void> {
    const now = this.clock.now();
    if (!this.store.startCheck(check.id, now)) return;
    this.runningChecks.add(check.id);

    // Create per-check output directory
    const checkOutputDir = `${this.outputDir}/${check.id}`;
    try { this.fs.mkdir(checkOutputDir); } catch { /* ignore */ }

    // Run guard BEFORE spawn (brief: "must exit 0 before a run starts")
    if (kindConfig.budget.guard_cmd && kindConfig.budget.guard_cmd.length > 0) {
      try {
        const guardResult = await this.guardRunner.run(kindConfig.budget.guard_cmd, this.repoDir, GUARD_TIMEOUT_MS);
        if (guardResult.exitCode !== 0) {
          const reason = `guard refused: ${guardResult.output.slice(0, 200)}`;
          this.completeCheck(check.id, "guard", undefined, [], reason);
          return;
        }
      } catch (e) {
        // Guard failed to run (timeout, error): fail closed
        const reason = `guard error: ${e instanceof Error ? e.message : String(e)}`;
        this.completeCheck(check.id, "guard", undefined, [], reason);
        return;
      }
    }

    const argv = buildCommand(kindConfig.command, {
      sha: check.sha,
      branch: check.branch,
      tests: check.tests.join(" "),
      agent: check.agent,
      check_id: check.id,
      output_dir: checkOutputDir,
    });
    if (!argv) {
      this.completeCheck(check.id, "refused", undefined, [], "command build failed");
      return;
    }

    if (this.events) {
      this.events.emit("check.started", { project: check.project, id: check.id, kind: check.kind, agent: check.agent });
    }

    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(argv, {
        cwd: this.repoDir, // Run in repo dir, not output dir
        env: {
          CHECK_ID: check.id,
          CHECK_SHA: check.sha,
          CHECK_BRANCH: check.branch ?? "",
          CHECK_AGENT: check.agent,
          CHECK_OUTPUT_DIR: checkOutputDir,
        },
        timeoutMs: kindConfig.timeout_seconds * 1000,
      });
    } catch (e) {
      this.completeCheck(check.id, "infrastructure", undefined, [], `spawn error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (result.timedOut) {
      this.completeCheck(check.id, "timeout", undefined, [], result.stderr.slice(-2000) || result.stdout.slice(-2000));
      return;
    }

    let status: CheckStatus;
    let failingTests: string[] = [];
    switch (result.exitCode) {
      case EXIT_PASS:
        status = "pass";
        break;
      case EXIT_FAIL:
        status = "fail";
        if (kindConfig.parse.junit_path) {
          failingTests = this.readJUnitFailures(checkOutputDir, kindConfig.parse.junit_path);
        }
        break;
      case EXIT_INFRASTRUCTURE:
        status = await this.retryOnce(check, kindConfig, argv, checkOutputDir);
        break;
      case EXIT_GUARD_REFUSED:
        status = "guard";
        break;
      case 2: // Usage/validation error from the project script
        status = "refused";
        break;
      default:
        status = "fail";
    }
    this.completeCheck(check.id, status, result.exitCode, failingTests, (result.stderr || result.stdout).slice(-LOG_TAIL_LINES * 200));
  }

  /**
   * Read JUnit failures from the output directory.
   * Supports glob patterns (e.g., TEST-*.xml) by reading all matching files.
   */
  private readJUnitFailures(outputDir: string, junitPath: string): string[] {
    const failures: string[] = [];

    // Check if it's a glob pattern
    if (junitPath.includes("*")) {
      // Get the directory and pattern
      const lastSlash = junitPath.lastIndexOf("/");
      const dir = lastSlash >= 0 ? `${outputDir}/${junitPath.slice(0, lastSlash)}` : outputDir;
      const pattern = lastSlash >= 0 ? junitPath.slice(lastSlash + 1) : junitPath;

      // Convert glob to regex
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

      const files = this.fs.readDir(dir);
      if (files) {
        // Limit files read to prevent unbounded work
        let filesRead = 0;
        for (const file of files) {
          if (filesRead >= 100) break;
          if (regex.test(file)) {
            const content = this.fs.readFile(`${dir}/${file}`);
            if (content) {
              failures.push(...parseJUnitFailures(content));
              filesRead++;
            }
          }
        }
      }
    } else {
      // Single file path
      const content = this.fs.readFile(`${outputDir}/${junitPath}`);
      if (content) {
        failures.push(...parseJUnitFailures(content));
      }
    }

    // Dedupe and limit
    return [...new Set(failures)].slice(0, MAX_FAILING_TESTS);
  }

  private async retryOnce(check: CheckRequest, kindConfig: CheckKindConfig, argv: string[], checkOutputDir: string): Promise<CheckStatus> {
    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(argv, {
        cwd: this.repoDir,
        env: {
          CHECK_ID: check.id,
          CHECK_SHA: check.sha,
          CHECK_BRANCH: check.branch ?? "",
          CHECK_AGENT: check.agent,
          CHECK_OUTPUT_DIR: checkOutputDir,
          CHECK_RETRY: "1",
        },
        timeoutMs: kindConfig.timeout_seconds * 1000,
      });
    } catch {
      return "infrastructure";
    }
    if (result.timedOut) return "timeout";
    if (result.exitCode === EXIT_PASS) return "pass";
    if (result.exitCode === EXIT_FAIL) return "fail";
    if (result.exitCode === EXIT_GUARD_REFUSED) return "guard"; // Guard on retry = guard, not infra
    return "infrastructure";
  }

  private completeCheck(id: string, status: CheckStatus, exitCode: number | undefined, failingTests: string[], logTail: string): void {
    this.runningChecks.delete(id);
    const now = this.clock.now();
    this.store.completeCheck(id, status, exitCode, failingTests, logTail, now);
    const waiters = this.pollWaiters.get(id);
    if (waiters) {
      const check = this.store.getCheck(id);
      if (check) {
        const r = this.toCheckResult(check);
        for (const w of waiters) {
          clearTimeout(w.timeout);
          w.resolve(r);
        }
      }
      this.pollWaiters.delete(id);
    }
    if (this.events) {
      const check = this.store.getCheck(id);
      if (check) {
        this.events.emit("check.completed", { project: check.project, id, kind: check.kind, agent: check.agent, status, durationMs: check.durationMs });
      }
    }
  }
}
