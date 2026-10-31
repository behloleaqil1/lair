/**
 * Checks service: the core logic for running pre-gate checks.
 *
 * Agents request checks with their bus token. The service:
 * - Validates the request (active run, kind, branch, the run's branch, selector, limits)
 * - Refuses a sha that is not on the branch as pushed to the remote
 * - Queues the check (fair FIFO per kind, max_concurrent per kind)
 * - Runs the guard before each run (and again before the infrastructure retry)
 * - Runs the check, without a shell, in the project's repository
 * - Returns results through long-poll
 * - Prunes old results and their output directories (off the request path)
 */
import { join, relative, isAbsolute } from "path";
import type { EventBus } from "../core/event-bus.js";
import type { BusTokenBinding } from "../bus/tokens.js";
import {
  buildCommand,
  validateBranchName,
  validateSelector,
  type CheckKindConfig,
  type ParsedChecksConfig,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_INFRASTRUCTURE,
  EXIT_GUARD_REFUSED,
} from "./config.js";
import { ChecksStore, CHECK_ID_PATTERN, CHECK_STATUSES, MAX_FAILING_TESTS, type CheckRequest, type CheckStatus } from "./store.js";
import { parseJUnitFailures } from "./junit.js";
import type { ShaCheck } from "./git.js";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  durationMs?: number;
  failingTests: string[];
  logTail: string;
}

export interface RetentionSettings {
  /** Finished checks older than this are pruned */
  maxAgeMs: number;
  /** At most this many checks are kept (checks younger than a day are never pruned by count) */
  maxRows: number;
  /** How often the prune runs (also once at start) */
  intervalMs: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxRows: 10_000,
  intervalMs: 60 * 60 * 1000,
};

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
  /** Whether a sha is on a branch as pushed to a remote (git.ts shaOnPushedBranch in production) */
  validateSha: (sha: string, branch: string, remote: string) => Promise<ShaCheck>;
  /** Whether the run is active in the agents module for this agent (required: there is no permissive default) */
  isRunActive: (runId: string, agent: string) => boolean;
  retention?: Partial<RetentionSettings>;
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
  run(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut?: boolean }>;
}

export interface Clock {
  now(): number;
}

/** The filesystem as the service uses it: every call is async and every read is bounded. */
export interface ChecksFs {
  /** At most `maxBytes` of the file as UTF-8, or null when it can't be read */
  readFile(path: string, maxBytes: number): Promise<string | null>;
  /** The names in a directory, or null when it can't be read */
  readDir(path: string): Promise<string[] | null>;
  mkdir(path: string): Promise<void>;
  /** Remove a directory and everything in it; no error when it is missing */
  remove(path: string): Promise<void>;
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

type Waiter = { wake: () => void; timeout: NodeJS.Timeout };

/** Max waiters per check (long-poll limit) */
const MAX_WAITERS_PER_CHECK = 10;
/** Guard timeout in milliseconds */
export const GUARD_TIMEOUT_MS = 30_000;
/** Max refusals per agent per hour; past it nothing more is written for that agent */
export const MAX_REFUSALS_PER_AGENT_HOUR = 100;
/** JUnit reads: per file, in total, and how many files */
export const MAX_JUNIT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_JUNIT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_JUNIT_FILES = 100;
/** How long stop() waits for checks in flight to end before it returns */
export const STOP_WAIT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
/** Rows this recent are never pruned by count: the hourly and daily limits read them */
const RATE_WINDOW_MS = 25 * HOUR_MS;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A glob for a file name (* and ?), as a whole-name regex: every other character is literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function statusOf(result: SpawnResult): CheckStatus {
  if (result.timedOut) return "timeout";
  switch (result.exitCode) {
    case EXIT_PASS:
      return "pass";
    case EXIT_FAIL:
      return "fail";
    case EXIT_INFRASTRUCTURE:
      return "infrastructure";
    case EXIT_GUARD_REFUSED:
      return "guard";
    case 2: // Usage/validation error from the project script
      return "refused";
    default:
      // A signal or any other exit: never a pass
      return "fail";
  }
}

function emptyCounts(): { total: number; byStatus: Record<CheckStatus, number>; byKind: Record<string, number> } {
  return { total: 0, byStatus: Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>, byKind: {} };
}

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
  private validateSha: (sha: string, branch: string, remote: string) => Promise<ShaCheck>;
  private isRunActive: (runId: string, agent: string) => boolean;
  private retention: RetentionSettings;
  private pollWaiters = new Map<string, Waiter[]>();
  /** Checks this instance is running (stop() kills and records them) */
  private runningChecks = new Set<string>();
  /** Work in flight (runs, sha checks, prunes): stop() waits for it before the store closes */
  private inflight = new Set<Promise<unknown>>();
  /** Git calls one at a time (a fetch updates a ref) */
  private gitQueue: Promise<unknown> = Promise.resolve();
  private pruneTimer: NodeJS.Timeout | null = null;
  private pruning = false;
  private stopped = false;

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
    this.isRunActive = options.isRunActive;
    this.retention = { ...DEFAULT_RETENTION, ...(options.retention ?? {}) };
  }

  isEnabled(): boolean {
    return this.config.kinds.size > 0;
  }

  /**
   * Start the service: reconcile checks a previous instance left running,
   * run what is queued, and prune old results now and every interval.
   * Called at server startup.
   */
  start(): void {
    const now = this.clock.now();
    // Mark any checks left running by a crash or restart as infrastructure failures
    const runningCount = this.store.reconcileRunningChecks("server restarted", now);
    if (runningCount > 0 && this.events) {
      this.events.emit("check.reconciled", { project: this.store.project, count: runningCount });
    }
    for (const kind of this.config.kinds.keys()) this.pump(kind);
    this.track(this.prune());
    this.pruneTimer = setInterval(() => this.track(this.prune()), this.retention.intervalMs);
    this.pruneTimer.unref?.();
  }

  /**
   * Stop the service: running checks are recorded as interrupted and killed,
   * waiters are answered, and the work in flight is awaited (at most
   * STOP_WAIT_MS) so the caller can close the store afterwards.
   */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      if (this.pruneTimer) clearInterval(this.pruneTimer);
      this.pruneTimer = null;
      const now = this.clock.now();
      for (const id of this.runningChecks) {
        this.store.completeCheck(id, "infrastructure", undefined, [], "server stopping", now);
        this.spawner.kill(id);
      }
      for (const waiters of this.pollWaiters.values()) {
        for (const w of [...waiters]) w.wake();
      }
      this.pollWaiters.clear();
    }
    await this.settle();
  }

  private async settle(): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...this.inflight]), deadline]);
    if (timer) clearTimeout(timer);
  }

  /** Keep `work` in flight until it settles; errors are logged, never unhandled. */
  private track<T>(work: Promise<T>, after?: () => void): void {
    const tracked: Promise<unknown> = work
      .catch((e) => console.error(`[checks] ${this.store.project}: ${message(e)}`))
      .finally(() => {
        this.inflight.delete(tracked);
        after?.();
      });
    this.inflight.add(tracked);
  }

  private serialGit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  async requestCheck(
    binding: BusTokenBinding,
    kind: string,
    sha: string,
    branch: string | undefined,
    tests: string[],
  ): Promise<CheckServiceResult<{ id: string }>> {
    if (this.stopped || !this.isEnabled()) {
      return { ok: false, error: { code: "disabled", message: "Checks module is not configured" } };
    }
    const now = this.clock.now();

    // Refused requests are limited first: past the limit nothing more is written for this agent
    if (this.store.countAgentRefusals(binding.agent, now - HOUR_MS) >= MAX_REFUSALS_PER_AGENT_HOUR) {
      return { ok: false, error: { code: "rate_limit", message: "Too many refused requests in the last hour" } };
    }

    const refuse = (code: CheckError["code"], reason: string): CheckServiceResult<{ id: string }> => {
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, this.clock.now());
      return { ok: false, error: { code, message: reason } as CheckError };
    };

    const kindConfig = this.config.kinds.get(kind);
    if (!kindConfig) return refuse("bad_request", `Unknown check kind: ${kind}`);

    // The run must be active in the agents module (a token that was never revoked is not enough)
    if (!this.isRunActive(binding.runId, binding.agent)) return refuse("forbidden", "run is no longer active");

    if (branch === undefined || branch === "") {
      return refuse("bad_request", "branch is required: the branch the sha is pushed to");
    }
    const branchCheck = validateBranchName(branch);
    if (!branchCheck.valid) return refuse("bad_request", `invalid branch: ${branchCheck.reason}`);

    // A run tests one branch: the one its first accepted check named
    const bound = this.store.getRunBranch(binding.runId);
    if (bound !== null && bound !== branch) {
      return refuse("forbidden", `this run tests branch "${bound}", not "${branch}"`);
    }

    const selectorResult = validateSelector(tests, kindConfig.tests);
    if (!selectorResult.valid) return refuse("bad_request", selectorResult.reason);

    // Limits before git: an agent can't buy unlimited git calls
    const limited = this.limitReason(binding.agent, kind, kindConfig, now);
    if (limited) return refuse("rate_limit", limited);

    let shaCheck: ShaCheck;
    const validation = this.serialGit(() => this.validateSha(sha, branch, kindConfig.remote));
    this.track(validation);
    try {
      shaCheck = await validation;
    } catch (e) {
      shaCheck = { ok: false, reason: `sha check error: ${message(e)}` };
    }
    if (this.stopped) {
      return { ok: false, error: { code: "disabled", message: "Checks module is stopping" } };
    }
    if (!shaCheck.ok) return refuse("forbidden", shaCheck.reason);

    // From here on everything is synchronous: the limits, the binding and the insert can't interleave
    const at = this.clock.now();
    if (!this.isRunActive(binding.runId, binding.agent)) return refuse("forbidden", "run is no longer active");
    const limitedNow = this.limitReason(binding.agent, kind, kindConfig, at);
    if (limitedNow) return refuse("rate_limit", limitedNow);
    const runBranch = this.store.bindRunBranch(binding.runId, binding.agent, branch, at);
    if (runBranch !== branch) return refuse("forbidden", `this run tests branch "${runBranch}", not "${branch}"`);

    const id = this.store.createCheck(kind, binding.agent, binding.runId, sha, branch, tests, at);
    if (this.events) {
      this.events.emit("check.requested", {
        project: binding.project, id, kind, agent: binding.agent, sha, tests: tests.length,
      });
    }
    this.pump(kind);
    return { ok: true, data: { id } };
  }

  private limitReason(agent: string, kind: string, kindConfig: CheckKindConfig, now: number): string | null {
    const hourly = this.store.countAgentHourly(agent, kind, now - HOUR_MS);
    if (hourly >= kindConfig.max_per_agent_per_hour) {
      return `rate limit: ${hourly}/${kindConfig.max_per_agent_per_hour} per hour`;
    }
    const daily = kindConfig.budget.daily_limit;
    if (daily) {
      const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
      const count = this.store.countDailyChecks(kind, dayStart);
      if (count >= daily) return `daily budget exceeded: ${count}/${daily}`;
    }
    return null;
  }

  /**
   * Get a check result, optionally with long-poll.
   * Token-bound: only the requesting run's agent or the owner (tokenBinding null) can read it.
   */
  async getCheck(
    id: string,
    tokenBinding: BusTokenBinding | null,
    waitMs?: number,
  ): Promise<CheckServiceResult<CheckResult>> {
    if (this.stopped || !this.isEnabled()) {
      return { ok: false, error: { code: "disabled", message: "Checks module is not configured" } };
    }

    const check = this.store.getCheck(id);
    if (!check) {
      return { ok: false, error: { code: "not_found", message: `Check ${id} not found` } };
    }

    if (tokenBinding && (tokenBinding.runId !== check.runId || tokenBinding.agent !== check.agent)) {
      return { ok: false, error: { code: "forbidden", message: "Cannot read another agent's check" } };
    }

    if (!waitMs || (check.status !== "queued" && check.status !== "running")) {
      return { ok: true, data: this.toCheckResult(check) };
    }

    const waiters = this.pollWaiters.get(id) ?? [];
    if (waiters.length >= MAX_WAITERS_PER_CHECK) {
      return { ok: true, data: this.toCheckResult(check) };
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        wake: () => {
          clearTimeout(waiter.timeout);
          const list = this.pollWaiters.get(id);
          if (list) {
            const idx = list.indexOf(waiter);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) this.pollWaiters.delete(id);
          }
          try {
            const current = this.store.getCheck(id);
            resolve(current
              ? { ok: true, data: this.toCheckResult(current) }
              : { ok: false, error: { code: "not_found", message: `Check ${id} not found` } });
          } catch (e) {
            resolve({ ok: false, error: { code: "disabled", message: `Checks module is stopping: ${message(e)}` } });
          }
        },
        timeout: setTimeout(() => waiter.wake(), waitMs),
      };
      waiters.push(waiter);
      this.pollWaiters.set(id, waiters);
    });
  }

  /**
   * List checks (owner only in routes).
   */
  listChecks(options: { kind?: string; agent?: string; sha?: string; status?: CheckStatus; limit?: number }): CheckRequest[] {
    if (this.stopped || !this.isEnabled()) return [];
    return this.store.listChecks(options);
  }

  /**
   * Counts by status and kind over the stored checks (owner only in routes).
   */
  getStats(): { total: number; byStatus: Record<CheckStatus, number>; byKind: Record<string, number> } {
    if (this.stopped || !this.isEnabled()) return emptyCounts();
    return this.store.counts();
  }

  /**
   * Check if a sha has a passing check of a given kind.
   */
  hasPassingCheck(kind: string, sha: string): boolean {
    if (this.stopped || !this.isEnabled()) return false;
    return this.store.hasPassingCheck(kind, sha);
  }

  private toCheckResult(check: CheckRequest): CheckResult {
    return {
      id: check.id,
      status: check.status,
      durationMs: check.durationMs,
      failingTests: check.failingTests.map((name) => this.clean(name)),
      logTail: this.clean(check.refusalReason ?? check.logTail),
    };
  }

  /**
   * Cosmetic cleaning of command output for an agent: code fences and
   * tag-like markup are neutralised. This is not a prompt fence: whatever
   * puts a result into a prompt must wrap it as data (the bus tool will).
   */
  private clean(text: string): string {
    return text
      .replace(/```/g, "'''")
      .replace(/<\/?[a-z_-]+[^>]*>/gi, (m) => `[${m.slice(1, -1).replace(/[<>]/g, "")}]`);
  }

  /** Start queued checks of a kind while it has free slots. */
  private pump(kind: string): void {
    if (this.stopped) return;
    const kindConfig = this.config.kinds.get(kind);
    if (!kindConfig) return;
    while (this.store.countRunning(kind) < kindConfig.max_concurrent) {
      const next = this.store.getNextQueued(kind);
      if (!next) return;
      if (!this.store.startCheck(next.id, this.clock.now())) return;
      this.runningChecks.add(next.id);
      this.track(this.runCheck(next, kindConfig), () => {
        this.runningChecks.delete(next.id);
        this.pump(kind);
      });
    }
  }

  /** The guard's refusal, or null when the run may start. Fail closed: a timeout or an error refuses. */
  private async guard(kindConfig: CheckKindConfig): Promise<string | null> {
    const cmd = kindConfig.budget.guard_cmd;
    if (!cmd || cmd.length === 0) return null;
    try {
      const result = await this.guardRunner.run(cmd, this.repoDir, GUARD_TIMEOUT_MS);
      if (result.timedOut) return `guard refused: timed out after ${GUARD_TIMEOUT_MS / 1000} s`;
      if (result.exitCode !== 0) return `guard refused (exit ${result.exitCode}): ${result.output.slice(0, 200)}`;
      return null;
    } catch (e) {
      return `guard error: ${message(e)}`;
    }
  }

  /** One run of the command; a spawn error is returned as a string. */
  private async spawnOnce(
    argv: string[],
    check: CheckRequest,
    checkOutputDir: string,
    kindConfig: CheckKindConfig,
    retry: boolean,
  ): Promise<SpawnResult | string> {
    try {
      return await this.spawner.spawn(argv, {
        cwd: this.repoDir, // Run in the repository, not the output dir
        env: {
          CHECK_ID: check.id,
          CHECK_SHA: check.sha,
          CHECK_BRANCH: check.branch ?? "",
          CHECK_AGENT: check.agent,
          CHECK_OUTPUT_DIR: checkOutputDir,
          ...(retry ? { CHECK_RETRY: "1" } : {}),
        },
        timeoutMs: kindConfig.timeout_seconds * 1000,
      });
    } catch (e) {
      return `spawn error: ${message(e)}`;
    }
  }

  private async runCheck(check: CheckRequest, kindConfig: CheckKindConfig): Promise<void> {
    const checkOutputDir = join(this.outputDir, check.id);
    try {
      await this.fs.mkdir(checkOutputDir);
    } catch (e) {
      this.completeCheck(check.id, "infrastructure", undefined, [], `cannot create the output directory: ${message(e)}`);
      return;
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

    // The guard must exit 0 before a run starts
    const refusal = await this.guard(kindConfig);
    if (refusal) {
      this.completeCheck(check.id, "guard", undefined, [], refusal);
      return;
    }
    if (this.stopped) return;

    if (this.events) {
      this.events.emit("check.started", { project: check.project, id: check.id, kind: check.kind, agent: check.agent });
    }

    let result = await this.spawnOnce(argv, check, checkOutputDir, kindConfig, false);
    if (typeof result !== "string" && !result.timedOut && result.exitCode === EXIT_INFRASTRUCTURE && !this.stopped) {
      // Infrastructure: one retry, and the guard decides again before the paid command runs again
      const again = await this.guard(kindConfig);
      if (again) {
        this.completeCheck(check.id, "guard", undefined, [], again);
        return;
      }
      if (this.stopped) return;
      result = await this.spawnOnce(argv, check, checkOutputDir, kindConfig, true);
    }
    if (typeof result === "string") {
      this.completeCheck(check.id, "infrastructure", undefined, [], result);
      return;
    }

    const status = statusOf(result);
    const failingTests =
      status === "fail" && kindConfig.parse.junit_path
        ? await this.readJUnitFailures(checkOutputDir, kindConfig.parse.junit_path)
        : [];
    const output = result.stderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
    this.completeCheck(check.id, status, result.exitCode, failingTests, output);
  }

  /**
   * Read JUnit failures from the check's output directory. `junitPath` is
   * relative to it; its file name may be a glob (* and ?), e.g.
   * test-results/TEST-*.xml. Reads are bounded per file, in total and in
   * number of files.
   */
  private async readJUnitFailures(outputDir: string, junitPath: string): Promise<string[]> {
    const failures: string[] = [];
    const lastSlash = junitPath.lastIndexOf("/");
    const dir = lastSlash >= 0 ? join(outputDir, junitPath.slice(0, lastSlash)) : outputDir;
    const name = junitPath.slice(lastSlash + 1);
    if (!name || !isInside(outputDir, dir)) return [];

    let budget = MAX_JUNIT_TOTAL_BYTES;
    const readOne = async (path: string): Promise<void> => {
      const content = await this.fs.readFile(path, Math.min(MAX_JUNIT_FILE_BYTES, budget));
      if (!content) return;
      budget -= Buffer.byteLength(content);
      failures.push(...parseJUnitFailures(content));
    };

    if (name.includes("*") || name.includes("?")) {
      const regex = globToRegExp(name);
      const files = ((await this.fs.readDir(dir)) ?? []).filter((file) => regex.test(file)).sort();
      for (const file of files.slice(0, MAX_JUNIT_FILES)) {
        if (budget <= 0 || failures.length >= MAX_FAILING_TESTS) break;
        await readOne(join(dir, file));
      }
    } else {
      await readOne(join(dir, name));
    }

    return [...new Set(failures)].slice(0, MAX_FAILING_TESTS);
  }

  private completeCheck(id: string, status: CheckStatus, exitCode: number | undefined, failingTests: string[], logTail: string): void {
    // After stop() the check is recorded as interrupted and the store may be closing
    if (this.stopped) return;
    this.store.completeCheck(id, status, exitCode, failingTests, logTail, this.clock.now());
    const waiters = this.pollWaiters.get(id);
    if (waiters) {
      for (const w of [...waiters]) w.wake();
    }
    if (this.events) {
      const check = this.store.getCheck(id);
      if (check) {
        this.events.emit("check.completed", { project: check.project, id, kind: check.kind, agent: check.agent, status, durationMs: check.durationMs });
      }
    }
  }

  /**
   * Prune old results (age and count, see RetentionSettings), remove their
   * output directories, and remove output directories whose check is gone.
   * Runs at start and on a timer, never on the request path. Returns the
   * number of checks pruned.
   */
  async prune(): Promise<number> {
    if (this.stopped || this.pruning) return 0;
    this.pruning = true;
    try {
      const now = this.clock.now();
      const ids = this.store.pruneOldChecks({
        olderThan: now - this.retention.maxAgeMs,
        maxRows: this.retention.maxRows,
        keepSince: now - RATE_WINDOW_MS,
      });
      for (const id of ids) {
        if (this.stopped) return ids.length;
        await this.fs.remove(join(this.outputDir, id));
      }
      // Directories left by a prune that stopped half way (only names shaped like a check id)
      const names = (await this.fs.readDir(this.outputDir)) ?? [];
      for (const name of names) {
        if (this.stopped) break;
        if (CHECK_ID_PATTERN.test(name) && !this.store.getCheck(name)) {
          await this.fs.remove(join(this.outputDir, name));
        }
      }
      return ids.length;
    } finally {
      this.pruning = false;
    }
  }
}
