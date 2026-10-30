/**
 * Checks service: the core logic for running pre-gate checks.
 *
 * Agents request checks with their bus token. The service:
 * - Validates the request (token, selector, limits)
 * - Queues the check
 * - Runs it when a slot is free
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
import { ChecksStore, type CheckRequest, type CheckStatus, LOG_TAIL_LINES } from "./store.js";
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
  outputDir: string;
  validateSha: (sha: string) => Promise<boolean>;
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
  run(argv: string[], cwd: string): Promise<{ exitCode: number; output: string }>;
}

export interface Clock {
  now(): number;
}

export interface ChecksFs {
  readFile(path: string): string | null;
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

export class ChecksService {
  private store: ChecksStore;
  private config: ParsedChecksConfig;
  private events?: EventBus;
  private spawner: CheckSpawner;
  private guardRunner: GuardRunner;
  private clock: Clock;
  private fs: ChecksFs;
  private outputDir: string;
  private validateSha: (sha: string) => Promise<boolean>;
  private pollWaiters = new Map<string, Waiter[]>();

  constructor(options: ChecksServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.events = options.events;
    this.spawner = options.spawner;
    this.guardRunner = options.guardRunner;
    this.clock = options.clock;
    this.fs = options.fs;
    this.outputDir = options.outputDir;
    this.validateSha = options.validateSha;
  }

  isEnabled(): boolean {
    return this.config.kinds.size > 0;
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

    const selectorResult = validateSelector(tests, kindConfig.tests);
    if (!selectorResult.valid) {
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, selectorResult.reason, now);
      return { ok: false, error: { code: "bad_request", message: selectorResult.reason } };
    }

    const shaValid = await this.validateSha(sha);
    if (!shaValid) {
      const reason = "sha is not on a pushed branch of the repository";
      this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
      return { ok: false, error: { code: "forbidden", message: reason } };
    }

    const hourAgo = now - 60 * 60 * 1000;
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

    if (kindConfig.budget.guard_cmd && kindConfig.budget.guard_cmd.length > 0) {
      const guardResult = await this.guardRunner.run(kindConfig.budget.guard_cmd, this.outputDir);
      if (guardResult.exitCode !== 0) {
        const reason = `guard refused: ${guardResult.output.slice(0, 200)}`;
        this.store.createRefusedCheck(kind, binding.agent, binding.runId, sha, branch, tests, reason, now);
        return { ok: false, error: { code: "guard", message: reason } };
      }
    }

    const id = this.store.createCheck(kind, binding.agent, binding.runId, sha, branch, tests, now);

    if (this.events) {
      this.events.emit("check.requested", {
        project: binding.project, id, kind, agent: binding.agent, sha, tests: tests.length,
      });
    }

    void this.processQueue(kind);
    return { ok: true, data: { id } };
  }

  async getCheck(id: string, waitMs?: number): Promise<CheckServiceResult<CheckResult>> {
    const check = this.store.getCheck(id);
    if (!check) {
      return { ok: false, error: { code: "not_found", message: `Check ${id} not found` } };
    }

    if (!waitMs || (check.status !== "queued" && check.status !== "running")) {
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

  listChecks(options: { kind?: string; agent?: string; sha?: string; status?: CheckStatus; limit?: number }): CheckRequest[] {
    return this.store.listChecks(options);
  }

  getStats(): { total: number; byStatus: Record<CheckStatus, number>; byKind: Record<string, number> } {
    const all = this.store.listChecks({ limit: 1000 });
    const byStatus: Record<CheckStatus, number> = { queued: 0, running: 0, pass: 0, fail: 0, infrastructure: 0, timeout: 0, guard: 0, refused: 0 };
    const byKind: Record<string, number> = {};
    for (const c of all) { byStatus[c.status]++; byKind[c.kind] = (byKind[c.kind] ?? 0) + 1; }
    return { total: all.length, byStatus, byKind };
  }

  private toCheckResult(check: CheckRequest): CheckResult {
    return { id: check.id, status: check.status, durationMs: check.durationMs, failingTests: check.failingTests, logTail: this.sanitizeLogTail(check.logTail) };
  }

  private sanitizeLogTail(log: string): string {
    return log.replace(/```/g, "'''").replace(/<\/?[a-z_]+>/gi, (m) => `[${m.slice(1, -1)}]`).slice(-LOG_TAIL_LINES * 200);
  }

  private async processQueue(kind: string): Promise<void> {
    const kindConfig = this.config.kinds.get(kind);
    if (!kindConfig) return;
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

    const argv = buildCommand(kindConfig.command, { sha: check.sha, branch: check.branch, tests: check.tests.join(" "), agent: check.agent, check_id: check.id });
    if (!argv) { this.completeCheck(check.id, "refused", undefined, [], "command build failed"); return; }

    const checkOutputDir = `${this.outputDir}/${check.id}`;
    try { this.fs.mkdir(checkOutputDir); } catch { /* ignore */ }

    if (this.events) this.events.emit("check.started", { project: check.project, id: check.id, kind: check.kind, agent: check.agent });

    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(argv, { cwd: checkOutputDir, env: { CHECK_ID: check.id, CHECK_SHA: check.sha, CHECK_BRANCH: check.branch ?? "", CHECK_AGENT: check.agent }, timeoutMs: kindConfig.timeout_seconds * 1000 });
    } catch (e) { this.completeCheck(check.id, "infrastructure", undefined, [], `spawn error: ${e instanceof Error ? e.message : String(e)}`); return; }

    if (result.timedOut) { this.completeCheck(check.id, "timeout", undefined, [], result.stderr.slice(-2000) || result.stdout.slice(-2000)); return; }

    let status: CheckStatus;
    let failingTests: string[] = [];
    switch (result.exitCode) {
      case EXIT_PASS: status = "pass"; break;
      case EXIT_FAIL:
        status = "fail";
        if (kindConfig.parse.junit_path) {
          const content = this.fs.readFile(`${checkOutputDir}/${kindConfig.parse.junit_path}`);
          if (content) failingTests = parseJUnitFailures(content);
        }
        break;
      case EXIT_INFRASTRUCTURE: status = await this.retryOnce(check, kindConfig, argv, checkOutputDir); break;
      case EXIT_GUARD_REFUSED: status = "guard"; break;
      default: status = "fail";
    }
    this.completeCheck(check.id, status, result.exitCode, failingTests, (result.stderr || result.stdout).slice(-LOG_TAIL_LINES * 200));
  }

  private async retryOnce(check: CheckRequest, kindConfig: CheckKindConfig, argv: string[], checkOutputDir: string): Promise<CheckStatus> {
    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(argv, { cwd: checkOutputDir, env: { CHECK_ID: check.id, CHECK_SHA: check.sha, CHECK_BRANCH: check.branch ?? "", CHECK_AGENT: check.agent, CHECK_RETRY: "1" }, timeoutMs: kindConfig.timeout_seconds * 1000 });
    } catch { return "infrastructure"; }
    if (result.timedOut) return "timeout";
    if (result.exitCode === EXIT_PASS) return "pass";
    if (result.exitCode === EXIT_FAIL) return "fail";
    return "infrastructure";
  }

  private completeCheck(id: string, status: CheckStatus, exitCode: number | undefined, failingTests: string[], logTail: string): void {
    const now = this.clock.now();
    this.store.completeCheck(id, status, exitCode, failingTests, logTail, now);
    const waiters = this.pollWaiters.get(id);
    if (waiters) {
      const check = this.store.getCheck(id);
      if (check) { const r = this.toCheckResult(check); for (const w of waiters) { clearTimeout(w.timeout); w.resolve(r); } }
      this.pollWaiters.delete(id);
    }
    if (this.events) {
      const check = this.store.getCheck(id);
      if (check) this.events.emit("check.completed", { project: check.project, id, kind: check.kind, agent: check.agent, status, durationMs: check.durationMs });
    }
  }
}
