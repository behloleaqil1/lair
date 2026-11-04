/**
 * External worker tokens (#366): the owner makes one (POST /api/bus/tokens, or `lair bus token create`, with an owner
 * session), and a worker outside Lair's runs reports with it through POST /api/bus/call, the same report path as a
 * run's. Real routes, a real HumanAuth, the real bus store, mirror, event bus and live channel (Home); the agents
 * module is a fake with no runs. Each acceptance test of the issue is a test named `AT<n>:`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { busStoreFor, EXT_CALLS_PER_MINUTE, forgetBusService, registerBusRoutes } from "../routes/bus.js";
import { registerAgentsRoutes } from "../agents/routes.js";
import type { AgentsManager } from "../agents/index.js";
import { registerDecisionRoutes } from "../decisions/routes.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { registerReviewRoutes, type ReviewManager } from "../review/index.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { BusLiveUpdate } from "../../shared/bus-live.js";
import { busCli, EXIT_OK, type BusCliDeps } from "../../cli/bus.js";
import { BusLive } from "./live.js";
import { validateBusReportEvent, type BusConsumeMode } from "./consumers.js";
import { closeBusStores } from "./store.js";
import { hashBusToken, newBusToken, newExtToken } from "./tokens.js";

/** A listed project (projects/example.yaml): the token routes name it */
const PROJECT = "example";
/** The dashboard in a browser, as requests carry it (no session yet) */
const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

let dir: string;
let events: EventBus;
let mode: BusConsumeMode;
let published: { project: string; update: BusLiveUpdate }[];
let live: BusLive;
let logLines: string[];
let app: FastifyInstance;
let auth: HumanAuth;
let owner: Record<string, string>;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const queueFile = () => join(dir, "queue.md");
const queueLines = () => (existsSync(queueFile()) ? readFileSync(queueFile(), "utf-8").split("\n").filter((line) => line !== "") : []);
const store = () => busStoreFor(PROJECT, dir);

/** The agents module, faked: no run holds anything (an external worker has none) */
const agents = { get: () => null, getStore: () => null } as unknown as AgentsManager;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lair-bus-ext-"));
  events = new EventBus();
  mode = "observe";
  published = [];
  live = new BusLive({ events, mode: () => mode, publish: (project, update) => published.push({ project, update }), quietMs: 5, maxWaitMs: 20 });
  live.start();
  // The server's own request log, at its most verbose
  logLines = [];
  app = Fastify({ logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } } });
  auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  await registerBusRoutes(app, auth, {
    agents,
    events,
    dataDir: dir,
    getConfig: () => ({ queue_file: queueFile() }) as unknown as ProjectConfig,
    mode: () => mode,
    enabled: () => [PROJECT],
    health: () => ({ mode, received: 0, refused: [], refusedCount: 0, observations: { total: 0, matches: 0, mismatches: 0, recent: [] } }),
  });
  await app.ready();
  owner = { ...DASHBOARD, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(join(dir, "owner.token"), "utf-8").trim())!.session };
});

afterEach(async () => {
  vi.restoreAllMocks();
  live.stop();
  await app.close();
  auth.close();
  forgetBusService(PROJECT);
  closeBusStores();
  rmSync(dir, { recursive: true, force: true });
});

/** The owner makes a token: the token (shown this once) and its list entry */
async function mint(body: Record<string, unknown> = { worker: "worker-x" }) {
  const res = await app.inject({ method: "POST", url: `/api/bus/tokens?project=${PROJECT}`, headers: owner, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json().data as { token: string; info: { id: string; worker: string; agent: string; kinds: string[] } };
}

function call(token: string, tool: string, args: Record<string, unknown> = {}, query = "") {
  return app.inject({ method: "POST", url: `/api/bus/call${query}`, headers: { authorization: `Bearer ${token}` }, payload: { tool, args } });
}

const report = (token: string, args: Record<string, unknown> = {}, query = "") =>
  call(token, "report", { kind: "PROGRESS", task: "feat-search", summary: "halfway there", ...args }, query);

function collect(): unknown[] {
  const emitted: unknown[] = [];
  events.on("bus.report", (event) => void emitted.push(event.data));
  return emitted;
}

describe("external worker tokens: reports from outside Lair's runs", () => {
  it("AT1: a report with a valid external token is stored, mirrored as one line ending [bus:<id>], emitted, and shown on Home with agent ext:<worker>", async () => {
    const emitted = collect();
    const { token } = await mint({ worker: "worker-x" });
    const res = await report(token, { kind: "WAITING", summary: "gate running", gate_id: "gate-7", pr: 12, sha: "abc1234" });
    expect(res.statusCode).toBe(200);
    const { id } = res.json().data as { id: number };
    await settle();

    expect(store().getReport(id)).toMatchObject({ agent: "ext:worker-x", kind: "WAITING", task: "feat-search", gateId: "gate-7", pr: 12, sha: "abc1234" });
    const lines = queueLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^- WAITING feat-search by ext:worker-x \\d{2}:\\d{2}Z: gate running \\[gate-7\\] PR #12 \\[abc1234\\] \\[bus:${id}\\]$`));
    expect(emitted).toMatchObject([{ project: PROJECT, id, agent: "ext:worker-x", kind: "WAITING", task: "feat-search", gateId: "gate-7", pr: 12, sha: "abc1234" }]);
    // The consumers (fill, the planner) take the event as they take a run's
    expect(validateBusReportEvent(emitted[0])).toMatchObject({ ok: true });
    // Home: the project's live bus channel
    expect(published.flatMap((p) => p.update.events)).toMatchObject([{ type: "report", id, agent: "ext:worker-x", kind: "WAITING", task: "feat-search" }]);
  });

  it("AT2: an expired, revoked or unknown token gets 401, and nothing is stored or mirrored", async () => {
    const { token: revoked, info } = await mint({ worker: "worker-x" });
    // The same request with a live token is taken
    expect((await report(revoked)).statusCode).toBe(200);
    const expired = newExtToken();
    store().issueExtToken("worker-y", ["PROGRESS"], hashBusToken(expired), Date.now() - 120_000, Date.now() - 60_000);
    expect((await app.inject({ method: "POST", url: `/api/bus/tokens/${info.id}/revoke?project=${PROJECT}`, headers: owner, payload: {} })).statusCode).toBe(200);

    for (const token of [expired, revoked, newExtToken()]) {
      for (const query of ["", `?project=${PROJECT}`]) {
        const res = await report(token, { summary: "after the end" }, query);
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("Invalid, expired or revoked bus token");
      }
    }
    expect(store().listReports().map((r) => r.summary)).toEqual(["halfway there"]);
    expect(queueLines()).toHaveLength(1);
  });

  it("AT3: a token for worker X cannot set the agent to kiro-K: the stored report, its line and its event say ext:X", async () => {
    const emitted = collect();
    const { token } = await mint({ worker: "worker-x" });
    const res = await report(token, { agent: "kiro-K", run_id: "run-0001", summary: "done, as kiro-K" });
    expect(res.statusCode).toBe(200);
    const { id } = res.json().data as { id: number };
    // A worker named like a fleet agent still reports in its own namespace
    const { token: namesake, info } = await mint({ worker: "kiro-K" });
    expect(info.agent).toBe("ext:kiro-K");
    expect((await report(namesake, { agent: "kiro-K" })).statusCode).toBe(200);

    expect(store().getReport(id)).toMatchObject({ agent: "ext:worker-x", runId: expect.stringMatching(/^ext:[0-9a-f-]{36}$/) });
    expect(store().listReports({ agent: "kiro-K" })).toEqual([]);
    expect(store().listReports().map((r) => r.agent).sort()).toEqual(["ext:kiro-K", "ext:worker-x"]);
    expect(queueLines()[0]).toContain(" by ext:worker-x ");
    expect(emitted.map((e) => (e as { agent: string }).agent)).toEqual(["ext:worker-x", "ext:kiro-K"]);
  });

  it("AT4: a kind outside the token's allowed kinds gets 403, and nothing is stored or mirrored", async () => {
    const { token } = await mint({ worker: "worker-x", kinds: ["PROGRESS", "BLOCKED"] });
    expect((await report(token, { kind: "BLOCKED" })).statusCode).toBe(200);
    const done = await report(token, { kind: "DONE" });
    expect(done.statusCode).toBe(403);
    expect(done.json().error).toBe("This token reports PROGRESS, BLOCKED only, not DONE");
    // The default kinds leave out TICK
    const { token: defaults, info } = await mint({ worker: "worker-y" });
    expect(info.kinds).toEqual(["PROGRESS", "WAITING", "DONE", "BLOCKED"]);
    expect((await report(defaults, { kind: "TICK" })).statusCode).toBe(403);

    expect(store().listReports().map((r) => r.kind)).toEqual(["BLOCKED"]);
    expect(queueLines()).toHaveLength(1);
    expect(store().listExtAudit(10).filter((a) => a.outcome === "refused").map((a) => a.detail)).toEqual([
      "This token reports PROGRESS, WAITING, DONE, BLOCKED only, not TICK",
      "This token reports PROGRESS, BLOCKED only, not DONE",
    ]);
  });

  it("AT5: a canary token never appears in logs, responses, mirror lines, stored reports, events, Home or the audit record", async () => {
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(" ")));
    }
    const emitted = collect();
    const { token: canary, info } = await mint({ worker: "worker-x", kinds: ["PROGRESS"] });
    const cut = canary.slice(0, 20);
    const responses: string[] = [];
    const send = async (tool: string, args: Record<string, unknown>) => {
      const res = await call(canary, tool, args);
      responses.push(res.body);
      return res.statusCode;
    };
    // Its own token, whole and cut short, everywhere a worker can put text
    expect(await send("report", { kind: "PROGRESS", task: "feat-search", summary: `LAIR_BUS_TOKEN=${canary}; cut ${cut}` })).toBe(200);
    expect(await send("report", { kind: "PROGRESS", task: "feat-search", summary: "waits", gate_id: canary })).toBe(400);
    expect(await send("report", { kind: canary, task: "feat-search", summary: "a kind" })).toBe(400);
    expect(await send("report", { kind: "PROGRESS", task: canary, summary: "a task" })).toBe(400);
    expect(await send("report", { kind: "DONE", task: "feat-search", summary: canary })).toBe(403);
    expect(await send(canary, {})).toBe(403);
    expect(await send("send", { to: "owner", text: canary })).toBe(403);
    for (const path of ["/api/bus/tokens", "/api/bus/tokens/audit", "/api/bus/activity", "/api/bus/board"]) {
      responses.push((await app.inject({ method: "GET", url: `${path}?project=${PROJECT}`, headers: owner })).body);
    }
    await settle();

    const audit = store().listExtAudit(100);
    expect(audit.filter((a) => a.tokenId === info.id && a.worker === "worker-x")).toHaveLength(8);
    const seen = {
      logs: [...logLines, ...consoleLines].join("\n"),
      responses: responses.join("\n"),
      mirror: queueLines().join("\n"),
      reports: JSON.stringify(store().listReports()),
      audit: JSON.stringify(audit),
      events: JSON.stringify(emitted),
      home: JSON.stringify(published),
    };
    expect(seen.mirror).toContain("LAIR_BUS_TOKEN=[bus-token]; cut [bus-token]");
    expect(logLines.length).toBeGreaterThan(0);
    for (const [where, text] of Object.entries(seen)) {
      expect(text.includes(canary), where).toBe(false);
      expect(text.includes(cut), where).toBe(false);
    }
  });

  it("AT6: creating, listing and revoking tokens need an owner session (403 otherwise); creation and revocation are audited", async () => {
    const runToken = newBusToken();
    store().issueToken("kiro-K", "run-0001", hashBusToken(runToken), Date.now());
    const { token: ext, info } = await mint({ worker: "worker-x" });
    const refused: Record<string, Record<string, string>> = {
      bare: {},
      dashboardNotSignedIn: DASHBOARD,
      guessedSession: { ...DASHBOARD, [OWNER_SESSION_HEADER]: "g".repeat(43) },
      sessionWithoutOrigin: { [OWNER_SESSION_HEADER]: owner[OWNER_SESSION_HEADER] },
      runToken: { authorization: `Bearer ${runToken}` },
      externalToken: { authorization: `Bearer ${ext}` },
    };
    for (const [name, headers] of Object.entries(refused)) {
      const create = await app.inject({ method: "POST", url: `/api/bus/tokens?project=${PROJECT}`, headers, payload: { worker: "intruder" } });
      const list = await app.inject({ method: "GET", url: `/api/bus/tokens?project=${PROJECT}`, headers });
      const auditRead = await app.inject({ method: "GET", url: `/api/bus/tokens/audit?project=${PROJECT}`, headers });
      const revoke = await app.inject({ method: "POST", url: `/api/bus/tokens/${info.id}/revoke?project=${PROJECT}`, headers, payload: {} });
      expect([name, create.statusCode, list.statusCode, auditRead.statusCode, revoke.statusCode]).toEqual([name, 403, 403, 403, 403]);
    }
    expect(store().listExtTokens().map((t) => [t.worker, t.revokedAt])).toEqual([["worker-x", null]]);
    // The owner's creation, audited with the owner session's public id (never the token)
    const session = auth.listSessions()[0].id;
    expect(store().listExtAudit(10)).toEqual([
      { at: expect.any(Number), tokenId: info.id, worker: "worker-x", action: "(token created)", outcome: "ok", detail: expect.stringMatching(new RegExp(`^by owner session ${session}; kinds PROGRESS,WAITING,DONE,BLOCKED; expires `)) },
    ]);

    expect((await app.inject({ method: "POST", url: `/api/bus/tokens/${info.id}/revoke?project=${PROJECT}`, headers: owner, payload: {} })).statusCode).toBe(200);
    expect(store().listExtAudit(1)).toMatchObject([{ tokenId: info.id, worker: "worker-x", action: "(token revoked)", detail: `by owner session ${session}` }]);
    // The list: worker, created, expires, last used, report count; never the token or its hash
    const list = await app.inject({ method: "GET", url: `/api/bus/tokens?project=${PROJECT}`, headers: owner });
    expect(list.json().data).toEqual([
      { id: info.id, worker: "worker-x", agent: "ext:worker-x", kinds: ["PROGRESS", "WAITING", "DONE", "BLOCKED"], createdAt: expect.any(String), expiresAt: expect.any(String), revokedAt: expect.any(String), lastUsedAt: null, reports: 0 },
    ]);
    expect(list.body).not.toContain(ext);
    expect(list.body).not.toContain(hashBusToken(ext));
  });

  it("AT7: more reports a minute than the limit from one token get 429; another token is not slowed", async () => {
    const { token, info } = await mint({ worker: "worker-x" });
    for (let i = 0; i < EXT_CALLS_PER_MINUTE; i++) expect((await report(token, { summary: `step ${i}` })).statusCode).toBe(200);
    const over = await report(token, { summary: "one too many" });
    expect(over.statusCode).toBe(429);
    expect(store().listReports()).toHaveLength(EXT_CALLS_PER_MINUTE);
    expect(queueLines()).toHaveLength(EXT_CALLS_PER_MINUTE);
    expect(store().listExtAudit(1)).toMatchObject([{ tokenId: info.id, outcome: "refused", detail: `more than ${EXT_CALLS_PER_MINUTE} calls a minute` }]);
    expect(store().listExtTokens().find((t) => t.id === info.id)).toMatchObject({ reports: EXT_CALLS_PER_MINUTE, lastUsedAt: expect.any(String) });

    const { token: other } = await mint({ worker: "worker-y" });
    expect((await report(other)).statusCode).toBe(200);
  });

  it("the owner makes a token with `lair bus token create`, and the worker reports with `lair bus report`", async () => {
    const out: string[] = [];
    const deps = (env: Record<string, string>): BusCliDeps => ({
      env,
      fetch: async (url, init) => {
        const target = new URL(url);
        const res = await app.inject({ method: init.method as "GET" | "POST", url: `${target.pathname}${target.search}`, headers: init.headers, ...(init.body === undefined ? {} : { payload: init.body }) });
        return { status: res.statusCode, text: async () => res.body };
      },
      out: (line) => void out.push(line),
      err: (line) => void out.push(line),
    });
    const session = owner[OWNER_SESSION_HEADER];
    expect(await busCli(["token", "create", "--project", PROJECT, "--worker", "worker-x", "--ttl", "2h", "--kinds", "progress,done"], deps({ LAIR_OWNER_SESSION: session }))).toBe(EXIT_OK);
    const { token, info } = JSON.parse(out.join("\n")) as { token: string; info: { id: string; kinds: string[]; createdAt: string; expiresAt: string } };
    expect(info.kinds).toEqual(["PROGRESS", "DONE"]);
    expect(Date.parse(info.expiresAt) - Date.parse(info.createdAt)).toBe(2 * 60 * 60_000);

    const summary = join(dir, "summary.md");
    writeFileSync(summary, "merged\n");
    out.length = 0;
    expect(await busCli(["report", "--kind", "DONE", "--task", "feat-search", "--summary-file", summary, "--pr", "12"], deps({ LAIR_BUS_TOKEN: token }))).toBe(EXIT_OK);
    expect(store().listReports()).toMatchObject([{ agent: "ext:worker-x", kind: "DONE", task: "feat-search", pr: 12 }]);

    out.length = 0;
    expect(await busCli(["token", "list", "--project", PROJECT], deps({ LAIR_OWNER_SESSION: session }))).toBe(EXIT_OK);
    expect(JSON.parse(out.join("\n"))).toMatchObject([{ id: info.id, reports: 1 }]);
    expect(await busCli(["token", "revoke", info.id, "--project", PROJECT], deps({ LAIR_OWNER_SESSION: session }))).toBe(EXIT_OK);
    expect(store().listExtTokens()[0].revokedAt).not.toBeNull();
    expect(out.join("\n")).not.toContain(session);
  });
});

describe("AT8: an external token is refused everything but a report", () => {
  /** Another route module on its own server, with the same owner credential */
  async function serve(register: (server: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    await register(server);
    await server.ready();
    return server;
  }

  it("AT8: the bus refuses it whoami, inbox, ack, send and board, and sends nothing", async () => {
    const { token, info } = await mint({ worker: "worker-x" });
    const tries: Array<[string, Record<string, unknown>]> = [
      ["whoami", {}],
      ["inbox", {}],
      ["ack", { message_id: "abcd1234" }],
      ["send", { to: "orchestrator", text: "please merge" }],
      ["board", {}],
    ];
    for (const [tool, args] of tries) {
      const res = await call(token, tool, args);
      expect([tool, res.statusCode, res.json().error]).toEqual([tool, 403, "An external worker's token only reports (tool: report)"]);
    }
    expect(store().listRecentMessages(10)).toEqual([]);
    expect(queueLines()).toEqual([]);
    expect(store().listExtAudit(10).map((a) => [a.action, a.outcome])).toEqual([
      ["board", "refused"],
      ["send", "refused"],
      ["ack", "refused"],
      ["inbox", "refused"],
      ["whoami", "refused"],
      ["(token created)", "ok"],
    ]);
    expect(store().listExtTokens()).toMatchObject([{ id: info.id, reports: 0 }]);
  });

  it("AT8: fill refuses it: no claim or fill hold is released and no check runs", async () => {
    const { token } = await mint();
    const service = { releaseFillHold: vi.fn(), releaseClaim: vi.fn(), checkNow: vi.fn() };
    const manager = { get: vi.fn(() => service), status: vi.fn(() => ({ errors: [] })) } as unknown as AgentsManager;
    const server = await serve((s) => registerAgentsRoutes(s, manager, () => PROJECT, auth));
    for (const url of ["/api/agents/fill/release", "/api/agents/claims/release", "/api/agents/tick"]) {
      const res = await server.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: { task: "feat-search", confirm: true } });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect(manager.get).not.toHaveBeenCalled();
    expect(service.releaseFillHold).not.toHaveBeenCalled();
    await server.close();
  });

  it("AT8: runs refuse it: none is started or restarted", async () => {
    const { token } = await mint();
    const service = { requestRun: vi.fn(), freshSession: vi.fn() };
    const manager = { get: vi.fn(() => service), status: vi.fn(() => ({ errors: [] })) } as unknown as AgentsManager;
    const server = await serve((s) => registerAgentsRoutes(s, manager, () => PROJECT, auth));
    const tries: Array<[string, Record<string, unknown>]> = [
      ["/api/agents/runs", { agent: "kiro-K", task: "feat-search", prompt: "build it" }],
      ["/api/agents/runs/0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b/fresh-session", { confirm: true }],
    ];
    for (const [url, payload] of tries) {
      const res = await server.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect(manager.get).not.toHaveBeenCalled();
    expect(service.requestRun).not.toHaveBeenCalled();
    await server.close();
  });

  it("AT8: decisions refuse it: an open decision stays open", async () => {
    const { token } = await mint();
    const decisions = new DecisionStore(":memory:");
    const inbox = new DecisionInbox({ store: decisions, secrets: new MemorySecretStore(), clock: { now: () => Date.now() } });
    const { decision } = await inbox.raise({
      project: PROJECT,
      kind: "other",
      title: "Pick the search backend",
      context: "The search work waits on it.",
      options: [
        { id: "approve", label: "Approve", consequences: "The work goes ahead." },
        { id: "decline", label: "Decline", consequences: "The work stays blocked." },
      ],
      recommended: { optionId: "approve", reasoning: "It is ready." },
      source: { module: "delivery", ref: "search" },
      key: "search-backend",
    });
    const server = await serve((s) => registerDecisionRoutes(s, inbox, () => PROJECT, auth));
    const res = await server.inject({ method: "POST", url: `/api/decisions/${decision.id}/answer`, headers: { authorization: `Bearer ${token}` }, payload: { optionId: "approve" } });
    expect(res.statusCode).toBe(403);
    expect(inbox.get(decision.id)).toMatchObject({ status: "open" });
    await server.close();
    decisions.close();
  });

  it("AT8: reviews refuse it: no merge, owner review, review request, resolution or hold release", async () => {
    const { token } = await mint();
    const manager = { get: vi.fn(), info: vi.fn(() => ({ errors: [] })) } as unknown as ReviewManager;
    const server = await serve((s) => registerReviewRoutes(s, manager, () => PROJECT, auth));
    const sha = "a".repeat(40);
    const tries: Array<[string, Record<string, unknown>]> = [
      ["/api/review/prs/12/merge", { confirm: true, head_sha: sha, by: "worker-x" }],
      ["/api/review/prs/12/owner-review", { reviewer: "worker-x", head_sha: sha, verdict: "approve", summary: "fine" }],
      ["/api/review/prs/12/request-reviews", {}],
      ["/api/review/findings/1/resolve", { by: "worker-x", status: "fixed" }],
      ["/api/review/holds/1/release", { by: "worker-x" }],
    ];
    for (const [url, payload] of tries) {
      const res = await server.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect(manager.get).not.toHaveBeenCalled();
    await server.close();
  });
});
