/**
 * The pipeline API over real HTTP: a Fastify server with the same root
 * guards and pipeline routes as src/server/index.ts, listening on a port,
 * with a project config loaded from projects/local/ by the real loader.
 * Steps run as real processes (the real spawner) in a real git worktree.
 * Only the GitHub REST API is fake.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { listProjects, loadProjectConfig } from "../config.js";
import { registerRootGuards } from "../root-guards.js";
import type { PipelineRun, PipelinesStatus } from "../../shared/pipeline-types.js";
import { PipelineManager } from "./pipeline-service.js";
import { registerPipelineRoutes } from "./routes.js";
import { AMPLE, FakeCapacity, FakeClock, FakeGitHub, TOKEN } from "./testing/fakes.js";

const LOCAL_DIR = join(process.cwd(), "projects", "local");
const PROJECT = "lair-pipelines-http-test";
const READ_ONLY = "lair-pipelines-http-readonly";
const SPENDING = "The job was not started because recent account payments have failed or your spending limit needs to be increased.";

let tmp = "";
let repo = "";
let sha = "";
let base = "";
let createdLocalDir = false;
let app: FastifyInstance | null = null;
let manager: PipelineManager | null = null;
let github: FakeGitHub;
let capacity: FakeCapacity;

function yamlFor(name: string, readOnly: boolean): string {
  const q = JSON.stringify;
  const node = process.execPath;
  return [
    `name: ${name}`,
    `repo: ${q(repo)}`,
    "github: example-org/example-app",
    `queue_file: ${q(join(tmp, "queue.md"))}`,
    `agents_dir: ${q(tmp)}`,
    `gates_dir: ${q(tmp)}`,
    "machines: {}",
    `read_only: ${readOnly}`,
    "pipelines:",
    "  gate:",
    "    steps:",
    "      - name: check",
    `        run: [${q(node)}, "-e", "process.stdout.write('file:' + require('fs').readFileSync('file.txt', 'utf8'))"]`,
    "      - name: quick",
    "        lane: quick",
    `        run: [${q(node)}, "-e", "process.exit(0)"]`,
    "    lanes:",
    "      quick: { executors: [local] }",
    "executors:",
    "  github:",
    "    monthly_minutes: 30",
    "  local:",
    `    worktree_dir: ${q(join(tmp, "worktrees"))}`,
    "",
  ].join("\n");
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lair-pipelines-http-"));
  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "file.txt"), "hello");
  execFileSync("git", ["-C", repo, "add", "file.txt"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Lair Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  if (!existsSync(LOCAL_DIR)) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    createdLocalDir = true;
  }
  writeFileSync(join(LOCAL_DIR, `${PROJECT}.yaml`), yamlFor(PROJECT, false));
  writeFileSync(join(LOCAL_DIR, `${READ_ONLY}.yaml`), yamlFor(READ_ONLY, true));

  const clock = new FakeClock();
  github = new FakeGitHub(clock);
  github.repo = { private: true, visibility: "private", default_branch: "main" };
  github.defaultScript = { refuse: SPENDING };
  capacity = new FakeCapacity();
  manager = new PipelineManager({
    dbPath: ":memory:",
    fetch: github.fetch,
    clock,
    capacity,
    env: { ...process.env, LAIR_GITHUB_TOKEN: TOKEN },
    lairDir: tmp,
  });
  manager.load(
    listProjects()
      .filter((name) => name === PROJECT || name === READ_ONLY)
      .map((name) => ({ name, config: loadProjectConfig(name) })),
  );
  github.commitWorkflow((await manager.workflow(PROJECT)).content);

  app = Fastify({ logger: false });
  registerRootGuards(app);
  await registerPipelineRoutes(app, manager, () => PROJECT);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await manager?.stop();
  rmSync(join(LOCAL_DIR, `${PROJECT}.yaml`), { force: true });
  rmSync(join(LOCAL_DIR, `${READ_ONLY}.yaml`), { force: true });
  if (createdLocalDir && existsSync(LOCAL_DIR) && readdirSync(LOCAL_DIR).length === 0) {
    rmSync(LOCAL_DIR, { recursive: true, force: true });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: { success: boolean; data?: T; error?: string } }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.origin) headers.origin = init.origin;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: T; error?: string } };
}

async function waitForRun(id: string, project = PROJECT): Promise<PipelineRun> {
  for (let i = 0; i < 400; i++) {
    const { body } = await api<PipelineRun>(`/api/pipelines/runs/${id}?project=${project}`);
    if (body.data?.completedAt) return body.data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not finish`);
}

describe("pipeline API over HTTP", () => {
  it("runs a pipeline: GitHub refuses the job for billing, and the local machine runs it at the commit", async () => {
    const started = await api<PipelineRun>(`/api/pipelines/runs?project=${PROJECT}`, {
      method: "POST",
      body: { pipeline: "gate" },
    });
    expect(started.status).toBe(202);
    expect(started.body.data!.id).toMatch(/^run-[0-9a-f]{12}$/);
    expect(started.body.data!.commitSha).toBe(sha);

    const run = await waitForRun(started.body.data!.id);
    expect(run.status).toBe("passed");
    expect(run.steps.map((s) => [s.name, s.lane, s.status, s.executor, s.where])).toEqual([
      ["check", "default", "passed", "local", "local machine"],
      ["quick", "quick", "passed", "local", "local machine"],
    ]);
    // The step ran in a worktree of the commit, as a real process
    const checks = run.jobs.find((j) => j.lane === "default")!;
    expect(checks.result!.steps[0].output).toBe("file:hello");
    expect(checks.attempts.map((a) => [a.executor, a.status])).toEqual([
      ["github-self-hosted", "skipped"],
      ["github-hosted", "fell_back"],
      ["nodes", "skipped"],
      ["local", "completed"],
    ]);
    expect(checks.attempts[1].reason).toBe(`GitHub refused the job: ${SPENDING}`);
    expect(checks.attempts[1].ciRunUrl).toMatch(/^https:\/\/github\.com\/example-org\/example-app\/actions\/runs\/\d+$/);
    expect(run.jobs.find((j) => j.lane === "quick")!.attempts.map((a) => [a.executor, a.status])).toEqual([
      ["local", "completed"],
    ]);
    expect(run.minutes).toBe(0);
    expect(github.dispatches).toHaveLength(1);
    expect(github.dispatches[0].inputs).toMatchObject({ sha, job: "gate.default", runner: "hosted" });
    expect(existsSync(join(tmp, "worktrees", checks.id))).toBe(false);

    const status = await api<PipelinesStatus>(`/api/pipelines/status?project=${PROJECT}`);
    expect(status.status).toBe(200);
    expect(status.body.data!.executors.find((e) => e.executor === "github-hosted")).toMatchObject({
      available: false,
      reason: `GitHub refused the job: ${SPENDING}`,
    });
    expect(status.body.data!.github).toMatchObject({ tokenSet: true, visibility: "private" });

    const list = await api<PipelineRun[]>(`/api/pipelines/runs?project=${PROJECT}&limit=5`);
    expect(list.body.data!.map((r) => r.id)).toContain(run.id);
  });

  it("cancels a run that waits for local capacity", async () => {
    capacity.value = { ...AMPLE, memoryPressure: "critical" };
    try {
      const started = await api<PipelineRun>(`/api/pipelines/runs?project=${PROJECT}`, {
        method: "POST",
        body: { pipeline: "gate", sha },
      });
      expect(started.status).toBe(202);
      const id = started.body.data!.id;
      const cancelled = await api<PipelineRun>(`/api/pipelines/runs/${id}/cancel?project=${PROJECT}`, {
        method: "POST",
      });
      expect(cancelled.status).toBe(200);
      const run = await waitForRun(id);
      expect(run.status).toBe("cancelled");
      expect(run.steps.every((s) => s.status === "pending")).toBe(true);
    } finally {
      capacity.value = AMPLE;
    }
  });

  it("serves the workflow file with setup steps", async () => {
    const { status, body } = await api<{ path: string; content: string; allowSelfHosted: boolean; instructions: string[] }>(
      `/api/pipelines/workflow?project=${PROJECT}`,
    );
    expect(status).toBe(200);
    expect(body.data!.path).toBe(".github/workflows/lair-gates.yml");
    expect(body.data!.allowSelfHosted).toBe(true);
    expect(body.data!.content).toContain("workflow_dispatch:");
    expect(body.data!.content).toContain("permissions:\n  contents: read");
    expect(body.data!.instructions.join(" ")).toContain("register a self-hosted runner");
  });

  it("refuses cross-site requests, invalid input, unknown runs and read-only projects", async () => {
    const crossSite = await api(`/api/pipelines/runs?project=${PROJECT}`, {
      method: "POST",
      body: { pipeline: "gate" },
      origin: "http://attacker.example",
    });
    expect(crossSite.status).toBe(403);

    expect((await api(`/api/pipelines/runs/not-a-run?project=${PROJECT}`)).status).toBe(400);
    expect((await api(`/api/pipelines/runs/run-000000000000?project=${PROJECT}`)).status).toBe(404);
    expect((await api(`/api/pipelines/runs?project=no-such-project`)).status).toBe(400);
    const post = (body: unknown, project = PROJECT) =>
      api(`/api/pipelines/runs?project=${project}`, { method: "POST", body });
    expect((await post({ pipeline: "nope" })).status).toBe(404);
    expect((await post({ pipeline: "gate", sha: "not-a-sha" })).status).toBe(400);
    expect((await post({ pipeline: "gate", branch: "--upload-pack=x" })).status).toBe(400);
    expect((await post({ pipeline: "gate", extra: true })).status).toBe(400);
    const readOnly = await post({ pipeline: "gate", sha }, READ_ONLY);
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error).toBe("Project is in read-only mode");
    expect(github.dispatches).toHaveLength(1);
  });
});
