/**
 * Wiring: mountTriage() (what src/server/index.ts calls) on a real Fastify
 * instance with the real owner credential (HumanAuth), driven over HTTP and
 * through the event bus. A signed failed gate result is POSTed, classified,
 * and its re-check requested through the project's command, which posts its
 * signed answer straight back while it runs. Forged and unsigned results,
 * forged answers and owner actions without the owner's session are refused.
 * Only the command runner, the clock and git are fake; signatures are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GateResult } from "../../shared/policy-types.js";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { mountTriage, type TriageManager } from "./index.js";
import {
  actingTriage,
  FakeClock,
  FakeGit,
  FakeRunner,
  fixture,
  gate,
  junitPassing,
  projectConfig,
  sha,
  sha256,
  step,
  trustedNode,
  type TestNode,
} from "./testing/harness.js";

let app: FastifyInstance | null = null;
let manager: TriageManager | null = null;
let auth: HumanAuth | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  await manager?.stop();
  auth?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  auth = null;
  dir = null;
});

const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const P1 = sha("p1");
const OrderApiIT = "com.example.shop.api.OrderApiIT";
const PaymentApiIT = "com.example.shop.api.PaymentApiIT";
const CONTEXT_TESTS = [
  { suite: OrderApiIT, name: "createsOrder()" },
  { suite: OrderApiIT, name: "listsOrders()" },
  { suite: OrderApiIT, name: "cancelsOrder()" },
  { suite: PaymentApiIT, name: "refundsPayment()" },
];

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "lair-triage-routes-"));
  const runner = new FakeRunner();
  const git = new FakeGit();
  const events = new EventBus();
  const node = trustedNode(dir, "ci-1");
  const tokenPath = join(dir, "owner.token");
  auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const session = auth.createSession(readFileSync(tokenPath, "utf-8").trim(), "test browser")!;
  const owner = { ...DASHBOARD, [OWNER_SESSION_HEADER]: session.session };
  app = Fastify();
  manager = await mountTriage(app, {
    dbPath: ":memory:",
    probes: { runner, clock: new FakeClock(), fs: new NodeFileSystem(), git: () => git },
    events,
    projects: [
      { name: "demo", config: projectConfig(dir, actingTriage({ trusted_nodes: [{ id: node.id, public_key_file: node.publicKeyFile }] })) },
      { name: "off", config: projectConfig(dir, {}) },
      { name: "broken", config: projectConfig(dir, { enabled: true, mode: "sometimes" }) },
      { name: "unreadable", error: "Project config not found" },
    ],
    defaultProject: () => "demo",
    owner: auth,
  });
  await app.ready();
  return { app, manager, runner, git, events, node, owner, sessionId: session.info.id };
}

/** What a trusted node sends: the result with its reports' digests, signed, and the reports. */
function signedBody(
  node: TestNode,
  result: GateResult,
  reports: { name: string; step?: string; content: string }[] = [],
  recheckId?: string,
) {
  const withDigests: GateResult = {
    ...result,
    nodeId: node.id,
    reports: reports.map((r) => ({ name: r.name, step: r.step, sha256: sha256(r.content) })),
  };
  return { signed: node.sign(withDigests), reports: reports.map((r) => ({ name: r.name, content: r.content })), ...(recheckId ? { recheckId } : {}) };
}

function failedContextResult(id = "gate-1", commit = P1): GateResult {
  return gate({ id, sha: commit, branch: "feat/orders", steps: [step("lint", "passed"), step("test", "failed")] });
}

const contextReport = () => [{ name: "TEST-OrderApiIT.xml", step: "test", content: fixture("junit-context-failure.xml") }];

function requestOf(argv: string[]): string {
  return argv.find((a) => a.startsWith("--request="))!.slice("--request=".length);
}

describe("triage over HTTP", () => {
  it("a signed failed result is classified and re-checked; the re-check command posts its signed answer straight back", async () => {
    const { app, runner, node } = await boot();
    const answers: number[] = [];
    // The project's re-check command: it runs the tests and posts the signed answer before it returns
    runner.when(
      (argv) => argv[0] === "./bin/recheck",
      async (argv) => {
        const request = requestOf(argv);
        const res = await app.inject({
          method: "POST",
          url: "/api/triage/results",
          payload: signedBody(
            node,
            gate({ id: request, sha: P1, branch: "feat/orders", status: "passed", steps: [step("test", "passed")] }),
            [{ name: "TEST-recheck.xml", step: "test", content: junitPassing(CONTEXT_TESTS) }],
            request,
          ),
        });
        answers.push(res.statusCode);
        return { code: 0, stdout: `run-${request.slice(0, 8)}\n`, stderr: "" };
      },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/triage/results?project=demo",
      payload: signedBody(node, failedContextResult(), contextReport()),
    });
    expect(res.statusCode).toBe(200);
    const { record, rechecks } = res.json().data;
    expect(record).toMatchObject({ gateId: "gate-1", sha: P1, trust: "signed", verdict: "infra", retries: 1 });
    expect(record.causes[0].verdict.rule).toBe("infra-pattern:connection-timeout");
    // Only the failed classes, at the same commit
    expect(runner.callsTo("./bin/recheck")).toEqual([
      ["./bin/recheck", `--sha=${P1}`, `--request=${rechecks[0].id}`, "--steps=test", OrderApiIT, PaymentApiIT],
    ]);
    // The answer came back while the command ran, and unblocked the failure: no deadlock
    expect(answers).toEqual([200]);
    expect(rechecks[0]).toMatchObject({ status: "passed", runId: `run-${rechecks[0].id.slice(0, 8)}` });
    expect(record).toMatchObject({ blocking: false, resolution: "re-check 1 passed at the same commit: it was infrastructure" });

    // Per failure: the verdict, its evidence, the actions and the retry count
    const detail = (await app.inject({ url: `/api/triage/failures/${record.id}` })).json().data;
    expect(detail.record.retries).toBe(1);
    expect(detail.record.causes[0].verdict.evidence[0]).toContain("java.net.SocketTimeoutException: connect timed out");
    expect(detail.record.causes[0].cause.testCount).toBe(4);
    expect(detail.actions.map((a: { kind: string; status: string }) => `${a.kind}:${a.status}`).sort()).toEqual([
      "recheck:done",
      "recheck:waiting",
      "unblock:done",
    ]);

    const status = (await app.inject({ url: "/api/triage/status" })).json().data;
    expect(status).toMatchObject({
      project: "demo",
      enabled: true,
      mode: "act",
      actBlocked: null,
      counts: { failures: 1, blocking: 0 },
      pendingRechecks: 0,
      incident: null,
      trustedNodes: ["ci-1"],
      commands: { recheck: true, notify_agent: true, create_task: true, raise_decision: true, open_revert: true },
    });
  });

  it("refuses unsigned, tampered and untrusted results, and forged re-check answers", async () => {
    const { app, node } = await boot();
    const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/triage/results", payload });

    // Unsigned: anyone on this machine could send it
    const unsigned = await post({ result: { ...failedContextResult(), status: "passed" } });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json().error).toContain("must be signed");

    // Tampered after signing: a failure turned into a pass
    const tampered = signedBody(node, failedContextResult("gate-t"));
    (tampered.signed.result as GateResult).status = "passed";
    expect((await post(tampered)).statusCode).toBe(403);
    expect((await post(tampered)).json().error).toContain("The signature does not verify");

    // Signed by a node the project doesn't trust, or by another key in a trusted node's name
    const rogue = trustedNode(dir!, "rogue");
    expect((await post(signedBody(rogue, failedContextResult("gate-r")))).json().error).toBe(
      "Node rogue is not trusted (triage.trusted_nodes)",
    );
    const impostor = { ...signedBody(rogue, failedContextResult("gate-i")) };
    const claimed = { ...impostor.signed.result, nodeId: "ci-1" };
    expect((await post({ ...impostor, signed: { ...impostor.signed, result: claimed } })).statusCode).toBe(403);

    // A report the signature doesn't cover
    const uncovered = signedBody(node, failedContextResult("gate-u"));
    uncovered.reports.push({ name: "extra.xml", content: fixture("junit-assertion.xml") });
    const refused = await post(uncovered);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("not covered by the signed result");

    // A real failure whose re-check is pending
    const failed = await post(signedBody(node, failedContextResult(), contextReport()));
    const { record, rechecks } = failed.json().data;
    expect(rechecks[0].status).toBe("requested");
    // A validly signed pass that isn't the asked-for run: refused, the failure stays blocking
    const forged = await post(
      signedBody(
        node,
        gate({ id: "another-run", sha: P1, branch: "feat/orders", status: "passed", steps: [step("test", "passed")] }),
        [{ name: "TEST-pass.xml", step: "test", content: junitPassing(CONTEXT_TESTS) }],
        rechecks[0].id,
      ),
    );
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error).toContain("must have its id");
    // ... or one for another commit
    const elsewhere = await post(
      signedBody(node, gate({ id: rechecks[0].id, sha: sha("p9"), branch: "feat/orders", status: "passed" }), [], rechecks[0].id),
    );
    expect(elsewhere.statusCode).toBe(400);
    expect((await app.inject({ url: `/api/triage/failures/${record.id}` })).json().data.record.blocking).toBe(true);

    // A signed result claims the node but carries no agent: nothing goes to an agent from HTTP
    const code = await post(signedBody(node, gate({ id: "gate-c", sha: sha("p5"), branch: "feat/tax" }), [{ name: "TEST-a.xml", content: fixture("junit-assertion.xml") }]));
    expect(code.json().data.actions.find((a: { kind: string }) => a.kind === "route")).toMatchObject({ status: "skipped" });
  });

  it("protect, unprotect, revert and releasing a quarantine need the owner's session (403 otherwise), and record who acted", async () => {
    const { app, owner, sessionId, manager } = await boot();
    const m1 = sha("m1");
    const call = (method: "POST" | "DELETE", url: string, headers: Record<string, string>, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

    const routes: ["POST" | "DELETE", string, Record<string, unknown> | undefined][] = [
      ["POST", "/api/triage/owner/protected", { sha: m1 }],
      ["DELETE", `/api/triage/owner/protected/${m1}`, undefined],
      ["DELETE", `/api/triage/owner/flaky/${encodeURIComponent("CartTest#addsItem()")}`, undefined],
      ["POST", "/api/triage/owner/incidents/00000000-0000-4000-8000-000000000000/revert", {}],
    ];
    // No session, an agent with the session but no browser origin, and a cross-site page
    const refused: Record<string, string>[] = [
      {},
      { [OWNER_SESSION_HEADER]: owner[OWNER_SESSION_HEADER] },
      { ...owner, "sec-fetch-site": "cross-site" },
    ];
    for (const [method, url, payload] of routes) {
      for (const headers of refused) {
        const res = await call(method, url, headers, payload);
        expect(res.statusCode).toBe(403);
      }
    }
    expect(manager.getStore()!.listProtected("demo")).toEqual([]);

    const protectedNow = await call("POST", "/api/triage/owner/protected", owner, { sha: m1, note: "keep" });
    expect(protectedNow.statusCode).toBe(200);
    expect(protectedNow.json().data).toEqual([{ sha: m1, note: "keep", by: `owner session ${sessionId}`, createdAt: expect.any(String) }]);
    expect((await call("POST", "/api/triage/owner/protected", owner, { sha: "abc1234" })).statusCode).toBe(400);
    expect(manager.getStore()!.listActions("demo")[0]).toMatchObject({ actor: `owner session ${sessionId}` });
    expect((await call("DELETE", `/api/triage/owner/protected/${m1}`, owner)).json().data).toEqual([]);
    expect((await call("DELETE", `/api/triage/owner/protected/${m1}`, owner)).statusCode).toBe(404);

    const store = manager.getStore()!;
    store.bumpFlaky("demo", "CartTest#addsItem()", new Date().toISOString());
    store.quarantine("demo", "CartTest#addsItem()", new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    const released = await call("DELETE", `/api/triage/owner/flaky/${encodeURIComponent("CartTest#addsItem()")}`, owner);
    expect(released.statusCode).toBe(200);
    expect(store.quarantinedKeys("demo").size).toBe(0);

    expect((await call("POST", "/api/triage/owner/incidents/00000000-0000-4000-8000-000000000000/revert", owner, {})).statusCode).toBe(404);
  });

  it("takes in-process results from gate.completed events (trusted: the agent is routed to)", async () => {
    const { app, events, runner, manager } = await boot();
    await events.emit("gate.completed", {
      project: "demo",
      result: gate({ id: "gate-from-bus", sha: sha("p5"), branch: "feat/tax" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
      context: { agent: "worker-a" },
    });
    await manager.idle();
    const failures = (await app.inject({ url: "/api/triage/failures" })).json().data;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ gateId: "gate-from-bus", verdict: "code", trust: "trusted", agent: "worker-a" });
    expect(runner.callsTo("./bin/notify").map((c) => c[1])).toEqual(["worker-a"]);
    // Events for other projects, or not valid, are ignored
    await events.emit("gate.completed", { project: "off", result: gate({ sha: sha("p6"), branch: "feat/x" }) });
    await events.emit("gate.completed", { project: "demo", result: { id: "bad" } });
    await manager.idle();
    expect((await app.inject({ url: "/api/triage/failures" })).json().data).toHaveLength(1);
  });

  it("shows the default branch's incident and its bisect, and refuses a revert before there is a culprit", async () => {
    const { app, git, runner, events, manager, owner } = await boot();
    const c0 = sha("c0");
    const m1 = sha("m1");
    const m2 = sha("m2");
    git.commitOnMain(c0);
    git.commitOnMain(m1);
    git.commitOnMain(m2);
    await events.emit("gate.completed", { project: "demo", result: gate({ id: "main-0", sha: c0, branch: "main", status: "passed" }) });
    await events.emit("gate.completed", {
      project: "demo",
      result: gate({ id: "main-2", sha: m2, branch: "main" }),
      reports: [{ content: fixture("junit-assertion.xml") }],
    });
    await manager.idle();

    const status = (await app.inject({ url: "/api/triage/status" })).json().data;
    expect(status.openIncidents).toBe(1);
    const incident = status.incident;
    expect(incident).toMatchObject({ status: "open", redSha: m2, lastGreenSha: c0, pipelineId: "example" });
    expect(incident.bisect).toMatchObject({ status: "running", candidates: [m1, m2] });

    const listed = (await app.inject({ url: "/api/triage/incidents?status=open" })).json().data;
    expect(listed.map((i: { id: string }) => i.id)).toEqual([incident.id]);
    const one = (await app.inject({ url: `/api/triage/incidents/${incident.id}` })).json().data;
    expect(one.incident.bisect.probes.map((p: { sha: string; outcome: string }) => `${p.sha.slice(0, 4)}:${p.outcome}`)).toEqual([
      `${m2.slice(0, 4)}:fail`,
      `${m1.slice(0, 4)}:pending`,
    ]);
    expect(one.rechecks[0]).toMatchObject({ purpose: "bisect", sha: m1, status: "requested" });

    const early = await app.inject({ method: "POST", url: `/api/triage/owner/incidents/${incident.id}/revert`, headers: owner, payload: {} });
    expect(early.statusCode).toBe(409);
    expect(runner.callsTo("./bin/revert")).toEqual([]);
  });

  it("validates input, ids and origins", async () => {
    const { app, node } = await boot();
    const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url, payload, headers });

    const badSha = await post("/api/triage/results", signedBody(node, gate({ id: "g", sha: "abc1234", branch: "feat/x" })));
    expect(badSha.statusCode).toBe(400);
    expect(badSha.json().error).toContain("commitSha");

    const off = await post("/api/triage/results?project=off", signedBody(node, failedContextResult()));
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("Triage is off for off (set triage.enabled: true in its YAML)");
    const broken = await post("/api/triage/results?project=broken", signedBody(node, failedContextResult()));
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toContain("triage.mode");

    const unknownRecheck = await post("/api/triage/results", signedBody(node, failedContextResult(), [], "00000000-0000-4000-8000-000000000000"));
    expect(unknownRecheck.statusCode).toBe(404);

    expect((await app.inject({ url: "/api/triage/failures/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/triage/failures/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/triage/failures?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/triage/failures?verdict=bogus" })).statusCode).toBe(400);

    const crossSite = await post("/api/triage/results", signedBody(node, failedContextResult()), { origin: "http://attacker.example" });
    expect(crossSite.statusCode).toBe(403);
    expect((await app.inject({ url: "/api/triage/failures" })).json().data).toEqual([]);

    const statusOff = (await app.inject({ url: "/api/triage/status?project=off" })).json().data;
    expect(statusOff).toMatchObject({ enabled: false, errors: [], incident: null, trustedNodes: [] });
    const statusBroken = (await app.inject({ url: "/api/triage/status?project=broken" })).json().data;
    expect(statusBroken.errors[0]).toContain("triage.mode");
    const statusUnreadable = (await app.inject({ url: "/api/triage/status?project=unreadable" })).json().data;
    expect(statusUnreadable.errors).toEqual(["Project config not found"]);
  });
});
