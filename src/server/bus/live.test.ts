/**
 * The bus live on the dashboard's `bus` WebSocket channel (live.ts). The agent side goes through the real entry
 * point, POST /api/bus/call with the run's bus token (report, send, inbox, ack); the owner's message through
 * BusService.sendFromOwner as POST /api/bus/send runs it; claims are the agents module's events with the payload it
 * emits (agents/service.ts record()). The one fake boundary is the agents module (the run and its claim). Every
 * update is checked for the token and the message texts: the socket carries no owner session.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth } from "../human-auth/index.js";
import { LairWebSocketServer } from "../websocket.js";
import { busStoreFor, forgetBusService, registerBusRoutes } from "../routes/bus.js";
import type { AgentsManager } from "../agents/index.js";
import type { ProjectConfig } from "../../shared/types.js";
import type { BusLiveUpdate } from "../../shared/bus-live.js";
import { BusService } from "./service.js";
import { closeBusStores } from "./store.js";
import { hashBusToken, newBusToken } from "./tokens.js";
import { BUS_LIVE_MAX_BATCH, BusLive, liveEvents } from "./live.js";
import type { BusConsumeMode } from "./consumers.js";

const PROJECT = "demo";
const RUN = "run-0001";
const AGENT = "worker-a";
const TASK = "feat-login";
const AGENT_TEXT = "a private question for the owner";
const OWNER_TEXT = "a private instruction for the agent";
const ACK_NOTE = "a private ack note";

let dir: string;
let events: EventBus;
let mode: BusConsumeMode;
let published: { project: string; update: BusLiveUpdate }[];
let live: BusLive;
let app: FastifyInstance;
let token: string;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agents module, faked: one running run of AGENT holding TASK */
const agents = {
  get: () => ({}),
  getStore: () => ({
    getRun: (id: string) => (id === RUN ? { id: RUN, project: PROJECT, agent: AGENT, task: TASK, state: "running" } : null),
    listClaims: () => [{ project: PROJECT, task: TASK, runId: RUN, agent: AGENT, claimedAt: 0 }],
    runAgents: () => [AGENT],
  }),
} as unknown as AgentsManager;

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/bus/call", headers: { authorization: `Bearer ${token}` }, payload: { tool, args } });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

function allPublished(): string {
  return JSON.stringify(published);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lair-bus-live-"));
  events = new EventBus();
  mode = "observe";
  published = [];
  live = new BusLive({ events, mode: () => mode, publish: (project, update) => published.push({ project, update }), quietMs: 5, maxWaitMs: 20 });
  live.start();
  app = Fastify({ logger: false });
  const auth = HumanAuth.open({ tokenPath: join(dir, "owner.token"), dbPath: ":memory:" });
  await registerBusRoutes(app, auth, {
    agents,
    events,
    dataDir: dir,
    getConfig: () => ({ queue_file: join(dir, "queue.md") }) as unknown as ProjectConfig,
    mode: () => mode,
    enabled: () => [PROJECT],
    health: () => ({ mode, received: 0, refused: [], refusedCount: 0, observations: { total: 0, matches: 0, mismatches: 0, recent: [] } }),
  });
  await app.ready();
  token = newBusToken();
  busStoreFor(PROJECT, dir).issueToken(AGENT, RUN, hashBusToken(token), Date.now());
});

afterEach(async () => {
  live.stop();
  await app.close();
  forgetBusService(PROJECT);
  closeBusStores();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => closeBusStores());

describe("bus live: what each bus action publishes", () => {
  it("a report: its fields and its summary cut to 500 characters, as one update on the project's channel", async () => {
    const summary = `ready for review ${"y".repeat(800)}`;
    const { id } = await call("report", { kind: "WAITING", task: TASK, summary, gate_id: "gate-42", pr: 7, sha: "abc1234" });
    await settle();
    expect(published).toEqual([
      {
        project: PROJECT,
        update: {
          dropped: 0,
          events: [
            { type: "report", id, at: expect.any(String), agent: AGENT, task: TASK, kind: "WAITING", summary: summary.slice(0, 500), gateId: "gate-42", pr: 7, sha: "abc1234" },
          ],
        },
      },
    ]);
  });

  it("messages: sent, read and acknowledged as metadata only, never a text, an ack note or the token", async () => {
    await call("send", { to: "owner", text: AGENT_TEXT });
    const owner = new BusService({ store: busStoreFor(PROJECT, dir), getClaimedTask: () => null, getAllClaims: () => [], getKnownAgents: () => [], events });
    const sent = await owner.sendFromOwner(AGENT, OWNER_TEXT);
    if (!sent.ok) throw new Error(sent.error.message);
    const messageId = sent.data.messageId;
    const inbox = await call("inbox");
    expect(inbox.map((m: { text: string }) => m.text)).toEqual([OWNER_TEXT]);
    await call("ack", { message_id: messageId, note: ACK_NOTE });
    await settle();

    const all = published.flatMap((p) => p.update.events);
    expect(all).toEqual([
      { type: "message", id: expect.any(String), at: expect.any(String), from: AGENT, to: "owner", state: "sent" },
      { type: "message", id: messageId, at: expect.any(String), from: "owner", to: AGENT, state: "sent" },
      { type: "message", id: messageId, at: expect.any(String), to: AGENT, state: "read" },
      { type: "message", id: messageId, at: expect.any(String), to: AGENT, state: "acknowledged" },
    ]);
    const text = allPublished();
    for (const secret of [AGENT_TEXT, OWNER_TEXT, ACK_NOTE, token, hashBusToken(token)]) expect(text).not.toContain(secret);
  });

  it("an ack of a message already acknowledged, or not the agent's, publishes nothing more", async () => {
    const owner = new BusService({ store: busStoreFor(PROJECT, dir), getClaimedTask: () => null, getAllClaims: () => [], getKnownAgents: () => [], events });
    const sent = await owner.sendFromOwner(AGENT, OWNER_TEXT);
    if (!sent.ok) throw new Error(sent.error.message);
    await call("ack", { message_id: sent.data.messageId });
    await call("ack", { message_id: sent.data.messageId });
    await settle();
    expect(published.flatMap((p) => p.update.events).filter((e) => e.type === "message" && e.state === "acknowledged")).toHaveLength(1);
  });

  it("claims: taken when a run starts, released when it ends or its claim is released; no run summary", async () => {
    // As agents/service.ts record() emits them
    const base = { project: PROJECT, agent: AGENT, task: TASK, runId: RUN, subject: null };
    await events.emit("agent.run.started", { ...base, kind: "started", eventId: "e1", summary: `started ${AGENT} on ${TASK} as pid 4242` });
    await events.emit("agent.run.ended", { ...base, kind: "completed", eventId: "e2", summary: `${AGENT} finished ${TASK}: exited 0` });
    await events.emit("agent.claim.released", { ...base, kind: "claim_released", eventId: "e3", summary: "released by the owner" });
    await settle();
    expect(published).toHaveLength(1);
    expect(published[0].update.events).toEqual([
      { type: "claim", at: expect.any(String), agent: AGENT, task: TASK, claim: "taken" },
      { type: "claim", at: expect.any(String), agent: AGENT, task: TASK, claim: "released" },
      { type: "claim", at: expect.any(String), agent: AGENT, task: TASK, claim: "released" },
    ]);
    expect(allPublished()).not.toContain("pid 4242");
  });

  it("publishes nothing while the project's bus.consume is off", async () => {
    await call("report", { kind: "DONE", task: TASK, summary: "done" });
    mode = "off";
    await events.emit("agent.run.started", { project: PROJECT, agent: AGENT, task: TASK });
    await events.emit("bus.message", { project: PROJECT, id: "m1", from: "owner", to: AGENT, priority: 5 });
    await settle();
    expect(published.flatMap((p) => p.update.events).map((e) => e.type)).toEqual(["report"]);
  });

  it("coalesces a burst into one bounded update and counts what it dropped", async () => {
    for (let i = 0; i < 120; i++) {
      await events.emit("bus.report", { project: PROJECT, id: i + 1, agent: AGENT, kind: "PROGRESS", task: TASK, summary: `step ${i}` });
    }
    await settle(60);
    const updates = published.map((p) => p.update);
    expect(updates.reduce((n, u) => n + u.events.length + u.dropped, 0)).toBe(120);
    for (const u of updates) expect(u.events.length).toBeLessThanOrEqual(BUS_LIVE_MAX_BATCH);
    expect(updates.at(-1)!.events.at(-1)).toMatchObject({ id: 120 });
  });

  it("drops an event whose fields don't check (no project, a bad kind, an id list that isn't one)", () => {
    const at = new Date().toISOString();
    const ev = (type: string, data: Record<string, unknown>) => ({ id: "x", type, timestamp: at, data }) as Parameters<typeof liveEvents>[0];
    expect(liveEvents(ev("bus.report", { id: 1, agent: AGENT, kind: "DONE", task: TASK }))).toBeNull();
    expect(liveEvents(ev("bus.report", { project: PROJECT, id: 1, agent: AGENT, kind: "MERGED", task: TASK }))).toBeNull();
    expect(liveEvents(ev("bus.message_read", { project: PROJECT, agent: AGENT, ids: "m1" }))).toBeNull();
    expect(liveEvents(ev("agent.run.started", { project: PROJECT, agent: AGENT }))).toBeNull();
    expect(liveEvents(ev("gate.completed", { project: PROJECT }))).toBeNull();
  });
});

describe("bus live: over the real WebSocket server", () => {
  it("reaches the project's `bus` subscribers only", async () => {
    const server = Fastify({ logger: false });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const ws = new LairWebSocketServer(server.server);
    const port = (server.server.address() as AddressInfo).port;
    live.stop();
    live = new BusLive({ events, mode: () => "on", publish: (project, update) => ws.broadcast("bus", update, { project }), quietMs: 5 });
    live.start();
    const open = async (project: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?project=${project}`);
      const got: { type: string; channel?: string; data?: BusLiveUpdate }[] = [];
      socket.on("message", (raw) => got.push(JSON.parse(raw.toString())));
      await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
      socket.send(JSON.stringify({ type: "subscribe", channels: ["bus"] }));
      return { socket, got };
    };
    const ours = await open(PROJECT);
    const other = await open("elsewhere");
    try {
      await settle();
      expect(ours.got.find((m) => m.type === "subscribed")).toMatchObject({ channels: ["bus"] });
      await call("report", { kind: "DONE", task: TASK, summary: "merged", pr: 9 });
      await settle(50);
      const updates = ours.got.filter((m) => m.type === "update");
      expect(updates).toMatchObject([{ channel: "bus", data: { events: [{ type: "report", kind: "DONE", pr: 9 }], dropped: 0 } }]);
      expect(other.got.filter((m) => m.type === "update")).toEqual([]);
    } finally {
      ours.socket.close();
      other.socket.close();
      ws.close();
      await server.close();
    }
  });
});
