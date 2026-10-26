/**
 * Executor selection and fallback (docs/design/runners.md), end to end
 * through the real PipelineManager, selector, GitHub Actions and local
 * executors, store and gate executor. Only the boundaries are fake: the
 * GitHub REST API (FakeGitHub, an HttpFetch), the process spawner, the
 * capacity probe and the clock.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import { BudgetManager } from "../fleet/budget.js";
import type { Event } from "../../shared/server-types.js";
import type { GateResult } from "../../shared/policy-types.js";
import type { PipelineAttempt, PipelineRun } from "../../shared/pipeline-types.js";
import { validateGateResult } from "./gate-executor.js";
import { parsePipelineConfig } from "./project-pipelines.js";
import { NODES_NOT_BUILT, PipelineManager } from "./pipeline-service.js";
import { PipelineStore } from "./run-store.js";
import { GitHubActionsExecutor, GitHubProvider } from "./executors/github.js";
import {
  AMPLE,
  FakeCapacity,
  FakeClock,
  FakeGitHub,
  FakeSpawner,
  SHA,
  SHA2,
  TOKEN,
  projectConfig,
  type RunScript,
} from "./testing/fakes.js";

const MIN = 60_000;
const REPO_DIR = "/home/user/example-app";

const PIPELINES = {
  gate: {
    steps: [
      { name: "lint", run: ["npm", "run", "lint"] },
      { name: "test", run: ["npm", "test"] },
    ],
  },
};

interface HarnessOptions {
  pipelines?: Record<string, unknown>;
  executors?: Record<string, unknown>;
  visibility?: "public" | "private";
  runners?: { name: string; busy?: boolean }[];
  token?: boolean;
  dbPath?: string;
  scripts?: RunScript[];
}

interface Harness {
  manager: PipelineManager;
  github: FakeGitHub;
  spawner: FakeSpawner;
  capacity: FakeCapacity;
  clock: FakeClock;
  events: EventBus;
  budget: BudgetManager;
  decisions: Event[];
  options: ConstructorParameters<typeof PipelineManager>[0];
  config: ReturnType<typeof projectConfig>;
  /** Start a run of `gate` at SHA and wait until it is finished */
  run(sha?: string): Promise<PipelineRun>;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock();
  const github = new FakeGitHub(clock);
  if (o.visibility === "private") github.repo = { private: true, visibility: "private", default_branch: "main" };
  for (const runner of o.runners ?? []) github.addRunner(runner.name, { busy: runner.busy });
  github.scripts = [...(o.scripts ?? [])];
  const spawner = new FakeSpawner();
  const capacity = new FakeCapacity();
  const events = new EventBus();
  const budget = new BudgetManager();
  const decisions: Event[] = [];
  events.on("decision.needed", (e) => {
    decisions.push(e);
  });
  const lairDir = mkdtempSync(join(tmpdir(), "lair-runners-"));
  cleanups.push(() => rmSync(lairDir, { recursive: true, force: true }));
  const options = {
    dbPath: o.dbPath ?? ":memory:",
    events,
    budget,
    fetch: github.fetch,
    spawner,
    capacity,
    clock,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user", ...(o.token === false ? {} : { LAIR_GITHUB_TOKEN: TOKEN }) },
    lairDir,
    git: { run: async () => ({ code: 0, stdout: `${SHA}\n`, stderr: "" }) },
  };
  const config = projectConfig("demo", REPO_DIR, o.pipelines ?? PIPELINES, o.executors);
  const manager = new PipelineManager(options);
  cleanups.push(() => manager.stop());
  manager.load([{ name: "demo", config }]);
  // The project committed the workflow file Lair generated for it
  github.commitWorkflow((await manager.workflow("demo")).content);
  return {
    manager,
    github,
    spawner,
    capacity,
    clock,
    events,
    budget,
    decisions,
    options,
    config,
    async run(sha = SHA) {
      const started = await manager.startRun("demo", { pipeline: "gate", sha });
      await manager.idle();
      return manager.getRun("demo", started.id);
    },
  };
}

function attemptsOf(run: PipelineRun, lane = "default"): Pick<PipelineAttempt, "executor" | "status" | "reason">[] {
  const job = run.jobs.find((j) => j.lane === lane)!;
  return job.attempts.map((a) => ({ executor: a.executor, status: a.status, reason: a.reason }));
}

/** Wait (yielding to other tasks) until `condition` holds */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

describe("executor order", () => {
  it("sends a private repository's job to an idle self-hosted runner first", async () => {
    const h = await harness({
      visibility: "private",
      runners: [{ name: "runner-1" }],
      executors: { github: { monthly_minutes: 100 } },
    });
    const run = await h.run();

    expect(h.github.dispatches).toHaveLength(1);
    expect(h.github.dispatches[0]).toMatchObject({
      ref: "main",
      inputs: { sha: SHA, job: "gate.default", runner: "self-hosted" },
    });
    expect(run.status).toBe("passed");
    expect(run.jobs[0]).toMatchObject({ executor: "github-self-hosted", where: "self-hosted runner runner-1" });
    expect(run.steps.map((s) => [s.name, s.status, s.where])).toEqual([
      ["lint", "passed", "self-hosted runner runner-1"],
      ["test", "passed", "self-hosted runner runner-1"],
    ]);
    expect(run.billedMinutes).toBe(0);
    expect(run.jobs[0].artifacts).toEqual([{ name: "reports", sizeBytes: 2048, expired: false }]);
    expect(h.spawner.stepCalls()).toEqual([]);
  });

  it("uses GitHub-hosted runners next, within the minutes budget, and bills their minutes", async () => {
    const h = await harness({ visibility: "private", executors: { github: { monthly_minutes: 100 } } });
    const run = await h.run();

    expect(h.github.dispatches[0].inputs.runner).toBe("hosted");
    expect(run.jobs[0]).toMatchObject({
      executor: "github-hosted",
      where: "GitHub-hosted runner (ubuntu-latest)",
      minutes: 1,
      billedMinutes: 1,
    });
    expect(attemptsOf(run)).toEqual([
      {
        executor: "github-self-hosted",
        status: "skipped",
        reason: "no online self-hosted runner has the labels self-hosted",
      },
      { executor: "github-hosted", status: "completed", reason: undefined },
    ]);
    expect(h.spawner.stepCalls()).toEqual([]);
  });

  it("runs on the local machine last, in a worktree at the commit, without the token in the env", async () => {
    const h = await harness({ token: false });
    const run = await h.run();

    expect(h.github.requests).toEqual([]);
    expect(attemptsOf(run)).toEqual([
      { executor: "github-self-hosted", status: "skipped", reason: "LAIR_GITHUB_TOKEN is not set" },
      { executor: "github-hosted", status: "skipped", reason: "LAIR_GITHUB_TOKEN is not set" },
      { executor: "nodes", status: "skipped", reason: NODES_NOT_BUILT },
      { executor: "local", status: "completed", reason: undefined },
    ]);
    expect(run.status).toBe("passed");
    expect(run.jobs[0].where).toBe("local machine");
    const argv = h.spawner.calls.map((c) => c.argv);
    const worktree = argv[0][argv[0].length - 2];
    expect(argv).toEqual([
      ["git", "-C", REPO_DIR, "worktree", "add", "--detach", worktree, SHA],
      ["npm", "run", "lint"],
      ["npm", "test"],
      ["git", "-C", REPO_DIR, "worktree", "remove", "--force", worktree],
    ]);
    expect(h.spawner.stepCalls().every((c) => c.cwd === worktree)).toBe(true);
  });

  it("follows a lane's own order, and never passes the GitHub token to local steps", async () => {
    const h = await harness({
      visibility: "private",
      runners: [{ name: "runner-1" }],
      pipelines: { gate: { ...PIPELINES.gate, lanes: { default: { executors: ["local", "github"] } } } },
    });
    const run = await h.run();

    expect(h.github.dispatches).toEqual([]);
    expect(run.jobs[0].executor).toBe("local");
    const env = h.spawner.stepCalls()[0].env;
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env).not.toHaveProperty("LAIR_GITHUB_TOKEN");
  });

  it("runs lanes as separate jobs that pick their executors independently", async () => {
    const h = await harness({
      pipelines: {
        gate: {
          steps: [
            { name: "lint", run: ["npm", "run", "lint"], lane: "quick" },
            { name: "test", run: ["npm", "test"], lane: "heavy" },
          ],
          lanes: { quick: { executors: ["local"] } },
        },
      },
    });
    const run = await h.run();

    expect(run.status).toBe("passed");
    expect(run.steps.map((s) => [s.name, s.lane, s.where])).toEqual([
      ["lint", "quick", "local machine"],
      ["test", "heavy", "GitHub-hosted runner (ubuntu-latest)"],
    ]);
    expect(h.github.dispatches.map((d) => d.inputs.job)).toEqual(["gate.heavy"]);
  });
});

describe("public repositories", () => {
  it("never route a job to a self-hosted runner, even an idle one", async () => {
    const h = await harness({ visibility: "public", runners: [{ name: "runner-1" }] });
    const workflow = await h.manager.workflow("demo");
    expect(workflow.allowSelfHosted).toBe(false);
    expect(workflow.content).not.toContain("self-hosted");

    const run = await h.run();
    expect(h.github.dispatches).toHaveLength(1);
    expect(h.github.dispatches[0].inputs).not.toHaveProperty("runner");
    expect(run.jobs[0].executor).toBe("github-hosted");
    expect(attemptsOf(run)[0]).toEqual({
      executor: "github-self-hosted",
      status: "skipped",
      reason: "the repository is public: Lair never sends jobs to self-hosted runners of a public repository",
    });
    const status = await h.manager.status("demo");
    expect(status.github.warnings.join(" ")).toContain("public repository has 1 self-hosted runner(s) registered (runner-1)");
    expect(status.executors.find((e) => e.executor === "github-self-hosted")).toMatchObject({ available: false });
  });

  it("run locally when hosted runners are off, and never on the registered runner", async () => {
    const h = await harness({
      visibility: "public",
      runners: [{ name: "runner-1" }],
      executors: { github: { hosted: false } },
    });
    const run = await h.run();

    expect(h.github.dispatches).toEqual([]);
    expect(run.jobs[0].executor).toBe("local");
    expect(attemptsOf(run).slice(0, 2)).toEqual([
      {
        executor: "github-self-hosted",
        status: "skipped",
        reason: "the repository is public: Lair never sends jobs to self-hosted runners of a public repository",
      },
      { executor: "github-hosted", status: "skipped", reason: "executors.github.hosted is false" },
    ]);
  });

  it("are refused by the self-hosted executor itself, before any dispatch", async () => {
    const clock = new FakeClock();
    const github = new FakeGitHub(clock);
    const parsed = parsePipelineConfig(PIPELINES, {}, "example-org/example-app");
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const provider = new GitHubProvider({
      project: "demo",
      settings: parsed.settings,
      token: TOKEN,
      fetch: github.fetch,
      clock,
    });
    const lane = parsed.settings.pipelines[0].lanes[0];
    const outcome = await new GitHubActionsExecutor("github-self-hosted", provider).run(
      {
        project: "demo",
        runId: "run-000000000001",
        jobId: "job-000000000001",
        pipeline: "gate",
        lane,
        commitSha: SHA,
        repoDir: REPO_DIR,
        settings: parsed.settings,
        attemptNo: 1,
      },
      { update: () => undefined, wait: () => undefined },
      { signal: new AbortController().signal, isCancelled: () => false },
    );
    expect(outcome).toMatchObject({ kind: "fallback" });
    expect(github.dispatches).toEqual([]);
  });
});

describe("fallback", () => {
  const SPENDING =
    "The job was not started because your spending limit needs to be increased. Please check the 'Billing & plans' section of your settings.";

  it("falls back when GitHub refuses the job for billing, and marks hosted runners unavailable", async () => {
    const h = await harness({ visibility: "private", executors: { github: { monthly_minutes: 100 } } });
    h.github.defaultScript = { refuse: SPENDING };
    const first = await h.run();

    expect(first.status).toBe("passed");
    expect(attemptsOf(first).slice(1)).toEqual([
      { executor: "github-hosted", status: "fell_back", reason: `GitHub refused the job: ${SPENDING}` },
      { executor: "nodes", status: "skipped", reason: NODES_NOT_BUILT },
      { executor: "local", status: "completed", reason: undefined },
    ]);
    expect(h.spawner.stepCalls().map((c) => c.argv.join(" "))).toEqual(["npm run lint", "npm test"]);

    const status = await h.manager.status("demo");
    const hosted = status.executors.find((e) => e.executor === "github-hosted")!;
    expect(hosted).toMatchObject({ available: false, reason: `GitHub refused the job: ${SPENDING}` });
    const left = Date.parse(hosted.unavailableUntil!) - h.clock.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(30 * MIN);

    // Within the period nothing is dispatched
    const second = await h.run();
    expect(h.github.dispatches).toHaveLength(1);
    const hostedSkip = attemptsOf(second).find((a) => a.executor === "github-hosted");
    expect(hostedSkip).toMatchObject({ status: "skipped" });
    expect(hostedSkip?.reason).toMatch(/^unavailable until .*spending limit/);
    expect(second.jobs[0].executor).toBe("local");

    // After it, hosted runners are tried again
    h.clock.advance(31 * MIN);
    h.github.defaultScript = {};
    const third = await h.run();
    expect(h.github.dispatches).toHaveLength(2);
    expect(third.jobs[0].executor).toBe("github-hosted");
  });

  it("falls back without marking anything when a dispatch is refused for the commit's own reasons", async () => {
    const h = await harness({ visibility: "public" });
    h.github.dispatchError = { status: 422, message: "Required input 'sha' not provided" };
    const run = await h.run();

    expect(run.jobs[0].executor).toBe("local");
    expect(attemptsOf(run)[1]).toMatchObject({ executor: "github-hosted", status: "fell_back" });
    const status = await h.manager.status("demo");
    expect(status.executors.find((e) => e.executor === "github-hosted")).toMatchObject({ available: true });
  });

  it("skips GitHub when the commit is not pushed or the workflow file is out of date", async () => {
    const h = await harness({ visibility: "public" });
    h.github.commits = new Set([SHA]);
    const unpushed = await h.run(SHA2);
    expect(attemptsOf(unpushed)[1]).toEqual({
      executor: "github-hosted",
      status: "skipped",
      reason: `commit ${SHA2} is not on GitHub (push it first)`,
    });

    h.github.commitWorkflow("# lair-workflow-version: 0000000000000000\nname: lair-gates\n");
    const stale = await h.run(SHA);
    expect(attemptsOf(stale)[1].reason).toContain(".github/workflows/lair-gates.yml on main is out of date");
    expect(h.github.dispatches).toEqual([]);
    expect(stale.jobs[0].executor).toBe("local");
  });

  it("cancels a run no runner picks up, confirms the cancel, then falls back", async () => {
    const h = await harness({
      visibility: "private",
      runners: [{ name: "runner-1" }],
      executors: { github: { pickup_timeout_minutes: 2, poll_seconds: 15 } },
      scripts: [{ pickupAfterPolls: Infinity }],
    });
    const run = await h.run();

    const ciRun = [...h.github.runs.values()][0];
    expect(h.github.cancels).toEqual([{ id: ciRun.id, force: false }]);
    expect(ciRun.conclusion).toBe("cancelled");
    expect(attemptsOf(run)).toEqual([
      {
        executor: "github-self-hosted",
        status: "fell_back",
        reason: "no runner picked the job up within 2 min; the CI run was cancelled",
      },
      {
        executor: "github-hosted",
        status: "skipped",
        reason: "executors.github.monthly_minutes is 0, so GitHub-hosted runners are off for this private repository",
      },
      { executor: "nodes", status: "skipped", reason: NODES_NOT_BUILT },
      { executor: "local", status: "completed", reason: undefined },
    ]);
    expect(h.spawner.stepCalls()).toHaveLength(2);
    const status = await h.manager.status("demo");
    expect(status.executors.find((e) => e.executor === "github-self-hosted")).toMatchObject({
      available: false,
      reason: "no runner picked the job up within 2 min; the CI run was cancelled",
    });
  });

  it("keeps the CI result when a runner takes the job just as it is cancelled: the job never runs twice", async () => {
    const h = await harness({
      visibility: "private",
      runners: [{ name: "runner-1" }],
      executors: { github: { pickup_timeout_minutes: 2 } },
      scripts: [{ pickupAfterPolls: Infinity, cancelTooLate: true }],
    });
    const run = await h.run();

    expect(h.github.cancels).toHaveLength(1);
    expect(h.github.dispatches).toHaveLength(1);
    expect(run.status).toBe("passed");
    expect(run.jobs[0].executor).toBe("github-self-hosted");
    expect(attemptsOf(run).map((a) => a.status)).toEqual(["completed"]);
    expect(h.spawner.stepCalls()).toEqual([]);
  });

  it("finds the run by its name when the dispatch API returns no run id", async () => {
    const h = await harness({ visibility: "public" });
    h.github.returnRunDetails = false;
    const run = await h.run();

    expect(run.jobs[0].executor).toBe("github-hosted");
    const ciRun = [...h.github.runs.values()][0];
    expect(run.jobs[0].attempts.at(-1)).toMatchObject({
      dispatchId: `${run.jobs[0].id}-1`,
      ciRunId: ciRun.id,
      ciRunUrl: `https://github.com/example-org/example-app/actions/runs/${ciRun.id}`,
    });
  });
});

describe("minutes budget", () => {
  it("raises one spend decision instead of going over the budget, and sends nothing to hosted runners", async () => {
    const h = await harness({
      visibility: "private",
      executors: { github: { monthly_minutes: 10 } },
      scripts: [{ durationMs: 8.5 * MIN }],
    });
    const first = await h.run();
    expect(first.jobs[0]).toMatchObject({ executor: "github-hosted", billedMinutes: 9 });
    // Into the fleet budget, as minutes, and not into its money totals
    expect(h.budget.getProviderStatus("github-actions:demo")).toMatchObject({
      currentCost: 9,
      maxCostPerPeriod: 10,
      unit: "minutes",
    });
    expect(h.budget.getStatus().totalCostToday).toBe(0);
    expect(h.decisions).toEqual([]);

    const second = await h.run();
    expect(h.github.dispatches).toHaveLength(1);
    expect(second.jobs[0].executor).toBe("local");
    expect(attemptsOf(second)[1]).toEqual({
      executor: "github-hosted",
      status: "skipped",
      reason:
        "GitHub-hosted minutes would go over the monthly budget (9 of 10 used, the next job needs about 9); a spend decision was raised",
    });
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0].data).toMatchObject({
      key: "pipelines:github-minutes:demo:2026-03",
      project: "demo",
      kind: "spend",
      onTimeout: "wait",
      requestedBy: "pipelines",
    });

    await h.run();
    expect(h.decisions).toHaveLength(1);
    expect(h.github.dispatches).toHaveLength(1);
    const status = await h.manager.status("demo");
    expect(status.minutes).toMatchObject({ usedThisMonth: 9, budget: 10 });
    expect(status.decisions).toHaveLength(1);
  });

  it("does not use hosted runners of a private repository without a budget", async () => {
    const h = await harness({ visibility: "private" });
    const run = await h.run();
    expect(h.github.dispatches).toEqual([]);
    expect(run.jobs[0].executor).toBe("local");
    expect(h.decisions).toEqual([]);
  });
});

describe("results", () => {
  const THREE_STEPS = {
    gate: {
      steps: [
        { name: "lint", run: ["npm", "run", "lint"] },
        { name: "test", run: ["npm", "test"] },
        { name: "build", run: ["npm", "run", "build"] },
      ],
    },
  };

  const normalize = (r: GateResult) => ({
    status: r.status,
    pipelineId: r.pipelineId,
    pipelineVersion: r.pipelineVersion,
    commitSha: r.commitSha,
    selectedSteps: r.selectedSteps,
    steps: r.steps.map((s) => ({ name: s.name, status: s.status, exitCode: s.exitCode, error: s.error })),
  });

  it("are the same GateResult whichever executor ran the job", async () => {
    const local = await harness({ token: false, pipelines: THREE_STEPS });
    local.spawner.results.set("npm test", { exitCode: 1, stdout: "1 test failed" });
    const localRun = await local.run();

    const ci = await harness({
      visibility: "public",
      pipelines: THREE_STEPS,
      scripts: [{ steps: [{ name: "test", conclusion: "failure", exitCode: 1, output: "1 test failed" }] }],
    });
    const ciRun = await ci.run();

    const a = localRun.jobs[0].result!;
    const b = ciRun.jobs[0].result!;
    expect(localRun.jobs[0].executor).toBe("local");
    expect(ciRun.jobs[0].executor).toBe("github-hosted");
    expect(normalize(b)).toEqual(normalize(a));
    expect(normalize(a).steps).toEqual([
      { name: "lint", status: "passed", exitCode: 0, error: undefined },
      { name: "test", status: "failed", exitCode: 1, error: "Exit code 1" },
      { name: "build", status: "skipped", exitCode: undefined, error: "Previous step failed" },
    ]);
    expect(a.steps[1].output).toContain("1 test failed");
    expect(b.steps[1].output).toContain("1 test failed");
    expect(a.nodeId).toBe("local");
    expect(b.nodeId).toBe("github-hosted");
    const parsed = parsePipelineConfig(THREE_STEPS, {}, "example-org/example-app");
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const gate = parsed.settings.pipelines[0].lanes[0].gate;
    expect(validateGateResult(a, gate)).toEqual([]);
    expect(validateGateResult(b, gate)).toEqual([]);
    expect([localRun.status, ciRun.status]).toEqual(["failed", "failed"]);
    expect([localRun.minutes, ciRun.minutes]).toEqual([0, 1]);
    // The stored log has the step output, never the token
    expect(ciRun.jobs[0].log).toContain("1 test failed");
    expect(ciRun.jobs[0].log).not.toContain(TOKEN);
  });

  it("fail when the CI run is missing a step, even if its log has a marker for it", async () => {
    const h = await harness({ visibility: "public", scripts: [{ omitSteps: ["test"] }] });
    const run = await h.run();
    expect(run.status).toBe("failed");
    expect(run.jobs[0].result!.steps[1]).toMatchObject({ name: "test", status: "failed", exitCode: -1 });
    expect(run.jobs[0].result!.steps[1].output).toContain("the CI run has no result for step test");
  });

  it("fail when GitHub failed a step whose log says exit 0", async () => {
    const h = await harness({
      visibility: "public",
      scripts: [{ steps: [{ name: "lint", conclusion: "failure", exitCode: 0 }] }],
    });
    const run = await h.run();
    expect(run.status).toBe("failed");
    expect(run.jobs[0].result!.steps[0]).toMatchObject({ name: "lint", status: "failed", exitCode: 1 });
  });
});

describe("restarts and capacity", () => {
  it("resumes a CI attempt that was in flight, without dispatching again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-runners-db-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "pipelines.db");
    const h = await harness({ visibility: "public", dbPath, scripts: [{ pickupAfterPolls: 3 }] });
    const started = await h.manager.startRun("demo", { pipeline: "gate", sha: SHA });
    await until(() => [...h.github.runs.values()].some((r) => r.polls >= 1));
    await h.manager.stop();

    const store = new PipelineStore(dbPath);
    const stored = store.getRun("demo", started.id)!;
    store.close();
    expect(stored.status).toBe("running");
    expect(stored.jobs[0].attempts.at(-1)).toMatchObject({ executor: "github-hosted", status: "queued" });

    const restarted = new PipelineManager(h.options);
    cleanups.push(() => restarted.stop());
    restarted.load([{ name: "demo", config: h.config }]);
    expect(await restarted.start()).toEqual(["demo"]);
    await restarted.idle();

    const run = restarted.getRun("demo", started.id);
    expect(run.status).toBe("passed");
    expect(h.github.dispatches).toHaveLength(1);
    expect(attemptsOf(run).map((a) => [a.executor, a.status])).toEqual([
      ["github-self-hosted", "skipped"],
      ["github-hosted", "completed"],
    ]);
  });

  it("waits for local capacity before it starts a job", async () => {
    const h = await harness({ token: false, executors: { local: { capacity_retry_seconds: 30 } } });
    h.capacity.queue = [
      { ...AMPLE, memoryPressure: "warn" },
      { ...AMPLE, freeRamMb: 100 },
      { ...AMPLE, load1: 40 },
    ];
    const before = h.clock.now();
    const run = await h.run();

    expect(run.status).toBe("passed");
    expect(h.capacity.calls).toBe(4);
    expect(h.clock.now() - before).toBeGreaterThanOrEqual(90_000);
    expect(h.spawner.stepCalls()).toHaveLength(2);
  });

  it("runs at most max_parallel local jobs at once, even when they ask together", async () => {
    const h = await harness({
      token: false,
      pipelines: {
        gate: {
          steps: [
            { name: "lint", run: ["npm", "run", "lint"], lane: "a" },
            { name: "test", run: ["npm", "test"], lane: "b" },
            { name: "build", run: ["npm", "run", "build"], lane: "c" },
          ],
        },
      },
    });
    h.spawner.stepTicks = 20;
    const run = await h.run();

    expect(run.status).toBe("passed");
    expect(h.spawner.stepCalls()).toHaveLength(3);
    expect(h.spawner.maxRunning).toBe(1);
  });

  it("cancels a waiting run", async () => {
    const h = await harness({ token: false });
    h.capacity.value = { ...AMPLE, memoryPressure: "critical" };
    const started = await h.manager.startRun("demo", { pipeline: "gate", sha: SHA });
    await until(() => h.capacity.calls >= 2);
    const cancelled = await h.manager.cancelRun("demo", started.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.jobs[0].status).toBe("cancelled");
    expect(h.spawner.stepCalls()).toEqual([]);
  });
});

describe("cancels, lost runners and visibility", () => {
  it("falls back, and does not fail the gate, when Lair's own pickup cancel stops a job a runner had just taken", async () => {
    const h = await harness({
      visibility: "private",
      runners: [{ name: "runner-1" }],
      executors: { github: { pickup_timeout_minutes: 2 } },
      scripts: [{ pickupAfterPolls: Infinity, pickupOnCancel: true }],
    });
    const run = await h.run();

    expect(h.github.cancels).toHaveLength(1);
    expect([...h.github.runs.values()][0].conclusion).toBe("cancelled");
    expect(run.status).toBe("passed");
    expect(run.jobs[0].executor).toBe("local");
    expect(run.jobs[0].attempts[0]).toMatchObject({
      executor: "github-self-hosted",
      status: "fell_back",
      reason:
        "no runner picked the job up within 2 min; a runner took the job just as Lair cancelled it, so it stopped unfinished: running it on the next executor",
    });
    expect(h.spawner.stepCalls()).toHaveLength(2);
  });

  it("retries once when the runner is lost mid-run", async () => {
    const h = await harness({ visibility: "public", scripts: [{ lostRunner: true }, {}] });
    const run = await h.run();

    expect(run.status).toBe("passed");
    expect(h.github.dispatches).toHaveLength(2);
    const hosted = run.jobs[0].attempts.filter((a) => a.executor === "github-hosted");
    expect(hosted.map((a) => a.status)).toEqual(["interrupted", "completed"]);
    expect(hosted[0]).toMatchObject({
      runnerLost: true,
      reason: "runner lost: the job ended cancelled with no failed step; trying once more",
    });
    expect(h.spawner.stepCalls()).toEqual([]);
  });

  it("fails, and says the runner was lost again, the second time", async () => {
    const h = await harness({ visibility: "public", scripts: [{ lostRunner: true }, { lostRunner: true }] });
    const run = await h.run();

    expect(run.status).toBe("failed");
    expect(h.github.dispatches).toHaveLength(2);
    expect(run.jobs[0].attempts.at(-1)).toMatchObject({
      executor: "github-hosted",
      status: "completed",
      reason: "runner lost: the job ended cancelled with no failed step, for the second time, so the result stands",
    });
  });

  it("reads the visibility again right before a self-hosted dispatch, not from the cache", async () => {
    const h = await harness({ visibility: "private", runners: [{ name: "runner-1" }] });
    // Made public after Lair cached it as private
    h.github.repo = { private: false, visibility: "public", default_branch: "main" };
    const run = await h.run();

    expect(h.github.dispatches).toEqual([]);
    expect(run.jobs[0].attempts[0]).toMatchObject({
      executor: "github-self-hosted",
      status: "fell_back",
      reason: "the repository is public: Lair never sends jobs to its self-hosted runners",
    });
    expect(run.jobs[0].executor).toBe("local");
  });

  it("treats only GitHub's own annotations as a billing refusal", async () => {
    const h = await harness({
      visibility: "private",
      executors: { github: { monthly_minutes: 100 } },
      scripts: [
        {
          refuse: "unused",
          annotations: [
            { path: ".github", message: "The job was not started because no runner matches its labels." },
            { path: "src/billing.test.ts", message: "The job was not started because the spending limit fixture says so" },
          ],
        },
      ],
    });
    const run = await h.run();

    const hosted = run.jobs[0].attempts.find((a) => a.executor === "github-hosted")!;
    expect(hosted).toMatchObject({
      status: "fell_back",
      reason: "the job never started on a runner: The job was not started because no runner matches its labels.",
    });
    expect(hosted.reason).not.toContain("spending limit");
  });
});

describe("restarts", () => {
  it("after a restart, waits up to 10 minutes for the run of a dispatch it had sent, instead of dispatching again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-runners-db-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "pipelines.db");
    const h = await harness({ visibility: "public", dbPath });
    h.github.returnRunDetails = false;
    h.github.listHiddenUntil = Number.MAX_SAFE_INTEGER;
    const started = await h.manager.startRun("demo", { pipeline: "gate", sha: SHA });
    await until(() => h.github.dispatches.length === 1 && h.github.requests.some((r) => r.path.endsWith("/runs")));
    await h.manager.stop();

    const store = new PipelineStore(dbPath);
    const attempt = store.getRun("demo", started.id)!.jobs[0].attempts.at(-1);
    store.close();
    expect(attempt).toMatchObject({ executor: "github-hosted", status: "dispatching" });

    // The run shows up 5 minutes after the restart: longer than a fresh dispatch waits
    h.github.listHiddenUntil = h.clock.now() + 5 * MIN;
    const restarted = new PipelineManager(h.options);
    cleanups.push(() => restarted.stop());
    restarted.load([{ name: "demo", config: h.config }]);
    await restarted.start();
    await restarted.idle();

    const run = restarted.getRun("demo", started.id);
    expect(run.status).toBe("passed");
    expect(h.github.dispatches).toHaveLength(1);
    expect(run.jobs[0].executor).toBe("github-hosted");
  });

  it("removes the worktrees a crash left behind when it starts", async () => {
    const h = await harness({ token: false });
    const base = join(h.options.lairDir!, "data", "pipelines", "worktrees");
    mkdirSync(join(base, "job-0123456789ab"), { recursive: true });
    writeFileSync(join(base, "job-0123456789ab", "file.txt"), "left over");
    mkdirSync(join(base, "keep-me"), { recursive: true });

    expect(await h.manager.start()).toEqual(["demo"]);
    expect(existsSync(join(base, "job-0123456789ab"))).toBe(false);
    expect(existsSync(join(base, "keep-me"))).toBe(true);
    expect(h.spawner.calls.map((c) => c.argv)).toContainEqual(["git", "-C", REPO_DIR, "worktree", "prune"]);
  });
});
