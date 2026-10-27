/**
 * Re-checks in a project's own gate system (gate-recheck.ts), through the
 * production path: mountTriage() on a real Fastify instance, signed results
 * POSTed to /api/triage/results (real Ed25519 signatures) or handed over as
 * gate.completed events, the real manager, service, parsers, classifier and
 * SQLite store. Only the command runner (it records each argv and answers as
 * the gate system's enqueue script would), the clock and git are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GateResult, GateStepResult } from "../../shared/policy-types.js";
import type { FlakyTest, GateRecheck, TriageRecord } from "../../shared/triage-types.js";
import { EventBus } from "../core/event-bus.js";
import { NodeFileSystem, type CommandOutput } from "../watchdog/probes.js";
import { parseTriageConfig } from "./config.js";
import { buildRecheckArgv } from "./gate-recheck.js";
import { mountTriage, type TriageManager } from "./index.js";
import { TriageStore } from "./store.js";
import {
  FakeClock,
  FakeGit,
  FakeRunner,
  fixture,
  gate,
  junitPassing,
  MIN,
  NOW,
  projectConfig,
  sha,
  sha256,
  step,
  trustedNode,
  type TestNode,
} from "./testing/harness.js";

const PROGRAM = "/opt/gates/bin/gate-recheck";
const COMMAND = [PROGRAM, "{sha}", "{pipeline}", "{kind}", "{result_id}", "{reason}", "{tests}"];
const ORDER = "com.example.shop.orders.OrderServiceTest";
const CART = "com.example.shop.cart.CartTest";
const BRANCH = "feat/orders";
const HOUR = 60 * MIN;
const DOCKER_DOWN = "Starting the test containers\nERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";
const OUT_OF_MEMORY = "Running the test suite\njava.lang.OutOfMemoryError: Java heap space\n";

interface Boot {
  app: FastifyInstance;
  manager: TriageManager;
  runner: FakeRunner;
  clock: FakeClock;
  events: EventBus;
  node: TestNode;
  dir: string;
  /** The decisions triage appended to the project's inbox file (no Decision Inbox here) */
  decisions(): string[];
  tick(): Promise<void>;
}

const opened: { app: FastifyInstance; manager: TriageManager }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.app.close();
    await o.manager.stop();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Triage observes; its gate system re-checks act (triage.recheck.mode decides
 * for its command alone), with no cool-down unless a test sets one.
 */
async function boot(
  recheck: Record<string, unknown> = {},
  options: { triage?: Record<string, unknown>; dir?: string; dbPath?: string; readOnly?: boolean } = {},
): Promise<Boot> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "lair-gate-recheck-"));
  if (!options.dir) dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const node = trustedNode(dir, "gates-1");
  const runner = new FakeRunner();
  const clock = new FakeClock();
  const git = new FakeGit();
  const events = new EventBus();
  const app = Fastify();
  const triage = {
    enabled: true,
    mode: "observe",
    trusted_nodes: [{ id: node.id, public_key_file: node.publicKeyFile }],
    recheck: { mode: "act", command: COMMAND, cooldown_seconds: 0, ...recheck },
    ...options.triage,
  };
  const manager = await mountTriage(app, {
    dbPath: options.dbPath ?? ":memory:",
    probes: { runner, clock, fs: new NodeFileSystem(), git: () => git },
    events,
    projects: [{ name: "demo", config: projectConfig(repo, triage, options.readOnly ? { read_only: true } : {}) }],
    defaultProject: () => "demo",
  });
  await app.ready();
  opened.push({ app, manager });
  const inbox = join(repo, "inbox.md");
  return {
    app,
    manager,
    runner,
    clock,
    events,
    node,
    dir,
    decisions: () => (existsSync(inbox) ? readFileSync(inbox, "utf-8").split("\n").filter((l) => l.startsWith("- OWNER?")) : []),
    tick: async () => {
      await manager.get("demo")!.tick();
      await manager.idle();
    },
  };
}

/** The gate system's enqueue script: it prints the new gate's result id (run-1, run-2, ...). */
function enqueues(b: Boot): void {
  let n = 0;
  b.runner.when(
    (argv) => argv[0] === PROGRAM,
    () => ({ code: 0, stdout: `run-${++n}\n`, stderr: "" }),
  );
}

type Report = { name: string; step?: string; content: string };

/** What the gate runner sends: the result with its reports' digests, signed, and the reports. */
function signedBody(node: TestNode, result: GateResult, reports: Report[], recheckId?: string) {
  const withDigests: GateResult = {
    ...result,
    nodeId: node.id,
    reports: reports.map((r) => ({ name: r.name, step: r.step, sha256: sha256(r.content) })),
  };
  return {
    signed: node.sign(withDigests),
    reports: reports.map((r) => ({ name: r.name, content: r.content })),
    ...(recheckId ? { recheckId } : {}),
  };
}

async function post(b: Boot, result: GateResult, reports: Report[] = [], recheckId?: string) {
  const res = await b.app.inject({ method: "POST", url: "/api/triage/results", payload: signedBody(b.node, result, reports, recheckId) });
  await b.manager.idle();
  return res;
}

function result(id: string, commit: string, steps: GateStepResult[], pipelineId = "backend"): GateResult {
  return gate({ id, sha: commit, branch: BRANCH, pipelineId, steps });
}

/** JUnit 5 @Timeout failures of `names` (full test names, e.g. "createsOrder()") */
function timeoutReport(names: string[], suite = ORDER): Report {
  const simple = suite.split(".").pop();
  const cases = names.map(
    (n) => `<testcase name="${n}" classname="${suite}" time="10.0"><error message="${n} timed out after 10 seconds" type="java.util.concurrent.TimeoutException">java.util.concurrent.TimeoutException: ${n} timed out after 10 seconds
	at ${suite}.${n.replace(/\(.*$/, "")}(${simple}.java:42)
</error></testcase>`,
  );
  return { name: `TEST-${simple}.xml`, step: "test", content: `<testsuite name="${suite}">${cases.join("")}</testsuite>` };
}

/** JUnit 4 timeouts (TestTimedOutException): no timeout signature, so classified code; triage's timeout signal re-checks them */
function junit4TimeoutReport(names: string[], suite = ORDER): Report {
  const simple = suite.split(".").pop();
  const cases = names.map(
    (n) => `<testcase name="${n}" classname="${suite}" time="10.0"><error message="test timed out after 10000 milliseconds" type="org.junit.runners.model.TestTimedOutException">org.junit.runners.model.TestTimedOutException: test timed out after 10000 milliseconds
	at ${suite}.${n.replace(/\(.*$/, "")}(${simple}.java:42)
</error></testcase>`,
  );
  return { name: `TEST-${simple}-junit4.xml`, step: "test", content: `<testsuite name="${suite}">${cases.join("")}</testsuite>` };
}

function assertionReport(suite: string, test: string, message: string): Report {
  const simple = suite.split(".").pop();
  return {
    name: `TEST-${simple}.xml`,
    step: "test",
    content: `<testsuite name="${suite}"><testcase classname="${suite}" name="${test}"><failure message="${message}" type="java.lang.AssertionError">java.lang.AssertionError: ${message}
	at ${suite}.${test.replace(/\(\)$/, "")}(${simple}.java:10)
</failure></testcase></testsuite>`,
  };
}

const failedTest = [step("lint", "passed"), step("test", "failed")];
const dockerDown = (name = "test") => [step("lint", "passed"), step(name, "failed", DOCKER_DOWN, 1)];

async function rechecks(b: Boot): Promise<GateRecheck[]> {
  return (await b.app.inject({ url: "/api/triage/gate-rechecks" })).json().data as GateRecheck[];
}

async function failure(b: Boot, gateId: string): Promise<{ record: TriageRecord; gateRechecks: GateRecheck[] }> {
  const list = (await b.app.inject({ url: "/api/triage/failures?limit=500" })).json().data as TriageRecord[];
  const record = list.find((r) => r.gateId === gateId);
  if (!record) throw new Error(`no failure ${gateId}`);
  return (await b.app.inject({ url: `/api/triage/failures/${record.id}` })).json().data;
}

function eventsOf(b: Boot, type: "triage.recheck_would" | "triage.recheck_queued" | "triage.recheck_resolved" | "triage.recheck_escalated") {
  return b.events.getRecentEvents(type).map((e) => e.data);
}

describe("which re-check, by the classification", () => {
  it("each kind maps to its argv: infra -> same, a test timeout -> failed_tests, flaky -> failed_tests, a timeout under load -> failed_tests", async () => {
    const b = await boot();
    enqueues(b);
    const S1 = sha("i1");
    const S2 = sha("t1");
    const S3 = sha("f1");
    const S4 = sha("l1");

    // The container runtime was down: the same pipeline again at the same commit
    expect((await post(b, result("gate-infra", S1, dockerDown()))).statusCode).toBe(200);
    // JUnit timeouts with no load reading (a signed result never carries one): only the failed tests
    await post(b, result("gate-timeout", S2, failedTest), [{ name: "TEST-OrderServiceTest.xml", step: "test", content: fixture("junit-timeout.xml") }]);
    // A test that passed at this commit and fails now: flaky
    await post(b, gate({ id: "gate-pass", sha: S3, branch: BRANCH, pipelineId: "backend", status: "passed", steps: [step("test", "passed")] }), [
      { name: "TEST-CartTest.xml", step: "test", content: junitPassing([{ suite: CART, name: "addsItem()" }]) },
    ]);
    await post(b, result("gate-flaky", S3, failedTest), [assertionReport(CART, "addsItem()", "expected 2 items")]);
    // In-process, with the machine's load: triage's own timeout-under-load rule
    await b.events.emit("gate.completed", {
      project: "demo",
      result: result("gate-load", S4, failedTest),
      reports: [junit4TimeoutReport(["listsOrders()"])],
      context: { loadPerCore: 3.5 },
    });
    await b.manager.idle();
    // A JUnit 4 timeout, no load reading: classified code, re-checked by the timeout signal
    await post(b, result("gate-junit4", sha("j1"), failedTest), [junit4TimeoutReport(["cancelsOrder()"])]);

    expect(b.runner.callsTo(PROGRAM)).toEqual([
      [PROGRAM, S1, "backend", "same", "gate-infra", "infra:infra-pattern:container-start"],
      [
        PROGRAM,
        S2,
        "backend",
        "failed_tests",
        "gate-timeout",
        "timeout:timeout-signature:timeout-exception",
        `${ORDER}#createsOrder`,
        `${ORDER}#listsOrders`,
      ],
      [PROGRAM, S3, "backend", "failed_tests", "gate-flaky", "flaky:passed-at-same-sha", `${CART}#addsItem`],
      [PROGRAM, S4, "backend", "failed_tests", "gate-load", "timeout:timeout-under-load", `${ORDER}#listsOrders`],
      [PROGRAM, sha("j1"), "backend", "failed_tests", "gate-junit4", "timeout:test-timeout", `${ORDER}#cancelsOrder`],
    ]);
    const list = await rechecks(b);
    expect(list.map((r) => [r.gateId, r.kind, r.causes, r.status, r.runId])).toEqual([
      ["gate-junit4", "failed_tests", ["timeout"], "queued", "run-5"],
      ["gate-load", "failed_tests", ["timeout"], "queued", "run-4"],
      ["gate-flaky", "failed_tests", ["flaky"], "queued", "run-3"],
      ["gate-timeout", "failed_tests", ["timeout"], "queued", "run-2"],
      ["gate-infra", "same", ["infra"], "queued", "run-1"],
    ]);
    // The load hint only where the result carried it
    expect(list[1].detail).toContain("load per core 3.50");
    expect(list[3].detail).not.toContain("load per core");
    expect(eventsOf(b, "triage.recheck_queued")).toHaveLength(5);

    // The failure waits for its re-check, and says so: a JUnit 5 timeout is infra (its timeout signature) ...
    const timeout = await failure(b, "gate-timeout");
    expect(timeout.record).toMatchObject({ verdict: "infra", blocking: true, resolution: "infra: re-check 1/2 (failed_tests) in the gate system" });
    expect(timeout.record.causes[0].verdict).toMatchObject({ rule: "timeout-signature:timeout-exception", infraKind: "load" });
    expect(timeout.gateRechecks.map((r) => r.status)).toEqual(["queued"]);
    // ... a JUnit 4 one stays code, and is not sent to its author while its re-check runs
    const junit4 = await failure(b, "gate-junit4");
    expect(junit4.record).toMatchObject({ verdict: "code", blocking: true, resolution: "code: re-check 1/2 (failed_tests) in the gate system" });
    expect(junit4.gateRechecks[0].holdRoute).toBe(true);

    const status = (await b.app.inject({ url: "/api/triage/status" })).json().data;
    expect(status.gateRecheck).toEqual({ mode: "act", blocked: null, pending: 5 });
  });

  it("a real failure is never re-checked, and neither is a result that has one", async () => {
    const b = await boot();
    enqueues(b);
    // Assertion and validation failures: real
    await post(b, result("gate-real", sha("r1"), failedTest), [{ name: "TEST-OrderServiceTest.xml", step: "test", content: fixture("junit-assertion.xml") }]);
    // A timeout beside a real failure
    await post(b, result("gate-mixed", sha("r2"), failedTest), [
      timeoutReport(["createsOrder()"]),
      assertionReport(CART, "addsItem()", "expected 2 items"),
    ]);
    // The container runtime was down for one step, and another step has a real failure
    await post(b, result("gate-infra-real", sha("r3"), [step("test", "failed"), step("it", "failed", DOCKER_DOWN, 1)]), [
      assertionReport(CART, "addsItem()", "expected 2 items"),
    ]);

    expect(b.runner.callsTo(PROGRAM)).toEqual([]);
    expect(await rechecks(b)).toEqual([]);
    const real = await failure(b, "gate-real");
    expect(real.record).toMatchObject({ verdict: "code", blocking: true });
    const mixed = await failure(b, "gate-mixed");
    expect(mixed.record).toMatchObject({ verdict: "code", resolution: "infra: not re-checked: it has a real failure; code: back to the author" });
    const infraReal = await failure(b, "gate-infra-real");
    expect(infraReal.record.verdict).toBe("code");
    expect(infraReal.record.resolution).toContain("infra: not re-checked: it has a real failure");
    const skipped = (await b.app.inject({ url: `/api/triage/failures/${infraReal.record.id}` })).json().data.actions as { kind: string; status: string; detail: string }[];
    expect(skipped.find((a) => a.kind === "recheck")).toMatchObject({ status: "skipped", detail: expect.stringContaining("it has a real failure (CartTest#addsItem()") });
  });

  it("observe never runs the command: it records what it would run, with the exact argv", async () => {
    const b = await boot({ mode: "observe", cooldown_seconds: 120 });
    enqueues(b);
    const S = sha("o1");
    await post(b, result("gate-infra", S, dockerDown()));
    await post(b, result("gate-timeout", sha("o2"), failedTest), [junit4TimeoutReport(["createsOrder()"])]);
    b.clock.advance(10 * HOUR);
    await b.tick();

    expect(b.runner.callsTo(PROGRAM)).toEqual([]);
    const list = await rechecks(b);
    expect(list.map((r) => [r.gateId, r.status])).toEqual([
      ["gate-timeout", "would"],
      ["gate-infra", "would"],
    ]);
    expect(list[1].argv).toEqual([PROGRAM, S, "backend", "same", "gate-infra", "infra:infra-pattern:container-start"]);
    const infra = await failure(b, "gate-infra");
    const actions = (await b.app.inject({ url: `/api/triage/failures/${infra.record.id}` })).json().data.actions as {
      kind: string;
      status: string;
      argv?: string[];
      detail: string;
    }[];
    expect(actions.find((a) => a.kind === "recheck")).toMatchObject({
      status: "planned",
      argv: list[1].argv,
      detail: expect.stringContaining("not run: triage.recheck.mode is observe"),
    });
    expect(eventsOf(b, "triage.recheck_would")).toHaveLength(2);
    expect(eventsOf(b, "triage.recheck_queued")).toHaveLength(0);
    // In observe mode a test timeout still goes to its author as before: nothing waits for a re-check that never runs
    expect((await failure(b, "gate-timeout")).record.resolution).toContain("code: back to the author");
    expect((await b.app.inject({ url: "/api/triage/status" })).json().data.gateRecheck).toEqual({
      mode: "observe",
      blocked: "triage.recheck.mode is observe",
      pending: 0,
    });
  });

  it("act on a read_only project runs nothing either; mode off leaves triage as it was", async () => {
    const ro = await boot({}, { readOnly: true });
    await post(ro, result("gate-infra", sha("ro"), dockerDown()));
    expect(ro.runner.callsTo(PROGRAM)).toEqual([]);
    expect((await rechecks(ro)).map((r) => r.status)).toEqual(["would"]);
    const roActions = (await ro.app.inject({ url: `/api/triage/failures/${(await failure(ro, "gate-infra")).record.id}` })).json().data
      .actions as { kind: string; detail: string }[];
    expect(roActions.find((a) => a.kind === "recheck")?.detail).toContain("not run: the project is read_only");

    const off = await boot({ mode: "off" });
    enqueues(off);
    await post(off, result("gate-infra", sha("of"), dockerDown()));
    expect(off.runner.callsTo(PROGRAM)).toEqual([]);
    expect(await rechecks(off)).toEqual([]);
    // Triage's own re-check (triage.commands.recheck) is planned as before
    const lair = await failure(off, "gate-infra");
    expect(lair.record.resolution).toBe("infra: re-check 1/1 queued");
    // A result naming a failure as its recheckId is refused as before (no such Lair re-check)
    const answer = await post(off, result("run-x", sha("of"), [step("test", "passed")]), [], "gate-infra");
    expect(answer.statusCode).toBe(404);
    expect((await off.app.inject({ url: "/api/triage/status" })).json().data.gateRecheck).toEqual({ mode: "off", blocked: null, pending: 0 });
  });
});

describe("budget and safety", () => {
  it("the cool-down: no re-check sooner than cooldown_seconds after the failure", async () => {
    const b = await boot({ cooldown_seconds: 120 });
    enqueues(b);
    await post(b, result("gate-infra", sha("c1"), dockerDown()));
    expect((await rechecks(b))[0].status).toBe("waiting");
    b.clock.advance(119_000);
    await b.tick();
    expect(b.runner.callsTo(PROGRAM)).toHaveLength(0);
    b.clock.advance(1000);
    await b.tick();
    await b.tick();
    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
    expect((await rechecks(b))[0]).toMatchObject({ status: "queued", runId: "run-1" });
  });

  it("no re-check while one for the same commit and pipeline is pending", async () => {
    const b = await boot();
    enqueues(b);
    const S = sha("p1");
    await post(b, result("gate-1", S, failedTest), [timeoutReport(["createsOrder()"])]);
    // The agent submitted the same gate again meanwhile
    await post(b, result("gate-2", S, failedTest), [timeoutReport(["createsOrder()"])]);
    // Another pipeline at the same commit is its own
    await post(b, result("gate-3", S, failedTest, "kiro-backend-targeted"), [timeoutReport(["createsOrder()"])]);

    expect(b.runner.callsTo(PROGRAM).map((argv) => argv[4])).toEqual(["gate-1", "gate-3"]);
    const second = (await rechecks(b)).find((r) => r.gateId === "gate-2")!;
    expect(second.status).toBe("refused");
    expect(second.detail).toMatch(/^not re-checked: re-check [0-9a-f]{8} of gate-1 \(the same commit and pipeline\) is pending$/);
  });

  it("max_per_result: a re-check that fails differently is a new failure, re-checked from the same budget; then the human is asked, once", async () => {
    const b = await boot({ max_per_result: 2 });
    enqueues(b);
    const S = sha("b1");
    await post(b, result("gate-a", S, failedTest), [timeoutReport(["createsOrder()"])]);
    // Its quiet re-check ran on a machine whose container runtime was down: a new failure
    const first = await post(b, result("run-1", S, dockerDown(), "kiro-backend-targeted"), [], "gate-a");
    expect(first.statusCode).toBe(200);
    expect(first.json().data.record).toMatchObject({ purpose: "recheck", verdict: "infra" });
    // ... re-checked as the same pipeline it ran: the second and last re-check of gate-a
    expect(b.runner.callsTo(PROGRAM)[1]).toEqual([PROGRAM, S, "kiro-backend-targeted", "same", "run-1", "infra:infra-pattern:container-start"]);
    // ... which fails differently again (out of memory): no budget left
    await post(b, result("run-2", S, [step("test", "failed", OUT_OF_MEMORY, 1)], "kiro-backend-targeted"), [], "run-1");
    await b.tick();
    b.clock.advance(4 * HOUR);
    await b.tick();

    expect(b.runner.callsTo(PROGRAM)).toHaveLength(2);
    const list = (await rechecks(b)).reverse();
    expect(list.map((r) => [r.gateId, r.attempt, r.status])).toEqual([
      ["gate-a", 1, "failed_differently"],
      ["run-1", 2, "failed_differently"],
      ["run-2", 3, "refused"],
    ]);
    expect(list[2].detail).toBe("not re-checked: 2 re-check(s) already (max_per_result 2)");
    expect(new Set(list.map((r) => r.rootId)).size).toBe(1);
    const decisions = b.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain("[triage:recheck:");
    expect(decisions[0]).toContain(`Gate gate-a at ${S.slice(0, 8)} on ${BRANCH} still fails after 2 re-check(s).`);
    expect(decisions[0]).not.toContain("Re-check once more");
    expect(eventsOf(b, "triage.recheck_resolved").map((d) => d.outcome)).toEqual(["failed_differently", "failed_differently"]);
  });

  it("a queued re-check without a result expires after expire_hours: reported, never retried", async () => {
    const b = await boot({ expire_hours: 3 });
    enqueues(b);
    await post(b, result("gate-infra", sha("e1"), dockerDown()));
    b.clock.advance(3 * HOUR - 1);
    await b.tick();
    expect((await rechecks(b))[0].status).toBe("queued");
    b.clock.advance(1);
    await b.tick();
    b.clock.advance(24 * HOUR);
    await b.tick();

    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
    const [expired] = await rechecks(b);
    expect(expired.status).toBe("expired");
    expect((await failure(b, "gate-infra")).record).toMatchObject({ blocking: true, resolution: "re-check 1 expired (no result within 3 h)" });
    expect(eventsOf(b, "triage.recheck_resolved")).toMatchObject([{ outcome: "expired" }]);
  });
});

describe("the re-check's result", () => {
  it("a pass resolves the failure and records the tests that timed out as flaky; only the queued run answers, at the same commit", async () => {
    const b = await boot();
    enqueues(b);
    const S = sha("t1");
    await post(b, result("gate-t", S, failedTest), [{ name: "TEST-OrderServiceTest.xml", step: "test", content: fixture("junit-timeout.xml") }]);
    const passing: Report = {
      name: "TEST-OrderServiceTest.xml",
      step: "test",
      content: junitPassing([
        { suite: ORDER, name: "createsOrder()" },
        { suite: ORDER, name: "listsOrders()" },
      ]),
    };
    const pass = (id: string, commit = S) =>
      gate({ id, sha: commit, branch: BRANCH, pipelineId: "kiro-backend-targeted", status: "passed", steps: [step("test", "passed")] });

    // Not the run the command queued, or not the same commit: refused, nothing changes
    const other = await post(b, pass("someone-elses-run"), [passing], "gate-t");
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe("The re-check of gate-t was queued as run-1: only that result answers it");
    const elsewhere = await post(b, pass("run-1", sha("t9")), [passing], "gate-t");
    expect(elsewhere.statusCode).toBe(400);
    expect((await failure(b, "gate-t")).record.blocking).toBe(true);

    const answer = await post(b, pass("run-1"), [passing], "gate-t");
    expect(answer.statusCode).toBe(200);
    const { record, gateRechecks } = await failure(b, "gate-t");
    expect(record).toMatchObject({ verdict: "flaky", blocking: false });
    expect(record.resolution).toBe(
      "re-check run-1 passed at the same commit: it was a timeout under load; flaky: OrderServiceTest#createsOrder(), OrderServiceTest#listsOrders()",
    );
    expect(gateRechecks[0]).toMatchObject({
      status: "passed",
      passedTests: ["OrderServiceTest#createsOrder()", "OrderServiceTest#listsOrders()"],
    });
    expect(gateRechecks[0].answerId).toBe(answer.json().data.record.id);
    const flaky = (await b.app.inject({ url: "/api/triage/flaky" })).json().data as FlakyTest[];
    expect(flaky.map((f) => [f.key, f.occurrences]).sort()).toEqual([
      ["OrderServiceTest#createsOrder()", 1],
      ["OrderServiceTest#listsOrders()", 1],
    ]);
    expect(eventsOf(b, "triage.recheck_resolved")).toMatchObject([
      { outcome: "passed", flaky: ["OrderServiceTest#createsOrder()", "OrderServiceTest#listsOrders()"] },
    ]);
    // Answered: a second answer is refused
    const again = await post(b, pass("run-1b"), [passing], "gate-t");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("Triage's re-check of gate-t is passed: it is not waiting for a result");
  });

  it("an infra failure whose same re-run passes is resolved as infrastructure, its tests not flaky", async () => {
    const b = await boot();
    enqueues(b);
    const S = sha("s1");
    await post(b, result("gate-infra", S, dockerDown()));
    await post(b, gate({ id: "run-1", sha: S, branch: BRANCH, pipelineId: "backend", status: "passed", steps: [step("lint", "passed"), step("test", "passed")] }), [], "gate-infra");
    const { record, gateRechecks } = await failure(b, "gate-infra");
    expect(record).toMatchObject({ verdict: "infra", blocking: false, resolution: "re-check run-1 passed at the same commit: it was infrastructure" });
    expect(gateRechecks[0].status).toBe("passed");
    expect((await b.app.inject({ url: "/api/triage/flaky" })).json().data).toEqual([]);
  });

  it("a pass that does not list the re-checked tests is unproven: not resolved, not re-checked again", async () => {
    const b = await boot();
    enqueues(b);
    const S = sha("u1");
    await post(b, result("gate-t", S, failedTest), [timeoutReport(["createsOrder()"])]);
    await post(b, gate({ id: "run-1", sha: S, branch: BRANCH, pipelineId: "kiro-backend-targeted", status: "passed", steps: [step("test", "passed")] }), [], "gate-t");
    await b.tick();
    const { record, gateRechecks } = await failure(b, "gate-t");
    expect(gateRechecks[0].status).toBe("unproven");
    expect(record.blocking).toBe(true);
    expect(record.resolution).toBe(
      "re-check 1 unproven: 1 of the 1 re-checked test(s) are not listed as passed (send the JUnit reports with the result)",
    );
    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
    expect(eventsOf(b, "triage.recheck_resolved")).toMatchObject([{ outcome: "unproven" }]);
  });

  it("a failure the same way escalates once, as a real failure, and is not re-checked again", async () => {
    const b = await boot();
    enqueues(b);
    const S = sha("a1");
    await post(b, result("gate-t", S, failedTest), [timeoutReport(["createsOrder()"])]);
    // Quiet, and it times out again: not load
    const same = await post(b, result("run-1", S, failedTest, "kiro-backend-targeted"), [timeoutReport(["createsOrder()"])], "gate-t");
    expect(same.statusCode).toBe(200);
    await b.tick();
    b.clock.advance(4 * HOUR);
    await b.tick();

    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
    const { record, gateRechecks } = await failure(b, "gate-t");
    expect(gateRechecks.map((r) => r.status)).toEqual(["failed_again"]);
    // A timeout that comes back on a quiet machine is not load: the failure is real now (it was infra by its signature)
    expect(record).toMatchObject({ verdict: "code", blocking: true, resolution: "re-check run-1 failed the same way: escalated as a real failure" });
    expect(record.causes[0].verdict).toMatchObject({ class: "code", rule: "failed-on-recheck" });
    expect(record.causes[0].verdict.evidence[0]).toBe(
      "failed again the same way on triage's re-check at the same commit (result run-1): a real failure",
    );
    const routed = (await b.app.inject({ url: `/api/triage/failures/${record.id}` })).json().data.actions as { kind: string; status: string }[];
    // Back to its author (a signed result names none here, so the route is recorded as skipped)
    expect(routed.filter((a) => a.kind === "route").map((a) => a.status)).toEqual(["skipped"]);
    // The re-check's own result is not re-checked, nor routed a second time
    const answer = await failure(b, "run-1");
    expect(answer.gateRechecks.map((r) => r.status)).toEqual(["failed_again"]);
    expect(answer.record.resolution).toBe("infra: it failed the same way on a re-check: escalated");
    const decisions = b.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain(
      `Gate gate-t at ${S.slice(0, 8)} on ${BRANCH} failed the same way on triage's re-check (result run-1).`,
    );
    expect(decisions[0]).toContain("Options: Treat it as a real failure | Re-check once more | Ignore");
    expect(eventsOf(b, "triage.recheck_escalated")).toHaveLength(1);
    // Nothing waits for an answer now
    const late = await post(b, result("run-1b", S, failedTest, "kiro-backend-targeted"), [timeoutReport(["createsOrder()"])], "gate-t");
    expect(late.statusCode).toBe(409);
    expect(b.decisions()).toHaveLength(1);
  });
});

describe("classified by the root cause, not the top exception", () => {
  const targeted = (id: string, commit: string, output: string) =>
    result(id, commit, [step("backend-tests", "passed"), step("backend-targeted", "failed", output, 1)], "kiro-backend-targeted");
  const redisReports = (): Report[] => [
    { name: "TEST-com.example.shop.api.OrderApiIT.xml", step: "backend-targeted", content: fixture("junit-context-redis-order.xml") },
    { name: "TEST-com.example.shop.api.PaymentApiIT.xml", step: "backend-targeted", content: fixture("junit-context-redis-payment.xml") },
  ];

  it("five context-load failures whose console chain ends in a Redis that did not answer: ONE infra cause, re-checked as the same pipeline", async () => {
    const b = await boot({ mode: "observe" });
    const S = sha("rd");
    const res = await post(b, targeted("gate-redis", S, fixture("gradle-context-redis.txt")), redisReports());
    expect(res.statusCode).toBe(200);
    const { record, gateRechecks } = await failure(b, "gate-redis");
    // The other test classes only say the cached context failed before: consequences, joined to the first failure
    expect(record.causes).toHaveLength(1);
    const [c] = record.causes;
    expect(c.cause.kind).toBe("context");
    expect(c.cause.testCount).toBe(5);
    expect(c.cause.tests.map((t) => t.key)).toEqual([
      "OrderApiIT#createsOrder()",
      "OrderApiIT#listsOrders()",
      "OrderApiIT#cancelsOrder()",
      "PaymentApiIT#refundsPayment()",
      "PaymentApiIT#capturesPayment()",
    ]);
    // The report's trace has no "Caused by"; the console's chain for the same tests is the root cause
    expect(c.cause.causedBy).toEqual([
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'sessionRepository': Invocation of init method failed",
      "org.springframework.data.redis.RedisConnectionFailureException: Unable to connect to Redis",
      "io.lettuce.core.RedisConnectionException: Unable to connect to 127.0.0.1/<unresolved>:64225",
      "io.lettuce.core.RedisCommandTimeoutException: Connection initialization timed out after 2 second(s)",
    ]);
    expect(c.cause.rootCause).toBe("io.lettuce.core.RedisCommandTimeoutException: Connection initialization timed out after 2 second(s)");
    expect(c.verdict).toMatchObject({ class: "infra", rule: "infra-signature:unable-to-connect", infraKind: "network", confidence: "high" });
    expect(c.verdict.evidence).toEqual([
      "Caused by: org.springframework.data.redis.RedisConnectionFailureException: Unable to connect to Redis (matches infra signature unable-to-connect)",
      "one context failure for 5 test(s): the tests never ran, so this is not the change",
    ]);
    expect(record).toMatchObject({ verdict: "infra", blocking: true });
    expect(gateRechecks).toMatchObject([{ status: "would", kind: "same", causes: ["infra"] }]);
    expect(gateRechecks[0].argv).toEqual([PROGRAM, S, "kiro-backend-targeted", "same", "gate-redis", "infra:infra-signature:unable-to-connect"]);
  });

  it("the same, with the chain in the report itself and no console output; a timeout signature alone is a timeout", async () => {
    const b = await boot({ mode: "observe" });
    const chain = (lines: string[]) => lines.map((l) => `Caused by: ${l}\n\tat io.lettuce.core.Example.run(Example.java:1)\n`).join("");
    const leader = (extra: string) =>
      fixture("junit-context-redis-order.xml").replace("\t... 85 more\n", `${extra}\t... 85 more\n`);
    await post(b, targeted("gate-in-report", sha("rr"), ""), [
      {
        name: "TEST-OrderApiIT.xml",
        step: "backend-targeted",
        content: leader(chain(["io.lettuce.core.RedisConnectionException: Unable to connect to 127.0.0.1/&lt;unresolved&gt;:64225"])),
      },
    ]);
    await post(b, targeted("gate-init-timeout", sha("rt"), ""), [
      {
        name: "TEST-OrderApiIT.xml",
        step: "backend-targeted",
        content: leader(chain(["io.lettuce.core.RedisCommandTimeoutException: Connection initialization timed out after 2 second(s)"])),
      },
    ]);
    const inReport = (await failure(b, "gate-in-report")).record.causes[0].verdict;
    expect(inReport).toMatchObject({ class: "infra", rule: "infra-signature:unable-to-connect" });
    const initTimeout = await failure(b, "gate-init-timeout");
    expect(initTimeout.record.causes[0].verdict).toMatchObject({
      class: "infra",
      rule: "timeout-signature:connection-init-timeout",
      infraKind: "load",
      confidence: "low",
    });
    // A timeout of the environment: only the failed tests, quietly
    expect(initTimeout.gateRechecks[0]).toMatchObject({ kind: "failed_tests", causes: ["timeout"] });
  });

  it("follower failures in other reports follow the first failure's class: a real context failure keeps them code", async () => {
    const b = await boot();
    enqueues(b);
    const realLeader = fixture("junit-context-redis-order.xml").replace(
      "\t... 85 more\n",
      "Caused by: org.springframework.beans.factory.NoSuchBeanDefinitionException: No qualifying bean of type 'com.example.shop.payments.PaymentGateway' available\n\t... 85 more\n",
    );
    await post(b, targeted("gate-bean", sha("bn"), ""), [
      { name: "TEST-OrderApiIT.xml", step: "backend-targeted", content: realLeader },
      { name: "TEST-PaymentApiIT.xml", step: "backend-targeted", content: fixture("junit-context-redis-payment.xml") },
    ]);
    const { record } = await failure(b, "gate-bean");
    expect(record.causes).toHaveLength(1);
    expect(record.causes[0]).toMatchObject({ cause: { kind: "context", testCount: 5 }, verdict: { class: "code" } });
    expect(b.runner.callsTo(PROGRAM)).toEqual([]);
  });

  it("real failures stay code: an assertion that quotes an infra message, and a compile error", async () => {
    const b = await boot();
    enqueues(b);
    await post(b, result("gate-assert", sha("as"), failedTest), [
      {
        name: "TEST-OrderClientTest.xml",
        step: "test",
        content: `<testsuite name="com.example.shop.OrderClientTest"><testcase classname="com.example.shop.OrderClientTest" name="reportsDownstreamErrors()"><failure message="expected: &lt;OK&gt; but was: &lt;Connection refused&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;OK&gt; but was: &lt;Connection refused&gt;
	at com.example.shop.OrderClientTest.reportsDownstreamErrors(OrderClientTest.java:31)
</failure></testcase></testsuite>`,
      },
    ]);
    await post(b, result("gate-compile", sha("cp"), [step("build", "failed", fixture("gradle-compile.txt"), 1)]));
    expect((await failure(b, "gate-assert")).record.causes[0].verdict.class).toBe("code");
    const compile = (await failure(b, "gate-compile")).record.causes[0];
    expect(compile).toMatchObject({ cause: { kind: "build" }, verdict: { class: "code" } });
    expect(b.runner.callsTo(PROGRAM)).toEqual([]);
  });

  it("the signatures are configurable; default_infra_patterns: false drops the built-in ones", () => {
    const parsed = parseTriageConfig({
      enabled: true,
      infra_signatures: ["license server .* unreachable"],
      timeout_signatures: ["index refresh took too long"],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.infraSignatures.map((s) => s.id)).toEqual([
      "infra_signatures.0",
      "connection-refused",
      "connection-reset",
      "unable-to-connect",
      "redis-connection",
      "jdbc-connection",
      "docker-environment",
      "disk-full",
      "out-of-memory",
    ]);
    expect(parsed.settings.timeoutSignatures.map((s) => s.id)).toEqual(["timeout_signatures.0", "connection-init-timeout", "timeout-exception"]);
    const own = parseTriageConfig({ enabled: true, default_infra_patterns: false, infra_signatures: ["license server"] });
    if (!own.ok) throw new Error(own.errors.join("; "));
    expect(own.settings.infraSignatures.map((s) => s.id)).toEqual(["infra_signatures.0"]);
    expect(own.settings.timeoutSignatures).toEqual([]);
    const bad = parseTriageConfig({ enabled: true, timeout_signatures: ["("] });
    expect(bad.ok ? [] : bad.errors[0]).toContain("triage.timeout_signatures.0: not a valid regular expression");
  });
});

describe("placeholders and the command", () => {
  it("every placeholder value is validated: one that is not valid refuses the re-check", async () => {
    const b = await boot();
    enqueues(b);
    await post(b, result("gate-space", sha("v1"), dockerDown(), "back end"));
    await post(b, result("gate-empty", sha("v2"), dockerDown(), ""));
    // A parameterized test's id has characters the command does not get, and a timeout has no fallback
    await post(b, result("gate-param", sha("v3"), failedTest), [timeoutReport(["createsOrder(String)[1]"])]);
    expect(b.runner.callsTo(PROGRAM)).toEqual([]);
    const byGate = new Map((await rechecks(b)).map((r) => [r.gateId, r]));
    expect(byGate.get("gate-space")).toMatchObject({ status: "refused", detail: 'not re-checked: refused: {pipeline}: "back end" is not valid' });
    expect(byGate.get("gate-empty")).toMatchObject({ status: "refused", detail: 'not re-checked: refused: {pipeline}: "" is not valid' });
    expect(byGate.get("gate-param")).toMatchObject({
      status: "refused",
      detail: `not re-checked: the test id "${ORDER}#createsOrder(String)[1]" has characters a re-check does not pass`,
    });
  });

  it("more failed tests than max_tests: infra falls back to the same pipeline, anything else is not re-checked", async () => {
    const b = await boot({ max_tests: 2, kinds: { infra: "failed_tests" } });
    enqueues(b);
    const S = sha("m1");
    await post(b, result("gate-many", sha("m2"), failedTest), [timeoutReport(["a()", "b()", "c()"])]);
    // An infra cause names no test (the runtime was down before any ran): the same pipeline
    await post(b, result("gate-infra", S, dockerDown()));
    expect(b.runner.callsTo(PROGRAM)).toEqual([[PROGRAM, S, "backend", "same", "gate-infra", "infra:infra-pattern:container-start"]]);
    const byGate = new Map((await rechecks(b)).map((r) => [r.gateId, r]));
    expect(byGate.get("gate-many")).toMatchObject({ status: "refused", detail: "not re-checked: 3 failed tests is more than max_tests (2)" });
    expect(byGate.get("gate-infra")?.detail).toContain("same, not failed_tests: a cause names no failed test");
  });

  it("{tests} inside a longer argument is joined with ','; a value never becomes an option", () => {
    const vars = {
      project: "demo",
      sha: sha("x1"),
      pipeline: "backend",
      branch: BRANCH,
      result_id: "gate-x",
      reason: "timeout:test-timeout",
      kind: "failed_tests",
      tests: [`${ORDER}#a`, `${ORDER}#b`],
    };
    expect(buildRecheckArgv([PROGRAM, "--sha={sha}", "--tests={tests}", "--kind={kind}"], vars, 8)).toEqual({
      argv: [PROGRAM, `--sha=${vars.sha}`, `--tests=${ORDER}#a,${ORDER}#b`, "--kind=failed_tests"],
    });
    expect(buildRecheckArgv([PROGRAM, "{tests}"], { ...vars, tests: ["-rf"] }, 8)).toEqual({ error: '{tests}: "-rf" is not a safe test id' });
    expect(buildRecheckArgv([PROGRAM, "{branch}"], { ...vars, branch: "-x" }, 8)).toEqual({ error: '{branch}: "-x" is not valid' });
    expect(buildRecheckArgv([PROGRAM, "{reason}"], { ...vars, reason: "a\nb" }, 8)).toEqual({ error: '{reason}: "a b" is not valid' });
  });

  it("the config: a command is required, its placeholders are known, its program is fixed", () => {
    const errors = (recheck: Record<string, unknown>) => {
      const parsed = parseTriageConfig({ enabled: true, recheck });
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errors({ mode: "act" })).toEqual(["triage.recheck.command is required with triage.recheck.mode: act"]);
    expect(errors({ mode: "observe", command: [PROGRAM, "{password}"] })[0]).toContain("triage.recheck.command: unknown placeholder {password}");
    expect(errors({ mode: "observe", command: ["{sha}"] })).toEqual(["triage.recheck.command: the program (its first item) cannot hold a placeholder"]);
    expect(errors({ mode: "act", command: COMMAND, kinds: { timeout: "rerun" } })[0]).toContain("triage.recheck.kinds.timeout");
    const parsed = parseTriageConfig({ enabled: true, recheck: { mode: "observe", command: COMMAND } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.gateRecheck).toEqual({
      mode: "observe",
      command: COMMAND,
      maxPerResult: 2,
      cooldownSeconds: 120,
      timeoutSeconds: 60,
      expireHours: 3,
      kinds: { infra: "same", timeout: "failed_tests", flaky: "failed_tests" },
      maxTests: 8,
    });
  });

  it("a command that fails or is killed is reported, never retried", async () => {
    const b = await boot();
    b.runner.when(
      (argv) => argv[0] === PROGRAM && argv[4] === "gate-refused",
      () => ({ code: 3, stdout: "", stderr: "gate-recheck: refused: at most 2 re-checks per result\n" }),
    );
    b.runner.when(
      (argv) => argv[0] === PROGRAM && argv[4] === "gate-killed",
      () => ({ code: -1, stdout: "", stderr: "Command failed: killed" }),
    );
    await post(b, result("gate-refused", sha("k1"), dockerDown()));
    await post(b, result("gate-killed", sha("k2"), dockerDown()));
    for (let i = 0; i < 3; i++) {
      b.clock.advance(HOUR);
      await b.tick();
    }
    expect(b.runner.callsTo(PROGRAM).map((argv) => argv[4])).toEqual(["gate-refused", "gate-killed"]);
    const byGate = new Map((await rechecks(b)).map((r) => [r.gateId, r]));
    expect(byGate.get("gate-refused")).toMatchObject({ status: "not_queued", output: "gate-recheck: refused: at most 2 re-checks per result" });
    expect(byGate.get("gate-refused")?.detail).toContain(`not queued: ${PROGRAM} exited 3`);
    expect(byGate.get("gate-killed")?.detail).toContain(`not queued: ${PROGRAM} did not finish: killed at the 60 s timeout, or it could not start`);
    expect((await failure(b, "gate-refused")).record.resolution).toBe(`re-check 1 could not be queued (${PROGRAM} exited 3)`);
    const actions = (await b.app.inject({ url: `/api/triage/failures/${(await failure(b, "gate-refused")).record.id}` })).json().data
      .actions as { kind: string; status: string; detail: string }[];
    expect(actions.find((a) => a.status === "failed")?.detail).toBe(`re-check 1/2 not queued: ${PROGRAM} exited 3; not retried`);
    expect(eventsOf(b, "triage.recheck_resolved").map((d) => d.outcome)).toEqual(["not_queued", "not_queued"]);
  });

  it("a command that never returns is stopped at timeout_seconds (plus a second) and reported", async () => {
    const b = await boot({ timeout_seconds: 1 });
    b.runner.when(
      (argv) => argv[0] === PROGRAM,
      () => new Promise<CommandOutput>(() => undefined),
    );
    await post(b, result("gate-hung", sha("h1"), dockerDown()));
    const [hung] = await rechecks(b);
    expect(hung.status).toBe("not_queued");
    expect(hung.detail).toContain(`not queued: ${PROGRAM} gave no answer within 2 s`);
    b.clock.advance(HOUR);
    await b.tick();
    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
  }, 15_000);

  it("a test timeout goes back to its author only once its re-check can't answer", async () => {
    const b = await boot(
      {},
      { triage: { mode: "act", commands: { notify_agent: ["/opt/bin/notify", "{agent}", "{message}"] } } },
    );
    enqueues(b);
    await b.events.emit("gate.completed", {
      project: "demo",
      result: result("gate-t", sha("n1"), failedTest),
      reports: [junit4TimeoutReport(["createsOrder()"])],
      context: { agent: "worker-a" },
    });
    await b.manager.idle();
    expect(b.runner.callsTo(PROGRAM)).toHaveLength(1);
    expect(b.runner.callsTo("/opt/bin/notify")).toEqual([]);
    expect((await rechecks(b))[0].holdRoute).toBe(true);
    b.clock.advance(3 * HOUR);
    await b.tick();
    const notified = b.runner.callsTo("/opt/bin/notify");
    expect(notified).toHaveLength(1);
    expect(notified[0][1]).toBe("worker-a");
    expect(notified[0][2]).toContain("re-check 1 expired (no result within 3 h)");
  });
});

describe("restarts", () => {
  it("a version 1 store gets the re-checks table", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-gate-recheck-db-"));
    dirs.push(dir);
    const path = join(dir, "triage.db");
    new TriageStore(path).close();
    const raw = new Database(path);
    raw.exec("DROP TABLE triage_gate_rechecks");
    raw.pragma("user_version = 1");
    raw.close();
    const store = new TriageStore(path);
    expect(store.gateRechecks.list("demo")).toEqual([]);
    store.close();
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    check.close();
  });

  it("a re-check whose command was running when the server stopped is kept as queued, never run again, and expires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-gate-recheck-restart-"));
    dirs.push(dir);
    const dbPath = join(dir, "data", "triage.db");
    const first = await boot({ cooldown_seconds: 120 }, { dir, dbPath });
    await post(first, result("gate-infra", sha("x1"), dockerDown()));
    expect((await rechecks(first))[0].status).toBe("waiting");
    const o = opened.splice(0);
    for (const x of o) {
      await x.app.close();
      await x.manager.stop();
    }
    // The server was killed while the command ran
    const raw = new Database(dbPath);
    raw.prepare("UPDATE triage_gate_rechecks SET status = 'running', started_ms = ?").run(NOW);
    raw.close();

    const second = await boot({ cooldown_seconds: 120 }, { dir, dbPath });
    enqueues(second);
    second.clock.advance(5 * MIN);
    await second.tick();
    const [kept] = await rechecks(second);
    expect(kept.status).toBe("queued");
    expect(kept.detail).toContain("its command was running when the server stopped: it may have queued the re-check, so it is not run again");
    second.clock.advance(3 * HOUR);
    await second.tick();
    expect((await rechecks(second))[0].status).toBe("expired");
    expect(second.runner.callsTo(PROGRAM)).toEqual([]);
  });
});
