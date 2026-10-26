/**
 * Wiring: mountTriage() (what src/server/index.ts calls) on a real Fastify
 * instance, driven over HTTP and through the event bus. A failed gate result
 * is POSTed, classified, and its re-check requested through the project's
 * command; the re-check's answer is POSTed back and unblocks the failure.
 * Only the command runner, the clock and git are fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import { mountTriage, type TriageManager } from "./index.js";
import { actingTriage, FakeClock, FakeGit, FakeRunner, fixture, projectConfig, sha } from "./test-harness.js";

let app: FastifyInstance | null = null;
let manager: TriageManager | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  await manager?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = null;
  manager = null;
  dir = null;
});

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "lair-triage-routes-"));
  const runner = new FakeRunner();
  const git = new FakeGit();
  const events = new EventBus();
  app = Fastify();
  manager = await mountTriage(app, {
    dbPath: ":memory:",
    probes: { runner, clock: new FakeClock(), fs: new NodeFileSystem(), git: () => git },
    events,
    projects: [
      { name: "demo", config: projectConfig(dir, actingTriage()) },
      { name: "off", config: projectConfig(dir, {}) },
      { name: "broken", config: projectConfig(dir, { enabled: true, mode: "sometimes" }) },
      { name: "unreadable", error: "Project config not found" },
    ],
    defaultProject: () => "demo",
  });
  await app.ready();
  return { app, manager, runner, git, events };
}

const P1 = sha("p1");
const OrderApiIT = "com.example.shop.api.OrderApiIT";
const PaymentApiIT = "com.example.shop.api.PaymentApiIT";

function failedResult(id = "gate-1", commit = P1) {
  return {
    result: {
      id,
      commitSha: commit,
      branch: "feat/orders",
      status: "failed",
      steps: [
        { name: "lint", status: "passed", exitCode: 0 },
        { name: "test", status: "failed", exitCode: 1 },
      ],
    },
    reports: [{ name: "TEST-OrderApiIT.xml", step: "test", content: fixture("junit-context-failure.xml") }],
    context: { agent: "worker-a" },
  };
}

describe("triage over HTTP", () => {
  it("a failed gate result is classified and its re-check requested; the answer unblocks it", async () => {
    const { app, runner } = await boot();

    const res = await app.inject({ method: "POST", url: "/api/triage/results?project=demo", payload: failedResult() });
    expect(res.statusCode).toBe(200);
    const { record, rechecks } = res.json().data;
    expect(record).toMatchObject({ gateId: "gate-1", sha: P1, verdict: "infra", blocking: true, retries: 1 });
    expect(record.causes[0].verdict.rule).toBe("infra-pattern:connection-timeout");
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]).toMatchObject({ purpose: "infra", status: "requested", sha: P1, classes: [OrderApiIT, PaymentApiIT] });
    expect(runner.callsTo("./bin/recheck")).toEqual([
      ["./bin/recheck", `--sha=${P1}`, `--request=${rechecks[0].id}`, "--steps=test", OrderApiIT, PaymentApiIT],
    ]);

    // Per failure: the verdict, its evidence, the actions and the retry count
    const detail = (await app.inject({ url: `/api/triage/failures/${record.id}` })).json().data;
    expect(detail.record.retries).toBe(1);
    expect(detail.record.causes[0].verdict.evidence[0]).toContain("java.net.SocketTimeoutException: connect timed out");
    expect(detail.record.causes[0].cause.testCount).toBe(4);
    expect(detail.actions.map((a: { kind: string; status: string }) => `${a.kind}:${a.status}`)).toEqual([
      "recheck:waiting",
      "recheck:done",
    ]);
    expect(detail.rechecks[0].id).toBe(rechecks[0].id);

    const listed = (await app.inject({ url: "/api/triage/failures?verdict=infra&blocking=true" })).json().data;
    expect(listed.map((r: { id: string }) => r.id)).toEqual([record.id]);

    // The gate runner answers the re-check
    const answer = await app.inject({
      method: "POST",
      url: "/api/triage/results",
      payload: {
        result: { id: "gate-1-recheck", commitSha: P1, branch: "feat/orders", status: "passed", steps: [{ name: "test", status: "passed" }] },
        context: { recheckId: rechecks[0].id },
      },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().data.record).toMatchObject({ purpose: "recheck", status: "passed", originId: record.id });

    const after = (await app.inject({ url: `/api/triage/failures/${record.id}` })).json().data;
    expect(after.record).toMatchObject({ blocking: false, resolution: "re-check 1 passed at the same commit: it was infrastructure" });
    expect(after.rechecks[0]).toMatchObject({ status: "passed" });

    const again = await app.inject({
      method: "POST",
      url: "/api/triage/results",
      payload: { result: { id: "late", commitSha: P1, branch: "feat/orders", status: "passed" }, context: { recheckId: rechecks[0].id } },
    });
    expect(again.statusCode).toBe(409);

    const status = (await app.inject({ url: "/api/triage/status" })).json().data;
    expect(status).toMatchObject({
      project: "demo",
      enabled: true,
      mode: "act",
      actBlocked: null,
      defaultBranch: "main",
      counts: { failures: 1, blocking: 0 },
      pendingRechecks: 0,
      incident: null,
      commands: { recheck: true, notify_agent: true, create_task: true, raise_decision: true, open_revert: true },
    });
    expect(status.counts.byClass.infra).toBe(1);
  });

  it("ingests gate.completed events from the bus", async () => {
    const { app, events, runner } = await boot();
    await events.emit("gate.completed", { project: "demo", ...failedResult("gate-from-bus") });
    const failures = (await app.inject({ url: "/api/triage/failures" })).json().data;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ gateId: "gate-from-bus", verdict: "infra" });
    expect(runner.callsTo("./bin/recheck")).toHaveLength(1);
    // Events for other projects, or not valid, are ignored
    await events.emit("gate.completed", { project: "off", ...failedResult("ignored") });
    await events.emit("gate.completed", { project: "demo", result: { id: "bad" } });
    expect((await app.inject({ url: "/api/triage/failures" })).json().data).toHaveLength(1);
  });

  it("shows the default branch's incident and its bisect over HTTP, and takes protect and revert requests", async () => {
    const { app, git, runner } = await boot();
    const c0 = sha("c0");
    const m1 = sha("m1");
    const m2 = sha("m2");
    git.commitOnMain(c0);
    git.commitOnMain(m1);
    git.commitOnMain(m2);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/triage/results", payload });
    expect((await post({ result: { id: "main-0", commitSha: c0, branch: "main", status: "passed" } })).statusCode).toBe(200);
    const red = await post({
      result: { id: "main-2", commitSha: m2, branch: "main", status: "failed", steps: [{ name: "test", status: "failed", exitCode: 1 }] },
      reports: [{ content: fixture("junit-assertion.xml") }],
    });
    const incident = red.json().data.incident;
    expect(incident).toMatchObject({ status: "open", redSha: m2, lastGreenSha: c0 });
    expect(incident.bisect).toMatchObject({ status: "running", candidates: [m1, m2] });

    const listed = (await app.inject({ url: "/api/triage/incidents?status=open" })).json().data;
    expect(listed.map((i: { id: string }) => i.id)).toEqual([incident.id]);
    const one = (await app.inject({ url: `/api/triage/incidents/${incident.id}` })).json().data;
    expect(one.incident.bisect.probes.map((p: { sha: string; outcome: string }) => `${p.sha.slice(0, 4)}:${p.outcome}`)).toEqual([
      `${m2.slice(0, 4)}:fail`,
      `${m1.slice(0, 4)}:pending`,
    ]);
    expect(one.rechecks[0]).toMatchObject({ purpose: "bisect", sha: m1, status: "requested" });
    expect((await app.inject({ url: "/api/triage/status" })).json().data.incident.id).toBe(incident.id);

    const protect = await app.inject({ method: "POST", url: "/api/triage/protected", payload: { sha: m1, note: "keep" } });
    expect(protect.json().data).toEqual([{ sha: m1, note: "keep", createdAt: expect.any(String) }]);
    expect((await app.inject({ method: "DELETE", url: `/api/triage/protected/${m1}` })).json().data).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/triage/protected/${m1}` })).statusCode).toBe(404);

    // No culprit yet: a revert can't be opened
    const early = await app.inject({ method: "POST", url: `/api/triage/incidents/${incident.id}/revert`, payload: {} });
    expect(early.statusCode).toBe(409);
    expect(runner.callsTo("./bin/revert")).toEqual([]);
  });

  it("validates input, ids and origins", async () => {
    const { app } = await boot();
    const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers });

    const badSha = await post("/api/triage/results", { result: { id: "g", commitSha: "not-a-sha", branch: "x", status: "failed" } });
    expect(badSha.statusCode).toBe(400);
    expect(badSha.json().error).toContain("result.commitSha");
    expect((await post("/api/triage/results", { result: { id: "g", commitSha: P1, branch: "-x", status: "failed" } })).statusCode).toBe(400);
    expect((await post("/api/triage/results", { ...failedResult(), context: { agent: "../etc" } })).statusCode).toBe(400);

    const unknown = await post("/api/triage/results", { ...failedResult(), context: { recheckId: "00000000-0000-4000-8000-000000000000" } });
    expect(unknown.statusCode).toBe(404);

    const off = await post("/api/triage/results?project=off", failedResult());
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("Triage is off for off (set triage.enabled: true in its YAML)");
    const broken = await post("/api/triage/results?project=broken", failedResult());
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toContain("triage.mode");

    expect((await app.inject({ url: "/api/triage/failures/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/triage/failures/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/triage/failures?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/triage/failures?verdict=bogus" })).statusCode).toBe(400);

    const crossSite = await post("/api/triage/results", failedResult(), { origin: "http://attacker.example" });
    expect(crossSite.statusCode).toBe(403);
    expect((await app.inject({ url: "/api/triage/failures" })).json().data).toEqual([]);

    const statusOff = (await app.inject({ url: "/api/triage/status?project=off" })).json().data;
    expect(statusOff).toMatchObject({ enabled: false, errors: [], incident: null });
    const statusBroken = (await app.inject({ url: "/api/triage/status?project=broken" })).json().data;
    expect(statusBroken.errors[0]).toContain("triage.mode");
    const statusUnreadable = (await app.inject({ url: "/api/triage/status?project=unreadable" })).json().data;
    expect(statusUnreadable.errors).toEqual(["Project config not found"]);
  });
});
