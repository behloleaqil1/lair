/**
 * A small GitHub REST client over an injected fetch (tests fake only this
 * HTTP boundary). It covers what the GitHub Actions executor needs: the
 * repository, its runners, the workflow file, dispatch, runs, jobs, logs,
 * annotations, artifacts and cancel.
 *
 * The token is sent only to the API host. Error messages never include it.
 */
import type { PipelineArtifact } from "../../../shared/pipeline-types.js";
import type { HttpFetch, HttpResponse } from "./types.js";

export const GITHUB_API_URL = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface RepoInfo {
  private: boolean;
  visibility: string;
  defaultBranch: string;
}

export interface RunnerInfo {
  id: number;
  name: string;
  os: string;
  status: string;
  busy: boolean;
  labels: string[];
}

export interface WorkflowRunInfo {
  id: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runStartedAt?: string;
}

export interface WorkflowStepInfo {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowJobInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerId: number | null;
  runnerName: string | null;
  runnerGroupName: string | null;
  labels: string[];
  steps: WorkflowStepInfo[];
}

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRun(raw: Json): WorkflowRunInfo {
  return {
    id: num(raw.id) ?? 0,
    name: str(raw.name),
    displayTitle: str(raw.display_title),
    status: str(raw.status),
    conclusion: strOrNull(raw.conclusion),
    htmlUrl: str(raw.html_url),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    runStartedAt: strOrNull(raw.run_started_at) ?? undefined,
  };
}

function toJob(raw: Json): WorkflowJobInfo {
  const steps = Array.isArray(raw.steps) ? (raw.steps as Json[]) : [];
  return {
    id: num(raw.id) ?? 0,
    name: str(raw.name),
    status: str(raw.status),
    conclusion: strOrNull(raw.conclusion),
    startedAt: strOrNull(raw.started_at),
    completedAt: strOrNull(raw.completed_at),
    runnerId: num(raw.runner_id),
    runnerName: strOrNull(raw.runner_name),
    runnerGroupName: strOrNull(raw.runner_group_name),
    labels: Array.isArray(raw.labels) ? (raw.labels as unknown[]).map(str).filter(Boolean) : [],
    steps: steps.map((s) => ({
      name: str(s.name),
      status: str(s.status),
      conclusion: strOrNull(s.conclusion),
      number: num(s.number) ?? 0,
      startedAt: strOrNull(s.started_at),
      completedAt: strOrNull(s.completed_at),
    })),
  };
}

export class GitHubApi {
  private readonly baseUrl: string;

  constructor(
    private options: {
      /** owner/name */
      repo: string;
      token: string;
      fetch: HttpFetch;
      baseUrl?: string;
    },
  ) {
    this.baseUrl = options.baseUrl ?? GITHUB_API_URL;
  }

  get repo(): string {
    return this.options.repo;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      Accept: accept,
      Authorization: `Bearer ${this.options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lair",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: HttpResponse;
    try {
      response = await this.options.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new GitHubApiError(0, `GitHub API unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await response.text().catch(() => "");
    return { status: response.status, text };
  }

  private async json(method: string, path: string, body?: unknown): Promise<Json> {
    const { status, text } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new GitHubApiError(status, `GitHub API ${method} ${path.split("?")[0]}: ${status} ${messageOf(text)}`);
    }
    try {
      return text ? (JSON.parse(text) as Json) : {};
    } catch {
      throw new GitHubApiError(status, `GitHub API ${method} ${path.split("?")[0]}: invalid JSON`);
    }
  }

  private repoPath(suffix = ""): string {
    return `/repos/${this.options.repo}${suffix}`;
  }

  async getRepo(): Promise<RepoInfo> {
    const raw = await this.json("GET", this.repoPath());
    const isPrivate = raw.private === true;
    return {
      private: isPrivate,
      visibility: str(raw.visibility) || (isPrivate ? "private" : "public"),
      defaultBranch: str(raw.default_branch) || "main",
    };
  }

  async listRunners(): Promise<RunnerInfo[]> {
    const raw = await this.json("GET", this.repoPath("/actions/runners?per_page=100"));
    const runners = Array.isArray(raw.runners) ? (raw.runners as Json[]) : [];
    return runners.map((r) => ({
      id: num(r.id) ?? 0,
      name: str(r.name),
      os: str(r.os),
      status: str(r.status),
      busy: r.busy === true,
      labels: Array.isArray(r.labels) ? (r.labels as Json[]).map((l) => str(l.name)).filter(Boolean) : [],
    }));
  }

  /** The decoded file at `ref`, or null when it does not exist there */
  async getFile(path: string, ref: string): Promise<string | null> {
    const { status, text } = await this.request(
      "GET",
      this.repoPath(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`),
    );
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw new GitHubApiError(status, `GitHub API GET contents/${path}: ${status} ${messageOf(text)}`);
    }
    const raw = JSON.parse(text) as Json;
    if (raw.encoding !== "base64" || typeof raw.content !== "string") return null;
    return Buffer.from(raw.content.replace(/\s/g, ""), "base64").toString("utf-8");
  }

  /** Whether GitHub has this commit */
  async hasCommit(sha: string): Promise<boolean> {
    const { status, text } = await this.request("GET", this.repoPath(`/commits/${sha}`));
    if (status === 200) return true;
    if (status === 404 || status === 422) return false;
    throw new GitHubApiError(status, `GitHub API GET commits/${sha}: ${status} ${messageOf(text)}`);
  }

  /**
   * workflow_dispatch. Newer API versions return the run id (200); older ones
   * answer 204 and the run must be found by its name.
   */
  async dispatch(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<{ runId?: number; runUrl?: string }> {
    const { status, text } = await this.request(
      "POST",
      this.repoPath(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`),
      { ref, inputs, return_run_details: true },
    );
    if (status === 204) return {};
    if (status === 200 || status === 201) {
      try {
        const raw = JSON.parse(text) as Json;
        const runId = num(raw.workflow_run_id) ?? num(raw.id) ?? undefined;
        return { runId, runUrl: strOrNull(raw.html_url) ?? undefined };
      } catch {
        return {};
      }
    }
    throw new GitHubApiError(status, `GitHub refused the dispatch: ${status} ${messageOf(text)}`);
  }

  async listWorkflowRuns(workflow: string, createdSince: string): Promise<WorkflowRunInfo[]> {
    const raw = await this.json(
      "GET",
      this.repoPath(
        `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=50&created=${encodeURIComponent(`>=${createdSince}`)}`,
      ),
    );
    const runs = Array.isArray(raw.workflow_runs) ? (raw.workflow_runs as Json[]) : [];
    return runs.map(toRun);
  }

  async getRun(runId: number): Promise<WorkflowRunInfo> {
    return toRun(await this.json("GET", this.repoPath(`/actions/runs/${runId}`)));
  }

  async listJobs(runId: number): Promise<WorkflowJobInfo[]> {
    const raw = await this.json("GET", this.repoPath(`/actions/runs/${runId}/jobs?filter=latest&per_page=100`));
    const jobs = Array.isArray(raw.jobs) ? (raw.jobs as Json[]) : [];
    return jobs.map(toJob);
  }

  /** The job's plain-text log (the API redirects to a download URL; fetch follows it) */
  async jobLog(jobId: number): Promise<string> {
    const { status, text } = await this.request(
      "GET",
      this.repoPath(`/actions/jobs/${jobId}/logs`),
      undefined,
      "application/vnd.github+json",
    );
    if (status < 200 || status >= 300) {
      throw new GitHubApiError(status, `GitHub API GET jobs/${jobId}/logs: ${status}`);
    }
    return text;
  }

  /** Annotations of a job (its check run): where GitHub explains a job it did not start */
  async annotations(jobId: number): Promise<string[]> {
    const { status, text } = await this.request("GET", this.repoPath(`/check-runs/${jobId}/annotations`));
    if (status < 200 || status >= 300) return [];
    try {
      const raw = JSON.parse(text) as unknown;
      return Array.isArray(raw) ? (raw as Json[]).map((a) => str(a.message)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async artifacts(runId: number): Promise<PipelineArtifact[]> {
    const raw = await this.json("GET", this.repoPath(`/actions/runs/${runId}/artifacts?per_page=100`));
    const list = Array.isArray(raw.artifacts) ? (raw.artifacts as Json[]) : [];
    return list.map((a) => ({
      name: str(a.name),
      sizeBytes: num(a.size_in_bytes) ?? 0,
      expired: a.expired === true,
    }));
  }

  /** Request a cancel: 202 accepted, 409 the run already finished */
  async cancel(runId: number, force = false): Promise<number> {
    const { status } = await this.request(
      "POST",
      this.repoPath(`/actions/runs/${runId}/${force ? "force-cancel" : "cancel"}`),
    );
    return status;
  }
}

/** GitHub's `message` from an error body, shortened */
export function messageOf(text: string): string {
  try {
    const raw = JSON.parse(text) as Json;
    if (typeof raw.message === "string") return raw.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}
