/**
 * The dashboard's own read routes, mounted as src/server/index.ts mounts
 * them, with a real HumanAuth and a real DataService over a gates_dir and
 * agents_dir on disk. The other modules' answers (agent runs, pipeline
 * runs, triage records, placement) are given as the data those modules
 * return. Logs and test output are the owner's: 403 for anyone else, and
 * bounded for the owner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { DataService } from "../services/data.js";
import { MAX_TAIL_LINES, MAX_TAIL_LINE_LENGTH } from "../services/log-tail.js";
import { registerDashboardRoutes } from "./routes.js";
import { MAX_FAILING_TESTS } from "./gate-detail.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentRunView } from "../../shared/agents-types.js";
import type { PipelineRun } from "../../shared/pipeline-types.js";
import type { PlacementStatus } from "../../shared/placement-types.js";
import type { TriageRecord } from "../../shared/triage-types.js";
import type { AgentLogView, DashboardModules, GateDetailView, GateOutputView } from "../../shared/dashboard-types.js";

const PROJECT = "dash";
const QUEUED = "20261024T170000Z-api-tests-abcdef12-1";
const FAILED = "20261024T160000Z-web-0123abcd-7";
const FROM_LOG = "20261024T150000Z-unit-11112222-3";
const SECRET = "ghp_" + "a".repeat(36);

let tmp = "";
let app: FastifyInstance;
let auth: HumanAuth;
let session = "";
let config: ProjectConfig;
let agentRuns: AgentRunView[] = [];

/** The dashboard in a browser signed in as the owner */
function owner(): Record<string, string> {
  return { origin: "http://localhost:4777", "sec-fetch-site": "same-origin", [OWNER_SESSION_HEADER]: session };
}

async function get<T>(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.json() as { success: boolean; data?: T; error?: string }, raw: res.body };
}

function triageRecord(gateId: string, tests: number): TriageRecord {
  return {
    id: "rec-1",
    project: PROJECT,
    gateId,
    pipelineId: "gate",
    trust: "trusted",
    sha: "0123abcd" + "0".repeat(32),
    branch: "feat/web",
    purpose: "gate",
    status: "failed",
    defaultBranch: false,
    verdict: "code",
    blocking: true,
    retries: 0,
    failedSteps: ["web-test"],
    changedFiles: [],
    receivedAt: "2026-10-24T16:10:00.000Z",
    causes: [
      {
        id: "cause-1",
        cause: {
          signature: "sig",
          kind: "test",
          step: "web-test",
          parser: "junit",
          type: "AssertionError",
          message: `expected 1 to be 2 (token ${SECRET})`,
          causedBy: [],
          rootCause: "AssertionError: expected 1 to be 2",
          tests: Array.from({ length: tests }, (_, i) => ({
            suite: "web.CartTest",
            name: `adds item ${i}`,
            id: `web.CartTest#adds item ${i}`,
            key: `CartTest#adds item ${i}`,
          })),
          testCount: tests,
          locations: [],
          evidence: ["at CartTest.java:42", "expected 1 to be 2"],
        },
        verdict: { class: "code", rule: "assertion", confidence: "high", evidence: ["an assertion failed"] },
      },
    ],
  };
}

const placement: PlacementStatus = {
  project: PROJECT,
  enabled: true,
  running: true,
  mode: "observe",
  actBlocked: "observe mode",
  errors: [],
  intervalSeconds: 60,
  lastTick: null,
  lastError: null,
  machines: [],
  lanes: [{ name: "heavy", machine: "builder", slots: 1, inUse: 0, queued: 1, limits: [], serves: [] }],
  jobs: [
    {
      id: QUEUED,
      lane: "heavy",
      priority: 1,
      status: "queued",
      class: null,
      expectedStart: "2026-10-24T17:10:00.000Z",
      expectedFinish: "2026-10-24T17:40:00.000Z",
      held: null,
      advice: { to: "remote", gainSeconds: 1200, explanation: "would move to remote: 20 min sooner", quiet: false },
    },
  ],
  moves: [],
  durations: [],
};

const pipelineRun: PipelineRun = {
  id: "run-0123456789ab",
  project: PROJECT,
  pipeline: "gate",
  commitSha: "f".repeat(40),
  branch: "main",
  status: "failed",
  createdAt: "2026-10-24T12:00:00.000Z",
  startedAt: "2026-10-24T12:00:05.000Z",
  completedAt: "2026-10-24T12:03:00.000Z",
  minutes: 3,
  billedMinutes: 0,
  steps: [
    { name: "install", lane: "default", status: "passed", durationMs: 40_000, executor: "local", where: "local machine" },
    { name: "test", lane: "default", status: "failed", exitCode: 1, durationMs: 120_000, executor: "local", where: "local machine" },
  ],
  jobs: [
    {
      id: "job-1",
      runId: "run-0123456789ab",
      lane: "default",
      status: "failed",
      executor: "local",
      where: "local machine",
      attempts: [],
      log: `npm test\n${SECRET}\nFAIL`,
      artifacts: [],
      minutes: 3,
      billedMinutes: 0,
      createdAt: "2026-10-24T12:00:00.000Z",
    },
  ],
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "lair-dashboard-"));
  const gates = join(tmp, "gates");
  const agentsDir = join(tmp, "agents");
  mkdirSync(join(gates, "queue"), { recursive: true });
  mkdirSync(join(gates, "results"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  // A running gate of the queue, with its log
  writeFileSync(join(gates, "queue", `heavy.1.${QUEUED}.req.run`), "");
  writeFileSync(
    join(gates, "queue", `heavy.1.${QUEUED}.log`),
    [
      "[gate-run] heavy lane, track: api-tests",
      "== gate api at abcdef1234 2026-10-24T17:00:00Z; base 99998888",
      "PASS security-guard (24s)",
      "STEP commitlint: PASS (2s)",
      `STEP gitleaks: PASS (15s) ${SECRET}`,
      "STEP verify: running",
    ].join("\n"),
  );
  // A failed result, which triage has a record of
  writeFileSync(join(gates, "results", `${FAILED}.rc`), "1\n");
  const long = "x".repeat(MAX_TAIL_LINE_LENGTH * 3);
  const many = Array.from({ length: 3000 }, (_, i) => `output line ${i}`);
  writeFileSync(
    join(gates, "results", `${FAILED}.log`),
    [...many, long, "STEP web-lint: PASS (3s)", "STEP web-test: FAIL (95s)", "== FAILED STEPS: web-test(rc=1)", ""].join("\n"),
  );
  // A failed result triage has no record of: its tests come from the log's console output
  writeFileSync(join(gates, "results", `${FROM_LOG}.rc`), "1\n");
  writeFileSync(
    join(gates, "results", `${FROM_LOG}.log`),
    `STEP unit: FAIL (30s)\n${readFileSync(join(process.cwd(), "fixtures", "triage", "vitest-console.txt"), "utf-8")}\n== FAILED STEPS: unit(rc=1)\n`,
  );

  // Agent logs: an older one Lair's agents module wrote, a newer one, and one outside agents_dir
  writeFileSync(join(agentsDir, "alpha-20261024T100000Z.log"), "old line\n");
  writeFileSync(join(agentsDir, "alpha-20261024T120000Z.log"), `started\nworking on feat-login\nauth ${SECRET}\n`);
  utimesSync(join(agentsDir, "alpha-20261024T100000Z.log"), new Date("2026-10-24T10:00:00Z"), new Date("2026-10-24T10:00:00Z"));
  writeFileSync(join(tmp, "outside.log"), "not an agent log\n");
  writeFileSync(join(tmp, "secret.txt"), "the owner token\n");
  symlinkSync(join(tmp, "secret.txt"), join(agentsDir, "beta-20261024T120000Z.log"));

  config = {
    name: PROJECT,
    repo: tmp,
    github: "example/app",
    queue_file: join(tmp, "queue.md"),
    agents_dir: agentsDir,
    gates_dir: gates,
    machines: { builder: { name: "builder", type: "local", runners: ["heavy"] } },
    read_only: false,
    agents: { enabled: true, fill: { enabled: true } },
    review: { enabled: true },
    processes: { helper: { command: ["true"] } },
    pipelines: { gate: { steps: [] } },
  } as ProjectConfig;
  const data = new DataService(config);

  auth = HumanAuth.open({ tokenPath: join(tmp, "owner.token"), dbPath: ":memory:" });
  session = auth.createSession(readFileSync(join(tmp, "owner.token"), "utf-8").trim())!.session;
  app = Fastify({ logger: false });
  await registerDashboardRoutes(
    app,
    {
      defaultProject: () => PROJECT,
      config: (project) => {
        if (project !== PROJECT) throw new Error(`No project ${project}`);
        return config;
      },
      data: () => data,
      agentRuns: () => agentRuns,
      pipelineRuns: () => [pipelineRun],
      triageRecords: () => [triageRecord(FAILED, 3)],
      placement: () => placement,
      nodeCount: () => 2,
    },
    auth,
  );
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  auth?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/dashboard/modules", () => {
  it("says which modules the project's YAML turns on", async () => {
    const { status, body } = await get<DashboardModules>(`/api/dashboard/modules?project=${PROJECT}`);
    expect(status).toBe(200);
    expect(body.data).toEqual({
      project: PROJECT,
      readOnly: false,
      error: null,
      modules: {
        agents: true,
        fill: true,
        review: true,
        triage: false,
        placement: false,
        pipelines: true,
        delivery: false,
        watchdog: false,
        processes: true,
        github: true,
        machines: true,
        nodes: true,
      },
    });
  });

  it("turns every module off for a project whose config can't be read, and says why", async () => {
    const { body } = await get<DashboardModules>("/api/dashboard/modules?project=gone");
    expect(body.data!.error).toBe("No project gone");
    expect(body.data!.readOnly).toBe(true);
    expect(Object.entries(body.data!.modules).filter(([, on]) => on)).toEqual([["nodes", true]]);
  });
});

describe("GET /api/dashboard/gates/:id", () => {
  it("a running gate of the queue: lane, track, sha, base, its steps with durations, placement", async () => {
    const { status, body, raw } = await get<GateDetailView>(`/api/dashboard/gates/${QUEUED}?project=${PROJECT}`);
    expect(status).toBe(200);
    const gate = body.data!;
    expect(gate).toMatchObject({
      id: QUEUED,
      source: "queue",
      status: "running",
      lane: "heavy",
      priority: 1,
      track: "api-tests",
      sha: "abcdef1234",
      base: "99998888",
      startedAt: "2026-10-24T17:00:00Z",
      machine: "builder",
      currentStep: "verify",
      rc: null,
      hasLog: true,
    });
    expect(gate.steps).toEqual([
      { name: "security-guard", state: "passed", durationSeconds: 24 },
      { name: "commitlint", state: "passed", durationSeconds: 2 },
      { name: "gitleaks", state: "passed", durationSeconds: 15 },
      { name: "verify", state: "running", durationSeconds: null },
    ]);
    expect(gate.placement?.job?.advice?.to).toBe("remote");
    // The open detail carries no log line
    expect(raw).not.toContain(SECRET);
  });

  it("a failed result: rc, failed steps with the exit code, and triage's verdict without test output", async () => {
    const { body, raw } = await get<GateDetailView>(`/api/dashboard/gates/${FAILED}?project=${PROJECT}`);
    const gate = body.data!;
    expect(gate).toMatchObject({ status: "failed", rc: 1, track: "web", branch: "feat/web", failedSteps: ["web-test"] });
    expect(gate.steps).toEqual([
      { name: "web-lint", state: "passed", durationSeconds: 3 },
      { name: "web-test", state: "failed", durationSeconds: 95, exitCode: 1 },
    ]);
    expect(gate.triage).toMatchObject({ recordId: "rec-1", verdict: "code", blocking: true });
    expect(gate.triage!.causes[0]).toMatchObject({ class: "code", rule: "assertion", kind: "test", testCount: 3 });
    expect(raw).not.toContain("adds item");
    expect(raw).not.toContain("at CartTest.java:42");
    expect(raw).not.toContain(SECRET);
  });

  it("a Lair pipeline run, by its id or its job's", async () => {
    for (const id of ["run-0123456789ab", "job-1"]) {
      const { body, raw } = await get<GateDetailView>(`/api/dashboard/gates/${id}?project=${PROJECT}`);
      expect(body.data).toMatchObject({
        source: "pipeline",
        runId: "run-0123456789ab",
        status: "failed",
        pipeline: "gate",
        branch: "main",
        machine: "local machine",
        failedSteps: ["test"],
        hasLog: true,
      });
      expect(body.data!.steps[1]).toMatchObject({ name: "test", state: "failed", durationSeconds: 120, exitCode: 1, lane: "default" });
      expect(raw).not.toContain(SECRET);
    }
  });

  it("404 for a gate nobody knows, 400 for an id that isn't a safe file name", async () => {
    expect((await get(`/api/dashboard/gates/20990101T000000Z-x-abc-1?project=${PROJECT}`)).status).toBe(404);
    expect((await get(`/api/dashboard/gates/..%2F..%2Fsecret?project=${PROJECT}`)).status).toBe(400);
  });
});

describe("GET /api/dashboard/gates/:id/output (owner only)", () => {
  it("403 without the owner's session, and nothing of the log or the tests in the refusal", async () => {
    for (const headers of [{}, { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" }, { [OWNER_SESSION_HEADER]: session }]) {
      const res = await get(`/api/dashboard/gates/${FAILED}/output?project=${PROJECT}`, headers);
      expect(res.status).toBe(403);
      expect(res.raw).not.toContain("output line");
      expect(res.raw).not.toContain("adds item");
    }
  });

  it("gives the owner a bounded log tail and the failing tests triage read, with their messages", async () => {
    const { status, body } = await get<GateOutputView>(`/api/dashboard/gates/${FAILED}/output?project=${PROJECT}&lines=50`, owner());
    expect(status).toBe(200);
    const out = body.data!;
    expect(out.log!.lines).toHaveLength(50);
    expect(out.log!.truncated).toBe(true);
    expect(out.log!.lines.at(-1)).toBe("== FAILED STEPS: web-test(rc=1)");
    expect(out.log!.file).toBe(`${FAILED}.log`);
    expect(out.testsFrom).toBe("triage");
    expect(out.tests).toHaveLength(3);
    expect(out.tests[0]).toMatchObject({ id: "web.CartTest#adds item 0", class: "code", step: "web-test" });
    expect(out.tests[0].message).toContain("AssertionError: expected 1 to be 2");
    expect(out.evidence).toContain("at CartTest.java:42");

    // At most MAX_TAIL_LINES lines, each at most MAX_TAIL_LINE_LENGTH characters
    const all = (await get<GateOutputView>(`/api/dashboard/gates/${FAILED}/output?project=${PROJECT}&lines=999999`, owner())).body.data!;
    expect(all.log!.lines).toHaveLength(MAX_TAIL_LINES);
    expect(Math.max(...all.log!.lines.map((l) => l.length))).toBe(MAX_TAIL_LINE_LENGTH);
  });

  it("caps the failing tests it lists", async () => {
    const big = Fastify({ logger: false });
    await registerDashboardRoutes(
      big,
      {
        defaultProject: () => PROJECT,
        config: () => config,
        data: () => new DataService(config),
        triageRecords: () => [triageRecord(FAILED, MAX_FAILING_TESTS + 50)],
      },
      auth,
    );
    const res = await big.inject({ method: "GET", url: `/api/dashboard/gates/${FAILED}/output`, headers: owner() });
    const out = (res.json() as { data: GateOutputView }).data;
    expect(out.tests).toHaveLength(MAX_FAILING_TESTS);
    expect(out.testsTruncated).toBe(true);
    await big.close();
  });

  it("without a triage record, reads the failing tests from the log's console output", async () => {
    const { body } = await get<GateOutputView>(`/api/dashboard/gates/${FROM_LOG}/output?project=${PROJECT}`, owner());
    const out = body.data!;
    expect(out.testsFrom).toBe("log");
    const test = out.tests.find((t) => t.name === "total > includes tax");
    expect(test).toMatchObject({ file: "src/orders/total.test.ts", step: "unit", class: null });
    expect(test!.message).toBe("AssertionError: expected 100 to be 108 // Object.is equality");
  });

  it("masks credentials in a pipeline job's log", async () => {
    const { body } = await get<GateOutputView>(`/api/dashboard/gates/run-0123456789ab/output?project=${PROJECT}`, owner());
    const lines = body.data!.log!.lines;
    expect(lines[0]).toBe("== default (local machine)");
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines).toContain("ghp_***");
  });
});

describe("GET /api/dashboard/agents/:id/log (owner only)", () => {
  it("403 without the owner's session", async () => {
    const res = await get(`/api/dashboard/agents/alpha/log?project=${PROJECT}`);
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain("feat-login");
  });

  it("gives the owner the newest log's tail, credentials masked", async () => {
    agentRuns = [];
    const { body } = await get<AgentLogView>(`/api/dashboard/agents/alpha/log?project=${PROJECT}&lines=2`, owner());
    expect(body.data).toMatchObject({ agent: "alpha", source: "dragon", runId: null });
    expect(body.data!.log!.file).toBe("alpha-20261024T120000Z.log");
    expect(body.data!.log!.lines).toEqual(["working on feat-login", "auth ghp_***"]);
  });

  it("prefers the agents module's run log, unless an older one; never a path outside agents_dir", async () => {
    const run = (id: string, logPath: string) => ({ id, agent: "alpha", logPath }) as AgentRunView;
    agentRuns = [run("r-new", join(config.agents_dir, "alpha-20261024T120000Z.log"))];
    expect((await get<AgentLogView>(`/api/dashboard/agents/alpha/log`, owner())).body.data).toMatchObject({
      source: "run",
      runId: "r-new",
    });
    agentRuns = [run("r-old", join(config.agents_dir, "alpha-20261024T100000Z.log"))];
    expect((await get<AgentLogView>(`/api/dashboard/agents/alpha/log`, owner())).body.data!.source).toBe("dragon");
    agentRuns = [run("r-out", join(tmp, "outside.log"))];
    const outside = (await get<AgentLogView>(`/api/dashboard/agents/alpha/log`, owner())).body.data!;
    expect(outside.source).toBe("dragon");
    expect(outside.log!.lines).not.toContain("not an agent log");
    agentRuns = [];
  });

  it("does not follow a symlink planted as an agent's log, and refuses an unsafe id", async () => {
    const res = await get<AgentLogView>(`/api/dashboard/agents/beta/log`, owner());
    expect(res.body.data!.log).toBeNull();
    expect(res.raw).not.toContain("the owner token");
    expect((await get(`/api/dashboard/agents/..%2Fx/log`, owner())).status).toBe(400);
  });
});
