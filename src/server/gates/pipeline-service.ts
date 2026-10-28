/**
 * Gate pipeline runs (docs/design/runners.md): one PipelineManager for all
 * projects that define `pipelines:`.
 *
 * A run has one job per lane. Each job goes through the executor order of
 * its lane (the selector): GitHub Actions (an idle self-hosted runner, then
 * hosted runners within the minutes budget, then a busy self-hosted runner),
 * lair-node machines (not built yet), then the local machine. Every attempt
 * is stored before it starts; an attempt that falls back is proven not to
 * have run a step. In-flight jobs resume after a restart.
 */
import { randomBytes } from "crypto";
import type { EventBus } from "../core/event-bus.js";
import type { BudgetManager } from "../fleet/budget.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  ExecutorAvailability,
  ExecutorId,
  PipelineAttempt,
  PipelineRun,
  PipelineRunStatus,
  PipelinesStatus,
} from "../../shared/pipeline-types.js";
import { ExecFileRunner, systemClock, type Clock, type CommandRunner } from "../watchdog/probes.js";
import { EXECUTOR_KINDS, parsePipelineConfig, type LaneSettings, type ProjectPipelineSettings } from "./project-pipelines.js";
import { PipelineStore, isTerminalJob, type JobPatch } from "./run-store.js";
import { EventBusDecisionHook, type DecisionHook, type DecisionRequest } from "./decision-hook.js";
import {
  GITHUB_EXECUTORS,
  GitHubActionsExecutor,
  GitHubProvider,
  type GitHubExecutorId,
} from "./executors/github.js";
import { SHA_PATTERN, generateWorkflow, workflowVersion } from "./executors/github-workflow.js";
import { LocalExecutor, ProcessSpawner, SystemCapacityProbe } from "./executors/local.js";
import type {
  AttemptOutcome,
  AttemptReporter,
  CapacityProbe,
  Executor,
  HttpFetch,
  JobControl,
  JobSpec,
  Spawner,
} from "./executors/types.js";

const MIN = 60_000;
const IN_FLIGHT = new Set<PipelineAttempt["status"]>(["dispatching", "queued", "running", "cancelling"]);
export const NODES_NOT_BUILT = "lair-node cannot run pipeline jobs yet";
export const RUN_ID = /^run-[0-9a-f]{12}$/;

/** A request the routes map to an HTTP status */
export class PipelineRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PipelineRequestError";
  }
}

export interface PipelineProjectEntry {
  name: string;
  config?: ProjectConfig;
  error?: string;
}

export interface PipelineManagerOptions {
  /** SQLite file (data/pipelines.db), or ":memory:" */
  dbPath: string;
  events?: EventBus;
  /** The fleet budget: billed minutes are recorded as provider `github-actions:<project>` */
  budget?: BudgetManager;
  /** Where "needs decision" goes; default: the "decision.needed" event */
  decisions?: DecisionHook;
  /** The HTTP boundary to GitHub (default: global fetch) */
  fetch?: HttpFetch;
  /** Runs local step commands (default: child_process.spawn, no shell) */
  spawner?: Spawner;
  capacity?: CapacityProbe;
  clock?: Clock;
  /** Resolves a branch to a commit (git rev-parse) */
  git?: CommandRunner;
  /** Environment: the GitHub token variable and what local steps inherit */
  env?: NodeJS.ProcessEnv;
  /** Directory for data/pipelines/worktrees (default: the working directory) */
  lairDir?: string;
  /** GitHub API base URL (default https://api.github.com) */
  githubApiUrl?: string;
}

interface LoadedProject {
  name: string;
  config: ProjectConfig;
  settings: ProjectPipelineSettings;
  github: GitHubProvider;
  executors: Map<GitHubExecutorId, GitHubActionsExecutor>;
}

interface ActiveJob {
  controller: AbortController;
  cancelled: boolean;
  done: Promise<void>;
}

/** First instant of the calendar month (UTC) containing `ms` */
export function monthStartIso(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** The fleet budget provider for a project's GitHub-hosted minutes */
export function budgetProvider(project: string): string {
  return `github-actions:${project}`;
}

function newId(prefix: "run" | "job" | "dec"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sum = (attempts: PipelineAttempt[], key: "minutes" | "billedMinutes") =>
  attempts.reduce((total, a) => total + (a[key] ?? 0), 0);

export class PipelineManager {
  private projects = new Map<string, LoadedProject>();
  private problems = new Map<string, string[]>();
  private storeInstance: PipelineStore | null = null;
  private readonly local: LocalExecutor;
  private readonly clock: Clock;
  private readonly decisions: DecisionHook;
  private readonly git: CommandRunner;
  private active = new Map<string, ActiveJob>();
  /** Expected minutes of hosted attempts in flight, per project (budget reservations) */
  private hostedReserved = new Map<string, number>();
  private stopped = false;
  /** Set by start(): from then on a reload launches the project's waiting jobs */
  private started = false;

  constructor(private options: PipelineManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.decisions = options.decisions ?? new EventBusDecisionHook(options.events);
    this.git = options.git ?? new ExecFileRunner(30_000);
    this.local = new LocalExecutor({
      spawner: options.spawner ?? new ProcessSpawner(),
      capacity: options.capacity ?? new SystemCapacityProbe(),
      clock: this.clock,
      lairDir: options.lairDir ?? process.cwd(),
      env: options.env ?? process.env,
    });
  }

  private get store(): PipelineStore {
    this.storeInstance ??= new PipelineStore(this.options.dbPath);
    return this.storeInstance;
  }

  private iso(ms = this.clock.now()): string {
    return new Date(ms).toISOString();
  }

  /** Read every project's `pipelines:` and `executors:` blocks */
  load(entries: PipelineProjectEntry[]): void {
    const env = this.options.env ?? process.env;
    const fetchImpl: HttpFetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    for (const entry of entries) {
      const config = entry.config;
      if (!config) continue;
      if (config.pipelines === undefined && config.executors === undefined) continue;
      const parsed = parsePipelineConfig(config.pipelines, config.executors, config.github);
      if (!parsed.ok) {
        this.problems.set(entry.name, parsed.errors);
        console.warn(`[pipelines] ${entry.name}: not loaded: ${parsed.errors.join("; ")}`);
        continue;
      }
      const settings = parsed.settings;
      const github = new GitHubProvider({
        project: entry.name,
        settings,
        token: env[settings.executors.github.tokenEnv] || undefined,
        fetch: fetchImpl,
        clock: this.clock,
        baseUrl: this.options.githubApiUrl,
      });
      this.projects.set(entry.name, {
        name: entry.name,
        config,
        settings,
        github,
        executors: new Map(GITHUB_EXECUTORS.map((id) => [id, new GitHubActionsExecutor(id, github)] as const)),
      });
      const monthly = settings.executors.github.monthlyMinutes;
      if (monthly > 0 && this.options.budget) {
        const start = monthStartIso(this.clock.now());
        this.options.budget.setProviderBudget({
          provider: budgetProvider(entry.name),
          maxCostPerPeriod: monthly,
          period: "monthly",
          currentCost: this.store.billedMinutesSince(entry.name, start),
          periodStart: start,
          paused: false,
          unit: "minutes",
        });
      }
    }
  }

  /**
   * Remove what a crash left behind (job worktrees, then `git worktree
   * prune`), then resume the jobs that were in flight when the server stopped.
   * Nothing runs yet, so every job worktree found here is an orphan.
   */
  async start(): Promise<string[]> {
    this.started = true;
    if (this.projects.size === 0) return [];
    for (const p of this.projects.values()) {
      try {
        const removed = await this.local.cleanupWorktrees(p.config.repo, p.settings.executors.local);
        if (removed.length > 0) {
          console.log(`[pipelines] ${p.name}: removed ${removed.length} leftover worktree(s)`);
        }
      } catch (e) {
        console.warn(`[pipelines] ${p.name}: worktree cleanup failed: ${message(e)}`);
      }
    }
    for (const job of this.store.activeJobs()) {
      if (this.projects.has(job.project) && !this.active.has(job.id)) this.launch(job.project, job.id);
    }
    return [...this.projects.keys()];
  }

  /**
   * Apply a project's new `pipelines:` and `executors:` (src/server/reload/).
   * A job in flight is not cut off: the attempt running now finishes with
   * the settings it started with, and the job's next step reads the new ones
   * (a job whose lane is gone ends with an error; a project without
   * pipelines any more leaves its jobs recorded, as a stop does). Jobs the
   * store holds for the project are then launched, as start() does.
   */
  async reloadProject(entry: PipelineProjectEntry): Promise<void> {
    if (this.stopped) return;
    const before = this.projects.get(entry.name);
    if (before && before.settings.executors.github.monthlyMinutes > 0) {
      this.options.budget?.removeProviderBudget(budgetProvider(entry.name));
    }
    this.projects.delete(entry.name);
    this.problems.delete(entry.name);
    this.load([entry]);
    if (!this.started || !this.projects.has(entry.name)) return;
    for (const job of this.store.activeJobs()) {
      if (job.project === entry.name && !this.active.has(job.id)) this.launch(job.project, job.id);
    }
  }

  /** Stop: in-flight attempts stay recorded and resume on the next start */
  async stop(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const job of active) job.controller.abort();
    await Promise.all(active.map((job) => job.done.catch(() => undefined)));
    this.active.clear();
    this.storeInstance?.close();
    this.storeInstance = null;
  }

  /** Resolves once every job running now has finished (for tests and shutdown) */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((job) => job.done.catch(() => undefined)));
    }
  }

  configured(project: string): boolean {
    return this.projects.has(project);
  }

  /** The project's config errors, without asking GitHub (the supervisor's module_errors check). */
  errors(project: string): string[] {
    return this.problems.get(project) ?? [];
  }

  private require(project: string): LoadedProject {
    const p = this.projects.get(project);
    if (p) return p;
    const errors = this.problems.get(project);
    if (errors) throw new PipelineRequestError(400, `Invalid pipeline config: ${errors.join("; ")}`);
    throw new PipelineRequestError(404, `No pipelines are configured for ${project}`);
  }

  // ============ RUNS ============

  listRuns(project: string, limit = 50): PipelineRun[] {
    return this.projects.has(project) ? this.store.listRuns(project, limit) : [];
  }

  getRun(project: string, id: string): PipelineRun {
    this.require(project);
    const run = this.store.getRun(project, id);
    if (!run) throw new PipelineRequestError(404, `Run not found: ${id}`);
    return run;
  }

  private async resolveCommit(p: LoadedProject, ref: string): Promise<string> {
    const out = await this.git.run(["git", "-C", p.config.repo, "rev-parse", "--verify", `${ref}^{commit}`], {
      timeoutMs: 30_000,
    });
    const sha = out.stdout.trim();
    if (out.code !== 0 || !SHA_PATTERN.test(sha)) {
      throw new PipelineRequestError(400, `Cannot resolve ${ref} in ${p.config.repo}: ${out.stderr.trim() || "not a commit"}`);
    }
    return sha;
  }

  /** Start a run of `pipeline` at a commit (or at a branch's head) */
  async startRun(project: string, request: { pipeline: string; sha?: string; branch?: string }): Promise<PipelineRun> {
    if (this.stopped) throw new PipelineRequestError(503, "The server is stopping");
    const p = this.require(project);
    if (p.config.read_only === true) throw new PipelineRequestError(403, "Project is in read-only mode");
    const pipeline = p.settings.pipelines.find((x) => x.name === request.pipeline);
    if (!pipeline) throw new PipelineRequestError(404, `Unknown pipeline: ${request.pipeline}`);
    const sha = request.sha ?? (await this.resolveCommit(p, request.branch ?? "HEAD"));
    const runId = newId("run");
    const jobs = pipeline.lanes.map((lane) => ({ id: newId("job"), lane: lane.name }));
    this.store.createRun(
      {
        id: runId,
        project,
        pipeline: pipeline.name,
        commitSha: sha,
        branch: request.branch,
        stepOrder: pipeline.steps.map((s) => ({ name: s.name, lane: s.lane })),
        createdAt: this.iso(),
      },
      jobs,
    );
    await this.options.events?.emit("pipeline.run.started", {
      project,
      runId,
      pipeline: pipeline.name,
      commitSha: sha,
      lanes: jobs.map((j) => j.lane),
    });
    for (const job of jobs) this.launch(project, job.id);
    return this.store.getRun(project, runId)!;
  }

  /** Cancel a run: its jobs stop, and CI runs in flight are asked to cancel */
  async cancelRun(project: string, id: string): Promise<PipelineRun> {
    const p = this.require(project);
    if (p.config.read_only === true) throw new PipelineRequestError(403, "Project is in read-only mode");
    const run = this.getRun(project, id);
    if (run.completedAt) return run;
    this.store.requestCancel(id);
    for (const job of run.jobs) {
      const active = this.active.get(job.id);
      if (active) {
        active.cancelled = true;
        active.controller.abort();
      } else if (!isTerminalJob(job.status)) {
        this.store.updateJob(job.id, { status: "cancelled", error: "cancelled", waitReason: null, completedAt: this.iso() });
      }
    }
    await Promise.all(run.jobs.map((job) => this.active.get(job.id)?.done.catch(() => undefined)));
    await this.finishRunIfDone(id);
    return this.getRun(project, id);
  }

  private launch(project: string, jobId: string): void {
    const controller = new AbortController();
    const entry: ActiveJob = { controller, cancelled: false, done: Promise.resolve() };
    const control: JobControl = { signal: controller.signal, isCancelled: () => entry.cancelled };
    this.active.set(jobId, entry);
    entry.done = this.drive(project, jobId, control)
      .catch((e) => {
        console.error(`[pipelines] job ${jobId} failed:`, e);
      })
      .finally(() => {
        if (this.active.get(jobId) === entry) this.active.delete(jobId);
      });
  }

  /** The job loop: select an executor, run an attempt, fall back or finish */
  private async drive(projectName: string, jobId: string, control: JobControl): Promise<void> {
    const store = this.store;
    for (;;) {
      const p = this.projects.get(projectName);
      const job = store.getJob(jobId);
      if (!p || !job || isTerminalJob(job.status)) return;
      const run = store.getRunRecord(job.runId);
      if (!run) return;
      if (run.cancelRequested || control.isCancelled()) {
        await this.finishJob(job.id, run.id, { status: "cancelled", error: "cancelled" });
        return;
      }
      if (control.signal.aborted) return;
      const lane = p.settings.pipelines.find((x) => x.name === run.pipeline)?.lanes.find((l) => l.name === job.lane);
      if (!lane) {
        await this.finishJob(job.id, run.id, {
          status: "error",
          error: `pipeline ${run.pipeline} has no lane ${job.lane} any more`,
        });
        return;
      }
      if (run.status === "queued") store.updateRun(run.id, { status: "running", startedAt: this.iso() });
      const retryMs = p.settings.executors.retrySeconds * 1000;
      const attempts = [...job.attempts];
      const spec: JobSpec = {
        project: p.name,
        runId: run.id,
        jobId: job.id,
        pipeline: run.pipeline,
        lane,
        commitSha: run.commitSha,
        branch: run.branch,
        repoDir: p.config.repo,
        settings: p.settings,
        attemptNo: 0,
      };

      // An attempt still in flight: resume it (GitHub) or record that it never finished (local)
      let executor: Executor | null = null;
      let resume: PipelineAttempt | undefined;
      const last = attempts[attempts.length - 1];
      if (last && IN_FLIGHT.has(last.status)) {
        const github = last.executor === "github-hosted" || last.executor === "github-self-hosted";
        if (github && (last.dispatchId !== undefined || last.ciRunId !== undefined)) {
          executor = p.executors.get(last.executor as GitHubExecutorId) ?? null;
          resume = last;
        } else {
          attempts[attempts.length - 1] = {
            ...last,
            status: "interrupted",
            reason:
              last.executor === "local"
                ? "the server stopped while it ran; it never finished"
                : "the server stopped before it was dispatched",
            completedAt: this.iso(),
          };
          store.updateJob(job.id, { attempts });
          continue;
        }
      }

      if (!executor) {
        let choice: { executor: Executor } | { wait: string };
        try {
          choice = await this.select(p, spec, attempts);
        } catch (e) {
          // Never drop the job: wait and select again
          choice = { wait: `choosing an executor failed: ${message(e)}` };
        }
        if ("wait" in choice) {
          store.updateJob(job.id, { status: "waiting", waitReason: choice.wait, attempts });
          await this.clock.sleep(retryMs, control.signal);
          continue;
        }
        executor = choice.executor;
        attempts.push({ executor: executor.id, status: "queued", startedAt: this.iso() });
        store.updateJob(job.id, { status: "running", waitReason: null, attempts, startedAt: this.iso() });
      }
      const index = attempts.length - 1;
      spec.attemptNo = attempts.filter((a) => a.status !== "skipped").length;
      spec.runnerLostBefore = attempts.some((a) => a.runnerLost === true);
      const reporter: AttemptReporter = {
        update: (patch) => {
          attempts[index] = { ...attempts[index], ...patch };
          store.updateJob(job.id, { attempts });
        },
        wait: (reason) => {
          store.updateJob(job.id, { status: reason ? "waiting" : "running", waitReason: reason ?? null });
        },
      };

      const reserved = executor.id === "github-hosted" ? this.estimate(p, spec) : 0;
      this.reserve(p.name, reserved);
      let outcome: AttemptOutcome;
      try {
        outcome = await executor.run(spec, reporter, control, resume);
      } catch (e) {
        const attempt = attempts[index];
        if (attempt.executor !== "local" && (attempt.dispatchId !== undefined || attempt.ciRunId !== undefined)) {
          // A CI run may exist: never fall back blindly. Resume it after a pause.
          store.updateJob(job.id, { waitReason: `${attempt.executor}: ${message(e)}; retrying` });
          await this.clock.sleep(retryMs, control.signal);
          continue;
        }
        outcome =
          attempt.executor === "local"
            ? { kind: "error", reason: `local executor failed: ${message(e)}` }
            : { kind: "fallback", reason: `${attempt.executor} failed before dispatching: ${message(e)}` };
      } finally {
        this.reserve(p.name, -reserved);
      }

      const now = this.iso();
      const attempt = attempts[index];
      switch (outcome.kind) {
        case "interrupted":
          return;
        case "completed": {
          attempts[index] = {
            ...attempt,
            status: "completed",
            reason: outcome.note,
            completedAt: now,
            where: outcome.where,
            minutes: outcome.minutes,
            billedMinutes: outcome.billedMinutes,
            ciRunId: outcome.ciRunId ?? attempt.ciRunId,
            ciRunUrl: outcome.ciRunUrl ?? attempt.ciRunUrl,
          };
          const status =
            outcome.result.status === "passed" ? "passed" : outcome.result.status === "failed" ? "failed" : "error";
          this.account(p, outcome.billedMinutes, job.id);
          await this.finishJob(job.id, run.id, {
            status,
            executor: executor.id,
            where: outcome.where,
            attempts,
            result: outcome.result,
            log: outcome.log,
            artifacts: outcome.artifacts,
            minutes: sum(attempts, "minutes"),
            billedMinutes: sum(attempts, "billedMinutes"),
          });
          // For triage: the run id links the result to a re-check that started this run
          await this.options.events?.emit("gate.completed", { project: p.name, result: outcome.result, context: { runId: run.id } });
          return;
        }
        case "retry": {
          // The runner was lost: this attempt never finished. Run the job again
          // (once); the same executor may take it, since it did not fall back
          attempts[index] = {
            ...attempt,
            status: "interrupted",
            reason: outcome.reason,
            runnerLost: true,
            completedAt: now,
            minutes: outcome.minutes ?? attempt.minutes,
            billedMinutes: outcome.billedMinutes ?? attempt.billedMinutes,
            ciRunId: outcome.ciRunId ?? attempt.ciRunId,
            ciRunUrl: outcome.ciRunUrl ?? attempt.ciRunUrl,
          };
          store.updateJob(job.id, {
            attempts,
            minutes: sum(attempts, "minutes"),
            billedMinutes: sum(attempts, "billedMinutes"),
          });
          this.account(p, outcome.billedMinutes ?? 0, job.id);
          continue;
        }
        case "fallback": {
          attempts[index] = {
            ...attempt,
            status: "fell_back",
            reason: outcome.reason,
            completedAt: now,
            minutes: outcome.minutes ?? attempt.minutes,
            billedMinutes: outcome.billedMinutes ?? attempt.billedMinutes,
            ciRunId: outcome.ciRunId ?? attempt.ciRunId,
            ciRunUrl: outcome.ciRunUrl ?? attempt.ciRunUrl,
          };
          store.updateJob(job.id, {
            attempts,
            minutes: sum(attempts, "minutes"),
            billedMinutes: sum(attempts, "billedMinutes"),
          });
          this.account(p, outcome.billedMinutes ?? 0, job.id);
          for (const id of outcome.markUnavailable ?? []) this.markUnavailable(p, id, outcome.reason);
          await this.options.events?.emit("pipeline.job.fallback", {
            project: p.name,
            runId: run.id,
            jobId: job.id,
            lane: job.lane,
            executor: attempt.executor,
            reason: outcome.reason,
            markedUnavailable: outcome.markUnavailable ?? [],
          });
          continue;
        }
        case "error":
        case "cancelled": {
          attempts[index] = {
            ...attempt,
            status: outcome.kind === "cancelled" ? "cancelled" : "completed",
            reason: outcome.reason,
            completedAt: now,
          };
          await this.finishJob(job.id, run.id, {
            status: outcome.kind === "cancelled" ? "cancelled" : "error",
            executor: outcome.kind === "error" ? executor.id : undefined,
            error: outcome.reason,
            attempts,
          });
          return;
        }
      }
    }
  }

  /** The executor for the next attempt, or why the job has to wait */
  private async select(
    p: LoadedProject,
    spec: JobSpec,
    attempts: PipelineAttempt[],
  ): Promise<{ executor: Executor } | { wait: string }> {
    const nowIso = this.iso();
    const unavailable = this.store.unavailable(p.name, nowIso);
    const tried = new Set(attempts.filter((a) => a.status === "fell_back").map((a) => a.executor));
    const reasons: string[] = [];
    const note = (executor: ExecutorId, reason: string) => {
      reasons.push(`${executor}: ${reason}`);
      // Recorded as a "skipped" attempt, once per reason
      const previous = [...attempts].reverse().find((a) => a.executor === executor);
      if (previous?.status === "skipped" && previous.reason === reason) return;
      attempts.push({ executor, status: "skipped", reason, startedAt: nowIso, completedAt: nowIso });
    };

    for (const kind of spec.lane.order) {
      if (kind === "github") {
        const open: GitHubExecutorId[] = [];
        for (const id of GITHUB_EXECUTORS) {
          if (tried.has(id)) continue;
          const marked = unavailable.get(id);
          if (marked) {
            note(id, `unavailable until ${marked.until}: ${marked.reason}`);
            continue;
          }
          open.push(id);
        }
        if (open.length === 0) continue;
        const plan = await p.github.plan(spec, open, () => this.hostedBudget(p, spec));
        if (plan.unavailable) {
          for (const id of plan.unavailable.executors) this.markUnavailable(p, id, plan.unavailable.reason);
        }
        for (const skipped of plan.skipped) note(skipped.executor, skipped.reason);
        const first = plan.candidates[0];
        const executor = first ? p.executors.get(first.executor) : undefined;
        if (executor) return { executor };
      } else if (kind === "nodes") {
        if (!tried.has("nodes")) note("nodes", NODES_NOT_BUILT);
      } else if (!tried.has("local")) {
        return { executor: this.local };
      }
    }
    return {
      wait: `no executor can take this job${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`,
    };
  }

  private estimate(p: LoadedProject, spec: JobSpec): number {
    return this.store.estimateHostedMinutes(p.name, spec.pipeline, spec.lane.name) ?? 1;
  }

  private reserve(project: string, minutes: number): void {
    if (minutes === 0) return;
    this.hostedReserved.set(project, Math.max(0, (this.hostedReserved.get(project) ?? 0) + minutes));
  }

  /** Why hosted runners may not run this job of a private repository (budget), or null */
  private async hostedBudget(p: LoadedProject, spec: JobSpec): Promise<string | null> {
    const budget = p.settings.executors.github.monthlyMinutes;
    if (budget <= 0) {
      return "executors.github.monthly_minutes is 0, so GitHub-hosted runners are off for this private repository";
    }
    const since = monthStartIso(this.clock.now());
    const billed = this.store.billedMinutesSince(p.name, since);
    const used = billed + (this.hostedReserved.get(p.name) ?? 0);
    const estimate = this.estimate(p, spec);
    if (used + estimate > budget) {
      const month = since.slice(0, 7);
      await this.raiseDecision(p, {
        key: `pipelines:github-minutes:${p.name}:${month}`,
        kind: "spend",
        question: `Allow more GitHub-hosted runner minutes for ${p.name} in ${month}?`,
        context: [
          `The private repository ${p.settings.executors.github.repo} has used ${billed} of its ${budget} GitHub-hosted minutes this month (\`executors.github.monthly_minutes\`).`,
          `The next ${spec.pipeline}/${spec.lane.name} job needs about ${estimate} minute(s), so Lair did not send it to a hosted runner.`,
          "Until the budget changes, jobs run on self-hosted runners or this machine.",
        ].join("\n\n"),
        options: [
          "Keep the budget (run on self-hosted runners or this machine)",
          "Raise executors.github.monthly_minutes",
        ],
        recommended: "Keep the budget (run on self-hosted runners or this machine)",
        why: "GitHub bills hosted minutes of private repositories; spending more needs your approval.",
        reversible: true,
        onTimeout: "wait",
      });
      return `GitHub-hosted minutes would go over the monthly budget (${billed} of ${budget} used, the next job needs about ${estimate}); a spend decision was raised`;
    }
    const fleet = this.options.budget;
    if (fleet && !fleet.isProviderAvailable(budgetProvider(p.name))) {
      return `paused in the fleet budget (${budgetProvider(p.name)})`;
    }
    return null;
  }

  private async raiseDecision(
    p: LoadedProject,
    request: Omit<DecisionRequest, "project" | "requestedBy">,
  ): Promise<void> {
    const full: DecisionRequest = { ...request, project: p.name, requestedBy: "pipelines" };
    const inserted = this.store.recordDecision({
      id: newId("dec"),
      key: request.key,
      kind: request.kind,
      question: request.question,
      createdAt: this.iso(),
      project: p.name,
      payload: full,
    });
    if (!inserted) return;
    try {
      await this.decisions.needsDecision(full);
    } catch (e) {
      console.warn(`[pipelines] ${p.name}: decision hook failed: ${message(e)}`);
    }
  }

  private markUnavailable(p: LoadedProject, executor: ExecutorId, reason: string): void {
    const minutes = p.settings.executors.github.unavailableMinutes;
    if (minutes <= 0) return;
    const now = this.clock.now();
    this.store.markUnavailable(p.name, executor, this.iso(now + minutes * MIN), reason, this.iso(now));
  }

  /** Billed minutes into the fleet budget (the store already holds them per job) */
  private account(p: LoadedProject, billedMinutes: number, jobId: string): void {
    if (billedMinutes <= 0 || !this.options.budget || p.settings.executors.github.monthlyMinutes <= 0) return;
    this.options.budget.recordCost(budgetProvider(p.name), billedMinutes, `pipeline job ${jobId}`);
  }

  private async finishJob(jobId: string, runId: string, patch: JobPatch): Promise<void> {
    this.store.updateJob(jobId, { ...patch, waitReason: null, completedAt: this.iso() });
    await this.finishRunIfDone(runId);
  }

  private async finishRunIfDone(runId: string): Promise<void> {
    const record = this.store.getRunRecord(runId);
    if (!record || record.completedAt) return;
    const jobs = this.store.jobsOf(runId);
    if (jobs.some((j) => !isTerminalJob(j.status))) return;
    const status: PipelineRunStatus =
      record.cancelRequested || jobs.some((j) => j.status === "cancelled")
        ? "cancelled"
        : jobs.some((j) => j.status === "error")
          ? "error"
          : jobs.some((j) => j.status === "failed")
            ? "failed"
            : "passed";
    const errors = jobs.filter((j) => j.error).map((j) => `${j.lane}: ${j.error}`);
    this.store.updateRun(runId, {
      status,
      completedAt: this.iso(),
      error: errors.length > 0 ? errors.join("; ") : null,
    });
    await this.options.events?.emit("pipeline.run.completed", {
      project: record.project,
      runId,
      pipeline: record.pipeline,
      commitSha: record.commitSha,
      status,
    });
  }

  // ============ STATUS ============

  async status(project: string): Promise<PipelinesStatus> {
    const p = this.projects.get(project);
    const now = this.clock.now();
    const periodStart = monthStartIso(now);
    if (!p) {
      return {
        project,
        configured: false,
        errors: this.problems.get(project) ?? [],
        readOnly: true,
        order: [...EXECUTOR_KINDS],
        pipelines: [],
        executors: [],
        github: {
          repo: null,
          tokenEnv: "LAIR_GITHUB_TOKEN",
          tokenSet: false,
          visibility: null,
          workflowPath: ".github/workflows/lair-gates.yml",
          runners: [],
          warnings: [],
        },
        minutes: { usedThisMonth: 0, budget: 0, periodStart },
        decisions: [],
      };
    }
    const gh = p.settings.executors.github;
    const unavailable = this.store.unavailable(project, this.iso(now));
    const info = await p.github.statusInfo();
    const configProblem = p.github.configProblem();
    const matching = p.github.matchingRunners(info.runners);
    const executors: ExecutorAvailability[] = [];
    const add = (executor: ExecutorId, reason: string | null) => {
      const marked = unavailable.get(executor);
      executors.push(
        marked
          ? { executor, available: false, reason: marked.reason, unavailableUntil: marked.until }
          : { executor, available: reason === null, reason: reason ?? undefined },
      );
    };
    add(
      "github-self-hosted",
      configProblem ??
        (!gh.selfHosted
          ? "executors.github.self_hosted is false"
          : info.visibility === null
            ? "the repository could not be read"
            : info.visibility !== "private"
              ? `never used for a ${info.visibility} repository`
              : matching.length === 0
                ? `no online self-hosted runner has the labels ${gh.selfHostedLabels.join(", ")}`
                : null),
    );
    add(
      "github-hosted",
      configProblem ??
        (!gh.hosted
          ? "executors.github.hosted is false"
          : info.visibility === null
            ? "the repository could not be read"
            : info.visibility !== "public" && gh.monthlyMinutes <= 0
              ? `executors.github.monthly_minutes is 0 for this ${info.visibility} repository`
              : null),
    );
    add("nodes", NODES_NOT_BUILT);
    add("local", null);
    return {
      project,
      configured: true,
      errors: [],
      readOnly: p.config.read_only === true,
      order: p.settings.executors.order,
      pipelines: p.settings.pipelines.map((pipeline) => ({
        name: pipeline.name,
        lanes: pipeline.lanes.map((lane: LaneSettings) => ({
          name: lane.name,
          order: lane.order,
          steps: lane.steps.map((s) => s.name),
        })),
      })),
      executors,
      github: {
        repo: gh.repo,
        tokenEnv: gh.tokenEnv,
        tokenSet: p.github.hasToken,
        visibility: info.visibility,
        workflowPath: p.github.workflowPath,
        runners: info.runners.map((r) => ({ name: r.name, status: r.status, busy: r.busy, labels: r.labels })),
        warnings: info.warnings,
      },
      minutes: {
        usedThisMonth: this.store.billedMinutesSince(project, periodStart),
        budget: gh.monthlyMinutes,
        periodStart,
      },
      decisions: this.store.listDecisions(project),
    };
  }

  /** The workflow file the project should commit, with setup steps */
  async workflow(project: string): Promise<{
    path: string;
    content: string;
    version: string;
    allowSelfHosted: boolean;
    visibility: string | null;
    instructions: string[];
  }> {
    const p = this.require(project);
    const gh = p.settings.executors.github;
    let visibility: string | null = null;
    let allowSelfHosted = false;
    const problem = p.github.configProblem();
    if (!problem) {
      try {
        const info = await p.github.repoInfo();
        visibility = info.visibility;
        allowSelfHosted = p.github.allowSelfHosted(info);
      } catch {
        // without the repository's visibility, generate the safe variant
      }
    }
    const options = { project, pipelines: p.settings.pipelines, github: gh, allowSelfHosted };
    const path = p.github.workflowPath;
    const instructions = [`Commit this file to the repository's default branch as ${path}.`];
    if (problem) {
      instructions.push(
        `Then create a fine-grained token for ${gh.repo ?? "the repository"} with Actions: read and write, Contents: read and Metadata: read (and Administration: read to use self-hosted runners), and start Lair with ${gh.tokenEnv} set. ${problem}.`,
      );
    }
    if (visibility === null) {
      instructions.push(
        "Lair could not read the repository, so this file has no self-hosted runner option. If the repository is private, copy the file again once the token works.",
      );
    } else if (visibility === "private") {
      instructions.push(
        allowSelfHosted
          ? `To run jobs without billed minutes, register a self-hosted runner to the repository (Settings, Actions, Runners, New self-hosted runner) on a spare machine and start it with GitHub's ./config.sh and ./run.sh commands. Its labels must include ${gh.selfHostedLabels.join(", ")}.`
          : "executors.github.self_hosted is false: jobs use GitHub-hosted runners only.",
        gh.monthlyMinutes > 0
          ? `GitHub-hosted runners may use ${gh.monthlyMinutes} minutes a month (executors.github.monthly_minutes).`
          : "GitHub-hosted runners are off for this private repository until you set executors.github.monthly_minutes.",
      );
    } else {
      instructions.push(
        `The repository is ${visibility}: jobs run on GitHub-hosted runners, which are free for public repositories. Never register self-hosted runners to it: fork pull requests could run code on them.`,
      );
    }
    return {
      path,
      content: generateWorkflow(options),
      version: workflowVersion(options),
      allowSelfHosted,
      visibility,
      instructions,
    };
  }
}
