/**
 * Test doubles for the two boundaries the pipeline executors touch: the
 * GitHub REST API (an HttpFetch) and the process spawner, plus a clock and a
 * capacity probe. Everything else in the tests is the real code.
 *
 * FakeGitHub behaves like the API for one repository: it keeps runners,
 * files, commits and workflow runs, and "runs" the committed workflow file:
 * a dispatched run gets the job whose `if:` matches the `job` input, with the
 * step names that file declares, and writes the log the real runner would.
 *
 * Not part of the build (tsconfig.server.json excludes src/**\/testing/**).
 */
import { parse as parseYaml } from "yaml";
import type { Clock } from "../../watchdog/probes.js";
import type { ExecuteResult } from "../gate-executor.js";
import type { CapacitySample, HttpFetch, HttpResponse, Spawner } from "../executors/types.js";
import type { ProjectConfig } from "../../../shared/types.js";

export const T0 = Date.parse("2026-03-02T12:00:00.000Z");
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
export const TOKEN = "test-token-not-a-secret";

// ============ CLOCK ============

/** sleep() moves time forward at once (after yielding to other tasks) */
export class FakeClock implements Clock {
  t: number;
  constructor(start = T0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    this.t += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ============ CAPACITY ============

export const AMPLE: CapacitySample = {
  cores: 8,
  load1: 0.5,
  totalRamMb: 16384,
  freeRamMb: 8192,
  memoryPressure: "normal",
};

export class FakeCapacity {
  /** Samples returned first, one per call; then `sample` */
  queue: CapacitySample[] = [];
  value: CapacitySample = AMPLE;
  calls = 0;
  async sample(): Promise<CapacitySample> {
    this.calls++;
    return this.queue.shift() ?? this.value;
  }
}

// ============ SPAWNER ============

export interface SpawnCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export class FakeSpawner implements Spawner {
  calls: SpawnCall[] = [];
  /** Step results by argv joined with spaces; default exit 0 */
  results = new Map<string, Partial<ExecuteResult>>();
  /** What `git rev-parse HEAD` prints */
  head = SHA;

  async run(argv: string[], options: { cwd: string; env: Record<string, string> }): Promise<ExecuteResult> {
    this.calls.push({ argv: [...argv], cwd: options.cwd, env: options.env });
    if (argv[0] === "git") {
      const out = argv.includes("rev-parse") ? `${this.head}\n` : "";
      return { exitCode: 0, stdout: out, stderr: "", timedOut: false, durationMs: 1 };
    }
    const r = this.results.get(argv.join(" ")) ?? {};
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? `ran ${argv.join(" ")}`,
      stderr: r.stderr ?? "",
      timedOut: r.timedOut ?? false,
      durationMs: r.durationMs ?? 5,
    };
  }

  /** Calls that ran a pipeline step (not git) */
  stepCalls(): SpawnCall[] {
    return this.calls.filter((c) => c.argv[0] !== "git");
  }
}

// ============ GITHUB ============

export interface FakeStep {
  name: string;
  conclusion: "success" | "failure" | "skipped" | "cancelled";
  exitCode?: number;
  output?: string;
}

/** How a dispatched run behaves */
export interface RunScript {
  /** Polls of the run before a runner picks the job up (default 0; Infinity: never) */
  pickupAfterPolls?: number;
  /** The job fails without ever getting a runner, with this annotation */
  refuse?: string;
  startupFailure?: boolean;
  /** Pipeline step results by name (default: success, exit 0) */
  steps?: FakeStep[];
  /** Leave these pipeline steps out of the jobs API answer */
  omitSteps?: string[];
  durationMs?: number;
  runnerName?: string;
  labels?: string[];
  /** A cancel arrives after a runner took the job: 409, and the run completes normally */
  cancelTooLate?: boolean;
}

interface WorkflowJob {
  name: string;
  if: string;
  steps: { name: string }[];
}

interface FakeRun {
  id: number;
  ref: string;
  inputs: Record<string, string>;
  script: RunScript;
  polls: number;
  state: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt?: number;
  job?: WorkflowJob;
  jobConclusion: string | null;
  steps: { name: string; status: string; conclusion: string | null; number: number; started_at: string | null; completed_at: string | null }[];
  log: string;
}

function response(status: number, body?: unknown, raw?: string): HttpResponse {
  const text = raw ?? (body === undefined ? "" : JSON.stringify(body));
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class FakeGitHub {
  readonly api = "https://api.github.com";
  repoName = "example-org/example-app";
  repo = { private: false, visibility: "public", default_branch: "main" };
  runners: { id: number; name: string; os: string; status: string; busy: boolean; labels: { name: string }[] }[] = [];
  runnersStatus = 200;
  /** Files by "<ref>:<path>" */
  files = new Map<string, string>();
  /** Commits GitHub has; null means every commit */
  commits: Set<string> | null = null;
  /** Answer every dispatch with this status and message */
  dispatchError?: { status: number; message: string };
  /** 200 with the run id (newer API) or 204 (older) */
  returnRunDetails = true;
  /** The script for the next dispatched runs (shifted), then `defaultScript` */
  scripts: RunScript[] = [];
  defaultScript: RunScript = {};
  dispatches: { ref: string; inputs: Record<string, string> }[] = [];
  cancels: { id: number; force: boolean }[] = [];
  requests: { method: string; path: string; auth: string | undefined }[] = [];
  runs = new Map<number, FakeRun>();
  private nextRunId = 9000;

  constructor(
    private clock: Clock,
    private token = TOKEN,
  ) {}

  /** Put the workflow file on the default branch */
  commitWorkflow(content: string, path = ".github/workflows/lair-gates.yml"): void {
    this.files.set(`${this.repo.default_branch}:${path}`, content);
  }

  addRunner(name: string, options: { busy?: boolean; status?: string; labels?: string[] } = {}): void {
    this.runners.push({
      id: this.runners.length + 1,
      name,
      os: "Linux",
      status: options.status ?? "online",
      busy: options.busy ?? false,
      labels: (options.labels ?? ["self-hosted", "Linux", "X64"]).map((label) => ({ name: label })),
    });
  }

  fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== this.api) throw new Error(`unexpected host ${u.origin}`);
    const auth = init.headers.Authorization;
    this.requests.push({ method: init.method, path: u.pathname, auth });
    if (auth !== `Bearer ${this.token}`) return response(401, { message: "Bad credentials" });
    const base = `/repos/${this.repoName}`;
    if (!u.pathname.startsWith(base)) return response(404, { message: "Not Found" });
    const path = u.pathname.slice(base.length);
    const m = (pattern: RegExp) => path.match(pattern);
    let match: RegExpMatchArray | null;

    if (init.method === "GET" && path === "") return response(200, this.repo);
    if (init.method === "GET" && path === "/actions/runners") {
      return this.runnersStatus === 200
        ? response(200, { total_count: this.runners.length, runners: this.runners })
        : response(this.runnersStatus, { message: "Resource not accessible by integration" });
    }
    if (init.method === "GET" && (match = m(/^\/contents\/(.+)$/))) {
      const file = this.files.get(`${u.searchParams.get("ref")}:${decodeURIComponent(match[1])}`);
      return file === undefined
        ? response(404, { message: "Not Found" })
        : response(200, { encoding: "base64", content: Buffer.from(file).toString("base64") });
    }
    if (init.method === "GET" && (match = m(/^\/commits\/([0-9a-f]{40})$/))) {
      return this.commits === null || this.commits.has(match[1])
        ? response(200, { sha: match[1] })
        : response(422, { message: "No commit found for SHA" });
    }
    if (init.method === "POST" && (match = m(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
      const body = JSON.parse(init.body ?? "{}") as { ref: string; inputs: Record<string, string> };
      this.dispatches.push({ ref: body.ref, inputs: body.inputs });
      if (this.dispatchError) return response(this.dispatchError.status, { message: this.dispatchError.message });
      const run = this.createRun(decodeURIComponent(match[1]), body.ref, body.inputs);
      if (!run) return response(422, { message: "Workflow does not have 'workflow_dispatch' trigger" });
      return this.returnRunDetails
        ? response(200, { workflow_run_id: run.id, html_url: `https://github.com/${this.repoName}/actions/runs/${run.id}` })
        : response(204);
    }
    if (init.method === "GET" && m(/^\/actions\/workflows\/[^/]+\/runs$/)) {
      return response(200, {
        total_count: this.runs.size,
        workflow_runs: [...this.runs.values()].map((r) => this.runJson(r)),
      });
    }
    if (init.method === "GET" && (match = m(/^\/actions\/runs\/(\d+)$/))) {
      const run = this.runs.get(Number(match[1]));
      if (!run) return response(404, { message: "Not Found" });
      this.poll(run);
      return response(200, this.runJson(run));
    }
    if (init.method === "GET" && (match = m(/^\/actions\/runs\/(\d+)\/jobs$/))) {
      const run = this.runs.get(Number(match[1]));
      if (!run) return response(404, { message: "Not Found" });
      return response(200, { total_count: run.job ? 1 : 0, jobs: run.job ? [this.jobJson(run)] : [] });
    }
    if (init.method === "GET" && (match = m(/^\/actions\/jobs\/(\d+)\/logs$/))) {
      const run = this.runs.get(Number(match[1]) - 1);
      return run ? response(200, undefined, run.log) : response(404, { message: "Not Found" });
    }
    if (init.method === "GET" && (match = m(/^\/check-runs\/(\d+)\/annotations$/))) {
      const run = this.runs.get(Number(match[1]) - 1);
      return response(200, run?.script.refuse ? [{ message: run.script.refuse, annotation_level: "failure" }] : []);
    }
    if (init.method === "GET" && (match = m(/^\/actions\/runs\/(\d+)\/artifacts$/))) {
      return response(200, { total_count: 1, artifacts: [{ name: "reports", size_in_bytes: 2048, expired: false }] });
    }
    if (init.method === "POST" && (match = m(/^\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/))) {
      const run = this.runs.get(Number(match[1]));
      if (!run) return response(404, { message: "Not Found" });
      this.cancels.push({ id: run.id, force: match[2] === "force-cancel" });
      if (run.state !== "completed" && run.script.cancelTooLate) {
        // A runner took the job just before the cancel: it runs to the end
        run.state = "in_progress";
        run.startedAt = this.clock.now();
        return response(409, { message: "Cannot cancel a workflow run that is completed." });
      }
      if (run.state === "completed") {
        return response(409, { message: "Cannot cancel a workflow run that is completed." });
      }
      run.cancelRequested = true;
      return response(202, {});
    }
    return response(404, { message: `no fake route for ${init.method} ${path}` });
  };

  private workflowJob(ref: string, key: string): WorkflowJob | undefined {
    const content = this.files.get(`${ref}:.github/workflows/lair-gates.yml`);
    if (!content) return undefined;
    const doc = parseYaml(content) as { jobs: Record<string, WorkflowJob> };
    return Object.values(doc.jobs).find((j) => j.if === `inputs.job == '${key}'`);
  }

  private createRun(_workflow: string, ref: string, inputs: Record<string, string>): FakeRun | null {
    const id = this.nextRunId;
    this.nextRunId += 2; // job ids are run id + 1
    const run: FakeRun = {
      id,
      ref,
      inputs,
      script: this.scripts.shift() ?? this.defaultScript,
      polls: 0,
      state: "queued",
      conclusion: null,
      cancelRequested: false,
      createdAt: iso(this.clock.now()),
      job: this.workflowJob(ref, inputs.job),
      jobConclusion: null,
      steps: [],
      log: "",
    };
    this.runs.set(id, run);
    return run;
  }

  /** One poll of GET run: move the run along its script */
  private poll(run: FakeRun): void {
    if (run.state === "completed") return;
    run.polls++;
    const script = run.script;
    if (!run.job) {
      // No job matches the input: GitHub skips every job
      this.complete(run, "success", "skipped");
      return;
    }
    if (script.startupFailure) {
      run.job = undefined;
      this.complete(run, "startup_failure", null);
      return;
    }
    if (script.refuse) {
      this.complete(run, "failure", "failure");
      return;
    }
    if (run.state === "queued") {
      if (run.cancelRequested) {
        this.complete(run, "cancelled", "cancelled");
        return;
      }
      if (run.polls > (script.pickupAfterPolls ?? 0)) {
        run.state = "in_progress";
        run.startedAt = this.clock.now();
      }
      return;
    }
    this.finishSteps(run);
  }

  private complete(run: FakeRun, conclusion: string, jobConclusion: string | null): void {
    run.state = "completed";
    run.conclusion = conclusion;
    run.jobConclusion = jobConclusion;
  }

  private finishSteps(run: FakeRun): void {
    const job = run.job!;
    const script = run.script;
    const started = run.startedAt ?? this.clock.now();
    const duration = script.durationMs ?? 60_000;
    const pipelineSteps = job.steps.map((s) => s.name).filter((n) => !n.startsWith("lair-"));
    const at = (fraction: number) => iso(started + Math.round(duration * fraction));
    const steps: FakeRun["steps"] = [
      { name: "Set up job", status: "completed", conclusion: "success", number: 1, started_at: at(0), completed_at: at(0) },
      { name: "lair-inputs", status: "completed", conclusion: "success", number: 2, started_at: at(0), completed_at: at(0) },
      { name: "lair-checkout", status: "completed", conclusion: "success", number: 3, started_at: at(0), completed_at: at(0.05) },
    ];
    const lines: string[] = [];
    const ts = iso(started);
    let failed = false;
    pipelineSteps.forEach((name, i) => {
      const scripted = script.steps?.find((s) => s.name === name);
      const conclusion = scripted?.conclusion ?? (failed ? "skipped" : "success");
      const from = 0.05 + (0.9 * i) / pipelineSteps.length;
      const to = 0.05 + (0.9 * (i + 1)) / pipelineSteps.length;
      if (!script.omitSteps?.includes(name)) {
        steps.push({
          name,
          status: "completed",
          conclusion,
          number: steps.length + 1,
          started_at: at(from),
          completed_at: conclusion === "skipped" ? at(from) : at(to),
        });
      }
      if (conclusion === "skipped") return;
      const exitCode = scripted?.exitCode ?? (conclusion === "success" ? 0 : 1);
      // What the runner prints: the script it runs, then the step's own output
      lines.push(
        `${ts} ##[group]Run echo "lair-step-start ${name}"`,
        `${ts} echo "lair-step-start ${name}"`,
        `${ts} echo "lair-step-exit ${name} $rc"`,
        `${ts} ##[endgroup]`,
        `${ts} lair-step-start ${name}`,
        ...(scripted?.output ?? `ok ${name}`).split("\n").map((l) => `${ts} ${l}`),
      );
      if (conclusion !== "cancelled") lines.push(`${ts} lair-step-exit ${name} ${exitCode}`);
      if (conclusion === "failure") {
        lines.push(`${ts} ##[error]Process completed with exit code ${exitCode}.`);
        failed = true;
      }
    });
    steps.push({ name: "Complete job", status: "completed", conclusion: "success", number: steps.length + 1, started_at: at(1), completed_at: at(1) });
    run.steps = steps;
    run.log = lines.join("\n") + "\n";
    const cancelled = run.cancelRequested && !script.cancelTooLate;
    this.complete(run, cancelled ? "cancelled" : failed ? "failure" : "success", cancelled ? "cancelled" : failed ? "failure" : "success");
  }

  private runJson(run: FakeRun) {
    return {
      id: run.id,
      name: "lair-gates",
      display_title: `lair ${run.inputs.lair_run}`,
      status: run.state,
      conclusion: run.conclusion,
      html_url: `https://github.com/${this.repoName}/actions/runs/${run.id}`,
      created_at: run.createdAt,
      updated_at: iso(this.clock.now()),
      run_started_at: run.startedAt ? iso(run.startedAt) : null,
    };
  }

  private jobJson(run: FakeRun) {
    const hosted = run.inputs.runner !== "self-hosted";
    const gotRunner = run.startedAt !== undefined;
    const duration = run.script.durationMs ?? 60_000;
    return {
      id: run.id + 1,
      name: run.job!.name,
      status: run.state === "completed" ? "completed" : run.state,
      conclusion: run.state === "completed" ? run.jobConclusion : null,
      started_at: gotRunner ? iso(run.startedAt!) : null,
      completed_at: gotRunner && run.state === "completed" ? iso(run.startedAt! + duration) : null,
      runner_id: gotRunner ? 42 : null,
      runner_name: gotRunner ? (run.script.runnerName ?? (hosted ? "GitHub Actions 2" : "runner-1")) : null,
      runner_group_name: gotRunner ? (hosted ? "GitHub Actions" : "Default") : null,
      labels: run.script.labels ?? (hosted ? ["ubuntu-latest"] : ["self-hosted"]),
      steps: run.state === "completed" ? run.steps.filter((s) => !run.script.omitSteps?.includes(s.name)) : [],
    };
  }
}

// ============ CONFIG ============

/** A project config with the given `pipelines:` and `executors:` blocks */
export function projectConfig(
  name: string,
  repo: string,
  pipelines: Record<string, unknown>,
  executors?: Record<string, unknown>,
  extra: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    name,
    repo,
    github: "example-org/example-app",
    queue_file: `${repo}/queue.md`,
    agents_dir: `${repo}/agents`,
    gates_dir: `${repo}/gates`,
    machines: {},
    read_only: false,
    pipelines,
    executors,
    ...extra,
  };
}
