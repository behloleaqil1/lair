/**
 * GitHub Actions as an executor (docs/design/runners.md §2, §4, §5).
 *
 * The provider decides which GitHub executors can take a job (plan) and runs
 * an attempt on one of them (run): dispatch the workflow with validated
 * inputs, find the run, poll it, cancel it when no runner picks it up, and
 * read the job's steps, log and artifacts. The job's steps are replayed
 * through the existing gate executor (runGate), so the result has exactly the
 * shape a local run produces, and a CI run with a missing step fails.
 *
 * A fallback is returned only when GitHub reports the run finished with no
 * pipeline step started, so a job never runs twice.
 */
import type { ExecutorId, PipelineAttempt } from "../../../shared/pipeline-types.js";
import { runGate, type ExecuteResult } from "../gate-executor.js";
import { jobKey, type GithubSettings, type ProjectPipelineSettings } from "../project-pipelines.js";
import type { Clock } from "../../watchdog/probes.js";
import {
  GitHubApi,
  GitHubApiError,
  type RepoInfo,
  type RunnerInfo,
  type WorkflowJobInfo,
  type WorkflowRunInfo,
} from "./github-api.js";
import {
  RUN_ID_PATTERN,
  SHA_PATTERN,
  laneJobName,
  parseStepLogs,
  readWorkflowVersion,
  redactSecrets,
  workflowVersion,
  type StepLog,
} from "./github-workflow.js";
import type {
  AttemptOutcome,
  AttemptReporter,
  Executor,
  HttpFetch,
  JobControl,
  JobSpec,
} from "./types.js";

export type GitHubExecutorId = Extract<ExecutorId, "github-hosted" | "github-self-hosted">;
export const GITHUB_EXECUTORS: GitHubExecutorId[] = ["github-self-hosted", "github-hosted"];

const REPO_TTL_MS = 10 * 60_000;
const RUNNERS_TTL_MS = 60_000;
/** How long to look for the run a dispatch created */
export const FIND_WINDOW_MS = 2 * 60_000;
/**
 * After a restart, how long to look for the run of a dispatch that was sent:
 * longer, since dispatching again could run the job twice
 */
export const RESUME_FIND_WINDOW_MS = 10 * 60_000;
const FIND_POLL_MS = 5_000;
/** After a cancel, how long before a force-cancel */
const CANCEL_GRACE_MS = 2 * 60_000;
const LOG_TAIL_CHARS = 64 * 1024;

/**
 * GitHub's own explanation for a job it did not start for money reasons
 * ("The job was not started because ... spending limit ..."). Matched only
 * against GitHub's own annotations, never those a project's tools write.
 */
export const BILLING_PATTERN =
  /^The job was not started because\b.*(?:billing|spending limit|payments? (?:have|has) failed|account is locked)/i;

/** An annotation GitHub wrote itself: no file path, or ".github" */
export function isGitHubAnnotation(annotation: { path: string }): boolean {
  return annotation.path === "" || annotation.path === ".github";
}

export interface GitHubPlan {
  /** Executors that can take the job, best first */
  candidates: { executor: GitHubExecutorId; note?: string }[];
  skipped: { executor: GitHubExecutorId; reason: string }[];
  /** An API failure that is not this job's problem: mark these unavailable */
  unavailable?: { executors: GitHubExecutorId[]; reason: string };
}

export interface GitHubStatusInfo {
  visibility: string | null;
  runners: RunnerInfo[];
  warnings: string[];
}

export interface GitHubProviderOptions {
  project: string;
  settings: ProjectPipelineSettings;
  token: string | undefined;
  fetch: HttpFetch;
  clock: Clock;
  baseUrl?: string;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function minutesOf(job: WorkflowJobInfo | undefined): { raw: number; multiplier: number } {
  if (!job || !job.runnerId || !job.startedAt || !job.completedAt) return { raw: 0, multiplier: 1 };
  const ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  if (!Number.isFinite(ms)) return { raw: 0, multiplier: 1 };
  const labels = job.labels.join(" ").toLowerCase();
  const multiplier = /windows/.test(labels) ? 2 : /macos|mac-|osx/.test(labels) ? 10 : 1;
  return { raw: Math.max(1, Math.ceil(ms / 60_000)), multiplier };
}

export class GitHubProvider {
  private api: GitHubApi | null;
  private repoCache: { at: number; info: RepoInfo } | null = null;
  private runnersCache: { at: number; runners: RunnerInfo[] } | null = null;

  constructor(private options: GitHubProviderOptions) {
    const repo = options.settings.executors.github.repo;
    this.api =
      repo && options.token
        ? new GitHubApi({ repo, token: options.token, fetch: options.fetch, baseUrl: options.baseUrl })
        : null;
  }

  get github(): GithubSettings {
    return this.options.settings.executors.github;
  }

  /** Whether the token environment variable is set (its value is never shown) */
  get hasToken(): boolean {
    return Boolean(this.options.token);
  }

  /** Why GitHub can't be used at all with this config, or null */
  configProblem(): string | null {
    if (!this.github.repo) {
      return "executors.github.repo is not set, and the project's github is not owner/name";
    }
    if (!this.options.token) return `${this.github.tokenEnv} is not set`;
    return null;
  }

  /** The repository (cached for 10 minutes; `fresh` reads it again) */
  async repoInfo(fresh = false): Promise<RepoInfo> {
    const now = this.options.clock.now();
    if (!fresh && this.repoCache && now - this.repoCache.at < REPO_TTL_MS) return this.repoCache.info;
    if (!this.api) throw new Error(this.configProblem() ?? "GitHub is not configured");
    const info = await this.api.getRepo();
    this.repoCache = { at: now, info };
    return info;
  }

  async runners(): Promise<RunnerInfo[]> {
    const now = this.options.clock.now();
    if (this.runnersCache && now - this.runnersCache.at < RUNNERS_TTL_MS) return this.runnersCache.runners;
    if (!this.api) throw new Error(this.configProblem() ?? "GitHub is not configured");
    const runners = await this.api.listRunners();
    this.runnersCache = { at: now, runners };
    return runners;
  }

  /** Online runners that carry every configured label */
  matchingRunners(runners: RunnerInfo[]): RunnerInfo[] {
    const wanted = this.github.selfHostedLabels.map((l) => l.toLowerCase());
    return runners.filter((r) => {
      const labels = new Set(r.labels.map((l) => l.toLowerCase()));
      return r.status === "online" && wanted.every((l) => labels.has(l));
    });
  }

  /** Self-hosted runners only for private repositories, and only when allowed */
  allowSelfHosted(info: RepoInfo): boolean {
    return this.github.selfHosted && info.visibility === "private";
  }

  expectedWorkflowVersion(info: RepoInfo): string {
    return workflowVersion({
      project: this.options.project,
      pipelines: this.options.settings.pipelines,
      github: this.github,
      allowSelfHosted: this.allowSelfHosted(info),
    });
  }

  get workflowPath(): string {
    return `.github/workflows/${this.github.workflow}`;
  }

  /**
   * Which of the `open` GitHub executors can take this job. `hostedBudget`
   * returns why hosted runners may not be used for a private repository
   * (budget), or null.
   */
  async plan(
    job: JobSpec,
    open: GitHubExecutorId[],
    hostedBudget: () => Promise<string | null>,
  ): Promise<GitHubPlan> {
    const skipAll = (reason: string): GitHubPlan => ({
      candidates: [],
      skipped: open.map((executor) => ({ executor, reason })),
    });
    const unavailable = (e: unknown): GitHubPlan => {
      const reason = `GitHub API: ${reasonOf(e)}`;
      return { ...skipAll(reason), unavailable: { executors: open, reason } };
    };
    const problem = this.configProblem();
    if (problem || !this.api) return skipAll(problem ?? "GitHub is not configured");

    let info: RepoInfo;
    try {
      info = await this.repoInfo();
      if (!(await this.api.hasCommit(job.commitSha))) {
        return skipAll(`commit ${job.commitSha} is not on GitHub (push it first)`);
      }
    } catch (e) {
      return unavailable(e);
    }

    let content: string | null;
    try {
      content = await this.api.getFile(this.workflowPath, info.defaultBranch);
    } catch (e) {
      return unavailable(e);
    }
    if (content === null) {
      return skipAll(
        `${this.workflowPath} is not on ${info.defaultBranch}: copy it from the Gates view and commit it`,
      );
    }
    const expected = this.expectedWorkflowVersion(info);
    const found = readWorkflowVersion(content);
    if (found !== expected) {
      return skipAll(
        `${this.workflowPath} on ${info.defaultBranch} is out of date (version ${found ?? "none"}, expected ${expected}): copy the new file from the Gates view and commit it`,
      );
    }

    const plan: GitHubPlan = { candidates: [], skipped: [] };
    let busyOnly = false;
    if (open.includes("github-self-hosted")) {
      const skip = (reason: string) => plan.skipped.push({ executor: "github-self-hosted", reason });
      if (!this.github.selfHosted) {
        skip("executors.github.self_hosted is false");
      } else if (info.visibility !== "private") {
        skip(`the repository is ${info.visibility}: Lair never sends jobs to self-hosted runners of a ${info.visibility} repository`);
      } else {
        try {
          const matching = this.matchingRunners(await this.runners());
          if (matching.length === 0) {
            skip(`no online self-hosted runner has the labels ${this.github.selfHostedLabels.join(", ")}`);
          } else if (matching.some((r) => !r.busy)) {
            // An idle runner costs nothing: no need to look at hosted runners
            plan.candidates.push({ executor: "github-self-hosted", note: "an idle runner is online" });
            return plan;
          } else {
            busyOnly = true;
          }
        } catch (e) {
          skip(
            e instanceof GitHubApiError && (e.status === 403 || e.status === 404)
              ? "the token cannot list the repository's runners (it needs Administration: read)"
              : `GitHub API: ${reasonOf(e)}`,
          );
        }
      }
    }
    if (open.includes("github-hosted")) {
      if (!this.github.hosted) {
        plan.skipped.push({ executor: "github-hosted", reason: "executors.github.hosted is false" });
      } else {
        const why = info.private ? await hostedBudget() : null;
        if (why) plan.skipped.push({ executor: "github-hosted", reason: why });
        else plan.candidates.push({ executor: "github-hosted" });
      }
    }
    if (busyOnly) {
      plan.candidates.push({
        executor: "github-self-hosted",
        note: "every matching runner is busy: the job queues there",
      });
    }
    return plan;
  }

  /** Repository warnings and runners for the status view */
  async statusInfo(): Promise<GitHubStatusInfo> {
    if (this.configProblem()) return { visibility: null, runners: [], warnings: [] };
    let info: RepoInfo;
    try {
      info = await this.repoInfo();
    } catch (e) {
      return { visibility: null, runners: [], warnings: [`GitHub API: ${reasonOf(e)}`] };
    }
    const warnings: string[] = [];
    let runners: RunnerInfo[] = [];
    try {
      runners = await this.runners();
    } catch {
      if (this.allowSelfHosted(info)) {
        warnings.push("The token cannot list the repository's runners (it needs Administration: read).");
      }
    }
    if (info.visibility !== "private" && runners.length > 0) {
      warnings.push(
        `This ${info.visibility} repository has ${runners.length} self-hosted runner(s) registered (${runners
          .map((r) => r.name)
          .join(", ")}). Fork pull requests can run code on them: remove them in the repository's Settings, Actions, Runners. Lair never sends jobs to them.`,
      );
    }
    return { visibility: info.visibility, runners, warnings };
  }

  private whereOf(executor: GitHubExecutorId, job: WorkflowJobInfo | undefined): string {
    if (executor === "github-self-hosted") return `self-hosted runner ${job?.runnerName ?? "(unknown)"}`;
    const labels = job?.labels.length ? job.labels.join(", ") : this.github.hostedRunsOn;
    return `GitHub-hosted runner (${labels})`;
  }

  private stopped(control: JobControl): AttemptOutcome {
    return control.isCancelled() ? { kind: "cancelled", reason: "cancelled" } : { kind: "interrupted" };
  }

  /** The run a dispatch created, found by its name `lair <dispatchId>` */
  private async findRun(
    api: GitHubApi,
    dispatchId: string,
    dispatchedAt: number,
    signal: AbortSignal,
    windowMs = FIND_WINDOW_MS,
  ): Promise<WorkflowRunInfo | undefined> {
    const { clock } = this.options;
    const title = `lair ${dispatchId}`;
    const since = new Date(dispatchedAt - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const start = clock.now();
    for (;;) {
      try {
        const runs = await api.listWorkflowRuns(this.github.workflow, since);
        const hit = runs.find((r) => r.displayTitle === title || r.name === title);
        if (hit) return hit;
      } catch {
        // transient: try again
      }
      if (signal.aborted || clock.now() - start >= windowMs) return undefined;
      await clock.sleep(FIND_POLL_MS, signal);
    }
  }

  /** A dispatch GitHub refused: nothing was created, so falling back is safe */
  private refused(e: unknown, branch: string): AttemptOutcome {
    const status = e instanceof GitHubApiError ? e.status : 0;
    const message = reasonOf(e);
    if (status === 401 || status === 403 || status === 429 || status === 0 || status >= 500) {
      return { kind: "fallback", reason: message, markUnavailable: [...GITHUB_EXECUTORS] };
    }
    if (status === 404) {
      return {
        kind: "fallback",
        reason: `${this.workflowPath} was not found on ${branch}, or the token cannot see it (${message})`,
      };
    }
    return { kind: "fallback", reason: message };
  }

  /** Run one attempt of `job` on `executor` (or resume one that was in flight) */
  async run(
    executor: GitHubExecutorId,
    job: JobSpec,
    reporter: AttemptReporter,
    control: JobControl,
    resume?: PipelineAttempt,
  ): Promise<AttemptOutcome> {
    const api = this.api;
    if (!api) return { kind: "fallback", reason: this.configProblem() ?? "GitHub is not configured" };
    const { clock } = this.options;
    const github = this.github;
    const key = jobKey(job.pipeline, job.lane.name);
    const pollMs = github.pollSeconds * 1000;
    const pickupMs = github.pickupTimeoutMinutes * 60_000;
    // Throws on an API failure: the caller retries, resuming this attempt
    const info = await this.repoInfo();

    let runId = resume?.ciRunId;
    let runUrl = resume?.ciRunUrl;
    let dispatchedAt = resume ? Date.parse(resume.startedAt) : clock.now();

    if (runId === undefined && resume?.dispatchId) {
      // The dispatch was sent before the restart: look longer before sending it again
      const found = await this.findRun(api, resume.dispatchId, dispatchedAt, control.signal, RESUME_FIND_WINDOW_MS);
      if (found) {
        runId = found.id;
        runUrl = found.htmlUrl || runUrl;
        reporter.update({ status: "queued", ciRunId: runId, ciRunUrl: runUrl });
      } else if (control.signal.aborted) {
        return this.stopped(control);
      }
    }

    if (runId === undefined) {
      const dispatchId = resume?.dispatchId ? `${resume.dispatchId}-2` : `${job.jobId}-${job.attemptNo}`;
      const inputs: Record<string, string> = { lair_run: dispatchId, sha: job.commitSha, job: key };
      // Right before a job goes to a self-hosted runner, read the visibility
      // again rather than trust the cache: a repository made public since
      // must never get one
      const current = executor === "github-self-hosted" ? await this.repoInfo(true) : info;
      if (this.allowSelfHosted(current)) {
        inputs.runner = executor === "github-self-hosted" ? "self-hosted" : "hosted";
      } else if (executor === "github-self-hosted") {
        return {
          kind: "fallback",
          reason: `the repository is ${current.visibility}: Lair never sends jobs to its self-hosted runners`,
        };
      }
      if (!RUN_ID_PATTERN.test(dispatchId) || !SHA_PATTERN.test(job.commitSha) || !/^[A-Za-z0-9._-]+$/.test(key)) {
        return { kind: "error", reason: "refused to dispatch: invalid workflow inputs" };
      }
      reporter.update({ status: "dispatching", dispatchId });
      dispatchedAt = clock.now();
      let dispatched: { runId?: number; runUrl?: string };
      try {
        dispatched = await api.dispatch(github.workflow, info.defaultBranch, inputs);
      } catch (e) {
        return this.refused(e, info.defaultBranch);
      }
      runId = dispatched.runId;
      runUrl = dispatched.runUrl;
      if (runId === undefined) {
        const found = await this.findRun(api, dispatchId, dispatchedAt, control.signal);
        if (!found) {
          // Left as "dispatching": a restart looks for the run again
          if (control.signal.aborted) return this.stopped(control);
          return {
            kind: "fallback",
            reason: `GitHub accepted the dispatch, but no run named "lair ${dispatchId}" appeared within ${FIND_WINDOW_MS / 60_000} minutes`,
            markUnavailable: [executor],
          };
        }
        runId = found.id;
        runUrl = found.htmlUrl || undefined;
      }
      reporter.update({ status: "queued", ciRunId: runId, ciRunUrl: runUrl });
    }

    // Poll until the run completes; cancel it when no runner picks it up
    let cancelAt: number | undefined = resume?.status === "cancelling" ? clock.now() : undefined;
    let cancelReason: string | undefined = resume?.status === "cancelling" ? resume.reason : undefined;
    let forced = false;
    let reportedRunning = resume?.status === "running";
    let run: WorkflowRunInfo | undefined;
    for (;;) {
      if (control.signal.aborted) {
        if (!control.isCancelled()) return { kind: "interrupted" };
        await api.cancel(runId).catch(() => 0);
        return { kind: "cancelled", reason: "cancelled: the CI run was asked to cancel" };
      }
      try {
        run = await api.getRun(runId);
      } catch {
        await clock.sleep(pollMs, control.signal);
        continue;
      }
      if (!runUrl && run.htmlUrl) {
        runUrl = run.htmlUrl;
        reporter.update({ ciRunUrl: runUrl });
      }
      if (run.status === "completed") break;
      let ours: WorkflowJobInfo | undefined;
      try {
        ours = findJob(await api.listJobs(runId), job.pipeline, job.lane);
      } catch {
        ours = undefined;
      }
      const started = ours !== undefined && (ours.status === "in_progress" || ours.status === "completed");
      if (started && !reportedRunning) {
        reportedRunning = true;
        reporter.update({ status: "running", where: this.whereOf(executor, ours) });
      }
      const now = clock.now();
      if (!started && cancelAt === undefined && now - dispatchedAt >= pickupMs) {
        cancelReason = `no runner picked the job up within ${github.pickupTimeoutMinutes} min`;
        reporter.update({ status: "cancelling", reason: cancelReason });
        await api.cancel(runId).catch(() => 0);
        cancelAt = now;
      } else if (cancelAt !== undefined && !forced && now - cancelAt >= CANCEL_GRACE_MS) {
        forced = true;
        await api.cancel(runId, true).catch(() => 0);
      }
      await clock.sleep(pollMs, control.signal);
    }

    // The run is finished: did any pipeline step start?
    const jobs = await api.listJobs(runId);
    const ours = findJob(jobs, job.pipeline, job.lane);
    const minutes = minutesOf(ours);
    const billedMinutes = executor === "github-hosted" && info.private ? minutes.raw * minutes.multiplier : 0;
    const usage = { minutes: minutes.raw, billedMinutes, ciRunId: runId, ciRunUrl: runUrl };
    let log = "";
    if (ours && ours.steps.length > 0) {
      log = await api
        .jobLog(ours.id)
        .then((text) => redactSecrets(text, this.options.token ? [this.options.token] : []))
        .catch(() => "");
    }
    const stepLogs = parseStepLogs(log);
    const laneSteps = new Set(job.lane.steps.map((s) => s.name));
    const anyRan = (ours?.steps ?? []).some(
      (s) => laneSteps.has(s.name) && (s.conclusion === "success" || s.conclusion === "failure" || stepLogs.has(s.name)),
    );

    if (!anyRan && run?.conclusion === "startup_failure") {
      return {
        kind: "fallback",
        reason: "the workflow failed to start on GitHub (startup_failure): check the workflow file",
        markUnavailable: [...GITHUB_EXECUTORS],
        ...usage,
      };
    }
    if (!ours || ours.conclusion === "skipped") {
      if (cancelReason) {
        return { kind: "fallback", reason: `${cancelReason}; the CI run was cancelled`, markUnavailable: [executor], ...usage };
      }
      return {
        kind: "fallback",
        reason: `the workflow on ${info.defaultBranch} has no job for ${key}: is ${this.workflowPath} out of date?`,
        ...usage,
      };
    }
    const cancelled = ours.conclusion === "cancelled" || run?.conclusion === "cancelled";
    if (cancelReason && cancelled) {
      // Lair cancelled it (no runner in time). A runner that took the job in
      // the last poll gap was stopped by that cancel: the commit is untested,
      // so this is a fallback, not a failed gate
      return {
        kind: "fallback",
        reason: anyRan
          ? `${cancelReason}; a runner took the job just as Lair cancelled it, so it stopped unfinished: running it on the next executor`
          : `${cancelReason}; the CI run was cancelled`,
        markUnavailable: [executor],
        ...usage,
      };
    }
    // Only what GitHub itself wrote, never annotations from the project's tools
    const githubNotes = async () =>
      (await api.annotations(ours.id))
        .filter(isGitHubAnnotation)
        .map((a) => a.message)
        .join(" ");
    if (!anyRan) {
      if (!ours.runnerId) {
        const notes = await githubNotes();
        if (BILLING_PATTERN.test(notes)) {
          return { kind: "fallback", reason: `GitHub refused the job: ${notes}`, markUnavailable: [executor], ...usage };
        }
        return {
          kind: "fallback",
          reason: `the job never started on a runner${notes ? `: ${notes}` : ` (${ours.conclusion ?? "no conclusion"})`}`,
          markUnavailable: [executor],
          ...usage,
        };
      }
      if (ours.conclusion === "cancelled") {
        return { kind: "fallback", reason: "the CI run was cancelled before a pipeline step started", ...usage };
      }
      const failed = ours.steps.find((s) => s.conclusion === "failure");
      return {
        kind: "fallback",
        reason: `the job failed before its first pipeline step (${failed?.name ?? ours.conclusion ?? "unknown"})`,
        ...usage,
      };
    }
    const expectedName = laneJobName(job.pipeline, job.lane);
    if (ours.name !== expectedName) {
      return {
        kind: "fallback",
        reason: `the workflow on ${info.defaultBranch} is out of date: it ran "${ours.name}", expected "${expectedName}"`,
        ...usage,
      };
    }

    // A runner lost mid-run (the job ended cancelled or timed out with no
    // failed step, or GitHub says it lost the runner) gets one retry; a time
    // limit the job reached is a real failure
    let note: string | undefined;
    const failedStep = ours.steps.some((s) => s.conclusion === "failure");
    const endedEarly = (cancelled || ours.conclusion === "timed_out") && !failedStep;
    if (endedEarly || ours.conclusion === "failure") {
      const notes = await githubNotes();
      const timeLimit = /exceeded the maximum execution time|has timed out/i.test(notes);
      const lostByGitHub = /lost communication with the server|received a shutdown signal/i.test(notes);
      if (!timeLimit && (endedEarly || lostByGitHub)) {
        const why = `runner lost: the job ended ${ours.conclusion ?? "unfinished"}${failedStep ? "" : " with no failed step"}${notes ? ` (${notes})` : ""}`;
        if (!job.runnerLostBefore) {
          return { kind: "retry", reason: `${why}; trying once more`, ...usage };
        }
        note = `${why}, for the second time, so the result stands`;
      }
    }

    // Replay the CI steps through the gate executor: same result shape as local
    const ci = new Map(ours.steps.map((s) => [s.name, s] as const));
    const where = this.whereOf(executor, ours);
    const result = await runGate({
      pipeline: job.lane.gate,
      commitSha: job.commitSha,
      branch: job.branch ?? "",
      projectId: job.project,
      nodeId: executor === "github-hosted" ? "github-hosted" : `github-self-hosted:${ours.runnerName ?? "unknown"}`,
      changedFiles: [],
      workDir: "",
      executeCommand: async (_command, options) =>
        replayStep(options.step, job, ci.get(options.step ?? ""), stepLogs.get(options.step ?? "")),
    });
    if (ours.startedAt && ours.completedAt) {
      result.startedAt = ours.startedAt;
      result.completedAt = ours.completedAt;
      result.durationMs = Math.max(0, Date.parse(ours.completedAt) - Date.parse(ours.startedAt));
    }
    for (const step of result.steps) {
      const c = ci.get(step.name);
      if (c?.startedAt) step.startedAt = c.startedAt;
      if (c?.completedAt) step.completedAt = c.completedAt;
    }
    const artifacts = await api.artifacts(runId).catch(() => []);
    return {
      kind: "completed",
      result,
      where,
      log: log.length > LOG_TAIL_CHARS ? log.slice(-LOG_TAIL_CHARS) : log,
      artifacts,
      minutes: minutes.raw,
      billedMinutes,
      ciRunId: runId,
      ciRunUrl: runUrl,
      note,
    };
  }
}

/** Our job in a run: named `lair <pipeline>.<lane> <version>` */
function findJob(
  jobs: WorkflowJobInfo[],
  pipeline: string,
  lane: JobSpec["lane"],
): WorkflowJobInfo | undefined {
  const exact = laneJobName(pipeline, lane);
  const prefix = `lair ${jobKey(pipeline, lane.name)} `;
  return jobs.find((j) => j.name === exact) ?? jobs.find((j) => j.name.startsWith(prefix));
}

/**
 * A CI step as a command result. GitHub's conclusion decides pass or fail;
 * the log marker gives the exit code and output. A step with no CI result
 * fails.
 */
function replayStep(
  name: string | undefined,
  job: JobSpec,
  ci: WorkflowJobInfo["steps"][number] | undefined,
  log: StepLog | undefined,
): ExecuteResult {
  const step = job.lane.steps.find((s) => s.name === name);
  const ran = ci && (ci.conclusion === "success" || ci.conclusion === "failure" || ci.conclusion === "cancelled" || ci.conclusion === "timed_out" || log);
  if (!step || !ci || !ran) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `the CI run has no result for step ${name ?? "(unnamed)"}`,
      timedOut: false,
      durationMs: 0,
    };
  }
  const durationMs =
    ci.startedAt && ci.completedAt ? Math.max(0, Date.parse(ci.completedAt) - Date.parse(ci.startedAt)) : 0;
  const timedOut =
    log?.exitCode === undefined &&
    ci.conclusion !== "success" &&
    (ci.conclusion === "timed_out" || log?.timedOut === true || durationMs >= step.timeoutSeconds * 1000 - 2000);
  let exitCode = log?.exitCode ?? (ci.conclusion === "success" ? 0 : 1);
  // GitHub's conclusion wins over a marker: a failed step never passes
  if (ci.conclusion !== "success" && exitCode === 0) exitCode = 1;
  return { exitCode, stdout: log?.output ?? "", stderr: "", timedOut, durationMs };
}

/** One GitHub executor (hosted or self-hosted) over a shared provider */
export class GitHubActionsExecutor implements Executor {
  constructor(
    readonly id: GitHubExecutorId,
    private provider: GitHubProvider,
  ) {}

  run(job: JobSpec, reporter: AttemptReporter, control: JobControl, resume?: PipelineAttempt): Promise<AttemptOutcome> {
    return this.provider.run(this.id, job, reporter, control, resume);
  }
}
