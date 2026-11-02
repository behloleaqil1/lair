/**
 * Infrastructure monitor acceptance tests.
 *
 * The module runs as the server runs it: InfraMonitorManager.load() with a
 * project config, useDecisions() with a real Decision Inbox (in-memory
 * SQLite), and the tick its timer calls. Everything else is real too: the
 * gate queue is files in a temp dir named and filled as the runners write
 * them, the probes and requeue_cmd are real programs run by the real
 * SpawnRunner (`cat` of a state file for a probe, a FIFO for a probe that
 * hangs, a small node script for the re-queue), process groups and runner
 * pids are real sleeping processes, and the ledger is a real file. The one
 * fake is the clock, so minutes pass between ticks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify from "fastify";
import type { ProjectConfig } from "../../shared/types.js";
import { EventBus } from "../core/event-bus.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { registerInfraMonitorRoutes } from "./routes.js";
import { InfraMonitorManager } from "./service.js";
import { SpawnRunner, type CommandOutput, type CommandRunner, type RunOptions } from "./probes.js";

const MIN = 60_000;

// Real programs run on every tick (and some probes wait for their 1 s timeout): room for a loaded CI machine
vi.setConfig({ testTimeout: 30_000 });

class FakeClock {
  t = Date.now();
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** The real runner, with a record of what ran (not a fake: every command really runs). */
class RecordingRunner implements CommandRunner {
  calls: string[][] = [];
  private real = new SpawnRunner();
  run(argv: string[], options: RunOptions): Promise<CommandOutput> {
    this.calls.push([...argv]);
    return this.real.run(argv, options);
  }
}

/** The re-queue script: logs its call; "ok" moves the request to the new lane, "noop" exits 0 without, "fail" refuses, "hang" hangs. */
const REQUEUE_JS = `
const fs = require("fs"), path = require("path");
const [dir, id, from, to] = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "requeue-calls.log"), [id, from, to].join(" ") + "\\n");
const mode = fs.existsSync(path.join(dir, "requeue-mode")) ? fs.readFileSync(path.join(dir, "requeue-mode"), "utf8").trim() : "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("refused: no free slot\\n"); process.exit(3); }
else {
  if (mode === "ok") {
    const q = path.join(dir, "gates", "queue");
    for (const name of fs.readdirSync(q)) {
      const m = /^([^.]+)\\.(\\d+)\\.(.+)\\.req\\.run$/.exec(name);
      if (m && m[1] === from && m[3] === id) fs.renameSync(path.join(q, name), path.join(q, to + "." + m[2] + "." + id + ".req"));
    }
  }
  process.exit(0);
}
`;

const ID_A = "20261031T123256Z-login-fix-600-eafa931b-9040";
const ID_B = "20261031T124522Z-search-fix-de189d60-56587";

interface Harness {
  root: string;
  queue: string;
  clock: FakeClock;
  runner: RecordingRunner;
  inbox: DecisionInbox;
  store: DecisionStore;
  events: EventBus;
  ledgerPath: string;
  manager: InfraMonitorManager;
}

let h: Harness;
const managers: InfraMonitorManager[] = [];
const sleepers: ChildProcess[] = [];

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const probe = (machine: string) => ({ argv: ["cat", join(h.root, `${machine}.state`)], expect: "up" });
  return {
    enabled: true,
    mode: "act",
    interval_seconds: 60,
    down_threshold_seconds: 120,
    probe_timeout_seconds: 1,
    machines: {
      local: { probes: [probe("local")] },
      laptop: { probes: [probe("laptop")] },
      cloud: { probes: [probe("cloud")], start_grace_seconds: 900 },
    },
    lanes: {
      heavy: { machine: "local", slots: 1 },
      remote: { machine: "laptop", slots: 2, runner_pid_files: ["runner-remote.pid", "runner-remote2.pid"], requeue_to: ["heavy"] },
      cloud: { machine: "cloud", slots: 2, requeue_to: ["remote", "heavy"] },
    },
    requeue_cmd: [process.execPath, join(h.root, "requeue.js"), h.root, "{id}", "{from}", "{to}"],
    requeue_timeout_seconds: 5,
    requeue_max_attempts: 2,
    requeue_backoff_seconds: 300,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}, extra: { read_only?: boolean } = {}): ProjectConfig {
  return {
    name: "demo",
    repo: h.root,
    github: "example/demo",
    queue_file: join(h.root, "queue.md"),
    agents_dir: join(h.root, "agents"),
    gates_dir: join(h.root, "gates"),
    machines: {},
    infra_monitor: block(overrides),
    ...extra,
  };
}

function newManager(): InfraMonitorManager {
  const manager = new InfraMonitorManager({
    probes: { runner: h.runner, clock: h.clock },
    events: h.events,
    ledgerPath: h.ledgerPath,
    log: { warn: () => undefined, log: () => undefined },
    firstTickMs: 3_600_000,
  });
  manager.useDecisions(h.inbox);
  managers.push(manager);
  return manager;
}

function startProject(overrides: Record<string, unknown> = {}, extra: { read_only?: boolean } = {}) {
  h.manager.load([{ name: "demo", config: project(overrides, extra) }]);
  expect(h.manager.start()).toEqual(["demo"]);
  const monitor = h.manager.get("demo");
  if (!monitor) throw new Error("not started");
  return monitor;
}

function setMachine(machine: string, state: "up" | "down" | "hang"): void {
  const path = join(h.root, `${machine}.state`);
  rmSync(path, { force: true });
  if (state === "hang") {
    // `cat` of a FIFO nobody writes blocks: a probe that never answers
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
  } else {
    writeFileSync(path, `${state}\n`);
  }
}

/** A real process in its own group, as a runner or a gate run. */
function sleeper(): number {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  sleepers.push(child);
  if (!child.pid) throw new Error("no sleeper");
  return child.pid;
}

async function killed(pid: number): Promise<void> {
  const child = sleepers.find((c) => c.pid === pid);
  if (!child) throw new Error("not a sleeper");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

/** A running request as a runner leaves it: the claimed request and its process group. */
function running(lane: string, id: string, pgid: number | null = sleeper()): void {
  writeFileSync(join(h.queue, `${lane}.5.${id}.req.run`), `track\nabc1234\nwork/bin/gate.sh backend {WT}\n`);
  if (pgid !== null) writeFileSync(join(h.queue, `${lane}.5.${id}.pgid`), `${pgid}\n`);
}

function queued(lane: string, id: string): void {
  writeFileSync(join(h.queue, `${lane}.5.${id}.req`), `track\nabc1234\nwork/bin/gate.sh backend {WT}\n`);
}

function notices() {
  return h.inbox.list({ project: "demo", status: "all" }).filter((d) => d.source.module === "infra_monitor");
}

function requeueCalls(): string[] {
  const path = join(h.root, "requeue-calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

/** Advance the clock, then tick (the function the monitor's timer calls). */
async function after(ms: number, monitor: { tick: () => Promise<unknown> }): Promise<void> {
  h.clock.advance(ms);
  await monitor.tick();
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "infra-monitor-"));
  const queue = join(root, "gates", "queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(root, "requeue.js"), REQUEUE_JS);
  const clock = new FakeClock();
  const store = new DecisionStore(":memory:");
  const events = new EventBus();
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock, events });
  h = { root, queue, clock, runner: new RecordingRunner(), inbox, store, events, ledgerPath: join(root, "data", "infra-monitor-requeues.json"), manager: undefined as unknown as InfraMonitorManager };
  h.manager = newManager();
  for (const m of ["local", "laptop", "cloud"]) setMachine(m, "up");
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
  for (const child of sleepers.splice(0)) child.kill("SIGKILL");
  h.store.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe("wiring", () => {
  it("is off by default: no monitor and nothing runs", async () => {
    const manager = newManager();
    manager.load([{ name: "demo", config: { ...project(), infra_monitor: undefined } }]);
    expect(manager.start()).toEqual([]);
    expect(manager.status("demo")).toMatchObject({ enabled: false, running: false, findings: [] });
    expect(h.runner.calls).toEqual([]);
  });

  it("an enabled block with no lanes is refused: it would watch nothing and look healthy", () => {
    h.manager.load([{ name: "demo", config: project({ lanes: {} }) }]);
    expect(h.manager.start()).toEqual([]);
    expect(h.manager.status("demo").lastError).toContain("watches nothing");
  });

  it("start() ticks by itself on its timer", async () => {
    const manager = new InfraMonitorManager({
      probes: { runner: h.runner, clock: h.clock },
      ledgerPath: h.ledgerPath,
      log: { warn: () => undefined, log: () => undefined },
      firstTickMs: 0,
    });
    managers.push(manager);
    manager.load([{ name: "demo", config: project({ mode: "observe" }) }]);
    manager.start();
    const deadline = Date.now() + 5000;
    while (manager.status("demo").lastTick === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const status = manager.status("demo");
    expect(status.lastTick?.machinesProbed).toBe(3);
    expect(status.machines.map((m) => [m.id, m.up])).toEqual([["local", true], ["laptop", true], ["cloud", true]]);
  });

  it("its routes only read: each GET answers from the status, and nothing else is routed", async () => {
    running("remote", ID_A);
    const monitor = startProject({ mode: "observe" });
    await monitor.tick();
    const app = Fastify({ logger: false });
    await registerInfraMonitorRoutes(app, h.manager, () => "demo");
    await app.ready();
    try {
      const status = await app.inject({ method: "GET", url: "/api/infra-monitor/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().data).toMatchObject({ project: "demo", enabled: true, mode: "observe", stale: false });
      expect((await app.inject({ url: "/api/infra-monitor/machines?project=demo" })).json().data).toHaveLength(3);
      expect((await app.inject({ url: "/api/infra-monitor/jobs?project=demo" })).json().data).toMatchObject([{ id: ID_A }]);
      expect((await app.inject({ url: "/api/infra-monitor/findings?project=demo" })).json().data).toEqual([]);
      for (const method of ["POST", "PUT", "DELETE"] as const) {
        expect((await app.inject({ method, url: "/api/infra-monitor/status" })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});

describe("a job whose machine stops", () => {
  it("raises one notice in the inbox, keeps it while the machine stays down, and withdraws it once the machine is back", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    expect(monitor.status().jobs).toMatchObject([{ id: ID_A, lane: "remote", machine: "laptop", machineSeenUp: true, groupAlive: true }]);

    setMachine("laptop", "down");
    await after(MIN, monitor);
    expect(notices()).toHaveLength(0);
    await after(MIN, monitor); // down for 60 s: not yet
    expect(notices()).toHaveLength(0);
    await after(MIN, monitor); // down for 120 s
    const [notice] = notices();
    expect(notices()).toHaveLength(1);
    expect(notice).toMatchObject({ status: "open", attention: "notice", key: "machine_down:laptop", class: "infra_monitor.notice" });
    expect(notice.title).toContain("Machine laptop has been down");
    expect(notice.evidence).toMatchObject({ code: "machine_down", facts: { machine: "laptop", running_jobs: 1, jobs: ID_A } });

    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()).toHaveLength(1);

    setMachine("laptop", "up");
    await after(MIN, monitor);
    expect(notices()[0].status).toBe("open"); // a single good probe is not a recovery yet
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].status).toBe("withdrawn");
    expect(monitor.status().findings).toEqual([]);
  });

  it("a probe that hangs is a failure: killed at the timeout, the machine counts as down", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "hang");
    const started = Date.now();
    await after(MIN, monitor);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(monitor.status().machines.find((m) => m.id === "laptop")).toMatchObject({ up: false, lastError: expect.stringContaining("timed out") });
    await after(2 * MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual(["machine_down:laptop"]);
    expect(notices()[0].evidence?.facts.last_error).toContain("timed out");
  });

  it("a blip or a flapping machine raises nothing; one that stays down does", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    for (let i = 0; i < 8; i++) {
      setMachine("laptop", i % 2 === 0 ? "down" : "up");
      await after(MIN, monitor);
    }
    expect(monitor.status().findings).toEqual([]);
    expect(notices()).toHaveLength(0);
    setMachine("laptop", "down");
    await after(MIN, monitor);
    await after(MIN, monitor);
    await after(MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual(["machine_down:laptop"]);
  });

  it("an on-demand machine starting for a new job is not down under it, until it was seen up or start_grace passes", async () => {
    setMachine("cloud", "down"); // stopped while idle: nothing to say
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    await after(5 * MIN, monitor);
    expect(monitor.status().findings).toEqual([]);

    running("cloud", ID_A); // claimed: the runner starts the server, which takes minutes
    for (let i = 0; i < 5; i++) await after(MIN, monitor);
    expect(monitor.status().findings).toEqual([]);

    setMachine("cloud", "up"); // it started and ran the job...
    await after(MIN, monitor);
    setMachine("cloud", "down"); // ...then stopped under it
    await after(MIN, monitor);
    await after(2 * MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual(["machine_down:cloud"]);
  });

  it("a machine down while jobs wait in its lanes is a finding too", async () => {
    setMachine("laptop", "down");
    queued("remote", ID_B);
    writeFileSync(join(h.root, "gates", "runner-remote.pid"), `${sleeper()}\n`); // its runner is alive, waiting on the machine
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    await after(MIN, monitor);
    expect(monitor.status().findings).toEqual([]); // down and waiting for 60 s: not yet
    await after(2 * MIN, monitor);
    expect(monitor.status().findings).toMatchObject([{ key: "machine_down:laptop", facts: { queued_jobs: 1, running_jobs: 0 } }]);
  });
});

describe("observe mode", () => {
  it("writes nothing: the finding and the re-queue it would run are shown; no notice, no command but probes, no ledger", async () => {
    running("remote", ID_A);
    const monitor = startProject({ mode: "observe" });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 4; i++) await after(MIN, monitor);
    const status = monitor.status();
    expect(status.actBlocked).toContain("observe");
    expect(status.findings.map((f) => f.key)).toEqual(["machine_down:laptop"]);
    expect(status.plannedRequeues).toEqual([
      { id: ID_A, from: "remote", to: "heavy", argv: [process.execPath, join(h.root, "requeue.js"), h.root, ID_A, "remote", "heavy"], reason: null },
    ]);
    expect(h.inbox.list({ status: "all" })).toEqual([]);
    expect(h.runner.calls.every((argv) => argv[0] === "cat")).toBe(true);
    expect(requeueCalls()).toEqual([]);
    expect(existsSync(h.ledgerPath)).toBe(false);
  });

  it("a read_only project in act mode raises and runs nothing", async () => {
    running("remote", ID_A);
    const monitor = startProject({}, { read_only: true });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 4; i++) await after(MIN, monitor);
    expect(monitor.status().actBlocked).toBe("the project is read_only");
    expect(monitor.status().findings).toHaveLength(1);
    expect(h.inbox.list({ status: "all" })).toEqual([]);
    expect(requeueCalls()).toEqual([]);
  });
});

describe("act mode: re-queue", () => {
  it("re-queues a job of a down machine once, onto a lane whose machine is up, and not again after a restart", async () => {
    writeFileSync(join(h.root, "requeue-mode"), "noop"); // exits 0 but leaves the request: the worst case for a repeat
    running("remote", ID_A);
    const monitor = startProject();
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(requeueCalls()).toEqual([`${ID_A} remote heavy`]);
    expect(monitor.status().requeues).toMatchObject([{ id: ID_A, from: "remote", to: "heavy", attempts: 1, status: "moved" }]);
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(requeueCalls()).toHaveLength(1);

    // Restart: a new manager reads the ledger
    await h.manager.stop();
    h.manager = newManager();
    const again = startProject();
    for (let i = 0; i < 5; i++) await after(MIN, again);
    expect(again.status().findings.map((f) => f.key)).toEqual(["machine_down:laptop"]);
    expect(requeueCalls()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it("moves the request for real and the finding clears", async () => {
    running("remote", ID_A);
    const monitor = startProject();
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(readdirSync(h.queue)).toContain(`heavy.5.${ID_A}.req`);
    for (let i = 0; i < 4; i++) await after(MIN, monitor);
    expect(monitor.status().findings).toEqual([]);
    expect(notices()[0].status).toBe("withdrawn");
  });

  it("picks the first lane in requeue_to whose machine is up, never the down one; with none up it waits", async () => {
    running("cloud", ID_A);
    const monitor = startProject();
    await monitor.tick();
    setMachine("cloud", "down");
    setMachine("laptop", "down");
    setMachine("local", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(monitor.status().plannedRequeues).toMatchObject([{ id: ID_A, to: null, reason: expect.stringContaining("no lane of remote, heavy") }]);
    expect(requeueCalls()).toEqual([]);
    setMachine("local", "up");
    await after(MIN, monitor);
    expect(requeueCalls()).toEqual([`${ID_A} cloud heavy`]);
  });

  it("a failed re-queue is retried after its backoff, at most requeue_max_attempts times", async () => {
    writeFileSync(join(h.root, "requeue-mode"), "fail");
    running("remote", ID_A);
    const monitor = startProject();
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(requeueCalls()).toHaveLength(1);
    expect(monitor.status().requeues[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "exited 3: refused: no free slot" });
    for (let i = 0; i < 4; i++) await after(MIN, monitor); // inside the 300 s backoff
    expect(requeueCalls()).toHaveLength(1);
    await after(MIN, monitor);
    expect(requeueCalls()).toHaveLength(2);
    expect(monitor.status().requeues[0]).toMatchObject({ status: "gave_up", attempts: 2 });
    for (let i = 0; i < 20; i++) await after(MIN, monitor);
    expect(requeueCalls()).toHaveLength(2);
  });

  it("a re-queue that hangs is killed at its timeout and counts as failed", async () => {
    writeFileSync(join(h.root, "requeue-mode"), "hang");
    running("remote", ID_A);
    const monitor = startProject({ requeue_timeout_seconds: 1 });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(monitor.status().requeues[0]).toMatchObject({ status: "failed", lastError: "timed out after 1 s" });
  });

  it("a restart in the middle of a re-queue counts the attempt: retried after the backoff, not at once", async () => {
    writeFileSync(join(h.root, "requeue-mode"), "hang");
    running("remote", ID_A);
    const monitor = startProject({ requeue_timeout_seconds: 60 });
    await monitor.tick();
    setMachine("laptop", "down");
    await after(MIN, monitor);
    await after(MIN, monitor);
    h.clock.advance(MIN);
    const tick = monitor.tick();
    const deadline = Date.now() + 5000;
    while (requeueCalls().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await h.manager.stop(); // the server stops while the command runs
    await tick;
    expect(JSON.parse(readFileSync(h.ledgerPath, "utf8")).records).toMatchObject([{ id: ID_A, status: "running", attempts: 1 }]);

    writeFileSync(join(h.root, "requeue-mode"), "ok");
    h.manager = newManager();
    const again = startProject();
    for (let i = 0; i < 3; i++) await after(MIN, again);
    expect(again.status().requeues[0]).toMatchObject({ status: "failed", lastError: "interrupted by a restart" });
    expect(requeueCalls()).toHaveLength(1);
    await after(2 * MIN, again);
    expect(requeueCalls()).toHaveLength(2);
    expect(again.status().requeues[0]).toMatchObject({ status: "moved", attempts: 2 });
  });

  it("a ledger that can't be parsed stops re-queues and is not overwritten", async () => {
    mkdirSync(join(h.root, "data"));
    writeFileSync(h.ledgerPath, "{not json");
    running("remote", ID_A);
    const monitor = startProject();
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(requeueCalls()).toEqual([]);
    expect(monitor.status().lastError).toContain("re-queues stop");
    expect(readFileSync(h.ledgerPath, "utf8")).toBe("{not json");
    expect(notices()).toHaveLength(1); // the notice still goes up
  });
});

describe("the job, the slots and the runners", () => {
  it("a running request whose process group is gone: one notice; a live group: none", async () => {
    const live = sleeper();
    const dead = sleeper();
    running("heavy", ID_A, live);
    running("remote", ID_B, dead);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    await killed(dead);
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual([`job_lost:${ID_B}`]);
    expect(notices()[0].evidence?.facts).toMatchObject({ gate: ID_B, lane: "remote", pgid: dead });
  });

  it("two runners in one slot: one notice", async () => {
    running("heavy", ID_A);
    running("heavy", ID_B);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual(["slot_overflow:heavy"]);
    expect(notices()[0].title).toBe("Lane heavy runs 2 gate jobs in 1 slot(s): more than one runner claims a slot");
  });

  it("no live runner while jobs wait: one notice; a live runner in either slot file: none", async () => {
    const runner = sleeper();
    writeFileSync(join(h.root, "gates", "runner-remote.pid"), `${runner}\n`);
    queued("remote", ID_B);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()).toHaveLength(0);

    await killed(runner);
    await after(MIN, monitor);
    expect(notices()).toHaveLength(0); // not for a moment: it must last
    for (let i = 0; i < 2; i++) await after(MIN, monitor);
    expect(notices().map((d) => d.key)).toEqual(["dead_runner:remote"]);
    expect(notices()[0].evidence?.facts).toMatchObject({ lane: "remote", queued_jobs: 1, pid_files: "runner-remote.pid, runner-remote2.pid" });
  });
});

describe("no false green, no spam", () => {
  it("a queue that can't be read is an error, not a healthy status, and withdraws nothing", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()).toHaveLength(1);
    rmSync(h.queue, { recursive: true, force: true });
    for (let i = 0; i < 6; i++) await after(MIN, monitor);
    expect(monitor.status().lastError).toContain("the gate queue can't be read");
    expect(notices()[0].status).toBe("open");
  });

  it("a status with no finished tick for three intervals says stale", async () => {
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    expect(monitor.status().stale).toBe(false);
    h.clock.advance(4 * MIN);
    expect(monitor.status().stale).toBe(true);
  });

  it("an answered notice is not raised again while its cause holds; it is when the cause clears and comes back", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    await h.inbox.answer(notices()[0].id, { optionId: "noted" });
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices().map((d) => d.status)).toEqual(["answered"]);

    setMachine("laptop", "up");
    for (let i = 0; i < 4; i++) await after(MIN, monitor);
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices().map((d) => d.status).sort()).toEqual(["answered", "open"]);
  });

  it("after a restart the open notice is kept, not raised twice, and withdrawn once its cause stays gone", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()).toHaveLength(1);

    await h.manager.stop();
    h.manager = newManager();
    const again = startProject({ requeue_cmd: null });
    for (let i = 0; i < 5; i++) await after(MIN, again);
    expect(notices()).toHaveLength(1);
    expect(again.status().findings[0].noticeId).toBe(notices()[0].id);

    setMachine("laptop", "up");
    for (let i = 0; i < 4; i++) await after(MIN, again);
    expect(notices().map((d) => d.status)).toEqual(["withdrawn"]);
  });

  it("an open notice left from before a restart whose cause is gone is withdrawn", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    await h.manager.stop();
    setMachine("laptop", "up");
    h.manager = newManager();
    const again = startProject({ requeue_cmd: null });
    await again.tick();
    expect(notices()[0].status).toBe("open");
    for (let i = 0; i < 3; i++) await after(MIN, again);
    expect(notices()[0].status).toBe("withdrawn");
  });

  it("a reload to observe mode withdraws the notices act mode raised", async () => {
    running("remote", ID_A);
    const monitor = startProject({ requeue_cmd: null });
    await monitor.tick();
    setMachine("laptop", "down");
    for (let i = 0; i < 3; i++) await after(MIN, monitor);
    expect(notices()[0].status).toBe("open");
    await h.manager.reloadProject({ name: "demo", config: project({ mode: "observe" }) });
    expect(notices()[0].status).toBe("withdrawn");
    expect(h.manager.status("demo")).toMatchObject({ mode: "observe", running: true });
  });

  it("stop() during a probe that hangs ends the tick at once", async () => {
    const monitor = startProject({ probe_timeout_seconds: 60 });
    setMachine("laptop", "hang");
    const tick = monitor.tick();
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await h.manager.stop();
    await tick;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
