/**
 * Watchdog acceptance tests.
 *
 * Only the system boundary is fake: a ProcessTable, a CommandRunner that
 * records argv (and, like the real project scripts would, changes files or
 * processes), and a Clock. Files are real, in a temp dir. Every test runs
 * Watchdog.tick(), i.e. the real detectors, the built-in playbooks and the
 * built-in executors, then asserts the argv the runner received and what the
 * store recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { createWatchdog, type Watchdog } from "./service.js";
import { WatchdogStore } from "./store.js";
import {
  NodeFileSystem,
  type Clock,
  type CommandOutput,
  type CommandRunner,
  type ProcessInfo,
  type ProcessTable,
} from "./probes.js";
import type { Breach, PlaybookRun } from "./types.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;

class FakeClock implements Clock {
  t = NOW;
  sleeps = 0;
  /** Make sleep() a long real wait that only an abort ends */
  blockSleeps = false;
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps++;
    if (!this.blockSleeps) {
      this.t += ms;
      return;
    }
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class FakeProcessTable implements ProcessTable {
  procs: ProcessInfo[] = [];
  listCalls = 0;
  /** `ps` is broken: list() fails */
  failing = false;
  /** Runs inside list() call n, before it answers (to change state mid-tick) */
  onList?: (call: number) => void;
  add(pid: number, command: string, options: { ppid?: number; upMinutes?: number } = {}): void {
    this.procs.push({
      pid,
      ppid: options.ppid ?? 1,
      elapsedSeconds: Math.round((options.upMinutes ?? 120) * 60),
      command,
      argv: command.split(" "),
    });
  }
  remove(pid: number): void {
    this.procs = this.procs.filter((p) => p.pid !== pid);
  }
  async list(): Promise<ProcessInfo[]> {
    this.listCalls++;
    if (this.failing) throw new Error("ps failed (1): ps: cannot read process table");
    this.onList?.(this.listCalls);
    return this.procs.map((p) => ({ ...p, argv: [...p.argv] }));
  }
}

/** Let pending promises run until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

interface Handler {
  match: (argv: string[]) => boolean;
  reply?: (argv: string[]) => CommandOutput;
  effect?: (argv: string[]) => void;
}

class FakeCommandRunner implements CommandRunner {
  calls: string[][] = [];
  private handlers: Handler[] = [];
  /** What the real command would do (its side effects and output) */
  when(match: (argv: string[]) => boolean, handler: Omit<Handler, "match">): void {
    this.handlers.push({ match, ...handler });
  }
  async run(argv: string[]): Promise<CommandOutput> {
    this.calls.push([...argv]);
    const handler = this.handlers.find((h) => h.match(argv));
    handler?.effect?.(argv);
    return handler?.reply?.(argv) ?? { code: 0, stdout: "", stderr: "" };
  }
}

// ============ PROJECT FIXTURE ============

const AGENT_COMMAND = "agent-cli run --agent {agent}";
const agentCmd = (id: string) => `agent-cli run --agent ${id} --model test-model`;

const ACTIONS = {
  break_lock: ["./bin/break-lock", "{lock}", "{lock_name}"],
  stop_duplicate: ["./bin/stop-agent", "{agent}", "{pid}"],
  restart_agent: ["./bin/restart-agent", "{agent}", "{pid}"],
  release_claim: ["./bin/release-claim", "{agent}", "{claim}"],
  mark_lane_broken: ["./bin/lane-broken", "{lane}"],
  requeue_gate: ["./bin/requeue-gate", "{gate}", "{lane}"],
  fill_capacity: ["./bin/tick", "--free", "{free}", "--queued", "{queued}"],
  triage_stall: ["./bin/triage", "{hours}"],
  stop_container_restarts: ["docker", "update", "--restart=no", "{container}"],
};

interface Paths {
  dir: string;
  agentsDir: string;
  gatesDir: string;
  queueDir: string;
  resultsDir: string;
  queueFile: string;
  inboxFile: string;
  lockDir: string;
}

interface Harness extends Paths {
  config: ProjectConfig;
  procs: FakeProcessTable;
  runner: FakeCommandRunner;
  clock: FakeClock;
  store: WatchdogStore;
  wd: Watchdog;
}

const dirs: string[] = [];
const stores: WatchdogStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "lair-watchdog-"));
  dirs.push(dir);
  const agentsDir = join(dir, "agents");
  const gatesDir = join(dir, "gates");
  const paths: Paths = {
    dir,
    agentsDir,
    gatesDir,
    queueDir: join(gatesDir, "queue"),
    resultsDir: join(gatesDir, "results"),
    queueFile: join(dir, "queue.md"),
    inboxFile: join(dir, "inbox.md"),
    lockDir: join(gatesDir, "gate.lock"),
  };
  mkdirSync(paths.agentsDir, { recursive: true });
  mkdirSync(paths.queueDir, { recursive: true });
  mkdirSync(paths.resultsDir, { recursive: true });
  writeFileSync(paths.queueFile, "# Queue\n");
  return paths;
}

function setup(
  watchdog: (p: Paths) => Record<string, unknown>,
  options: { readOnly?: boolean; paths?: Paths; store?: WatchdogStore; remote?: boolean } = {},
): Harness {
  const paths = options.paths ?? makePaths();
  const config: ProjectConfig = {
    name: "Demo",
    repo: paths.dir,
    github: "example/demo",
    queue_file: paths.queueFile,
    agents_dir: paths.agentsDir,
    gates_dir: paths.gatesDir,
    // remote: worker-r runs on an ssh machine, worker-u on a machine not listed here
    machines: options.remote
      ? {
          "build-server": {
            name: "Build Server",
            type: "ssh",
            host: "198.51.100.10",
            user: "deploy",
            key: "~/.ssh/example_key",
            runners: [],
          },
        }
      : {},
    read_only: options.readOnly ?? false,
    inbox_file: paths.inboxFile,
    dragons: {
      "worker-a": { name: "A", model: "test-model", machine: "local", instructions: "" },
      "worker-b": { name: "B", model: "test-model", machine: "local", instructions: "" },
      ...(options.remote
        ? {
            "worker-r": { name: "R", model: "test-model", machine: "build-server", instructions: "" },
            "worker-u": { name: "U", model: "test-model", machine: "gpu-box", instructions: "" },
          }
        : {}),
    },
    watchdog: { enabled: true, agent_command: AGENT_COMMAND, ...watchdog(paths) },
  };
  const procs = new FakeProcessTable();
  const runner = new FakeCommandRunner();
  const clock = new FakeClock();
  const store = options.store ?? new WatchdogStore(":memory:");
  if (!options.store) stores.push(store);
  const wd = createWatchdog({
    project: "demo",
    config,
    store,
    probes: { processes: procs, fs: new NodeFileSystem(), runner, clock },
  });
  return { ...paths, config, procs, runner, clock, store, wd };
}

/** Act mode with only `playbook` opted in. */
const act = (playbook: string, extra: Record<string, unknown> = {}) => () => ({
  mode: "act",
  actions: ACTIONS,
  playbooks: { [playbook]: { act: true } },
  ...extra,
});

/** Observe mode (the default), with the same actions configured. */
const observe = (extra: Record<string, unknown> = {}) => () => ({ actions: ACTIONS, ...extra });

/** Write a file (or make a directory) whose mtime is `minutesAgo` before NOW. */
function aged(path: string, minutesAgo: number, content: string | null = ""): string {
  if (content === null) {
    mkdirSync(path, { recursive: true });
  } else {
    writeFileSync(path, content);
  }
  const t = new Date(NOW - minutesAgo * MIN);
  utimesSync(path, t, t);
  return path;
}

function queueLine(h: Paths, line: string): void {
  appendFileSync(h.queueFile, `${line}\n`);
}

function inboxEntries(h: Paths): string[] {
  if (!existsSync(h.inboxFile)) return [];
  return readFileSync(h.inboxFile, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("- OWNER? "));
}

function breaches(h: Harness): Breach[] {
  return h.store.listBreaches("demo");
}

function runs(h: Harness): PlaybookRun[] {
  return h.store.listRuns("demo");
}

function steps(run: PlaybookRun): string[] {
  return run.steps.map((s) => `${s.type}:${s.status}`);
}

/** The act-mode bar: one run, these steps, this argv, and the breach state. */
function expectActRun(
  h: Harness,
  expected: {
    playbook: string;
    detector: string;
    argv: string[];
    outcome: "recovered" | "acted";
  },
): void {
  const [run, ...more] = runs(h);
  expect(more).toEqual([]);
  expect(run).toMatchObject({
    playbookId: expected.playbook,
    mode: "act",
    status: "succeeded",
    outcome: expected.outcome,
    attempt: 1,
  });
  expect(steps(run)).toEqual(["diagnose:succeeded", "act:succeeded", "verify:succeeded"]);
  expect(run.steps[1].command).toMatchObject({ argv: expected.argv, code: 0 });

  const [breach, ...others] = breaches(h);
  expect(others).toEqual([]);
  expect(breach.detector).toBe(expected.detector);
  expect(breach.id).toBe(run.breachId);
  if (expected.outcome === "recovered") {
    expect(breach).toMatchObject({ status: "resolved", resolution: "recovered" });
  } else {
    expect(breach.status).toBe("open");
  }
  expect(breach.escalatedAt).toBeUndefined();
  expect(inboxEntries(h)).toEqual([]);
}

/** The observe-mode bar: nothing ran, one escalation over two ticks, a planned run. */
async function expectObserved(
  h: Harness,
  expected: { playbook: string; detector: string; plannedArgv: string[]; probeCalls?: string[][] },
): Promise<void> {
  await h.wd.tick();
  await h.wd.tick();
  expect(h.runner.calls).toEqual(expected.probeCalls ?? []);

  const entries = inboxEntries(h);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toContain(`(${expected.detector})`);
  expect(entries[0]).toContain("Not acting: watchdog.mode is observe.");
  const inbox = readFileSync(h.inboxFile, "utf-8");
  expect(inbox).toContain("  - evidence: ");
  expect(inbox).toContain(`  - would run: ${expected.plannedArgv.join(" ")}`);

  const [breach, ...others] = breaches(h);
  expect(others).toEqual([]);
  expect(breach).toMatchObject({ detector: expected.detector, status: "open" });
  expect(breach.escalatedAt).toBeDefined();
  expect(h.store.listEscalations("demo")).toHaveLength(1);

  const [run, ...more] = runs(h);
  expect(more).toEqual([]);
  expect(run).toMatchObject({ playbookId: expected.playbook, mode: "observe", status: "observed" });
  expect(run.steps.find((s) => s.type === "act")?.plannedArgv).toEqual(expected.plannedArgv);
  expect(run.steps.every((s) => s.command === undefined)).toBe(true);
}

function sloState(h: Harness, detector: string): string | undefined {
  return h.store.sloStatus("demo").find((s) => s.detector === detector)?.state;
}

const GATE_A = "20260302T113000Z-login-fix-abc1234-101";

// ============ 1. DEAD LOCK HOLDER ============

describe("1. lock whose holder is dead, while agents wait", () => {
  const withLock = (mode: (p: Paths) => Record<string, unknown>) => (p: Paths) => ({
    ...mode(p),
    locks: [{ name: "gate-lock", path: p.lockDir, lease_minutes: 30 }],
  });

  function staleLock(h: Harness, options: { holderAlive?: boolean; pid?: boolean; ageMinutes?: number } = {}) {
    aged(h.lockDir, options.ageMinutes ?? 20, null);
    if (options.pid !== false) writeFileSync(join(h.lockDir, "pid"), "4001\n");
    if (options.holderAlive) h.procs.add(4001, "gate-runner --lane heavy");
    queueLine(h, `- WAITING login-fix ${GATE_A} by worker-a 11:30Z: queued on heavy`);
  }

  it("act: breaks the lock with the configured argv and records a recovered run", async () => {
    const h = setup(withLock(act("stale_lock")));
    staleLock(h);
    h.runner.when((a) => a[0] === "./bin/break-lock", {
      effect: (a) => rmSync(a[1], { recursive: true, force: true }),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/break-lock", h.lockDir, "gate-lock"]]);
    expectActRun(h, {
      playbook: "stale_lock",
      detector: "lock_holder_dead",
      argv: ["./bin/break-lock", h.lockDir, "gate-lock"],
      outcome: "recovered",
    });
    expect(breaches(h)[0].evidence).toContain("agent worker-a is WAITING");
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(withLock(observe()));
    staleLock(h);
    await expectObserved(h, {
      playbook: "stale_lock",
      detector: "lock_holder_dead",
      plannedArgv: ["./bin/break-lock", h.lockDir, "gate-lock"],
    });
    expect(existsSync(h.lockDir)).toBe(true);
  });

  it("never breaks a lock whose holder is alive", async () => {
    const h = setup(withLock(act("stale_lock")));
    staleLock(h, { holderAlive: true });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(sloState(h, "lock_holder_dead")).toBe("ok");
    expect(existsSync(h.lockDir)).toBe(true);
  });

  it("the act guard re-checks: a holder that comes back after diagnose is not broken", async () => {
    const h = setup(withLock(act("stale_lock")));
    staleLock(h);
    // ps call 1: the tick's detection, 2: the diagnose re-check, 3: the act guard
    h.procs.onList = (call) => {
      if (call === 3) h.procs.add(4001, "gate-runner --lane heavy");
    };

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    const [run] = runs(h);
    expect(steps(run)).toEqual(["diagnose:succeeded", "act:failed", "verify:skipped"]);
    expect(run.steps[1].error).toBe("refused: holder pid 4001 is running");
    expect(existsSync(h.lockDir)).toBe(true);
  });

  it("a lock with no pid is stale only past its lease", async () => {
    const young = setup(withLock(act("stale_lock")));
    staleLock(young, { pid: false, ageMinutes: 10 });
    await young.wd.tick();
    expect(young.runner.calls).toEqual([]);
    expect(breaches(young)).toEqual([]);

    const old = setup(withLock(act("stale_lock")));
    staleLock(old, { pid: false, ageMinutes: 45 });
    await old.wd.tick();
    expect(old.runner.calls).toEqual([["./bin/break-lock", old.lockDir, "gate-lock"]]);
  });
});

// ============ 2. DUPLICATE AGENT PROCESSES ============

describe("2. duplicate processes for one agent id", () => {
  function duplicates(h: Harness) {
    h.procs.add(2001, agentCmd("worker-a"), { upMinutes: 60 });
    h.procs.add(2002, agentCmd("worker-a"), { upMinutes: 2 });
    aged(join(h.agentsDir, "worker-a.log"), 1, "working\n");
  }

  it("act: stops the newer process, keeps the oldest, and verifies", async () => {
    const h = setup(act("duplicate_agent"));
    duplicates(h);
    h.runner.when((a) => a[0] === "./bin/stop-agent", { effect: (a) => h.procs.remove(Number(a[2])) });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/stop-agent", "worker-a", "2002"]]);
    expectActRun(h, {
      playbook: "duplicate_agent",
      detector: "duplicate_agent",
      argv: ["./bin/stop-agent", "worker-a", "2002"],
      outcome: "recovered",
    });
    expect(breaches(h)[0].vars).toMatchObject({ agent: "worker-a", pid: "2002", keep_pid: "2001" });
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    duplicates(h);
    await expectObserved(h, {
      playbook: "duplicate_agent",
      detector: "duplicate_agent",
      plannedArgv: ["./bin/stop-agent", "worker-a", "2002"],
    });
  });

  it("a wrapper and its child, or a similarly named agent, are not duplicates", async () => {
    const h = setup(act("duplicate_agent"));
    h.procs.add(2101, `sh -c ${agentCmd("worker-a")}`, { upMinutes: 30 });
    h.procs.add(2102, agentCmd("worker-a"), { ppid: 2101, upMinutes: 30 });
    h.procs.add(2103, agentCmd("worker-ab"), { upMinutes: 5 });
    aged(join(h.agentsDir, "worker-a.log"), 1, "working\n");

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(sloState(h, "duplicate_agent")).toBe("ok");
  });
});

// ============ 3. HUNG AGENT ============

describe("3. hung agent: alive, log silent, not WAITING on a gate", () => {
  function hung(h: Harness, latestLine = "- PROGRESS login-fix by worker-a 10:55Z: half done") {
    h.procs.add(3001, agentCmd("worker-a"), { upMinutes: 180 });
    aged(join(h.agentsDir, "worker-a-20260302T090000Z.log"), 60, "step 4 of 9\n");
    aged(join(h.agentsDir, "worker-a-20260301T090000Z.log"), 1500, "old session\n");
    queueLine(h, latestLine);
  }

  const restarts = (h: Harness) =>
    h.runner.when((a) => a[0] === "./bin/restart-agent", {
      effect: (a) => {
        h.procs.remove(Number(a[2]));
        h.procs.add(3002, agentCmd(a[1]), { upMinutes: 0 });
      },
    });

  it("act: restarts it, then verifies the old pid is gone and a new one runs", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    restarts(h);

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/restart-agent", "worker-a", "3001"]]);
    expectActRun(h, {
      playbook: "agent_stuck",
      detector: "agent_hung",
      argv: ["./bin/restart-agent", "worker-a", "3001"],
      outcome: "recovered",
    });
    expect(runs(h)[0].steps[2].output).toBe("agent worker-a is running as pid 3002");
    expect(h.clock.now()).toBe(NOW + 30_000); // the default verify delay
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    hung(h);
    await expectObserved(h, {
      playbook: "agent_stuck",
      detector: "agent_hung",
      plannedArgv: ["./bin/restart-agent", "worker-a", "3001"],
    });
  });

  it("never restarts an agent WAITING on a gate that has no result yet", async () => {
    const h = setup(act("agent_stuck"));
    hung(h, `- WAITING login-fix ${GATE_A} by worker-a 11:00Z: gate queued on heavy`);
    restarts(h);

    await h.wd.tick();
    h.clock.advance(120 * MIN);
    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(runs(h)).toEqual([]);
    expect(sloState(h, "agent_hung")).toBe("ok");
  });

  it("restarts an agent whose WAITING gate already has a result", async () => {
    const h = setup(act("agent_stuck"));
    hung(h, `- WAITING login-fix ${GATE_A} by worker-a 11:00Z: gate queued on heavy`);
    aged(join(h.resultsDir, `${GATE_A}.rc`), 50, "0\n");
    restarts(h);

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/restart-agent", "worker-a", "3001"]]);
  });

  it("a failing restart is retried after the cooldown, then escalated once", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    h.runner.when((a) => a[0] === "./bin/restart-agent", {
      reply: () => ({ code: 3, stdout: "", stderr: "session busy" }),
    });

    await h.wd.tick();
    h.clock.advance(5 * MIN);
    await h.wd.tick(); // inside the 10 min cooldown: no second attempt
    h.clock.advance(6 * MIN);
    await h.wd.tick(); // attempt 2 of 2 fails: escalate
    h.clock.advance(30 * MIN);
    await h.wd.tick(); // used up and escalated: nothing more

    const argv = ["./bin/restart-agent", "worker-a", "3001"];
    expect(h.runner.calls).toEqual([argv, argv]);
    expect(runs(h).map((r) => [r.attempt, r.status, steps(r)])).toEqual([
      [2, "failed", ["diagnose:succeeded", "act:failed", "verify:skipped"]],
      [1, "failed", ["diagnose:succeeded", "act:failed", "verify:skipped"]],
    ]);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Playbook agent_stuck failed on its last attempt (2/2).");
    expect(readFileSync(h.inboxFile, "utf-8")).toContain("session busy");
    expect(breaches(h)[0]).toMatchObject({ status: "open" });
  });

  it("the act guard re-checks: an agent that goes WAITING after diagnose is not restarted", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    restarts(h);
    // ps call 1: the tick's detection, 2: the diagnose re-check, 3: the act guard
    h.procs.onList = (call) => {
      if (call === 3) queueLine(h, `- WAITING login-fix ${GATE_A} by worker-a 11:59Z: gate queued on heavy`);
    };

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    const [run] = runs(h);
    expect(steps(run)).toEqual(["diagnose:succeeded", "act:failed", "verify:skipped"]);
    expect(run.steps[1].error).toBe(`refused: agent worker-a is WAITING on gate ${GATE_A}`);
  });

  it("a ps failure skips the breach that tick: no playbook, no attempt used up", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    h.runner.when((a) => a[0] === "./bin/restart-agent", {
      reply: () => ({ code: 3, stdout: "", stderr: "session busy" }),
    });
    const argv = ["./bin/restart-agent", "worker-a", "3001"];

    await h.wd.tick(); // attempt 1 fails
    h.clock.advance(11 * MIN);
    h.procs.failing = true;
    await h.wd.tick(); // ps fails: the open breach is left alone
    expect(h.runner.calls).toEqual([argv]);
    expect(runs(h)).toHaveLength(1);
    expect(sloState(h, "agent_hung")).toBe("error");
    expect(breaches(h)[0].status).toBe("open");
    expect(inboxEntries(h)).toEqual([]);

    h.procs.failing = false;
    await h.wd.tick(); // attempt 2 of 2, then the one escalation
    expect(h.runner.calls).toEqual([argv, argv]);
    expect(runs(h).map((r) => r.attempt)).toEqual([2, 1]);
    expect(inboxEntries(h)).toHaveLength(1);
  });

  it("a ps failure during diagnose ends the run before acting, without using up an attempt", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    restarts(h);
    h.procs.onList = (call) => {
      if (call === 2) throw new Error("ps failed (1): interrupted");
    };

    await h.wd.tick(); // diagnose fails: nothing runs
    expect(h.runner.calls).toEqual([]);
    await h.wd.tick(); // no cooldown or attempt was used: attempt 1 runs
    expect(h.runner.calls).toEqual([["./bin/restart-agent", "worker-a", "3001"]]);
    expect(runs(h).map((r) => [r.attempt, r.outcome, steps(r)])).toEqual([
      [1, "recovered", ["diagnose:succeeded", "act:succeeded", "verify:succeeded"]],
      [1, "failed", ["diagnose:failed", "act:skipped", "verify:skipped"]],
    ]);
    expect(inboxEntries(h)).toEqual([]);
  });

  it("stop() during the verify delay returns promptly; the action stands, verify is left to later ticks", async () => {
    const h = setup(act("agent_stuck"));
    hung(h);
    restarts(h);
    h.clock.blockSleeps = true;

    const tick = h.wd.tick();
    await until(() => h.clock.sleeps === 1); // restarted, now waiting 30 s to verify
    const started = Date.now();
    await h.wd.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    await tick;

    expect(h.runner.calls).toEqual([["./bin/restart-agent", "worker-a", "3001"]]);
    const [run] = runs(h);
    expect(run).toMatchObject({ status: "succeeded", outcome: "acted" });
    expect(steps(run)).toEqual(["diagnose:succeeded", "act:succeeded", "verify:skipped"]);
    expect(run.steps[2].output).toBe("watchdog stopping: left to later ticks");
    expect(breaches(h)[0].status).toBe("open");
    expect(inboxEntries(h)).toEqual([]);
  });
});

// ============ 4. ORPHAN CLAIMS ============

describe("4. claim whose agent has no live process", () => {
  it("act: releases the orphaned claim", async () => {
    const h = setup(act("orphan_claim"));
    const claim = aged(join(h.agentsDir, "worker-b.running"), 20, null);
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      effect: (a) => rmSync(a[2], { recursive: true, force: true }),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expectActRun(h, {
      playbook: "orphan_claim",
      detector: "orphan_claim",
      argv: ["./bin/release-claim", "worker-b", claim],
      outcome: "recovered",
    });
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    const claim = aged(join(h.agentsDir, "worker-b.running"), 20, null);
    await expectObserved(h, {
      playbook: "orphan_claim",
      detector: "orphan_claim",
      plannedArgv: ["./bin/release-claim", "worker-b", claim],
    });
    expect(existsSync(claim)).toBe(true);
  });

  it("never releases a live agent's claim, however old", async () => {
    const h = setup(act("orphan_claim"));
    const claim = aged(join(h.agentsDir, "worker-a.running"), 600, null);
    h.procs.add(4101, agentCmd("worker-a"), { upMinutes: 600 });
    aged(join(h.agentsDir, "worker-a.log"), 2, "working\n");

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(existsSync(claim)).toBe(true);
    expect(sloState(h, "orphan_claim")).toBe("ok");
  });
});

// ============ 5. INFRA FAILURE SIGNATURE ============

describe("5. the same failure in gates of different tracks on one lane", () => {
  function failedGate(h: Paths, id: string, minutesAgo: number, error: string, lane = "heavy") {
    aged(
      join(h.resultsDir, `${id}.log`),
      minutesAgo,
      [
        `[gate-run] ${lane} lane, track: ${id.split("-").slice(1, -2).join("-")}`,
        `== gate backend at ${id.split("-").slice(-2, -1)[0]} 2026-03-02T11:00:00Z; base 9f8e7d6`,
        "STEP commitlint: PASS (2s)",
        `STEP verify-backend: FAIL (${minutesAgo + 7}s)`,
        error,
        "Tests: 0 passed, 12 failed",
        "== FAILED STEPS: verify-backend(rc=1)",
      ].join("\n"),
    );
    aged(join(h.resultsDir, `${id}.rc`), minutesAgo, "1\n");
  }

  const dockerDown = (seconds: number) =>
    `error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock (retried for ${seconds}s at 2026-03-02T11:${10 + seconds}:00Z)`;

  function threeTracks(h: Paths) {
    failedGate(h, "20260302T111000Z-login-fix-abc1234-501", 10, dockerDown(3));
    failedGate(h, "20260302T112000Z-search-panel-def5678-502", 20, dockerDown(5));
    failedGate(h, "20260302T113000Z-billing-page-0a1b2c3-503", 30, dockerDown(8));
  }

  it("act: marks the lane broken once (verify deferred)", async () => {
    const h = setup(act("lane_broken"));
    threeTracks(h);

    await h.wd.tick();
    h.clock.advance(5 * MIN);
    await h.wd.tick(); // one attempt, still in its cooldown: nothing more

    expect(h.runner.calls).toEqual([["./bin/lane-broken", "heavy"]]);
    expectActRun(h, {
      playbook: "lane_broken",
      detector: "infra_signature",
      argv: ["./bin/lane-broken", "heavy"],
      outcome: "acted",
    });
    expect(breaches(h)[0].vars.signature).toBe(
      "error: cannot connect to the docker daemon at unix:///var/run/docker.sock (retried for <n>s at <time>)",
    );
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    threeTracks(h);
    await expectObserved(h, {
      playbook: "lane_broken",
      detector: "infra_signature",
      plannedArgv: ["./bin/lane-broken", "heavy"],
    });
  });

  it("a failure text starting with dashes never reaches the command as an option", async () => {
    const h = setup(
      act("lane_broken", {
        actions: { ...ACTIONS, mark_lane_broken: ["./bin/lane-broken", "{lane}", "{signature}"] },
      }),
    );
    const flagLike = "--- error: --force-reset lane storage unavailable";
    failedGate(h, "20260302T111000Z-login-fix-abc1234-501", 10, flagLike);
    failedGate(h, "20260302T112000Z-search-panel-def5678-502", 20, flagLike);
    failedGate(h, "20260302T113000Z-billing-page-0a1b2c3-503", 30, flagLike);

    await h.wd.tick();

    expect(h.runner.calls).toEqual([
      ["./bin/lane-broken", "heavy", "error: --force-reset lane storage unavailable"],
    ]);
  });

  it("two identical failures (not three) don't mark the lane", async () => {
    const h = setup(act("lane_broken"));
    failedGate(h, "20260302T111000Z-login-fix-abc1234-501", 10, dockerDown(3));
    failedGate(h, "20260302T112000Z-search-panel-def5678-502", 20, dockerDown(5));

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(sloState(h, "infra_signature")).toBe("ok");
  });

  it("three failures of one track, on other lanes, or outside the window don't count", async () => {
    const h = setup(act("lane_broken"));
    failedGate(h, "20260302T111000Z-login-fix-abc1234-501", 10, dockerDown(3));
    failedGate(h, "20260302T111500Z-login-fix-abc1234-504", 15, dockerDown(4));
    failedGate(h, "20260302T112000Z-search-panel-def5678-502", 20, dockerDown(5), "light");
    failedGate(h, "20260302T090000Z-billing-page-0a1b2c3-503", 180, dockerDown(8));

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
  });
});

// ============ 6. GATE OWNER GONE ============

describe("6. running gate whose runner is dead and whose log is silent", () => {
  const GATE = "20260302T110000Z-login-fix-abc1234-201";
  const RUN_FILE = `heavy.1.${GATE}.req.run`;

  function orphanedGate(h: Paths, options: { runnerAlive?: boolean; procs?: FakeProcessTable } = {}) {
    aged(join(h.queueDir, RUN_FILE), 50);
    aged(join(h.queueDir, `heavy.1.${GATE}.log`), 40, "STEP commitlint: PASS (2s)\nSTEP build:\n");
    aged(join(h.gatesDir, "runner-heavy.pid"), 50, "5001\n");
    if (options.runnerAlive) options.procs?.add(5001, "gate-runner --lane heavy");
  }

  it("act: requeues the gate and verifies it is no longer running", async () => {
    const h = setup(act("gate_owner_gone"));
    orphanedGate(h);
    h.runner.when((a) => a[0] === "./bin/requeue-gate", {
      effect: () => renameSync(join(h.queueDir, RUN_FILE), join(h.queueDir, `heavy.1.${GATE}.req`)),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/requeue-gate", GATE, "heavy"]]);
    expectActRun(h, {
      playbook: "gate_owner_gone",
      detector: "gate_owner_gone",
      argv: ["./bin/requeue-gate", GATE, "heavy"],
      outcome: "recovered",
    });
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    orphanedGate(h);
    await expectObserved(h, {
      playbook: "gate_owner_gone",
      detector: "gate_owner_gone",
      plannedArgv: ["./bin/requeue-gate", GATE, "heavy"],
    });
    expect(existsSync(join(h.queueDir, RUN_FILE))).toBe(true);
  });

  it("leaves a gate alone while its runner lives, or before the lease runs out", async () => {
    const alive = setup(act("gate_owner_gone"));
    orphanedGate(alive, { runnerAlive: true, procs: alive.procs });
    await alive.wd.tick();
    expect(alive.runner.calls).toEqual([]);
    expect(breaches(alive)).toEqual([]);

    const fresh = setup(act("gate_owner_gone"));
    orphanedGate(fresh);
    aged(join(fresh.queueDir, `heavy.1.${GATE}.log`), 5, "STEP build:\n");
    await fresh.wd.tick();
    expect(fresh.runner.calls).toEqual([]);
    expect(breaches(fresh)).toEqual([]);
  });
});

// ============ 7. IDLE CAPACITY ============

describe("7. ready work and free capacity, nothing started for 10 min", () => {
  function idle(h: Paths) {
    aged(join(h.queueDir, "light.2.20260302T113000Z-docs-fix-abc1234-301.req"), 15);
  }

  it("act: asks the project to start work", async () => {
    const h = setup(act("idle_capacity"));
    idle(h);

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/tick", "--free", "2", "--queued", "1"]]);
    expectActRun(h, {
      playbook: "idle_capacity",
      detector: "idle_capacity",
      argv: ["./bin/tick", "--free", "2", "--queued", "1"],
      outcome: "acted",
    });
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    idle(h);
    await expectObserved(h, {
      playbook: "idle_capacity",
      detector: "idle_capacity",
      plannedArgv: ["./bin/tick", "--free", "2", "--queued", "1"],
    });
  });

  it("is quiet when something started recently or capacity is used", async () => {
    const recent = setup(act("idle_capacity", { max_agents: 2 }));
    idle(recent);
    recent.procs.add(7001, agentCmd("worker-b"), { upMinutes: 3 });
    aged(join(recent.agentsDir, "worker-b.log"), 1, "starting\n");
    await recent.wd.tick();
    expect(recent.runner.calls).toEqual([]);
    expect(breaches(recent)).toEqual([]);

    const busy = setup(act("idle_capacity", { max_agents: 1 }));
    idle(busy);
    busy.procs.add(7002, agentCmd("worker-a"), { upMinutes: 90 });
    aged(join(busy.agentsDir, "worker-a.log"), 1, "working\n");
    await busy.wd.tick();
    expect(busy.runner.calls).toEqual([]);
    expect(breaches(busy)).toEqual([]);
  });

  it("counts ready tasks from ready_tasks_cmd, and how long they have waited", async () => {
    const h = setup(act("idle_capacity", { ready_tasks_cmd: ["./bin/ready-tasks"], max_agents: 3 }));
    h.runner.when((a) => a[0] === "./bin/ready-tasks", {
      reply: () => ({ code: 0, stdout: "# ready\ntask-1\ntask-2\n", stderr: "" }),
    });

    await h.wd.tick(); // ready since now: not idle for 10 min yet
    h.clock.advance(11 * MIN);
    await h.wd.tick();

    const probe = ["./bin/ready-tasks"];
    // tick 1: one view; tick 2: the tick's view, the diagnose re-check, then the action
    expect(h.runner.calls).toEqual([probe, probe, probe, ["./bin/tick", "--free", "3", "--queued", "0"]]);
    expect(breaches(h)[0].vars).toMatchObject({ ready: "2", queued: "0", free: "3", running: "0" });
  });
});

// ============ 8. PROGRESS STALL ============

describe("8. no merge for 4 h while work is queued (read from the queue file)", () => {
  function stalled(h: Harness, mergedAt: string) {
    queueLine(h, `- MERGED #41 login-fix by worker-a ${mergedAt}: merged`);
    queueLine(h, "- PROGRESS search-panel by worker-a 11:50Z: tests written");
    aged(join(h.agentsDir, "worker-a.running"), 200, null);
    h.procs.add(8001, agentCmd("worker-a"), { upMinutes: 200 });
    aged(join(h.agentsDir, "worker-a.log"), 1, "working\n");
  }

  it("an undated (HH:MMZ) MERGED line can't pass for a recent merge: merged_cmd decides", async () => {
    // "11:30Z" may be from any day; read as today it would look 30 min old
    const h = setup(act("no_merges", { merged_cmd: ["./bin/last-merge"] }));
    stalled(h, "11:30Z");
    h.runner.when((a) => a[0] === "./bin/last-merge", {
      reply: () => ({ code: 0, stdout: "2026-03-02T05:30:00Z\n", stderr: "" }),
    });

    await h.wd.tick();

    // the tick's detection, the diagnose re-check, then the action
    expect(h.runner.calls).toEqual([["./bin/last-merge"], ["./bin/last-merge"], ["./bin/triage", "6.5"]]);
  });

  it("without merged_cmd, an undated latest MERGED line means the last merge is unknown", async () => {
    const h = setup(act("no_merges"));
    queueLine(h, "- MERGED #39 docs-fix by worker-a 2026-03-01T20:00:00Z: merged"); // 16 h ago
    stalled(h, "11:30Z"); // later in the file, but undated

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    const slo = h.store.sloStatus("demo").find((s) => s.detector === "progress_stall");
    expect(slo).toMatchObject({ state: "ok" });
    expect(slo?.detail).toContain("the latest MERGED line has no date");
  });

  it("act: runs the triage command", async () => {
    const h = setup(act("no_merges"));
    stalled(h, "2026-03-02T06:30:00Z");

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/triage", "5.5"]]);
    expectActRun(h, {
      playbook: "no_merges",
      detector: "progress_stall",
      argv: ["./bin/triage", "5.5"],
      outcome: "acted",
    });
  });

  it("observe: runs nothing and escalates once", async () => {
    const h = setup(observe());
    stalled(h, "2026-03-02T06:30:00Z");
    await expectObserved(h, {
      playbook: "no_merges",
      detector: "progress_stall",
      plannedArgv: ["./bin/triage", "5.5"],
    });
  });

  it("a recent merge in the file means no stall, also for a freshly started watchdog", async () => {
    const first = setup(act("no_merges"));
    stalled(first, "2026-03-02T10:00:00Z");
    await first.wd.tick();
    expect(first.runner.calls).toEqual([]);

    // A restart: a new store and a new watchdog read the same persisted file
    const second = setup(act("no_merges"), { paths: first });
    second.procs.add(8001, agentCmd("worker-a"), { upMinutes: 200 });
    await second.wd.tick();
    expect(second.runner.calls).toEqual([]);
    expect(breaches(second)).toEqual([]);
    expect(sloState(second, "progress_stall")).toBe("ok");
  });

  it("a merged PR reported by merged_cmd counts as progress", async () => {
    const h = setup(act("no_merges", { merged_cmd: ["./bin/last-merge"] }));
    stalled(h, "2026-03-02T06:30:00Z");
    h.runner.when((a) => a[0] === "./bin/last-merge", {
      reply: () => ({ code: 0, stdout: '[{"number":42,"mergedAt":"2026-03-02T11:15:00Z"}]', stderr: "" }),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/last-merge"]]);
    expect(breaches(h)).toEqual([]);
  });
});

// ============ 9. CRASH LOOP ============

describe("9. a container's restart count rising within the window", () => {
  const containers = [{ name: "api", max_restarts: 3, window_minutes: 10 }];
  const INSPECT = ["docker", "inspect", "--format", "{{.RestartCount}}", "api"];

  function restartCounts(h: Harness, counts: number[]) {
    let i = 0;
    h.runner.when((a) => a[0] === "docker" && a[1] === "inspect", {
      reply: () => ({ code: 0, stdout: `${counts[Math.min(i++, counts.length - 1)]}\n`, stderr: "" }),
    });
  }

  async function threeSamples(h: Harness) {
    await h.wd.tick();
    h.clock.advance(2 * MIN);
    await h.wd.tick();
    h.clock.advance(2 * MIN);
    await h.wd.tick();
  }

  it("act: stops the container's restarts", async () => {
    const h = setup(act("crash_loop", { containers }));
    restartCounts(h, [5, 7, 9]);

    await threeSamples(h);

    // three ticks' samples, the diagnose re-check, then the action
    expect(h.runner.calls).toEqual([INSPECT, INSPECT, INSPECT, INSPECT, ["docker", "update", "--restart=no", "api"]]);
    expectActRun(h, {
      playbook: "crash_loop",
      detector: "crash_loop",
      argv: ["docker", "update", "--restart=no", "api"],
      outcome: "acted",
    });
    expect(breaches(h)[0].vars).toEqual({ container: "api", restarts: "4" });
  });

  it("observe: only inspects, and escalates once", async () => {
    const h = setup(observe({ containers }));
    restartCounts(h, [5, 7, 9]);
    await h.wd.tick();
    h.clock.advance(2 * MIN);
    await h.wd.tick();
    h.clock.advance(2 * MIN);
    await expectObserved(h, {
      playbook: "crash_loop",
      detector: "crash_loop",
      plannedArgv: ["docker", "update", "--restart=no", "api"],
      probeCalls: [INSPECT, INSPECT, INSPECT, INSPECT],
    });
  });

  it("a steady count, or a reset after the container is recreated, is not a loop", async () => {
    const steady = setup(act("crash_loop", { containers }));
    restartCounts(steady, [4, 4, 4]);
    await threeSamples(steady);
    expect(steady.runner.calls).toEqual([INSPECT, INSPECT, INSPECT]);
    expect(breaches(steady)).toEqual([]);

    const reset = setup(act("crash_loop", { containers }));
    restartCounts(reset, [6, 0, 1]);
    await threeSamples(reset);
    expect(reset.runner.calls).toEqual([INSPECT, INSPECT, INSPECT]);
    expect(breaches(reset)).toEqual([]);
  });
});

// ============ MODES AND OPT-IN ============

describe("modes: act needs mode act, read_only false and the playbook's opt-in", () => {
  function orphan(h: Paths): string {
    return aged(join(h.agentsDir, "worker-b.running"), 20, null);
  }

  it("act mode without the playbook's opt-in runs nothing and escalates once", async () => {
    const h = setup(() => ({ mode: "act", actions: ACTIONS }));
    orphan(h);
    await h.wd.tick();
    await h.wd.tick();
    expect(h.runner.calls).toEqual([]);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Not acting: no playbook for orphan_claim has act: true.");
  });

  it("act mode on a read_only project runs nothing and escalates once", async () => {
    const h = setup(act("orphan_claim"), { readOnly: true });
    orphan(h);
    await h.wd.tick();
    await h.wd.tick();
    expect(h.runner.calls).toEqual([]);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Not acting: the project is read_only.");
  });

  it("escalation_file overrides inbox_file", async () => {
    const h = setup((p) => ({ ...observe()(), escalation_file: join(p.dir, "decisions.md") }));
    orphan(h);
    await h.wd.tick();
    expect(inboxEntries(h)).toEqual([]);
    const decisions = readFileSync(join(h.dir, "decisions.md"), "utf-8");
    expect(decisions.split("\n").filter((l) => l.startsWith("- OWNER? "))).toHaveLength(1);
    expect(h.store.listEscalations("demo")[0].file).toBe(join(h.dir, "decisions.md"));
  });

  it("a cleared breach that comes back is escalated again only after reescalate_minutes", async () => {
    const h = setup(observe());
    const claim = orphan(h);
    await h.wd.tick(); // escalated
    rmSync(claim, { recursive: true });
    await h.wd.tick();
    expect(breaches(h)[0]).toMatchObject({ status: "resolved", resolution: "cleared" });

    aged(claim, 30, null);
    h.clock.advance(10 * MIN);
    await h.wd.tick(); // back within 60 min: recorded, not written
    expect(inboxEntries(h)).toHaveLength(1);
    expect(h.store.listEscalations("demo").map((e) => e.suppressed)).toEqual([true, false]);

    rmSync(claim, { recursive: true });
    await h.wd.tick();
    aged(claim, 30, null);
    h.clock.advance(61 * MIN);
    await h.wd.tick(); // back after more than 60 min: escalated
    expect(breaches(h).map((b) => b.status)).toEqual(["open", "resolved", "resolved"]);
    expect(inboxEntries(h)).toHaveLength(2);
  });

  it("process-based detectors are inactive without agent_command", async () => {
    const h = setup(() => ({ agent_command: undefined, actions: ACTIONS }));
    orphan(h);
    await h.wd.tick();
    expect(breaches(h)).toEqual([]);
    expect(sloState(h, "orphan_claim")).toBe("inactive");
    expect(sloState(h, "agent_hung")).toBe("inactive");
    expect(sloState(h, "duplicate_agent")).toBe("inactive");
  });
});

// ============ REMOTE AGENTS ============

describe("remote agents: the local process table says nothing about them", () => {
  it("never releases a remote agent's claim, even in act mode", async () => {
    const h = setup(act("orphan_claim"), { remote: true });
    const onSsh = aged(join(h.agentsDir, "worker-r.running"), 120, null);
    const onUnlisted = aged(join(h.agentsDir, "worker-u.running"), 120, null);
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      effect: (a) => rmSync(a[2], { recursive: true, force: true }),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    expect(existsSync(onSsh)).toBe(true);
    expect(existsSync(onUnlisted)).toBe(true);
    const slo = h.store.sloStatus("demo").find((s) => s.detector === "orphan_claim");
    expect(slo?.detail).toBe("not checked (remote agents): worker-r (build-server), worker-u (gpu-box)");
  });

  it("counts a remote agent with a claim as running for idle capacity", async () => {
    const h = setup(act("idle_capacity", { max_agents: 1 }), { remote: true });
    aged(join(h.agentsDir, "worker-r.running"), 120, null);
    aged(join(h.queueDir, "light.2.20260302T113000Z-docs-fix-abc1234-301.req"), 15);

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
    const slo = h.store.sloStatus("demo").find((s) => s.detector === "idle_capacity");
    expect(slo?.detail).toContain("1 agent(s) running of max 1");
  });

  it("ignores local processes that match a remote agent (an ssh wrapper is not the agent)", async () => {
    const h = setup(act("duplicate_agent", { playbooks: { duplicate_agent: { act: true }, agent_stuck: { act: true } } }), {
      remote: true,
    });
    h.procs.add(9001, `ssh build-server ${agentCmd("worker-r")}`, { upMinutes: 300 });
    h.procs.add(9002, `ssh build-server ${agentCmd("worker-r")}`, { upMinutes: 200 });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(breaches(h)).toEqual([]);
  });
});

// ============ DECISION INBOX ============

describe("Decision Inbox: an escalation is a decision, and its answer drives the watchdog", () => {
  const decisionStores: DecisionStore[] = [];
  afterEach(() => {
    for (const store of decisionStores.splice(0)) {
      try {
        store.close();
      } catch {}
    }
  });

  /** The real Decision Inbox, on the harness clock, connected as the server connects it. */
  function connect(h: Harness, dbPath = ":memory:") {
    const store = new DecisionStore(dbPath);
    decisionStores.push(store);
    const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock: h.clock });
    h.wd.useDecisions(inbox);
    return { inbox, store };
  }

  const BLOCK = "watchdog:demo:orphan_claim:worker-b.running";
  const orphan = (h: Paths) => aged(join(h.agentsDir, "worker-b.running"), 20, null);
  const releases = (h: Harness) =>
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      effect: (a) => rmSync(a[2], { recursive: true, force: true }),
    });

  it("observe: raises one decision with the evidence instead of an inbox line, and parks the breach", async () => {
    const h = setup(observe());
    const claim = orphan(h);
    const { inbox } = connect(h);

    await h.wd.tick();
    h.clock.advance(30 * MIN);
    await h.wd.tick();

    expect(h.runner.calls).toEqual([]);
    expect(inboxEntries(h)).toEqual([]);
    const [breach, ...others] = breaches(h);
    expect(others).toEqual([]);
    const [decision, ...more] = inbox.list();
    expect(more).toEqual([]);
    expect(decision).toMatchObject({
      project: "demo",
      kind: "escalation",
      status: "open",
      title: "Claim worker-b.running has no live agent process",
      source: { module: "watchdog", ref: breach.id },
      key: `breach:${breach.id}`,
      blocks: [BLOCK],
      recommended: { optionId: "run_playbook" },
    });
    expect(decision.options.map((o) => o.id)).toEqual(["run_playbook", "stand_down"]);
    expect(decision.context).toContain("Not acting: watchdog.mode is observe.");
    expect(decision.context).toContain(`- claim ${claim} is 20 min old`);
    expect(decision.context).toContain(`- would run: ./bin/release-claim worker-b ${claim}`);
    expect(inbox.blockedOn(BLOCK)?.id).toBe(decision.id);
    expect(h.store.listEscalations("demo")).toMatchObject([{ breachId: breach.id, decisionId: decision.id }]);
    expect(h.store.listEscalations("demo")[0].file).toBeUndefined();
    expect(h.store.breachDecision(breach.id)).toMatchObject({ decisionId: decision.id, state: "open" });
    expect(breach.escalatedAt).toBeDefined();
  });

  it("run_playbook: the next tick runs the playbook once, also in observe mode, and the breach recovers", async () => {
    const h = setup(observe());
    const claim = orphan(h);
    releases(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision] = inbox.list();

    const answered = await inbox.answer(decision.id, { optionId: "run_playbook" });
    expect(answered.deliveredAt).toBeDefined();
    expect(h.store.breachDecision(breaches(h)[0].id)).toMatchObject({ decisionId: decision.id, state: "run" });
    expect(h.runner.calls).toEqual([]);

    await h.wd.tick();
    expect(h.runner.calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expect(runs(h).find((r) => r.mode === "act")).toMatchObject({
      playbookId: "orphan_claim",
      status: "succeeded",
      outcome: "recovered",
      attempt: 1,
    });
    expect(breaches(h)[0]).toMatchObject({ status: "resolved", resolution: "recovered" });
    expect(h.store.breachDecision(breaches(h)[0].id)?.state).toBe("done");

    h.clock.advance(30 * MIN);
    await h.wd.tick();
    expect(h.runner.calls).toHaveLength(1);
    expect(inbox.list()).toHaveLength(1);
  });

  it("stand_down: nothing more runs or asks for the breach, which closes once it clears", async () => {
    const h = setup(observe());
    const claim = orphan(h);
    releases(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision] = inbox.list();
    await inbox.answer(decision.id, { optionId: "stand_down", note: "Looking at it myself." });

    for (let i = 0; i < 3; i++) {
      h.clock.advance(30 * MIN);
      await h.wd.tick();
    }
    expect(h.runner.calls).toEqual([]);
    expect(inbox.list().map((d) => d.status)).toEqual(["answered"]);
    expect(breaches(h)[0]).toMatchObject({ status: "open" });
    expect(h.store.breachDecision(breaches(h)[0].id)?.state).toBe("stand_down");

    rmSync(claim, { recursive: true });
    await h.wd.tick();
    expect(breaches(h)[0]).toMatchObject({ status: "resolved", resolution: "cleared" });
    expect(inbox.get(decision.id)?.status).toBe("answered");
  });

  it("withdraws the open decision of a breach that clears on its own", async () => {
    const h = setup(observe());
    const claim = orphan(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision] = inbox.list();

    rmSync(claim, { recursive: true });
    await h.wd.tick();

    expect(breaches(h)[0]).toMatchObject({ status: "resolved", resolution: "cleared" });
    expect(inbox.get(decision.id)).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "The breach cleared: orphan_claim no longer reports it.",
    });
    expect(inbox.blockedOn(BLOCK)).toBeNull();
    expect(h.store.breachDecision(breaches(h)[0].id)?.state).toBe("closed");
  });

  it("act mode, playbooks used up: recommends standing down, and an approved run that fails asks again", async () => {
    const h = setup(act("orphan_claim"));
    const claim = orphan(h);
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      reply: () => ({ code: 1, stdout: "", stderr: "claim is locked" }),
    });
    const { inbox } = connect(h);

    await h.wd.tick(); // attempt 1 fails
    h.clock.advance(11 * MIN);
    await h.wd.tick(); // attempt 2 of 2 fails: escalate
    const [first, ...none] = inbox.list();
    expect(none).toEqual([]);
    expect(first).toMatchObject({ status: "open", recommended: { optionId: "stand_down" } });
    expect(first.recommended.reasoning).toContain("already ran (attempt 2)");
    expect(first.context).toContain("Playbook orphan_claim failed on its last attempt (2/2).");
    expect(first.context).toContain("claim is locked");

    h.clock.advance(11 * MIN);
    await h.wd.tick(); // parked: no third attempt, no second escalation
    expect(h.runner.calls).toHaveLength(2);

    await inbox.answer(first.id, { optionId: "run_playbook" });
    await h.wd.tick(); // the approved attempt 3 fails: ask again
    const argv = ["./bin/release-claim", "worker-b", claim];
    expect(h.runner.calls).toEqual([argv, argv, argv]);
    expect(runs(h)[0]).toMatchObject({ playbookId: "orphan_claim", attempt: 3, status: "failed" });

    const decisions = inbox.list();
    expect(decisions.map((d) => d.status)).toEqual(["open", "answered"]);
    expect(decisions[0].key).toBe(first.key);
    expect(decisions[0].context).toContain("The approved run of playbook orphan_claim failed (attempt 3).");
    expect(h.store.listEscalations("demo")).toMatchObject([{ decisionId: decisions[0].id }]);

    h.clock.advance(60 * MIN);
    await h.wd.tick(); // parked again
    expect(h.runner.calls).toHaveLength(3);
  });

  it("read_only: offers no run, so the only answer is to leave it to you", async () => {
    const h = setup(act("orphan_claim"), { readOnly: true });
    orphan(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision] = inbox.list();
    expect(decision.options.map((o) => o.id)).toEqual(["stand_down"]);
    expect(decision.recommended).toEqual({
      optionId: "stand_down",
      reasoning: "The project is read_only, so Lair runs no command for it: only you can fix this.",
    });
    expect(decision.context).toContain("Not acting: the project is read_only.");
    expect(h.runner.calls).toEqual([]);
  });

  it("offers no run when the playbook's command is not configured", async () => {
    const h = setup(() => ({ actions: {} }));
    orphan(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision] = inbox.list();
    expect(decision.options.map((o) => o.id)).toEqual(["stand_down"]);
    expect(decision.recommended.reasoning).toBe(
      "No playbook for orphan_claim has its watchdog.actions command configured, so only you can fix this.",
    );
  });

  it("escalation_file still gets a copy of the entry", async () => {
    const h = setup((p) => ({ ...observe()(), escalation_file: join(p.dir, "decisions.md") }));
    orphan(h);
    const { inbox } = connect(h);
    await h.wd.tick();
    const [decision, ...more] = inbox.list();
    expect(more).toEqual([]);
    expect(inboxEntries(h)).toEqual([]);
    const copy = readFileSync(join(h.dir, "decisions.md"), "utf-8");
    expect(copy.split("\n").filter((l) => l.startsWith("- OWNER? "))).toHaveLength(1);
    expect(h.store.listEscalations("demo")[0]).toMatchObject({
      file: join(h.dir, "decisions.md"),
      decisionId: decision.id,
    });
  });

  it("writes the inbox file as before when the decision can't be raised", async () => {
    const h = setup(observe());
    orphan(h);
    const { store } = connect(h);
    store.close();
    await h.wd.tick();
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Not acting: watchdog.mode is observe.");
    expect(h.store.listEscalations("demo")[0].text).toContain("  - could not raise a decision: ");
    expect(h.store.breachDecision(breaches(h)[0].id)).toBeNull();
  });

  it("follows an answer given while it was stopped once it listens again (a restart)", async () => {
    const paths = makePaths();
    const watchdogDb = join(paths.dir, "watchdog.db");
    const decisionsDb = join(paths.dir, "decisions.db");
    const before = setup(observe(), { paths, store: new WatchdogStore(watchdogDb) });
    const claim = orphan(before);
    const first = connect(before, decisionsDb);
    await before.wd.tick();
    const [decision] = first.inbox.list();
    await before.wd.stop();
    const answered = await first.inbox.answer(decision.id, { optionId: "run_playbook" });
    expect(answered.deliveredAt).toBeUndefined();
    before.store.close();
    first.store.close();

    const after = setup(observe(), { paths, store: new WatchdogStore(watchdogDb) });
    stores.push(after.store);
    releases(after);
    const second = connect(after, decisionsDb);
    await second.inbox.deliverPending();
    expect(second.inbox.get(decision.id)?.deliveredAt).toBeDefined();

    await after.wd.tick();
    expect(after.runner.calls).toEqual([["./bin/release-claim", "worker-b", claim]]);
    expect(breaches(after)[0]).toMatchObject({ status: "resolved", resolution: "recovered" });
  });
});


// ============ 12. ORPHAN CLAIM WITH LIVE PID ============

describe("12. orphan claim: live pid that doesn't match the pattern", () => {
  it("a claim with a live pid that matches by command is not an orphan", async () => {
    const h = setup(act("orphan_claim"));
    // Create a claim file with pid recorded
    const claimDir = join(h.agentsDir, "worker-b.running");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "pid"), "pid=4999\nstarted=2026-03-02T11:00:00.000Z\n");
    // The claim is old enough
    const t = new Date(NOW - 20 * 60 * 1000);
    utimesSync(claimDir, t, t);
    // The pid is alive and its command contains the agent id (worker-b)
    h.procs.add(4999, "/different/path/to/agent --id worker-b", { upMinutes: 20 });

    await h.wd.tick();

    // No breach: the live pid's command contains the agent id
    expect(breaches(h)).toEqual([]);
    expect(h.runner.calls).toEqual([]);
    expect(sloState(h, "orphan_claim")).toBe("ok");
  });

  it("a claim with a dead recorded pid is an orphan as before", async () => {
    const h = setup(act("orphan_claim"));
    const claimDir = join(h.agentsDir, "worker-b.running");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "pid"), "pid=4999\nstarted=2026-03-02T10:00:00.000Z\n");
    const t = new Date(NOW - 20 * 60 * 1000);
    utimesSync(claimDir, t, t);
    // No process with pid 4999 is running
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      effect: (a) => rmSync(a[2], { recursive: true, force: true }),
    });

    await h.wd.tick();

    expect(h.runner.calls).toEqual([["./bin/release-claim", "worker-b", claimDir]]);
    expect(breaches(h)[0]).toMatchObject({ detector: "orphan_claim" });
  });

  it("a claim's recorded pid matching by command clears the breach", async () => {
    const h = setup(act("orphan_claim"));
    // Create claim with pid=4999, WITH a live process whose command contains the agent id
    const claimDir = join(h.agentsDir, "worker-b.running");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "pid"), "pid=4999\nstarted=2026-03-02T11:00:00.000Z\n");
    const t = new Date(NOW - 20 * 60 * 1000);
    utimesSync(claimDir, t, t);

    // The process is running with the agent id in the command
    h.procs.add(4999, "/different/path/to/agent --id worker-b", { upMinutes: 1 });

    // Tick: detection should NOT find this claim as orphaned (pid 4999 matches by command)
    await h.wd.tick();

    // No breach should be created because the process command contains worker-b
    expect(breaches(h)).toHaveLength(0);
    expect(h.runner.calls).toEqual([]); // release_claim never ran
  });

  it("a claim with a live pid that belongs to a different process is an orphan (pid reuse)", async () => {
    const h = setup(act("orphan_claim"));
    // Create claim with pid=4999 for worker-b
    const claimDir = join(h.agentsDir, "worker-b.running");
    mkdirSync(claimDir, { recursive: true });
    // The claim says pid 4999, started at 11:00:00
    writeFileSync(join(claimDir, "pid"), "pid=4999\nstarted=2026-03-02T11:00:00.000Z\n");
    const t = new Date(NOW - 20 * 60 * 1000);
    utimesSync(claimDir, t, t);

    // Pid 4999 IS alive, but it's a DIFFERENT process (no worker-b in command, wrong uptime)
    // The process started 5 minutes ago, but the claim's started time is older
    h.procs.add(4999, "/usr/bin/some-unrelated-process", { upMinutes: 5 });

    // Set up the release-claim playbook to remove the claim
    h.runner.when((a) => a[0] === "./bin/release-claim", {
      effect: (a) => rmSync(a[2], { recursive: true, force: true }),
    });

    await h.wd.tick();

    // This should be detected as an orphan because:
    // - The pid 4999 is alive BUT
    // - The command doesn't contain "worker-b"
    // - The process uptime (5 min) doesn't match the claim's start time (would be 20 min old)
    expect(breaches(h)).toHaveLength(1);
    expect(breaches(h)[0]).toMatchObject({ detector: "orphan_claim" });
    expect(h.runner.calls).toEqual([["./bin/release-claim", "worker-b", claimDir]]);
  });
});
