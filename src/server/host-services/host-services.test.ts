/**
 * Host services, end to end through the real module: HostServicesManager and
 * its store (with its file), the real Decision Inbox, the real event bus,
 * the routes with the real owner auth, the config reloader as the server
 * wires it, and the pipeline manager that asks for lane holds.
 *
 * One boundary is faked at a time: the command runner (FakeRunner answers
 * the probe and start commands of a scripted world) with a clock; or the
 * real ExecFileRunner runs real processes (hung probes, a probe that ignores
 * SIGTERM, a start that must not run).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { stringify } from "yaml";
import type { Decision } from "../../shared/decision-types.js";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { HumanAuth, OWNER_ONLY_PREFIXES, OWNER_SESSION_HEADER, isUnder } from "../human-auth/index.js";
import { loadProjectConfig } from "../config.js";
import { ConfigReloader, serverModules } from "../reload/index.js";
import { PipelineManager } from "../gates/pipeline-service.js";
import {
  FakeCapacity,
  FakeClock as PipelineClock,
  FakeGitHub,
  FakeSpawner,
  SHA,
  projectConfig as pipelineProjectConfig,
} from "../gates/testing/fakes.js";
import { parseHostServicesConfig } from "./config.js";
import { ExecFileRunner, type Clock, type CommandOutput, type CommandRunner, type RunOptions } from "./probes.js";
import { OWNER_PREFIX, registerHostServicesRoutes } from "./routes.js";
import { HostServicesManager, type HostServices } from "./service.js";
import { STORE_VERSION } from "./store.js";
import type { ServiceStatus } from "./types.js";

const PROJECT = "demo";
const M = "build-1";
const T0 = Date.parse("2026-03-02T12:00:00.000Z");
const S = 1000;
const quiet = { log: () => undefined, warn: () => undefined };
/** What the fake probe and start print, and what their argv carries: neither may leave the module */
const SECRET = "SECRET-VALUE";
const probeArgv = (svc: string) => ["probe-tool", svc, `--token=${SECRET}`];
const startArgv = (svc: string) => ["start-tool", svc, `--token=${SECRET}`];

// ============ BOUNDARY FAKES ============

class FakeClock implements Clock {
  t = T0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    this.t += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Answer = "up" | "down" | "timeout";

/** One service of the scripted world. */
class FakeService {
  /** What its probe answers now */
  answer: Answer = "down";
  /** The start command's exit code */
  startExit = 0;
  /** After a start that exits 0, it comes up this long after the start */
  upAfterMs = 0;
  /** After a start, it answers "up" to this many probes, then goes down by itself (flapping) */
  upProbesAfterStart = Infinity;
  pendingUpAt: number | null = null;
  upLeft = Infinity;
}

class FakeRunner implements CommandRunner {
  calls: { argv: string[]; at: number; timeoutMs?: number }[] = [];
  services = new Map<string, FakeService>();
  /** Starts wait until released (or killed by an abort) */
  blockStarts = false;
  abortedStarts: string[] = [];
  private releases: (() => void)[] = [];

  constructor(private clock: FakeClock) {}

  svc(name: string): FakeService {
    let s = this.services.get(name);
    if (!s) {
      s = new FakeService();
      this.services.set(name, s);
    }
    return s;
  }

  release(): void {
    for (const r of this.releases.splice(0)) r();
  }

  private probe(s: FakeService): Answer {
    if (s.pendingUpAt !== null && this.clock.now() >= s.pendingUpAt) {
      s.answer = "up";
      s.pendingUpAt = null;
      s.upLeft = s.upProbesAfterStart;
    }
    if (s.answer === "up") {
      if (s.upLeft <= 0) s.answer = "down";
      else s.upLeft--;
    }
    return s.answer;
  }

  async run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    this.calls.push({ argv: [...argv], at: this.clock.now(), timeoutMs: options.timeoutMs });
    const [tool, name] = argv;
    const s = this.svc(name ?? "");
    if (tool === "probe-tool") {
      const answer = this.probe(s);
      if (answer === "timeout") return { code: -1, stdout: `${SECRET} partial`, stderr: "", timedOut: true };
      return answer === "up"
        ? { code: 0, stdout: `${SECRET} ok`, stderr: "" }
        : { code: 1, stdout: "", stderr: `${SECRET}: cannot connect` };
    }
    if (tool === "start-tool") {
      if (this.blockStarts) {
        await new Promise<void>((resolve) => {
          this.releases.push(resolve);
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (options.signal?.aborted) {
        this.abortedStarts.push(name ?? "");
        return { code: -1, stdout: "", stderr: "stopped" };
      }
      if (s.startExit === 0) s.pendingUpAt = this.clock.now() + s.upAfterMs;
      return { code: s.startExit, stdout: "", stderr: s.startExit === 0 ? "" : `${SECRET} failed` };
    }
    return { code: 127, stdout: "", stderr: "unknown tool" };
  }

  starts(name = "docker"): number[] {
    return this.calls.filter((c) => c.argv[0] === "start-tool" && c.argv[1] === name).map((c) => c.at);
  }

  probes(name = "docker"): number {
    return this.calls.filter((c) => c.argv[0] === "probe-tool" && c.argv[1] === name).length;
  }
}

// ============ HELPERS ============

interface ServiceSpec {
  name: string;
  neededBy?: string[];
  probe?: string[];
  start?: string[];
}

function block(o: { mode?: "act" | "observe"; services?: ServiceSpec[]; settings?: Record<string, unknown> } = {}) {
  return {
    enabled: true,
    mode: o.mode ?? "act",
    interval_seconds: 60,
    probe_timeout_seconds: 5,
    start_timeout_seconds: 10,
    start_delay_seconds: 1,
    start_grace_seconds: 60,
    backoff_max_seconds: 600,
    stable_seconds: 300,
    max_start_attempts: 3,
    escalate_after_probes: 3,
    ...o.settings,
    machines: {
      [M]: (o.services ?? [{ name: "docker", neededBy: ["heavy"] }]).map((s) => ({
        name: s.name,
        probe: s.probe ?? probeArgv(s.name),
        start: s.start ?? startArgv(s.name),
        needed_by: s.neededBy ?? [],
      })),
    },
  };
}

function config(hostServices: unknown, extra: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: PROJECT,
    repo: "/srv/example-app",
    github: "example-org/example-app",
    queue_file: "/srv/example-app/queue.md",
    agents_dir: "/srv/example-app/agents",
    gates_dir: "/srv/example-app/gates",
    machines: {},
    host_services: hostServices as Record<string, unknown>,
    ...extra,
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The Decision Inbox, real, over an in-memory store (shared by "restarts" in one test) */
function inboxWith(clock: FakeClock, events: EventBus): DecisionInbox {
  const store = new DecisionStore(":memory:");
  cleanups.push(() => store.close());
  return new DecisionInbox({ store, secrets: new MemorySecretStore(), events, clock });
}

interface World {
  clock: FakeClock;
  runner: FakeRunner;
  events: EventBus;
  inbox: DecisionInbox;
}

function world(): World {
  const clock = new FakeClock();
  const events = new EventBus();
  return { clock, runner: new FakeRunner(clock), events, inbox: inboxWith(clock, events) };
}

interface Harness extends World {
  manager: HostServicesManager;
  svc(): HostServices;
  tick(): Promise<unknown>;
  status(name?: string): ServiceStatus;
  decisions(): Decision[];
  open(): Decision[];
  hostEvents(): { type: string; data: Record<string, unknown> }[];
}

/** A manager as the server builds it (one "Lair process"); `started` makes holds enforceable without timer ticks */
function harness(
  o: { cfg?: ProjectConfig; dataDir?: string; world?: World; started?: boolean; withDecisions?: boolean } = {},
): Harness {
  const w = o.world ?? world();
  const manager = new HostServicesManager({
    probes: { runner: w.runner, clock: w.clock },
    events: w.events,
    dataDir: o.dataDir,
    firstTickDelayMs: 1e9,
  });
  manager.load([{ name: PROJECT, config: o.cfg ?? config(block()) }]);
  if (o.withDecisions !== false) manager.useDecisions(w.inbox);
  if (o.started) manager.start();
  cleanups.push(() => manager.stop());
  return {
    ...w,
    manager,
    svc: () => manager.get(PROJECT)!,
    tick: () => manager.get(PROJECT)!.tick(),
    status: (name = "docker") => manager.status(PROJECT).services.get(M)!.find((s) => s.name === name)!,
    decisions: () => w.inbox.list({ project: PROJECT, status: "all" }),
    open: () => w.inbox.openOf(PROJECT, "host-services"),
    hostEvents: () =>
      w.events
        .getRecentEvents()
        .filter((e) => e.type.startsWith("host-service."))
        .map((e) => ({ type: e.type, data: e.data })),
  };
}

/** Tick, then let `ms` pass */
async function tickEvery(h: Harness, times: number, ms: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await h.tick();
    h.clock.advance(ms);
  }
}

async function waitFor(what: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ============ CONFIG ============

describe("config", () => {
  it("fills the defaults, including the backoff, the grace and the escalation keys", () => {
    const parsed = parseHostServicesConfig({ enabled: true, machines: { [M]: [{ name: "docker", probe: ["p"], start: ["s"] }] } });
    expect(parsed.ok && parsed.settings).toMatchObject({
      enabled: true,
      mode: "observe",
      intervalSeconds: 60,
      probeTimeoutSeconds: 15,
      startTimeoutSeconds: 30,
      startDelaySeconds: 10,
      startGraceSeconds: 120,
      backoffMaxSeconds: 1800,
      stableSeconds: 300,
      maxStartAttempts: 3,
      escalateAfterProbes: 5,
    });
    expect(parseHostServicesConfig(undefined)).toMatchObject({ ok: true, settings: { enabled: false } });
  });

  it("refuses a delay longer than the grace, duplicate names, bad names, shell strings and an empty enabled block", () => {
    const errors = (raw: unknown) => {
      const parsed = parseHostServicesConfig(raw);
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errors({ start_delay_seconds: 200, start_grace_seconds: 100 })).toEqual([
      "host_services.start_delay_seconds: must not be longer than start_grace_seconds",
    ]);
    const dup = { name: "docker", probe: ["p"], start: ["s"] };
    expect(errors({ machines: { [M]: [dup, dup] } })[0]).toContain('duplicate service name "docker"');
    expect(errors({ machines: { "bad machine": [] } })[0]).toMatch(/machine ids use a letter/);
    expect(errors({ machines: { [M]: [{ ...dup, name: "-x" }] } })[0]).toMatch(/service names use a letter/);
    expect(errors({ machines: { [M]: [{ ...dup, probe: "docker info" }] } })[0]).toMatch(/probe/);
    expect(errors({ machines: { [M]: [{ ...dup, needed_by: ["gate.default", "bad lane"] }] } })[0]).toMatch(/needed_by/);
    expect(errors({ enabled: true, machines: { [M]: [] } })).toEqual(["host_services is enabled but no machine has a service"]);
  });
});

// ============ PROBE, START AND BACKOFF (ACT MODE) ============

describe("act mode: probe and start", () => {
  it("starts a down service once, sees it come up, and emits each change once", async () => {
    const h = harness();
    const summaries = await h.tick();
    expect(summaries).toEqual([{ machine: M, at: new Date(T0).toISOString(), services: 1, up: 1, down: 0, started: 1, decisions: 0 }]);
    expect(h.runner.starts()).toEqual([T0]);
    expect(h.status()).toMatchObject({ state: "up", starts: 1, lastStart: { code: 0, timedOut: false } });
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60 * S);
      await h.tick();
    }
    expect(h.runner.starts()).toHaveLength(1);
    expect(h.hostEvents().map((e) => e.type)).toEqual(["host-service.down", "host-service.starting", "host-service.up"]);
    expect(h.hostEvents()[0].data).toEqual({ project: PROJECT, machine: M, service: "docker", cause: "probe_failed" });
  });

  it("gives a slow starter its grace window instead of a second start", async () => {
    const h = harness();
    h.runner.svc("docker").upAfterMs = 50 * S;
    await h.tick();
    expect(h.status()).toMatchObject({ state: "starting", starts: 1, holds: ["heavy"] });
    h.clock.advance(30 * S);
    await h.tick(); // 31 s after the start: still inside the 60 s grace
    expect(h.status().state).toBe("starting");
    h.clock.advance(30 * S);
    await h.tick(); // 61 s: it came up at 50 s
    expect(h.status().state).toBe("up");
    expect(h.runner.starts()).toEqual([T0]);
  });

  it("spaces starts that fail by a doubling backoff, then stops and raises one start_failed decision", async () => {
    const h = harness();
    h.runner.svc("docker").startExit = 1;
    await tickEvery(h, 40, 30 * S); // 20 minutes, a tick every 30 s
    // The start's own failure is not waited on; the backoff doubles from the 60 s grace
    expect(h.runner.starts()).toEqual([T0, T0 + 60 * S, T0 + 180 * S]);
    expect(h.status()).toMatchObject({ state: "failing", starts: 3, lastStart: { code: 1, timedOut: false }, nextStartAt: null });
    const decisions = h.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      status: "open",
      title: "docker on build-1 is down and Lair could not start it",
      key: `${M}:docker`,
      blocks: ["lane:heavy"],
      recommended: { optionId: "leave" },
      class: "host-services.service_down",
      evidence: { code: "start_failed", facts: { starts: 3, act: true } },
    });
    expect(decisions[0].options.map((o) => o.id)).toEqual(["retry", "leave"]);
    expect(decisions[0].context).toContain("`start-tool`");
    expect(JSON.stringify(decisions[0])).not.toContain(SECRET);
  });

  it("treats a timed-out probe as unknown: never up, never started, held, and one probe_timeout decision", async () => {
    const h = harness({ started: true });
    h.runner.svc("docker").answer = "timeout";
    await tickEvery(h, 2, 60 * S);
    expect(h.status()).toMatchObject({ state: "unknown", failedProbes: 2, lastProbe: { up: false, code: -1, timedOut: true } });
    expect(h.decisions()).toEqual([]);
    expect(h.manager.holdFor(PROJECT, ["heavy"])).toBe(`docker on build-1 does not answer its probe since ${new Date(T0).toISOString()}`);
    await tickEvery(h, 5, 60 * S);
    expect(h.runner.starts()).toEqual([]);
    expect(h.decisions()).toHaveLength(1);
    expect(h.decisions()[0]).toMatchObject({ evidence: { code: "probe_timeout" }, title: "docker on build-1 does not answer its probe" });
    // The hold began with the outage, not when it was asked about
    expect(h.svc().getHeldLanes()).toEqual([
      expect.objectContaining({ lane: "heavy", heldAt: new Date(T0).toISOString(), enforced: true }),
    ]);
  });
});

// ============ FLAPPING ============

/** A service that comes up after each start and dies before the next probe, driven to its decision */
async function flapToDecision(h: Harness): Promise<Decision> {
  h.runner.svc("docker").upProbesAfterStart = 1;
  await tickEvery(h, 12, 61 * S);
  const open = h.open();
  expect(open).toHaveLength(1);
  return open[0];
}

describe("a flapping service", () => {
  it("is started max_start_attempts times with a growing wait, then one flapping decision; its lanes follow each probe", async () => {
    const h = harness({ started: true });
    h.runner.svc("docker").upProbesAfterStart = 1;
    const held: (string | null)[] = [];
    for (let i = 0; i < 15; i++) {
      await h.tick();
      held.push(h.manager.holdFor(PROJECT, ["heavy"]));
      h.clock.advance(61 * S);
    }
    const starts = h.runner.starts();
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(60 * S);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(120 * S);
    const decisions = h.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ evidence: { code: "flapping" }, title: "docker on build-1 keeps going down after it starts" });
    expect(h.status().state).toBe("failing");
    // Released while up (right after each start), held while down
    expect(held[0]).toBeNull();
    expect(held.some((r) => r?.startsWith("docker on build-1 is down since"))).toBe(true);
    expect(held[14]).toMatch(/Lair stopped starting it after 3 start\(s\)$/);
  });

  it("answer retry: Lair starts it again", async () => {
    const h = harness();
    const decision = await flapToDecision(h);
    await h.inbox.answer(decision.id, { optionId: "retry" });
    expect(h.status()).toMatchObject({ starts: 0, state: "down", decisionId: null });
    h.clock.advance(61 * S);
    const before = h.runner.starts().length;
    await h.tick();
    expect(h.runner.starts()).toHaveLength(before + 1);
  });

  it("answer leave: no start and no new decision until it has stayed up; a stable recovery resets everything", async () => {
    const h = harness();
    const decision = await flapToDecision(h);
    await h.inbox.answer(decision.id, { optionId: "leave" });
    const before = h.runner.starts().length;
    await tickEvery(h, 10, 61 * S);
    expect(h.runner.starts()).toHaveLength(before);
    expect(h.decisions()).toHaveLength(1);

    // Someone fixed it: up, and it stays up
    const docker = h.runner.svc("docker");
    docker.answer = "up";
    docker.upLeft = Infinity;
    docker.upProbesAfterStart = Infinity;
    await tickEvery(h, 7, 60 * S);
    expect(h.status()).toMatchObject({ state: "up", starts: 0, failedProbes: 0 });

    // A new outage starts from the first start again
    docker.answer = "down";
    await h.tick();
    expect(h.runner.starts()).toHaveLength(before + 1);
  });

  it("withdraws its open decision once the service has stayed up for stable_seconds, not at the first good probe", async () => {
    const h = harness();
    const decision = await flapToDecision(h);
    const docker = h.runner.svc("docker");
    docker.answer = "up";
    docker.upLeft = Infinity;
    docker.upProbesAfterStart = Infinity;
    await h.tick();
    expect(h.status().state).toBe("up");
    expect(h.inbox.get(decision.id)?.status).toBe("open");
    await tickEvery(h, 6, 60 * S);
    expect(h.inbox.get(decision.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "docker on build-1 has stayed up for 5 minute(s)." });
    expect(h.status()).toMatchObject({ starts: 0, decisionId: null });
  });
});

// ============ OBSERVE MODE AND READ_ONLY ============

describe("no start path", () => {
  it("observe: starts nothing, enforces no hold, and asks once after escalate_after_probes failed probes", async () => {
    const h = harness({ cfg: config(block({ mode: "observe" })), started: true });
    await tickEvery(h, 2, 60 * S);
    expect(h.decisions()).toEqual([]);
    expect(h.manager.holdFor(PROJECT, ["heavy"])).toBeNull();
    expect(h.svc().getHeldLanes()).toEqual([expect.objectContaining({ lane: "heavy", enforced: false })]);
    await tickEvery(h, 4, 60 * S);
    expect(h.runner.starts()).toEqual([]);
    const decisions = h.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ evidence: { code: "not_started", facts: { act: false } }, blocks: [] });
    expect(decisions[0].context).toContain("Not acting: host_services.mode is observe.");
    expect(decisions[0].context).toContain("**Would be held in act mode:** heavy.");

    // "Ask again later": the count starts over; a second decision only after as many failures again
    await h.inbox.answer(decisions[0].id, { optionId: "retry" });
    await tickEvery(h, 2, 60 * S);
    expect(h.decisions()).toHaveLength(1);
    await h.tick();
    expect(h.decisions()).toHaveLength(2);
    expect(h.runner.starts()).toEqual([]);
  });

  it("act mode on a read_only project: starts nothing and says why", async () => {
    const h = harness({ cfg: config(block(), { read_only: true }) });
    await tickEvery(h, 3, 60 * S);
    expect(h.runner.starts()).toEqual([]);
    expect(h.decisions()[0].context).toContain("Not acting: the project is read_only.");
    expect(h.status().nextStartAt).toBeNull();
  });
});

// ============ RESTART AND RELOAD ============

describe("across restarts and reloads", () => {
  it("keeps the start count, the backoff and the open decision across a restart", async () => {
    const dataDir = tempDir("lair-host-services-");
    const w = world();
    w.runner.svc("docker").startExit = 1;
    const first = harness({ dataDir, world: w });
    await first.tick();
    await first.manager.stop();
    expect(JSON.parse(readFileSync(join(dataDir, "host-services", `${PROJECT}.json`), "utf8"))).toMatchObject({
      version: STORE_VERSION,
      services: [{ machine: M, name: "docker", starts: 1, state: "down" }],
    });

    // A new process 30 s later: the backoff from before the restart holds
    w.clock.advance(30 * S);
    const second = harness({ dataDir, world: w });
    await second.tick();
    expect(w.runner.starts()).toEqual([T0]);
    expect(second.status()).toMatchObject({ starts: 1, nextStartAt: new Date(T0 + 60 * S).toISOString() });
    w.clock.advance(30 * S);
    await tickEvery(second, 20, 30 * S);
    expect(w.runner.starts()).toEqual([T0, T0 + 60 * S, T0 + 180 * S]);
    expect(second.decisions()).toHaveLength(1);
    await second.manager.stop();

    // And again: still failing, no fourth start, no second decision
    const third = harness({ dataDir, world: w });
    await tickEvery(third, 5, 60 * S);
    expect(w.runner.starts()).toHaveLength(3);
    expect(third.decisions()).toHaveLength(1);
    expect(third.status()).toMatchObject({ state: "failing", decisionId: third.decisions()[0].id });
  });

  it("does not start a slow starter again after a restart inside its grace window", async () => {
    const dataDir = tempDir("lair-host-services-");
    const w = world();
    w.runner.svc("docker").upAfterMs = 50 * S;
    const first = harness({ dataDir, world: w });
    await first.tick();
    await first.manager.stop();
    w.clock.advance(20 * S);
    const second = harness({ dataDir, world: w });
    await second.tick();
    expect(second.status().state).toBe("starting");
    w.clock.advance(35 * S);
    await second.tick();
    expect(second.status().state).toBe("up");
    expect(w.runner.starts()).toEqual([T0]);
  });

  it("reads a version 1 file as written; a newer file is left alone and an unreadable one starts fresh, both reported", async () => {
    const dataDir = tempDir("lair-host-services-");
    const file = join(dataDir, "host-services", `${PROJECT}.json`);
    mkdirSync(join(dataDir, "host-services"), { recursive: true });
    const saved = {
      version: 1,
      services: [
        {
          machine: M,
          name: "docker",
          state: "failing",
          lastProbe: { up: false, code: 1, timedOut: false, checkedAt: "2026-03-02T11:00:00.000Z" },
          lastUpAt: "2026-03-02T10:00:00.000Z",
          upSince: null,
          outageStartedAt: "2026-03-02T10:30:00.000Z",
          failedProbes: 12,
          starts: 3,
          lastStart: { at: "2026-03-02T10:50:00.000Z", code: 1, timedOut: false },
          recoveredAfterStart: false,
          escalated: true,
          decisionId: null,
        },
        {
          machine: M,
          name: "gone-service",
          state: "up",
          lastProbe: null,
          lastUpAt: null,
          upSince: null,
          outageStartedAt: null,
          failedProbes: 0,
          starts: 0,
          lastStart: null,
          recoveredAfterStart: false,
          escalated: false,
          decisionId: null,
        },
      ],
    };
    writeFileSync(file, JSON.stringify(saved));
    const h = harness({ dataDir });
    await tickEvery(h, 3, 60 * S);
    expect(h.runner.starts()).toEqual([]);
    expect(h.decisions()).toEqual([]);
    expect(h.status()).toMatchObject({ state: "failing", starts: 3, outageStartedAt: "2026-03-02T10:30:00.000Z" });
    // A service the config no longer has is dropped from the file
    await h.manager.stop();
    expect(JSON.parse(readFileSync(file, "utf8")).services.map((s: { name: string }) => s.name)).toEqual(["docker"]);

    const newer = JSON.stringify({ version: STORE_VERSION + 1, services: [] });
    writeFileSync(file, newer);
    const later = harness({ dataDir });
    await later.tick();
    expect(later.manager.status(PROJECT).lastError).toMatch(/written by a newer Lair \(version 2/);
    await later.manager.stop();
    expect(readFileSync(file, "utf8")).toBe(newer);

    writeFileSync(file, "{ not json");
    const broken = harness({ dataDir });
    await broken.tick();
    expect(broken.manager.status(PROJECT).lastError).toMatch(/not valid JSON; starting fresh/);
    expect(broken.runner.starts()).toHaveLength(1);
  });

  it("a config reload during a start kills that start, counts it, and the new instance does not start it again early", async () => {
    const root = tempDir("lair-host-services-reload-");
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });
    const file = join(projects, `${PROJECT}.yaml`);
    const write = (interval: number) =>
      writeFileSync(
        file,
        stringify({
          name: "Demo",
          repo: root,
          github: "example-org/example-app",
          queue_file: join(root, "queue.md"),
          agents_dir: join(root, "agents"),
          gates_dir: join(root, "gates"),
          machines: {},
          host_services: block({ settings: { interval_seconds: interval } }),
        }),
      );
    write(60);
    const w = world();
    w.runner.blockStarts = true;
    const manager = new HostServicesManager({ probes: { runner: w.runner, clock: w.clock }, events: w.events, dataDir: join(root, "data"), firstTickDelayMs: 1e9 });
    const initial = [{ name: PROJECT, config: loadProjectConfig(PROJECT, projects) }];
    manager.load(initial);
    manager.useDecisions(w.inbox);
    manager.start();
    const reloader = new ConfigReloader({ modules: serverModules({ hostServices: manager }), initial, projectsDir: projects, debounceMs: 50, cwd: root, log: quiet });
    reloader.start();
    await reloader.ready();
    cleanups.push(async () => {
      await reloader.stop();
      await manager.stop();
    });

    const old = manager.get(PROJECT)!;
    const ticking = old.tick();
    await waitFor("the start to run", () => w.runner.starts().length === 1);
    write(120);
    await waitFor("the reload", () => manager.get(PROJECT) !== old);
    await reloader.settled();
    await ticking;
    expect(w.runner.abortedStarts).toEqual(["docker"]);
    expect(old.running).toBe(false);

    const next = manager.get(PROJECT)!;
    expect(next.settings.intervalSeconds).toBe(120);
    w.runner.blockStarts = false;
    await next.tick();
    expect(w.runner.starts()).toHaveLength(1);
    expect(manager.status(PROJECT).services.get(M)![0]).toMatchObject({ state: "starting", starts: 1 });
    w.clock.advance(61 * S);
    await next.tick();
    expect(w.runner.starts()).toHaveLength(2);
    expect(manager.status(PROJECT).services.get(M)![0].state).toBe("up");
  });
});

// ============ ROUTES ============

const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

async function serve(h: Harness): Promise<{ app: FastifyInstance; owner: Record<string, string> }> {
  const dir = tempDir("lair-host-services-auth-");
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const app = Fastify();
  cleanups.push(async () => {
    await app.close();
    auth.close();
  });
  registerHostServicesRoutes(app, h.manager, auth);
  await app.ready();
  const session = auth.createSession(readFileSync(tokenPath, "utf-8").trim());
  if (!session) throw new Error("no owner session");
  return { app, owner: { ...BROWSER, [OWNER_SESSION_HEADER]: session.session } };
}

describe("routes", () => {
  it("the tick runs commands, so only the owner may call it: no session or a bad one gets 403 and runs nothing", async () => {
    const h = harness();
    const { app, owner } = await serve(h);
    const url = `${OWNER_PREFIX}/${PROJECT}/tick`;
    expect(isUnder(url, OWNER_ONLY_PREFIXES)).toBe(true);
    for (const headers of [{}, BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "x".repeat(43) }]) {
      expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(403);
    }
    // The old public path does not exist
    expect((await app.inject({ method: "POST", url: `/api/host-services/${PROJECT}/tick`, headers: owner })).statusCode).toBe(404);
    expect(h.runner.calls).toEqual([]);

    const res = await app.inject({ method: "POST", url, headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ticks).toEqual([expect.objectContaining({ machine: M, started: 1 })]);
    expect(h.runner.starts()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `${OWNER_PREFIX}/other/tick`, headers: owner })).statusCode).toBe(404);
  });

  it("the reads are public and show states, codes and lanes, never a probe's output or a command's arguments", async () => {
    const h = harness({ started: true });
    h.runner.svc("docker").startExit = 1;
    await tickEvery(h, 12, 61 * S);
    const { app } = await serve(h);
    const status = await app.inject({ method: "GET", url: `/api/host-services/${PROJECT}` });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({
      enabled: true,
      running: true,
      mode: "act",
      holdsEnforced: true,
      services: { [M]: [expect.objectContaining({ name: "docker", state: "failing", starts: 3, holds: ["heavy"] })] },
      heldLanes: [expect.objectContaining({ lane: "heavy", enforced: true })],
    });
    const check = await app.inject({ method: "GET", url: `/api/host-services/${PROJECT}/holds/check?lane=heavy` });
    expect(check.json().data).toMatchObject({ lane: "heavy", held: true, enforced: true });
    const machine = await app.inject({ method: "GET", url: `/api/host-services/${PROJECT}/machines/${M}` });
    expect(machine.json().data.services).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/host-services/bad%20name" })).statusCode).toBe(400);
    const off = await app.inject({ method: "GET", url: "/api/host-services/other" });
    expect(off.json().data).toMatchObject({ enabled: false, heldLanes: [] });

    // Nothing public carries the probe's output or the argv: not the reads, the events or the decision
    for (const body of [status.body, check.body, machine.body, JSON.stringify(h.hostEvents()), JSON.stringify(h.decisions())]) {
      expect(body).not.toContain(SECRET);
    }
  });
});

// ============ PIPELINE LANE HOLDS ============

const PIPELINES = { gate: { steps: [{ name: "lint", run: ["npm", "run", "lint"] }] } };

async function pipelineWorld(mode: "act" | "observe") {
  const pclock = new PipelineClock();
  const github = new FakeGitHub(pclock);
  const spawner = new FakeSpawner();
  const lairDir = tempDir("lair-host-services-pipelines-");
  const pipelines = new PipelineManager({
    dbPath: ":memory:",
    events: new EventBus(),
    fetch: github.fetch,
    spawner,
    capacity: new FakeCapacity(),
    clock: pclock,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user" },
    lairDir,
    git: { run: async () => ({ code: 0, stdout: `${SHA}\n`, stderr: "" }) },
  });
  cleanups.push(() => pipelines.stop());
  const cfg = pipelineProjectConfig(PROJECT, "/srv/example-app", PIPELINES, { order: ["local"] }, {
    host_services: block({ mode, services: [{ name: "docker", neededBy: ["default"] }] }),
  });
  pipelines.load([{ name: PROJECT, config: cfg }]);
  const h = harness({ cfg, started: true });
  h.runner.svc("docker").startExit = 1;
  // As src/server/index.ts wires it
  pipelines.useLaneHolds((project, names) => h.manager.holdFor(project, names));
  await h.tick();
  return { h, pipelines, spawner };
}

describe("pipeline lane holds", () => {
  it("act: a job whose lane needs a down service waits without running a step, and runs once the probe passes", async () => {
    const { h, pipelines, spawner } = await pipelineWorld("act");
    expect(h.status().state).toBe("down");
    const run = await pipelines.startRun(PROJECT, { pipeline: "gate", sha: SHA });
    const job = () => pipelines.getRun(PROJECT, run.id).jobs[0];
    await waitFor("the job to be held", () => job().status === "waiting");
    expect(job().waitReason).toBe(`held: docker on build-1 is down since ${new Date(T0).toISOString()}`);
    expect(spawner.stepCalls()).toEqual([]);
    expect(job().attempts).toEqual([]);

    h.runner.svc("docker").answer = "up";
    await h.tick();
    await pipelines.idle();
    const done = pipelines.getRun(PROJECT, run.id);
    expect(done.status).toBe("passed");
    expect(done.jobs[0]).toMatchObject({ executor: "local", waitReason: null });
    expect(spawner.stepCalls().length).toBeGreaterThan(0);
  });

  it("observe: holds are reported only; the job runs", async () => {
    const { h, pipelines } = await pipelineWorld("observe");
    expect(h.svc().getHeldLanes()).toEqual([expect.objectContaining({ lane: "default", enforced: false })]);
    const run = await pipelines.startRun(PROJECT, { pipeline: "gate", sha: SHA });
    await pipelines.idle();
    expect(pipelines.getRun(PROJECT, run.id).status).toBe("passed");
  });

  it("matches a hold on the lane, the pipeline or <pipeline>.<lane>, and only while the module runs", async () => {
    const h = harness({ cfg: config(block({ services: [{ name: "docker", neededBy: ["gate.default", "deploy"] }] })), started: true });
    h.runner.svc("docker").startExit = 1;
    await h.tick();
    expect(h.manager.holdFor(PROJECT, ["default", "gate", "gate.default"])).toMatch(/^docker on build-1 is down/);
    expect(h.manager.holdFor(PROJECT, ["deploy"])).not.toBeNull();
    expect(h.manager.holdFor(PROJECT, ["default", "lint"])).toBeNull();
    expect(h.manager.holdFor("other", ["deploy"])).toBeNull();
    await h.svc().stop();
    expect(h.manager.holdFor(PROJECT, ["deploy"])).toBeNull();
  });
});

// ============ THE REAL COMMAND RUNNER ============

const NODE = process.execPath;

describe("the real command runner (ExecFileRunner)", () => {
  it("kills a probe that prints and then hangs at its timeout: code -1, timed out, never a success", async () => {
    const runner = new ExecFileRunner(30_000, 200);
    const started = Date.now();
    const out = await runner.run([NODE, "-e", "process.stdout.write('up\\n'); setInterval(() => {}, 1000)"], { timeoutMs: 700 });
    expect(out).toMatchObject({ code: -1, timedOut: true });
    expect(Date.now() - started).toBeLessThan(700 + 200 + 1000 + 3000);
  });

  it("ends a probe that ignores SIGTERM with SIGKILL after the grace", async () => {
    const runner = new ExecFileRunner(30_000, 300);
    const started = Date.now();
    const out = await runner.run(
      [NODE, "-e", "process.on('SIGTERM', () => {}); process.stdout.write('up\\n'); setInterval(() => {}, 1000)"],
      { timeoutMs: 1500 },
    );
    expect(out).toMatchObject({ code: -1, timedOut: true });
    expect(Date.now() - started).toBeLessThan(1500 + 300 + 1000 + 3000);
  });

  it("returns exit codes as they are, and -1 for a missing program, too much output or an abort", async () => {
    const runner = new ExecFileRunner(10_000, 200);
    expect(await runner.run([NODE, "-e", "process.stdout.write('ok')"])).toMatchObject({ code: 0, stdout: "ok", timedOut: false });
    expect(await runner.run([NODE, "-e", "process.exit(3)"])).toMatchObject({ code: 3, timedOut: false });
    expect(await runner.run(["/nonexistent/lair-probe-program"])).toMatchObject({ code: -1, stderr: "not found", timedOut: false });
    expect(await runner.run([NODE, "-e", "process.stdout.write('x'.repeat(4096))"], { maxBufferBytes: 1024 })).toMatchObject({
      code: -1,
      timedOut: false,
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const started = Date.now();
    expect(await runner.run([NODE, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20_000, signal: abort.signal })).toMatchObject({
      code: -1,
      timedOut: false,
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("through the module: a hung probe reads as unknown, runs no start, holds the lane and asks once", async () => {
    const dir = tempDir("lair-host-services-real-");
    const marker = join(dir, "started");
    const clock = new FakeClock();
    const events = new EventBus();
    const inbox = inboxWith(clock, events);
    const manager = new HostServicesManager({ probes: { runner: new ExecFileRunner(30_000, 200), clock }, events, firstTickDelayMs: 1e9 });
    cleanups.push(() => manager.stop());
    manager.load([
      {
        name: PROJECT,
        config: config(
          block({
            settings: { probe_timeout_seconds: 1, escalate_after_probes: 2 },
            services: [
              {
                name: "engine",
                neededBy: ["heavy"],
                probe: [NODE, "-e", "process.stdout.write('Server Version: 1\\n'); setInterval(() => {}, 1000)"],
                start: [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
              },
            ],
          }),
        ),
      },
    ]);
    manager.useDecisions(inbox);
    manager.start();
    const service = manager.get(PROJECT)!;
    await service.tick();
    clock.advance(60 * S);
    await service.tick();
    const status = manager.status(PROJECT).services.get(M)![0];
    expect(status).toMatchObject({ state: "unknown", starts: 0, lastProbe: { up: false, code: -1, timedOut: true } });
    expect(existsSync(marker)).toBe(false);
    expect(manager.holdFor(PROJECT, ["heavy"])).toMatch(/does not answer its probe/);
    const decisions = inbox.list({ project: PROJECT, status: "all" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ evidence: { code: "probe_timeout" } });
    // Only the program's base name, never its path or arguments
    expect(decisions[0].context).toContain("(`node`)");
    expect(decisions[0].context).not.toContain(marker);
    expect(decisions[0].context).not.toContain("Server Version");
  }, 20_000);
});
