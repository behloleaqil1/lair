/**
 * The bus consumers (bus PR 2a): the marker, the event validators, the
 * bus.consume switch, and the dispatch of the server's bus events. The
 * events are the ones BusService really emits, over a real EventBus and a
 * real bus store in a temp dir. What fill and the planner do with a report
 * is tested through their own entry points (agents/acceptance.test.ts,
 * planner/planner.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import type { Event } from "../../shared/server-types.js";
import { BusService } from "./service.js";
import { BusStore } from "./store.js";
import type { BusTokenBinding } from "./tokens.js";
import {
  BusConsumers,
  eventMismatch,
  extractBusId,
  isMirrorOf,
  stripBusMarker,
  structuredReport,
  validateBusMessageEvent,
  validateBusReportEvent,
  type BusConsumeMode,
  type StructuredReport,
} from "./consumers.js";
import { parseBusConfig } from "./config.js";

const PROJECT = "demo";
const NOW = Date.parse("2026-03-02T12:00:00.000Z");

let dir: string;
let store: BusStore;
let events: EventBus;
let service: BusService;
/** The task each run holds (the agents module's claims, as BusService asks) */
let claims: Map<string, string>;
let emitted: Event[];

const binding = (agent: string, runId: string): BusTokenBinding => ({ project: PROJECT, agent, runId, tokenHash: `hash-${runId}`, issuedAt: NOW });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lair-bus-consumers-"));
  store = new BusStore(PROJECT, join(dir, "bus", `${PROJECT}.db`));
  events = new EventBus();
  emitted = [];
  events.on("*", (event) => {
    emitted.push(event);
  });
  claims = new Map([["run-1", "feat-login"]]);
  service = new BusService({
    store,
    getClaimedTask: (runId) => claims.get(runId) ?? null,
    getAllClaims: () => [],
    getKnownAgents: () => [],
    mirrorConfig: { queueFile: join(dir, "queue.md") },
    events,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A report as an agent posts it (POST /api/bus/call runs BusService.report): its id */
async function report(kind: "DONE" | "WAITING" | "BLOCKED" | "PROGRESS" | "TICK", options: { gate?: string; pr?: number; sha?: string } = {}): Promise<number> {
  const result = await service.report(binding("worker-a", "run-1"), kind, "feat-login", "the summary", options.gate, options.pr, options.sha);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.id;
}

/** The data of the last event of this type BusService emitted */
function lastData(type: string): Record<string, unknown> {
  const event = emitted.filter((e) => e.type === type).at(-1);
  if (!event) throw new Error(`no ${type} event`);
  return event.data;
}

/** Let the event bus's handlers run (BusService doesn't await its emit) */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Calls {
  reports: StructuredReport[];
  messages: string[];
  runsEnded: string[];
  warnings: string[];
  storeReads: number[][];
}

function consumers(mode: BusConsumeMode, problem: (report: StructuredReport) => string | null = () => null): { bus: BusConsumers; calls: Calls } {
  const calls: Calls = { reports: [], messages: [], runsEnded: [], warnings: [], storeReads: [] };
  const bus = new BusConsumers({
    events,
    clock: { now: () => NOW },
    reports: (project, ids) => {
      calls.storeReads.push(ids);
      return project === PROJECT ? store.getReports(ids).map(structuredReport) : [];
    },
    problem: (_project, r) => problem(r),
    onReport: (project, r) => {
      if (project === PROJECT) calls.reports.push(r);
    },
    onMessage: (project, m) => {
      calls.messages.push(`${project}:${m.from}->${m.to}`);
    },
    onRunEnded: (project) => {
      calls.runsEnded.push(project);
    },
    warn: (text) => calls.warnings.push(text),
  });
  bus.setMode(PROJECT, mode);
  bus.start();
  return { bus, calls };
}

// ============ THE MARKER ============

describe("the bus marker on mirrored lines", () => {
  it("reads the id the mirror ends a line with, and only there", async () => {
    const id = await report("DONE", { gate: "gate-7", pr: 42, sha: "deadbeefcafe" });
    const line = readFileSync(join(dir, "queue.md"), "utf-8").trim();
    expect(line).toMatch(/PR #42 \[deadbee\] \[bus:\d+\]$/);
    expect(extractBusId(line)).toBe(id);
    expect(stripBusMarker(line)).toMatch(/PR #42 \[deadbee\]$/);
    // A marker the agent wrote into its summary is not the line's
    expect(extractBusId("- DONE feat-login by worker-a 12:00Z: see [bus:7] for details")).toBeNull();
    // Not a report id: zero, leading zeros, no digits
    expect(extractBusId("- DONE x by a 12:00Z: y [bus:0]")).toBeNull();
    expect(extractBusId("- DONE x by a 12:00Z: y [bus:007]")).toBeNull();
    expect(extractBusId("- DONE x by a 12:00Z: y [bus:]")).toBeNull();
    expect(extractBusId("- DONE x by a 12:00Z: y")).toBeNull();
  });

  it("tells the mirror's line for a report from a hand-written line that ends with its marker", async () => {
    const id = await report("BLOCKED");
    const line = readFileSync(join(dir, "queue.md"), "utf-8").trim();
    const stored = structuredReport(store.getReport(id)!);
    expect(isMirrorOf(line, stored)).toBe(true);
    expect(isMirrorOf(`- DONE feat-login by worker-a 12:00Z: done [bus:${id}]`, stored)).toBe(false);
    expect(isMirrorOf(`- BLOCKED feat-search by worker-a 12:00Z: x [bus:${id}]`, stored)).toBe(false);
    expect(isMirrorOf(`- BLOCKED feat-login by worker-b 12:00Z: x [bus:${id}]`, stored)).toBe(false);
  });
});

// ============ VALIDATION ============

describe("bus event validation: every field checked, a refusal has its reason", () => {
  it("accepts the report events BusService emits, for every kind", async () => {
    for (const kind of ["DONE", "WAITING", "BLOCKED", "PROGRESS", "TICK"] as const) {
      await report(kind, { gate: "gate-1", pr: 7, sha: "abc1234" });
      const checked = validateBusReportEvent(lastData("bus.report"));
      expect(checked).toMatchObject({ ok: true, value: { project: PROJECT, agent: "worker-a", kind, task: "feat-login", gateId: "gate-1", pr: 7, sha: "abc1234" } });
    }
    await report("DONE");
    expect(validateBusReportEvent(lastData("bus.report"))).toMatchObject({ ok: true, value: { kind: "DONE" } });
  });

  it.each([
    ["no data object", null, "no data object"],
    ["an array", [], "no data object"],
    ["no project", { id: 1, agent: "worker-a", kind: "DONE", task: "t" }, "project"],
    ["a string id", { project: PROJECT, id: "1", agent: "worker-a", kind: "DONE", task: "t" }, "id"],
    ["id 0", { project: PROJECT, id: 0, agent: "worker-a", kind: "DONE", task: "t" }, "id"],
    ["a fractional id", { project: PROJECT, id: 1.5, agent: "worker-a", kind: "DONE", task: "t" }, "id"],
    ["an agent id with a space", { project: PROJECT, id: 1, agent: "worker a", kind: "DONE", task: "t" }, "agent"],
    ["an unknown kind", { project: PROJECT, id: 1, agent: "worker-a", kind: "FINISHED", task: "t" }, "kind"],
    ["a lower-case kind", { project: PROJECT, id: 1, agent: "worker-a", kind: "done", task: "t" }, "kind"],
    ["a task id with ..", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: "a/../b" }, "task"],
    ["a numeric task", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: 5 }, "task"],
    ["an empty gate id", { project: PROJECT, id: 1, agent: "worker-a", kind: "WAITING", task: "t", gateId: "" }, "gateId"],
    ["a numeric gate id", { project: PROJECT, id: 1, agent: "worker-a", kind: "WAITING", task: "t", gateId: 5 }, "gateId"],
    ["a negative PR", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: "t", pr: -2 }, "pr"],
    ["a PR as a string", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: "t", pr: "42" }, "pr"],
    ["a sha that isn't hex", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: "t", sha: "main" }, "sha"],
    ["a sha longer than 64", { project: PROJECT, id: 1, agent: "worker-a", kind: "DONE", task: "t", sha: "a".repeat(65) }, "sha"],
  ])("refuses a report event with %s", (_name, data, field) => {
    const checked = validateBusReportEvent(data);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain(field);
  });

  it("accepts the message events BusService emits, and refuses each bad field with its reason", async () => {
    await service.send(binding("worker-a", "run-1"), "orchestrator", "I need the staging password", 3);
    expect(validateBusMessageEvent(lastData("bus.message"))).toMatchObject({ ok: true, value: { project: PROJECT, from: "worker-a", to: "orchestrator", priority: 3 } });
    await service.sendFromOwner("worker-a", "go on");
    expect(validateBusMessageEvent(lastData("bus.message"))).toMatchObject({ ok: true, value: { from: "owner", to: "worker-a", priority: 5 } });
    const good = { project: PROJECT, id: "m1", from: "worker-a", to: "orchestrator", priority: 5 };
    const bad: [Record<string, unknown>, string][] = [
      [{ ...good, id: 7 }, "id"],
      [{ ...good, id: "x".repeat(21) }, "id"],
      [{ ...good, from: "" }, "from"],
      [{ ...good, to: undefined }, "to"],
      [{ ...good, priority: 11 }, "priority"],
      [{ ...good, priority: "5" }, "priority"],
    ];
    for (const [data, field] of bad) {
      const checked = validateBusMessageEvent(data);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toContain(field);
    }
  });

  it("finds an event that doesn't match the report the bus stored under its id", async () => {
    const id = await report("WAITING", { gate: "gate-1" });
    const stored = structuredReport(store.getReport(id)!);
    const event = { project: PROJECT, id, agent: "worker-a", kind: "WAITING" as const, task: "feat-login", gateId: "gate-1" };
    expect(eventMismatch(event, stored)).toBeNull();
    expect(eventMismatch({ ...event, kind: "DONE" }, stored)).toContain(`report ${id} as stored`);
    expect(eventMismatch({ ...event, task: "feat-search" }, stored)).toContain(`report ${id} as stored`);
    expect(eventMismatch({ ...event, gateId: "gate-2" }, stored)).toContain("gate, PR or sha");
    expect(eventMismatch({ ...event, id: 999 }, null)).toBe("the bus store has no report 999");
  });
});

// ============ CONFIG ============

describe("bus.consume", () => {
  it("is off without a bus block, and takes off, observe or on", async () => {
    expect(parseBusConfig(undefined)).toEqual({ ok: true, settings: { consume: "off" } });
    expect(parseBusConfig({})).toEqual({ ok: true, settings: { consume: "off" } });
    for (const consume of ["off", "observe", "on"]) expect(parseBusConfig({ consume })).toEqual({ ok: true, settings: { consume } });
  });

  it("refuses another value, an unknown key and a block that isn't a mapping, with the reason", async () => {
    expect(parseBusConfig({ consume: "yes" })).toEqual({ ok: false, errors: ['bus.consume must be one of off, observe, on; got "yes"'] });
    expect(parseBusConfig({ consume: true })).toMatchObject({ ok: false });
    expect(parseBusConfig({ consum: "on" })).toEqual({ ok: false, errors: ["bus.consum is not a known key (known: consume)"] });
    expect(parseBusConfig("on")).toEqual({ ok: false, errors: ["bus must be a mapping"] });
    expect(parseBusConfig(["on"])).toEqual({ ok: false, errors: ["bus must be a mapping"] });
  });
});

// ============ DISPATCH ============

describe("BusConsumers: one subscription for the server, dispatched by project", () => {
  it("subscribes once per event type, however many projects there are", async () => {
    let subscriptions = 0;
    const counting = new EventBus();
    const on = counting.on.bind(counting);
    counting.on = (type, handler) => {
      subscriptions++;
      return on(type, handler);
    };
    const bus = new BusConsumers({ events: counting, clock: { now: () => NOW }, reports: () => [], onReport: () => {}, onMessage: () => {}, onRunEnded: () => {} });
    for (let i = 0; i < 20; i++) bus.setMode(`p${i}`, i % 2 === 0 ? "on" : "observe");
    bus.start();
    bus.start();
    expect(subscriptions).toBe(3); // bus.report, bus.message, agent.run.ended
    bus.stop();
  });

  it("on: a valid DONE, WAITING or BLOCKED report wakes the modules once, with the report as stored", async () => {
    const { calls } = consumers("on");
    const done = await report("DONE", { pr: 42, sha: "abc1234" });
    const waiting = await report("WAITING", { gate: "gate-1" });
    const blocked = await report("BLOCKED");
    await settle();
    expect(calls.reports.map((r) => [r.id, r.kind, r.task, r.agent])).toEqual([
      [done, "DONE", "feat-login", "worker-a"],
      [waiting, "WAITING", "feat-login", "worker-a"],
      [blocked, "BLOCKED", "feat-login", "worker-a"],
    ]);
    expect(calls.reports[0]).toMatchObject({ pr: 42, sha: "abc1234", runId: "run-1", summary: "the summary" });
    expect(calls.reports[1].gateId).toBe("gate-1");
  });

  it("on: PROGRESS and TICK reports are received but wake nothing (they change no state)", async () => {
    const { bus, calls } = consumers("on");
    await report("PROGRESS");
    await report("TICK");
    await settle();
    expect(calls.reports).toEqual([]);
    expect(bus.health(PROJECT)).toMatchObject({ received: 2, refusedCount: 0 });
  });

  it("observe and off: a report wakes nothing", async () => {
    for (const mode of ["observe", "off"] as const) {
      const { bus, calls } = consumers(mode);
      await report("DONE");
      await settle();
      expect(calls.reports).toEqual([]);
      expect(bus.health(PROJECT).received).toBe(mode === "observe" ? 1 : 0);
      bus.stop();
    }
  });

  it("refuses an invalid event with its reason: logged, on Health, and emitted; nothing is woken", async () => {
    const { bus, calls } = consumers("on");
    await events.emit("bus.report", { project: PROJECT, id: 3, agent: "worker-a", kind: "FINISHED", task: "feat-login" });
    expect(calls.reports).toEqual([]);
    const health = bus.health(PROJECT);
    expect(health.refused).toEqual([{ at: new Date(NOW).toISOString(), busId: 3, reason: "bus.report refused: kind is not one of WAITING, DONE, BLOCKED, PROGRESS, TICK" }]);
    expect(calls.warnings).toEqual(["[bus-consumers] demo: report 3: bus.report refused: kind is not one of WAITING, DONE, BLOCKED, PROGRESS, TICK"]);
    expect(lastData("bus.consume_refused")).toEqual({ project: PROJECT, busId: 3, reason: health.refused[0].reason });
    // The same event again is not audited twice
    await events.emit("bus.report", { project: PROJECT, id: 3, agent: "worker-a", kind: "FINISHED", task: "feat-login" });
    expect(bus.health(PROJECT).refusedCount).toBe(1);
  });

  it("refuses an event that doesn't match the bus store (no such report, or other fields)", async () => {
    const { bus, calls } = consumers("on");
    const id = await report("DONE");
    await settle();
    calls.reports.length = 0;
    await events.emit("bus.report", { project: PROJECT, id: id + 100, agent: "worker-a", kind: "DONE", task: "feat-login" });
    await events.emit("bus.report", { project: PROJECT, id, agent: "worker-a", kind: "BLOCKED", task: "feat-login" });
    expect(calls.reports).toEqual([]);
    expect(bus.health(PROJECT).refused.map((r) => r.reason)).toEqual([
      `bus.report refused: the event does not match report ${id} as stored (DONE feat-login by worker-a)`,
      `bus.report refused: the bus store has no report ${id + 100}`,
    ]);
  });

  it("ignores, and audits, a report for a task or agent no module knows: nothing is woken for it", async () => {
    const { bus, calls } = consumers("on", (r) => (r.task === "feat-login" ? "task feat-login is not in agents.fill.tasks_file: fill ignores the report" : null));
    const id = await report("DONE");
    await settle();
    expect(calls.reports).toEqual([]);
    expect(bus.health(PROJECT).refused).toEqual([
      { at: new Date(NOW).toISOString(), busId: id, reason: "bus.report ignored: task feat-login is not in agents.fill.tasks_file: fill ignores the report" },
    ]);
  });

  it("ignores events of other projects, and events that name none", async () => {
    const { bus, calls } = consumers("on");
    await events.emit("bus.report", { project: "other", id: 1, agent: "worker-a", kind: "DONE", task: "feat-login" });
    await events.emit("bus.report", { id: 1, agent: "worker-a", kind: "DONE", task: "feat-login" });
    expect(calls.reports).toEqual([]);
    expect(bus.health(PROJECT).refusedCount).toBe(0);
    expect(calls.warnings).toEqual(["[bus-consumers] a bus.report event was refused: it names no project"]);
  });

  it("on: a message to the orchestrator wakes the planner; one to an agent doesn't", async () => {
    const { calls } = consumers("on");
    await service.send(binding("worker-a", "run-1"), "orchestrator", "need a decision");
    await service.sendFromOwner("worker-a", "go on");
    await settle();
    expect(calls.messages).toEqual(["demo:worker-a->orchestrator"]);
  });

  it("on: a run that ended wakes fill (its last report is read at once); observe and off don't", async () => {
    const { bus, calls } = consumers("on");
    await events.emit("agent.run.ended", { project: PROJECT, kind: "completed", runId: "run-1" });
    expect(calls.runsEnded).toEqual([PROJECT]);
    bus.setMode(PROJECT, "observe");
    await events.emit("agent.run.ended", { project: PROJECT, kind: "completed", runId: "run-1" });
    bus.setMode(PROJECT, "off");
    await events.emit("agent.run.ended", { project: PROJECT, kind: "completed", runId: "run-1" });
    expect(calls.runsEnded).toEqual([PROJECT]);
  });

  it("stop() unsubscribes: nothing is woken after it", async () => {
    const { bus, calls } = consumers("on");
    bus.stop();
    await report("DONE");
    await settle();
    expect(calls.reports).toEqual([]);
  });
});

describe("BusConsumers.lineSource: the bus as fill and the planner read it", () => {
  it("is null while off, and follows the mode", async () => {
    const { bus } = consumers("off");
    expect(bus.lineSource(PROJECT)).toBeNull();
    bus.setMode(PROJECT, "observe");
    expect(bus.lineSource(PROJECT)?.mode).toBe("observe");
    bus.setMode(PROJECT, "on");
    expect(bus.lineSource(PROJECT)?.mode).toBe("on");
    expect(bus.lineSource("unknown")).toBeNull();
    expect(bus.enabled()).toEqual([PROJECT]);
  });

  it("reads each report from the store once, in one read for many ids", async () => {
    // Filed before the consumers start: no event of theirs has read them yet
    const a = await report("DONE");
    const b = await report("BLOCKED");
    const { bus, calls } = consumers("on");
    const source = bus.lineSource(PROJECT)!;
    expect([...source.reports([a, b, 999]).keys()]).toEqual([a, b]);
    expect([...source.reports([a, b]).keys()]).toEqual([a, b]);
    expect(calls.storeReads).toEqual([[a, b, 999]]);
    expect(source.reports([999]).size).toBe(0);
    expect(calls.storeReads).toEqual([[a, b, 999], [999]]);
  });

  it("a store that can't be read gives no reports (lines are read as hand-written), and says why", async () => {
    const warnings: string[] = [];
    const bus = new BusConsumers({
      events,
      clock: { now: () => NOW },
      reports: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      onReport: () => {},
      onMessage: () => {},
      onRunEnded: () => {},
      warn: (text) => warnings.push(text),
    });
    bus.setMode(PROJECT, "on");
    expect(bus.lineSource(PROJECT)!.reports([1]).size).toBe(0);
    expect(warnings).toEqual(["[bus-consumers] demo: the bus store could not be read: SQLITE_BUSY: database is locked"]);
  });

  it("observe: keeps what both readings made of each report once (in memory), and counts the differences", async () => {
    const { bus } = consumers("observe");
    const source = bus.lineSource(PROJECT)!;
    source.observed({ consumer: "fill", busId: 1, task: "t", agent: "a", report: "done", file: "done" });
    source.observed({ consumer: "fill", busId: 2, task: "t", agent: "a", report: "waiting on gate-1", file: "waiting on (nothing named)" });
    source.observed({ consumer: "fill", busId: 2, task: "t", agent: "a", report: "waiting on gate-1", file: "done" });
    source.observed({ consumer: "planner", busId: 2, task: "t", agent: "a", report: "WAITING t by a", file: "WAITING t by a" });
    const health = bus.health(PROJECT);
    expect(health.observations).toMatchObject({ total: 3, matches: 2, mismatches: 1 });
    expect(health.observations.recent).toEqual([
      { consumer: "fill", busId: 2, task: "t", agent: "a", report: "waiting on gate-1", file: "waiting on (nothing named)", at: new Date(NOW).toISOString(), match: false },
    ]);
    // On mode records none
    bus.setMode(PROJECT, "on");
    bus.lineSource(PROJECT)!.observed({ consumer: "fill", busId: 3, task: "t", agent: "a", report: "done", file: "blocked" });
    expect(bus.health(PROJECT).observations.total).toBe(0);
  });

  it("audits a module's ignored report once per reason", async () => {
    const { bus } = consumers("on");
    const source = bus.lineSource(PROJECT)!;
    source.ignored(4, "a queue line ends with this report's marker, but the bus store has no such report: read as a hand-written line");
    source.ignored(4, "a queue line ends with this report's marker, but the bus store has no such report: read as a hand-written line");
    expect(bus.health(PROJECT)).toMatchObject({ refusedCount: 1, refused: [{ busId: 4 }] });
  });

  it("health is off with nothing for a project it doesn't know", async () => {
    const { bus } = consumers("on");
    expect(bus.health("unknown")).toEqual({ mode: "off", received: 0, refused: [], refusedCount: 0, observations: { total: 0, matches: 0, mismatches: 0, recent: [] } });
  });
});
