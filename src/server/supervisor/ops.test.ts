/**
 * The diagnostics route and the ops API through the production routes
 * (mountSupervisor), with the real HumanAuth, stores, Decision Inbox and
 * dashboard readers on files in a temp dir; and the MCP bridge
 * (`lair ops-mcp`, runOpsMcp) over real stdio framing against the real
 * server on a local port. Only the clock and the OS measures are fakes.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { stringify } from "yaml";
import type { OpsAuditEntry } from "../../shared/supervisor-types.js";
import { runOpsMcp } from "../../cli/ops-mcp.js";
import { AgentsStore } from "../agents/store.js";
import { runView, type AgentRun } from "../agents/types.js";
import { loadProjectConfig } from "../config.js";
import { EventBus } from "../core/event-bus.js";
import type { DashboardSources } from "../dashboard/routes.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { HumanAuth, OWNER_ONLY_PREFIXES, OWNER_SESSION_HEADER, isUnder } from "../human-auth/index.js";
import { DataService } from "../services/data.js";
import { WatchdogManager } from "../watchdog/service.js";
import { RequestLatency, mountSupervisor } from "./index.js";
import type { OsMeasures } from "./measures.js";
import { OPS_TOOLS } from "./ops-catalog.js";
import { redactConfig, redactText } from "./redact.js";

const T0 = Date.parse("2026-10-28T09:00:00Z");
const MIN = 60_000;
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

// Planted in a log, the config and the stores, and looked for in every answer. Built from pieces, so this file
// holds nothing shaped like a secret
const fakeGh = ["gh", "p_", "R4nd0m", "T0k3n", "x".repeat(26)].join("");
const fakePass = ["s3cr", "etPa55"].join("");
const fakeUrl = [["https://deploy", fakePass].join(":"), "@git.example.com/org/repo.git"].join("");
const fakeAccount = ["1234", "56789012"].join("");
const fakeArn = ["arn", "aws", "iam", "", fakeAccount, "role/Deploy"].join(":");
const fakeDigits = ["4488", "12345678"].join("");
const fakeHook = ["https://hooks.example.com/services", "T0", "B0", "z".repeat(24)].join("/");
const bearerLine = ["Author", "ization: Bearer ", fakeGh].join("");
const PLANTED = [fakeGh, fakePass, fakeArn, fakeAccount, fakeDigits, "z".repeat(24)];

const leaks = (text: string) => PLANTED.filter((p) => text.includes(p));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const measures: OsMeasures = {
  eventLoopDelay: () => ({ p99Ms: 4, maxMs: 6, meanMs: 1 }),
  openFiles: async () => ({ open: 40, limit: 1024, source: "proc" }),
  diskSpace: async () => ({ freeBytes: 80 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
};

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: "run-7",
    project: "demo",
    task: "feat-x",
    agent: "kiro-A",
    prompt: "do the task",
    chainId: "run-7",
    attempt: 1,
    profileIndex: 0,
    profile: { adapter: "kiro", provider: "kiro" },
    sessionId: "s-7",
    sessionMode: "new",
    sameSessionRestarts: 0,
    freshSessions: 0,
    startRetries: 0,
    launchFailures: 0,
    state: "failed",
    detail: "crashed",
    requestedAt: T0 - 10 * MIN,
    notBefore: T0 - 10 * MIN,
    logOffset: 0,
    ...over,
  };
}

async function serve(options: { listen?: boolean } = {}) {
  const root = tempDir("lair-ops-");
  const projects = join(root, "projects");
  mkdirSync(projects);
  for (const name of ["demo", "other"]) {
    const dir = join(root, name);
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "gates", "queue"), { recursive: true });
    mkdirSync(join(dir, "gates", "results"));
    writeFileSync(
      join(projects, `${name}.yaml`),
      stringify({
        name,
        repo: dir,
        github: "example/demo",
        queue_file: join(dir, "queue.md"),
        agents_dir: join(dir, "agents"),
        gates_dir: join(dir, "gates"),
        machines: {},
        status_cmd: ["curl", "-H", bearerLine, fakeUrl],
        processes: { web: { command: ["node", "server.js"], env: { DEPLOY_HOOK: fakeHook } } },
        review: { token_env: "LAIR_GITHUB_TOKEN" },
      }),
    );
  }
  const demo = join(root, "demo");
  writeFileSync(
    join(demo, "agents", "kiro-A.log"),
    [
      `[09:00:01] cloning ${fakeUrl}`,
      `[09:00:02] using ${fakeGh} for the push`,
      `[09:00:03] assumed ${fakeArn}`,
      `[09:00:04] ${bearerLine}`,
      `[09:00:05] account ${fakeDigits} billed`,
      `[09:00:06] ok: build finished`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(demo, "gates", "results", "gate-1.rc"), "1\n");
  writeFileSync(join(demo, "gates", "results", "gate-1.log"), `=== test\nFAIL fetching ${fakeUrl} with ${fakeGh}\n`);

  const clock = { t: T0, now() {
    return this.t;
  } };
  const agentsStore = new AgentsStore(":memory:");
  agentsStore.insertRun(run({ detail: `crashed: push to ${fakeUrl} failed with ${fakeGh}` }));
  agentsStore.addEvent({
    project: "demo",
    kind: "transient",
    agent: "kiro-A",
    task: "feat-x",
    runId: "run-7",
    summary: `provider error at ${fakeUrl}`,
    evidence: [bearerLine],
    data: { line: fakeArn },
    at: T0 - MIN,
  });
  const decisionStore = new DecisionStore(":memory:");
  const inbox = new DecisionInbox({ store: decisionStore, secrets: new MemorySecretStore(), clock });
  await inbox.raise({
    project: "demo",
    kind: "escalation",
    title: "kiro-A is paused on feat-x",
    context: `Last output: ${bearerLine}`,
    options: [{ id: "fresh", label: "Start it again", consequences: "A fresh session." }],
    recommended: { optionId: "fresh", reasoning: "The provider is back." },
    source: { module: "agents", ref: "chain:run-7" },
    key: "escalation:run-7:3",
    blocks: ["agents:demo:task:feat-x"],
  });

  const tokenPath = join(root, "data", "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const events = new EventBus();
  const watchdogs = new WatchdogManager({ dbPath: ":memory:" });
  const config = (project: string) => loadProjectConfig(project, projects);
  const dashboard: DashboardSources = {
    defaultProject: () => "demo",
    config,
    data: (project) => new DataService(config(project)),
    agentRuns: (project, limit) => agentsStore.listRuns(project, { limit }).map(runView),
  };
  const app: FastifyInstance = Fastify({ logger: false });
  const mounted = await mountSupervisor(app, {
    dbPath: ":memory:",
    humanAuth: auth,
    defaultProject: () => "demo",
    projects: ["demo", "other"].map((name) => ({ name, config: config(name) })),
    checks: { dataDir: join(root, "data"), config },
    ops: {
      config,
      status: { watchdog: (project) => watchdogs.status(project) },
      agentsStore: () => agentsStore,
      serverEvents: () => events.getRecentEvents(undefined, 1000),
      decisions: (o) => inbox.list(o),
      dashboard,
      triageRecords: () => [],
    },
    latency: new RequestLatency(() => clock.now()),
    events,
    decisions: inbox,
    measures,
    clock,
    projectsDir: projects,
  });
  if (options.listen) await app.listen({ port: 0, host: "127.0.0.1" });
  else await app.ready();
  cleanups.push(async () => {
    await app.close();
    await watchdogs.stop();
    auth.close();
    agentsStore.close();
    decisionStore.close();
  });
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
  const call = (token: string, tool: string, args: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/ops/call", headers: { authorization: `Bearer ${token}` }, payload: { tool, args } });
  return { app, root, demo, clock, mounted, owner, events, call };
}

describe("the diagnostics route", () => {
  it("is the owner's: no session, a stranger's browser and an ops token all get 403, and reading runs nothing", async () => {
    for (const url of ["/api/health/diagnostics", "/api/supervisor/tokens", "/api/supervisor/audit", "/api/ops/call"]) {
      expect(isUnder(url, OWNER_ONLY_PREFIXES), url).toBe(true);
    }
    expect(isUnder("/api/health", OWNER_ONLY_PREFIXES)).toBe(false);

    const { app, owner, mounted } = await serve();
    const { token } = mounted.tokens.mintSession();
    const strangers: [string, Record<string, string>][] = [
      ["no session", {}],
      ["a browser not signed in", BROWSER],
      ["an invalid session", { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }],
      ["an ops token as the session", { ...BROWSER, [OWNER_SESSION_HEADER]: token }],
      ["an ops token as a bearer", { authorization: `Bearer ${token}` }],
    ];
    const routes: ["GET" | "POST", string][] = [
      ["GET", "/api/health/diagnostics"],
      ["GET", "/api/supervisor/tokens"],
      ["POST", "/api/supervisor/tokens"],
      ["GET", "/api/supervisor/audit"],
    ];
    for (const [method, url] of routes) {
      for (const [who, headers] of strangers) {
        const res = await app.inject({ method, url, headers });
        expect(res.statusCode, `${method} ${url}: ${who}`).toBe(403);
      }
    }

    const before = await app.inject({ url: "/api/health/diagnostics", headers: owner });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toMatchObject({ enabled: true, intervalSeconds: 60, lastRunAt: null, server: [] });

    await mounted.supervisor.runNow();
    const after = (await app.inject({ url: "/api/health/diagnostics?project=demo", headers: owner })).json().data;
    expect(after.server.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining(["event_loop_lag", "request_latency", "open_files", "disk_free", "store_size", "command_timeouts"]),
    );
    expect(after.projects.map((p: { project: string }) => p.project)).toEqual(["demo"]);
    expect(after.projects[0].checks.find((c: { id: string }) => c.id === "retention")).toMatchObject({ status: "ok" });
    expect((await app.inject({ url: "/api/health/diagnostics?project=nope", headers: owner })).statusCode).toBe(400);
  });
});

describe("ops tokens", () => {
  it("are scoped and read-only, expire, end with their run, and are refused anywhere else", async () => {
    const { app, owner, mounted, events, clock, call } = await serve();

    // The owner's, for an interactive session: shown once, for an hour by default, never listed
    const minted = await app.inject({ method: "POST", url: "/api/supervisor/tokens", headers: owner, payload: {} });
    expect(minted.statusCode).toBe(201);
    const { token, info } = minted.json().data;
    expect(token).toMatch(/^lairops_[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({ kind: "session", projects: "*", scope: "read", runId: null });
    expect(Date.parse(info.expiresAt) - clock.t).toBe(60 * MIN);
    const listed = await app.inject({ url: "/api/supervisor/tokens", headers: owner });
    expect(listed.json().data.map((t: { id: string }) => t.id)).toContain(info.id);
    expect(listed.body).not.toContain(token);
    expect((await call(token, "config.get")).statusCode).toBe(200);
    expect((await call(token, "config.get", { project: "other" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/supervisor/tokens", headers: owner, payload: { ttl_minutes: 100_000 } })).statusCode).toBe(400);

    // A run's: its project only, and it ends with the run
    const forRun = mounted.tokens.mintForRun("sup-run-1", "demo", 30 * MIN);
    expect((await call(forRun.token, "config.get")).statusCode).toBe(200);
    const elsewhere = await call(forRun.token, "config.get", { project: "other" });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error).toBe("this token reads demo only");
    await events.emit("agent.run.ended", { project: "demo", runId: "sup-run-1" });
    expect((await call(forRun.token, "config.get")).statusCode).toBe(401);
    const recovered = mounted.tokens.mintForRun("sup-run-2", "demo", 30 * MIN);
    await events.emit("agent.recovery", { project: "demo", runId: "sup-run-2", kind: "crashed" });
    expect((await call(recovered.token, "config.get")).statusCode).toBe(401);

    // Its TTL
    const short = mounted.tokens.mintForRun("sup-run-3", "demo", 10 * MIN);
    expect((await call(short.token, "config.get")).statusCode).toBe(200);
    clock.t += 10 * MIN;
    expect((await call(short.token, "config.get")).statusCode).toBe(401);

    // The owner revokes one
    expect((await app.inject({ method: "POST", url: `/api/supervisor/tokens/${info.id}/revoke`, headers: owner })).statusCode).toBe(200);
    expect((await call(token, "config.get")).statusCode).toBe(401);

    // Nothing else opens the ops API: no token, garbage, the right shape never minted, the owner's session
    const nothing = await app.inject({ method: "POST", url: "/api/ops/call", payload: { tool: "config.get", args: {} } });
    expect(nothing.statusCode).toBe(401);
    expect(nothing.headers["www-authenticate"]).toBe("Bearer");
    expect((await call("nope", "config.get")).statusCode).toBe(401);
    expect((await call(`lairops_${"A".repeat(43)}`, "config.get")).statusCode).toBe(401);
    const asOwner = await app.inject({ method: "POST", url: "/api/ops/call", headers: owner, payload: { tool: "config.get", args: {} } });
    expect(asOwner.statusCode).toBe(401);

    // Read tools only: no write tool exists; arguments are checked
    const fresh = mounted.tokens.mintSession();
    expect((await call(fresh.token, "proposals.submit", { op: "release_hold" })).statusCode).toBe(404);
    expect((await call(fresh.token, "config.get", { project: "demo", extra: 1 })).statusCode).toBe(400);
    expect((await call(fresh.token, "config.get", { project: "../etc" })).statusCode).toBe(400);
    expect((await call(fresh.token, "config.get", { project: "nope" })).statusCode).toBe(400);
    expect((await call(fresh.token, "runs.get", { id: "-rf" })).statusCode).toBe(400);
  });

  it("audit every call: who, when, the tool and its arguments, and how it ended; never a token", async () => {
    const { app, owner, mounted, call, clock } = await serve();
    const minted = (await app.inject({ method: "POST", url: "/api/supervisor/tokens", headers: owner, payload: { ttl_minutes: 30, label: "my terminal" } })).json().data;
    const forRun = mounted.tokens.mintForRun("sup-run-9", "demo", 30 * MIN);
    await call(minted.token, "config.get", { project: "other" });
    clock.t += 1000;
    await call(forRun.token, "config.get", { project: "other" });
    clock.t += 1000;
    await call(forRun.token, "logs.tail", { agent: "kiro-A", lines: 5 });
    clock.t += 1000;
    await call(forRun.token, "proposals.submit", {});
    await app.inject({ method: "POST", url: "/api/ops/call", payload: { tool: "config.get" } });

    const audit = (await app.inject({ url: "/api/supervisor/audit?limit=50", headers: owner })).json().data as OpsAuditEntry[];
    const rows = audit.map((a) => [a.who, a.tool, a.args, a.outcome]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["owner", "(token minted)", "ttl_minutes=30, label=my terminal", "ok"],
        ["my terminal", "config.get", `{"project":"other"}`, "ok"],
        ["run sup-run-9", "config.get", `{"project":"other"}`, "refused"],
        ["run sup-run-9", "logs.tail", `{"agent":"kiro-A","lines":5}`, "ok"],
        ["run sup-run-9", "proposals.submit", "{}", "refused"],
        ["(no valid token)", "-", "", "refused"],
      ]),
    );
    const refusal = audit.find((a) => a.tool === "config.get" && a.outcome === "refused");
    expect(refusal).toMatchObject({ tokenId: forRun.info.id, detail: "this token reads demo only", at: new Date(T0 + 1000).toISOString() });
    expect(JSON.stringify(audit)).not.toContain(minted.token);
    expect(JSON.stringify(audit)).not.toContain(forRun.token);
    // One token's calls
    const mine = (await app.inject({ url: `/api/supervisor/audit?token=${forRun.info.id}`, headers: owner })).json().data as OpsAuditEntry[];
    expect(mine.map((a) => a.tool)).toEqual(["proposals.submit", "logs.tail", "config.get"]);
  });
});

describe("the ops tools", () => {
  it("answer bounded and redacted: no secret, token, URL credential, ARN or long digit run from a log, the config or a store", async () => {
    const { mounted, call, demo } = await serve();
    appendFileSync(join(demo, "agents", "kiro-A.log"), `${"y".repeat(10_000)}\n[09:00:07] done\n`);
    const { token } = mounted.tokens.mintSession();
    const answers: Record<string, unknown> = {};
    const tools: [string, Record<string, unknown>][] = [
      ["logs.tail", { agent: "kiro-A", lines: 200 }],
      ["logs.tail", { gate: "gate-1" }],
      ["config.get", {}],
      ["events.query", { kinds: ["transient"] }],
      ["runs.get", { id: "run-7" }],
      ["runs.get", { agent: "kiro-A" }],
      ["decisions.list", {}],
      ["gates.result", { id: "gate-1" }],
      ["gates.result", {}],
      ["triage.record", {}],
      ["placement.status", {}],
      ["status.watchdog", {}],
      ["status.agents", {}],
      ["diagnostics.run", {}],
    ];
    for (const [tool, args] of tools) {
      const res = await call(token, tool, args);
      expect(res.statusCode, `${tool} ${JSON.stringify(args)}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(leaks(res.body), tool).toEqual([]);
      expect(res.body, tool).not.toContain("deploy:");
      answers[`${tool} ${JSON.stringify(args)}`] = res.json().data.result;
    }

    const agentLog = answers[`logs.tail {"agent":"kiro-A","lines":200}`] as { log: { file: string; lines: string[] } };
    expect(agentLog.log.file).toBe("kiro-A.log");
    expect(agentLog.log.lines).toEqual(
      expect.arrayContaining(["[09:00:01] cloning https://git.example.com/[...]", "[09:00:06] ok: build finished", "[09:00:07] done"]),
    );
    expect(agentLog.log.lines.find((l) => l.includes("account"))).toBe("[09:00:05] account [digits] billed");
    // A long line is cut
    expect(Math.max(...agentLog.log.lines.map((l) => l.length))).toBeLessThanOrEqual(503);

    const config = (answers["config.get {}"] as { config: Record<string, unknown> }).config;
    expect(config.processes).toEqual({ web: { command: ["node", "server.js"], env: "[removed: a command's environment]" } });
    expect(config.review).toEqual({ token_env: "LAIR_GITHUB_TOKEN" });
    expect(config.status_cmd).toEqual(["curl", "-H", "Authorization: [redacted]", "https://git.example.com/[...]"]);

    const events = (answers[`events.query {"kinds":["transient"]}`] as { events: { summary: string; runId: string }[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "run-7", summary: "provider error at https://git.example.com/[...]" });
    expect((answers[`runs.get {"id":"run-7"}`] as { run: { detail: string } }).run.detail).toBe("crashed: push to https://git.example.com/[...] failed with [secret]");
    expect((answers["decisions.list {}"] as { decisions: { title: string; context: string }[] }).decisions[0]).toMatchObject({
      title: "kiro-A is paused on feat-x",
      context: "Last output: Authorization: [redacted]",
    });
    expect((answers["status.agents {}"] as { enabled: boolean }).enabled).toBe(false);

    // Bounds: refused, not cut
    expect((await call(token, "logs.tail", { agent: "kiro-A", lines: 201 })).statusCode).toBe(400);
    expect((await call(token, "logs.tail", {})).statusCode).toBe(400);
    expect((await call(token, "events.query", { limit: 500 })).statusCode).toBe(400);
    expect((await call(token, "events.query", { since: new Date(T0 - 30 * 86_400_000).toISOString() })).statusCode).toBe(400);
    expect((await call(token, "decisions.list", { limit: 1000 })).statusCode).toBe(400);
    expect((await call(token, "events.query", { kinds: Array.from({ length: 21 }, () => "transient") })).statusCode).toBe(400);
    expect((await call(token, "runs.get", { id: "no-such-run" })).statusCode).toBe(404);
  });

  it("redact text and configs by the same rules", () => {
    expect(redactText(`see ${fakeUrl}?token=abc and ${fakeArn}`)).toBe("see https://git.example.com/[...] and [arn]");
    expect(redactText(`export GITHUB_TOKEN=${fakeGh}`)).toBe("export GITHUB_TOKEN=[secret]");
    expect(redactText(`export DEPLOY_TOKEN=${"q".repeat(12)}`)).toBe("export DEPLOY_TOKEN=[redacted]");
    expect(redactText(`"apiKey": "${"Q".repeat(8)}"`)).toBe(`"apiKey": "[redacted]"`);
    expect(redactText(`commit ${"a1b2c3d4".repeat(5)} on ${"0123456789abcdef".repeat(2)}`)).toBe(`commit ${"a1b2c3d4".repeat(5)} on [secret]`);
    expect(redactText("run 0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b ok")).toBe("run 0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b ok");
    expect(redactText(`key ${"Ab3".repeat(12)}`)).toBe("key [secret]");
    expect(redactText("x".repeat(5000)).length).toBe(1003);
    expect(
      redactConfig({ review: { token_env: "LAIR_GITHUB_TOKEN" }, ntfy: { token_file: "ntfy.token" }, deploy: { password: "hunter" }, processes: { a: { env: { A: "b" } } } }),
    ).toEqual({
      review: { token_env: "LAIR_GITHUB_TOKEN" },
      ntfy: { token_file: "ntfy.token" },
      deploy: { password: "[redacted]" },
      processes: { a: { env: "[removed: a command's environment]" } },
    });
  });
});

describe("lair ops-mcp", () => {
  it("speaks MCP over stdio through the real handler: initialize, tools/list, tools/call, and ends with its input", async () => {
    const { app, mounted } = await serve({ listen: true });
    const port = (app.server.address() as AddressInfo).port;
    const { token } = mounted.tokens.mintSession();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const messages: { jsonrpc?: string; id?: number; result?: any; error?: any }[] = [];
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() !== "") messages.push(JSON.parse(line));
      }
    });
    const errors: string[] = [];
    const done = runOpsMcp({
      env: { LAIR_OPS_TOKEN: token, LAIR_URL: `http://127.0.0.1:${port}` },
      fetch: (url, init) => fetch(url, init),
      err: (line) => errors.push(line),
      stdin,
      stdout,
    });
    const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify(message)}\n`);
    const reply = async (id: number) => {
      const until = Date.now() + 10_000;
      for (;;) {
        const found = messages.find((m) => m.id === id);
        if (found) return found;
        if (Date.now() > until) throw new Error(`no answer to request ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } });
    const init = await reply(1);
    expect(init.result.serverInfo).toMatchObject({ name: "lair-ops" });
    expect(init.result.capabilities.tools).toBeDefined();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await reply(2);
    const tools = list.result.tools as { name: string; inputSchema: { type: string; properties: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(OPS_TOOLS.map((t) => t.name).sort());
    const tail = tools.find((t) => t.name === "logs.tail")!;
    expect(tail.inputSchema.type).toBe("object");
    expect(Object.keys(tail.inputSchema.properties)).toEqual(expect.arrayContaining(["project", "agent", "gate", "lines"]));
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "config.get", arguments: { project: "demo" } } });
    const called = await reply(3);
    expect(called.result.isError).toBeFalsy();
    const text = called.result.content[0].text as string;
    expect(JSON.parse(text).result.config.review).toEqual({ token_env: "LAIR_GITHUB_TOKEN" });
    expect(leaks(text)).toEqual([]);

    // Over a bound: refused before Lair is asked
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "logs.tail", arguments: { agent: "kiro-A", lines: 500 } } });
    const tooMany = await reply(4);
    expect(tooMany.error ?? tooMany.result?.isError).toBeTruthy();
    // Refused by Lair: a tool error that says why
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "config.get", arguments: { project: "nope" } } });
    const refused = await reply(5);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("HTTP 400");
    // No such tool
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "proposals.submit", arguments: {} } });
    const unknown = await reply(6);
    expect(unknown.error ?? unknown.result?.isError).toBeTruthy();

    // stdout holds the protocol only, never the token
    expect(messages.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(token);
    expect(errors).toEqual([]);

    // Lair audited the calls that reached it
    expect(mounted.store.list(20).map((a) => [a.tool, a.outcome])).toEqual(
      expect.arrayContaining([
        ["config.get", "ok"],
        ["config.get", "refused"],
      ]),
    );

    // The client closes the session
    stdin.end();
    await expect(done).resolves.toBe(0);
  });

  it("refuses to start without an ops token or with a bad LAIR_URL, writing nothing to stdout", async () => {
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    const errors: string[] = [];
    const deps = { fetch: (url: string, init: RequestInit) => fetch(url, init), err: (line: string) => errors.push(line), stdin: new PassThrough(), stdout };
    expect(await runOpsMcp({ ...deps, env: {} })).toBe(2);
    expect(errors[0]).toBe("lair ops-mcp: LAIR_OPS_TOKEN is not set to an ops token");
    expect(await runOpsMcp({ ...deps, env: { LAIR_OPS_TOKEN: `lairops_${"A".repeat(43)}`, LAIR_URL: "ftp://example.com" } })).toBe(2);
    expect(errors).toContain("lair ops-mcp: LAIR_URL is not an http(s) URL");
    expect(out).toBe("");
  });
});
