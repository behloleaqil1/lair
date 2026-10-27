/**
 * Agents module acceptance tests.
 *
 * Only the system boundary is fake: the process table, the process spawner
 * (which, like a real agent CLI, writes its log, keeps running or exits) and
 * the clock. Files are real, in a temp dir, and so is the SQLite store. Every
 * test drives the production AgentsService as AgentsManager wires it (the
 * HTTP tests through registerAgentsRoutes), then asserts what was spawned or
 * signalled, the files on disk, and what the store recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentAdapter, ProjectConfig } from "../../shared/types.js";
import type { AgentEventKind, AgentsStatusView, AgentView, PromptFileView } from "../../shared/agents-types.js";
import { EventBus } from "../core/event-bus.js";
import { BudgetManager } from "../fleet/budget.js";
import {
  NodeFileSystem,
  type Clock,
  type CommandOutput,
  type CommandRunner,
  type ProcessInfo,
  type ProcessTable,
} from "../watchdog/probes.js";
import { WatchdogManager } from "../watchdog/service.js";
import { AgentsManager, type AgentsService } from "./service.js";
import { registerAgentsRoutes } from "./routes.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { mountDecisions } from "../decisions/index.js";
import {
  freshSessionAction,
  ownerRequest,
  promptFileUrl,
  promptsUrl,
  releaseClaimAction,
  startRunAction,
} from "../../client/agents-actions";
import { readLock } from "./locks.js";
import { DataService } from "../services/data.js";
import { listPromptFiles, MAX_PROMPT_FILE_BYTES, PromptFileError, readPromptFile } from "./prompts.js";
import type { AgentProbes, ProcessOwner, ProcessSpawner, SpawnOptions } from "./probes.js";
import type { DecisionInbox, DecisionRequest } from "./decisions.js";
import type { AgentsStore } from "./store.js";
import type { AgentEvent, AgentRun } from "./types.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SEC = 1000;
const MIN = 60_000;
/** This server process */
const SELF: ProcessOwner = { pid: 100, startedAt: NOW - 60 * MIN };

class FakeClock implements Clock {
  t = NOW;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Processes with real start times: `ps` elapsed times grow as the clock moves. */
class FakeProcessTable implements ProcessTable {
  private procs = new Map<number, { startedAt: number; command: string }>();
  failing = false;
  constructor(private clock: FakeClock) {}
  add(pid: number, command: string, startedAt: number = this.clock.now()): void {
    this.procs.set(pid, { startedAt, command });
  }
  remove(pid: number): void {
    this.procs.delete(pid);
  }
  has(pid: number): boolean {
    return this.procs.has(pid);
  }
  listCalls = 0;
  /** Runs right after reading n is taken: what happens on the machine between two readings */
  afterList?: (call: number) => void;
  async list(): Promise<ProcessInfo[]> {
    if (this.failing) throw new Error("ps failed (1): cannot read the process table");
    this.listCalls++;
    const reading = [...this.procs.entries()].map(([pid, p]) => ({
      pid,
      ppid: 1,
      elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - p.startedAt) / 1000)),
      argv: p.command.split(" "),
      command: p.command,
    }));
    this.afterList?.(this.listCalls);
    return reading;
  }
}

/** Append to a log as the agent would, the file's mtime following the clock. */
function writeLog(clock: FakeClock, path: string, text: string): void {
  appendFileSync(path, text);
  const t = new Date(clock.now());
  utimesSync(path, t, t);
}

interface SpawnCall {
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  logPath: string;
}

class FakeSpawner implements ProcessSpawner {
  calls: SpawnCall[] = [];
  kills: { pid: number; signal: string }[] = [];
  private exits = new Map<number, number | null>();
  nextPid = 5001;
  /** Every spawn fails with this message while set */
  failAll?: string;
  /** A stuck process ignores SIGTERM */
  ignoreTerm = false;
  /** What a started process does at once: write its log, exit, ... */
  behaviour?: (pid: number, logPath: string, call: number) => void;

  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}

  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    this.calls.push({ argv: [...argv], env: { ...options.env }, cwd: options.cwd, logPath: options.logPath });
    if (this.failAll) throw new Error(this.failAll);
    writeLog(this.clock, options.logPath, "");
    const pid = this.nextPid++;
    this.started.add(pid);
    this.procs.add(pid, argv.join(" "), this.clock.now());
    this.behaviour?.(pid, options.logPath, this.calls.length);
    return { pid, startedAt: this.clock.now() };
  }

  private started = new Set<number>();

  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }

  knows(pid: number): boolean {
    return this.started.has(pid);
  }

  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push({ pid, signal });
    if (signal === "SIGKILL" || !this.ignoreTerm) this.exit(pid, null);
    return true;
  }

  forget(pid: number): void {
    this.exits.delete(pid);
    this.started.delete(pid);
  }

  /** The process ends with this exit code */
  exit(pid: number, code: number | null): void {
    this.procs.remove(pid);
    this.exits.set(pid, code);
  }
}

class FakeCommandRunner implements CommandRunner {
  calls: string[][] = [];
  stdout = "";
  async run(argv: string[]): Promise<CommandOutput> {
    this.calls.push([...argv]);
    return { code: 0, stdout: this.stdout, stderr: "" };
  }
}

// ============ PROJECT FIXTURE ============

const ADAPTERS: Record<string, AgentAdapter> = {
  "test-cli": {
    id: "test-cli",
    name: "Test CLI",
    start_cmd: "agent-cli run --agent {agent_id} --model {model} --prompt {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    log_dir: "logs",
    session_id_env: "AGENT_SESSION_ID",
    resume_flag: "--resume {session_id}",
  },
  "other-cli": {
    id: "other-cli",
    name: "Other CLI",
    start_cmd: "other-cli --model {model} --task-file {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    log_dir: "logs",
    resume_flag: "--continue {session_id}",
  },
};

const BASE = {
  enabled: true,
  interval_seconds: 1,
  start_timeout_minutes: 10,
  dead_on_start_seconds: 60,
  hung_minutes: 45,
  stop_grace_seconds: 30,
  session_dir: "{agents_dir}/sessions/{agent}",
  recovery: { same_session_restarts: 2, fresh_sessions: 1, backoff_seconds: 10, max_backoff_seconds: 600 },
  retries: { max_retries: 2, backoff_seconds: 60, max_backoff_seconds: 3600 },
  providers: { "test-cli": "provider-a" },
};

const FALLBACK = { fallbacks: { "worker-a": [{ adapter: "other-cli", model: "model-b", provider: "provider-b" }] } };

interface Paths {
  dir: string;
  agentsDir: string;
  gatesDir: string;
  queueFile: string;
  inboxFile: string;
  promptsDir: string;
  locksDir: string;
  sessionDir: string;
  dbPath: string;
}

interface Harness extends Paths {
  config: ProjectConfig;
  clock: FakeClock;
  procs: FakeProcessTable;
  spawner: FakeSpawner;
  runner: FakeCommandRunner;
  manager: AgentsManager;
  service: AgentsService;
  store: AgentsStore;
  bus: string[];
}

const dirs: string[] = [];
const managers: AgentsManager[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const manager of managers.splice(0)) await manager.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "lair-agents-"));
  dirs.push(dir);
  const agentsDir = join(dir, "agents");
  const paths: Paths = {
    dir,
    agentsDir,
    gatesDir: join(dir, "gates"),
    queueFile: join(dir, "queue.md"),
    inboxFile: join(dir, "inbox.md"),
    promptsDir: join(dir, "prompts"),
    locksDir: join(dir, "locks"),
    sessionDir: join(agentsDir, "sessions", "worker-a"),
    dbPath: join(dir, "data", "agents.db"),
  };
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(paths.gatesDir, "results"), { recursive: true });
  mkdirSync(paths.locksDir, { recursive: true });
  writeFileSync(paths.queueFile, "# Queue\n");
  return paths;
}

function projectConfig(paths: Paths, agents: Record<string, unknown> | undefined, readOnly = false): ProjectConfig {
  const config = {
    name: "Demo",
    repo: paths.dir,
    github: "example/demo",
    queue_file: paths.queueFile,
    agents_dir: paths.agentsDir,
    gates_dir: paths.gatesDir,
    machines: {},
    read_only: readOnly,
    inbox_file: paths.inboxFile,
    prompts_dir: paths.promptsDir,
    dragons: {
      "worker-a": { name: "A", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
      "worker-b": { name: "B", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
    },
    agent_adapters: ADAPTERS,
    agents,
  };
  return config as ProjectConfig;
}

function setup(
  agents: (p: Paths) => Record<string, unknown> = () => ({}),
  options: { paths?: Paths; self?: ProcessOwner; readOnly?: boolean; budget?: BudgetManager; decisions?: DecisionInbox } = {},
): Harness {
  const paths = options.paths ?? makePaths();
  const config = projectConfig(paths, { ...BASE, ...agents(paths) }, options.readOnly);
  const clock = new FakeClock();
  const procs = new FakeProcessTable(clock);
  const spawner = new FakeSpawner(procs, clock);
  const runner = new FakeCommandRunner();
  const events = new EventBus();
  const bus: string[] = [];
  events.on("*", (event) => {
    bus.push(event.type);
  });
  const probes: AgentProbes = {
    processes: procs,
    fs: new NodeFileSystem(),
    runner,
    clock,
    spawner,
    self: options.self ?? SELF,
  };
  const manager = new AgentsManager({
    dbPath: paths.dbPath,
    probes,
    events,
    budget: options.budget,
    decisions: options.decisions,
  });
  managers.push(manager);
  manager.load([{ name: "demo", config }]);
  const service = manager.get("demo");
  const store = manager.getStore();
  if (!service || !store) throw new Error(`agents not enabled: ${manager.status("demo").errors.join("; ")}`);
  return { ...paths, config, clock, procs, spawner, runner, manager, service, store, bus };
}

const request = (h: Harness, agent = "worker-a", task = "feat-login", prompt = "Build the login form") =>
  h.service.requestRun({ agent, task, prompt });

/** Move the clock to NOW + ms, then tick. */
async function at(h: Harness, ms: number) {
  h.clock.t = NOW + ms;
  return h.service.tick();
}

/** Events of a kind, oldest first. */
function eventsOf(h: Harness, kind: AgentEventKind): AgentEvent[] {
  return h.store.listEvents("demo", { kinds: [kind], limit: 500 }).reverse();
}

/** Runs, oldest first. */
function runs(h: Harness): AgentRun[] {
  return h.store.listRuns("demo", { limit: 500 }).reverse();
}

function inboxEntries(h: Paths): string[] {
  if (!existsSync(h.inboxFile)) return [];
  return readFileSync(h.inboxFile, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("- OWNER? "));
}

function agentView(status: AgentsStatusView, id: string): AgentView {
  const agent = status.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`no agent ${id}`);
  return agent;
}

const lockText = (pid: number, startedAt: number, owner = "a launcher that was killed") =>
  `pid=${pid}\nstarted=${new Date(startedAt).toISOString()}\nowner=${owner}\n`;

function aged(path: string, minutesAgo: number): void {
  const t = new Date(NOW - minutesAgo * MIN);
  utimesSync(path, t, t);
}

/** The prompt file a spawn was given. */
const promptOf = (call: SpawnCall) => readFileSync(call.argv.find((a) => a.endsWith(".txt")) ?? "", "utf-8");

// ============ 1. CLAIMS ============

describe("1. claims: one run per task, owned by a pid and its start time", () => {
  it("a task is claimed by exactly one run; the claim passes to the agent's process; a second claim is refused", async () => {
    const h = setup();
    const run = await request(h);
    expect(run.state).toBe("queued");
    expect(h.store.getClaim("demo", "feat-login")).toMatchObject({
      runId: run.id,
      agent: "worker-a",
      ownerPid: SELF.pid,
      ownerStartedAt: SELF.startedAt,
    });
    await expect(request(h, "worker-b")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Task feat-login is already claimed by run"),
    });

    await h.service.tick();

    expect(h.spawner.calls).toHaveLength(1);
    const call = h.spawner.calls[0];
    expect(call.argv.slice(0, 7)).toEqual(["agent-cli", "run", "--agent", "worker-a", "--model", "model-a", "--prompt"]);
    expect(call.argv).not.toContain("--resume");
    expect(call.cwd).toBe(h.dir);
    expect(call.env).toMatchObject({ LAIR_RUN_ID: run.id, LAIR_TASK: "feat-login", LAIR_AGENT: "worker-a" });
    expect(call.env.AGENT_SESSION_ID).toBe(call.env.LAIR_SESSION_ID);
    expect(promptOf(call)).toContain("Build the login form");
    expect(h.store.getClaim("demo", "feat-login")).toMatchObject({ runId: run.id, ownerPid: 5001, ownerStartedAt: NOW });
    expect(runs(h)[0]).toMatchObject({ state: "running", pid: 5001 });

    // Still refused while the agent's process lives, and only one claim exists
    await expect(request(h, "worker-b")).rejects.toMatchObject({ statusCode: 409 });
    expect(h.store.listClaims("demo")).toHaveLength(1);
    // One run per agent at a time
    await expect(request(h, "worker-a", "other-task")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Agent worker-a is busy"),
    });
  });

  it("two servers on one database: the second one's claim of a live-claimed task is refused", async () => {
    const h1 = setup();
    const h2 = setup(() => ({}), { paths: h1, self: { pid: 200, startedAt: NOW } });
    h2.procs.add(SELF.pid, "lair-server", SELF.startedAt); // server 1 is alive

    await request(h1);
    await expect(request(h2, "worker-b")).rejects.toMatchObject({ statusCode: 409 });
    expect(h2.store.listClaims("demo")).toHaveLength(1);
  });

  it("a claim whose owner (a server that stopped) is dead is released, logged, and the run carries on", async () => {
    const h1 = setup();
    const run = await request(h1); // claimed by server 1 (pid 100), which then stops before starting it
    const h2 = setup(() => ({}), { paths: h1, self: { pid: 200, startedAt: NOW } });

    const summary = await h2.service.tick();

    expect(summary).toMatchObject({ claimsReleased: 1, started: 1 });
    const [released] = eventsOf(h2, "claim_released");
    expect(released.summary).toContain("its owner pid 100 is not running");
    expect(released.task).toBe("feat-login");
    expect(h2.store.getClaim("demo", "feat-login")).toMatchObject({ runId: run.id, ownerPid: 5001 });
  });

  it("a claim no active run holds is released once its owner is dead or its pid belongs to another process", async () => {
    const h = setup();
    h.store.claim("demo", "orphan-task", "left-by-a-crash", "worker-b", { pid: 4242, startedAt: NOW - 120 * MIN }, NOW - 120 * MIN, () => false);
    h.procs.add(4343, "an unrelated process", NOW - 5 * MIN);
    h.store.claim("demo", "reused-task", "left-by-a-crash-2", "worker-b", { pid: 4343, startedAt: NOW - 180 * MIN }, NOW - 180 * MIN, () => false);
    const live = await request(h, "worker-a", "live-task");

    const summary = await h.service.tick();

    expect(summary.claimsReleased).toBe(2);
    expect(h.store.getClaim("demo", "orphan-task")).toBeNull();
    expect(h.store.getClaim("demo", "reused-task")).toBeNull();
    const texts = eventsOf(h, "claim_released").map((e) => e.summary);
    expect(texts.some((t) => t.includes("pid 4242 is not running"))).toBe(true);
    expect(texts.some((t) => t.includes("pid 4343 is a different process now"))).toBe(true);
    // The live run's claim is untouched
    expect(h.store.getClaim("demo", "live-task")).toMatchObject({ runId: live.id, ownerPid: 5001 });
  });

  it("a run that lost its claim stops itself and is not restarted", async () => {
    const h = setup();
    const run = await request(h);
    await h.service.tick();

    expect(await h.service.releaseClaim("feat-login")).toMatchObject({ runId: run.id, runState: "running" });
    await h.service.tick(); // the run sees it lost the claim: SIGTERM
    expect(h.spawner.kills).toEqual([{ pid: 5001, signal: "SIGTERM" }]);
    expect(eventsOf(h, "lost_claim")).toHaveLength(1);
    await h.service.tick();
    await at(h, 30 * MIN);

    expect(runs(h).map((r) => r.state)).toEqual(["lost_claim"]);
    expect(h.spawner.calls).toHaveLength(1);
    // The task is free for another run
    await expect(request(h, "worker-b")).resolves.toMatchObject({ state: "queued" });
  });
});

// ============ 2. LOCKS ============

describe("2. locks are pid-owned; a dead holder's lock is broken, logged and counted", () => {
  const sessionLock = (p: Paths, extra: Record<string, unknown> = {}) => ({
    locks: [{ name: "session-store", path: join(p.locksDir, "session.lock"), hold: "launch", stale_minutes: 15, ...extra }],
  });
  const lockPath = (p: Paths) => join(p.locksDir, "session.lock");

  it("a lock held by a dead pid is broken when a run needs it, and the run starts", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), lockText(4242, NOW - 60 * MIN));
    const run = await request(h);

    const summary = await h.service.tick();

    expect(summary).toMatchObject({ locksBroken: 1, started: 1 });
    const [broken] = eventsOf(h, "lock_broken");
    expect(broken).toMatchObject({ subject: "session-store", runId: run.id });
    expect(broken.summary).toBe("broke lock session-store: holder pid 4242 is not running");
    expect(broken.evidence).toContain("content: pid=4242 started=2026-03-02T11:00:00.000Z owner=a launcher that was killed");
    expect(broken.data).toMatchObject({ pid: 4242, format: "lair", breaks: 1 });
    // A launch lock is released once the agent runs
    expect(existsSync(lockPath(h))).toBe(false);
    expect(h.spawner.calls).toHaveLength(1);
    expect(h.service.status().locks[0]).toMatchObject({ name: "session-store", exists: false, breaks: 1 });
    expect(h.bus).toContain("agent.lock.broken");
  });

  it("a lock held by a live pid: the run waits with the holder named, then is never-started; it starts once the holder dies", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), lockText(4242, NOW - 60 * MIN, "another launcher"));
    h.procs.add(4242, "another-launcher --task other", NOW - 60 * MIN);
    await request(h);

    await h.service.tick();
    const waiting = agentView(h.service.status(), "worker-a");
    expect(waiting.state).toBe("waiting_on_lock");
    expect(waiting.detail).toContain("waiting on lock session-store");
    expect(waiting.detail).toContain("held by live pid 4242 (another launcher)");
    expect(waiting.run?.waitingLock).toMatchObject({ lock: "session-store", holderPid: 4242, holderAlive: true });
    expect(h.spawner.calls).toEqual([]);

    await at(h, 10 * MIN);
    const [first, retry] = runs(h);
    expect(first.state).toBe("never_started");
    expect(first.detail).toContain("held by live pid 4242");
    expect(retry).toMatchObject({ state: "queued", startRetries: 1, notBefore: NOW + 11 * MIN });
    expect(eventsOf(h, "never_started")[0].summary).toContain("waiting on lock session-store");
    expect(readFileSync(lockPath(h), "utf-8")).toBe(lockText(4242, NOW - 60 * MIN, "another launcher"));
    expect(agentView(h.service.status(), "worker-a").state).toBe("never_started");

    h.procs.remove(4242);
    const summary = await at(h, 11 * MIN);
    expect(summary).toMatchObject({ locksBroken: 1, started: 1 });
    expect(runs(h)[1]).toMatchObject({ state: "running", pid: 5001 });
  });

  it("a lock whose pid now belongs to another process (pid reuse) is broken", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), lockText(4242, NOW - 120 * MIN));
    h.procs.add(4242, "an unrelated process", NOW - 10 * MIN);
    await request(h);

    await h.service.tick();

    const [broken] = eventsOf(h, "lock_broken");
    expect(broken.summary).toContain("holder pid 4242 is a different process now");
    expect(h.spawner.calls).toHaveLength(1);
  });

  it("a legacy lock with no pid is broken only once it is stale_minutes old; the wait says when", async () => {
    const h = setup(sessionLock);
    mkdirSync(lockPath(h));
    aged(lockPath(h), 10);
    await request(h);

    await h.service.tick();
    const waiting = agentView(h.service.status(), "worker-a");
    expect(waiting.state).toBe("waiting_on_lock");
    expect(waiting.detail).toContain(`no holder pid in ${join(lockPath(h), "pid")}; it is broken at 2026-03-02T12:05:00.000Z`);
    expect(waiting.run?.waitingLock).toMatchObject({ holderPid: null, holderAlive: false });
    expect(eventsOf(h, "lock_broken")).toEqual([]);

    await at(h, 6 * MIN);
    const [broken] = eventsOf(h, "lock_broken");
    expect(broken.summary).toContain("no holder pid");
    expect(broken.summary).toContain("16 min old (stale after 15 min)");
    expect(h.spawner.calls).toHaveLength(1);
  });

  it("a legacy lock with only a pid is broken when that pid is dead", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), "4242\n");
    aged(lockPath(h), 5);
    await request(h);

    await h.service.tick();

    const [broken] = eventsOf(h, "lock_broken");
    expect(broken.summary).toBe(`broke lock session-store: holder pid 4242 (from ${lockPath(h)}) is not running`);
    expect(broken.data).toMatchObject({ format: "pid" });
    expect(h.spawner.calls).toHaveLength(1);
  });

  it("a lock nobody in Lair waits on is broken too once two checks in a row found its holder dead", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), lockText(4242, NOW - 60 * MIN));

    expect(await h.service.tick()).toMatchObject({ locksBroken: 0 }); // the first dead reading
    expect(existsSync(lockPath(h))).toBe(true);
    expect(await h.service.tick()).toMatchObject({ locksBroken: 1 }); // the second
    expect(eventsOf(h, "lock_broken")[0].evidence).toContain("found by the lock check");
    expect(existsSync(lockPath(h))).toBe(false);
    // Counted per lock
    writeFileSync(lockPath(h), lockText(4243, NOW - 60 * MIN));
    await h.service.tick();
    await h.service.tick();
    expect(h.service.status().locks[0].breaks).toBe(2);
  });

  it("a holder that comes back between two checks resets the count: its lock is not broken", async () => {
    const h = setup(sessionLock);
    writeFileSync(lockPath(h), lockText(4242, NOW - 60 * MIN));
    await h.service.tick(); // dead once
    h.procs.add(4242, "another-launcher", NOW - 60 * MIN);
    await h.service.tick(); // alive: the count starts over
    h.procs.remove(4242);
    await h.service.tick(); // dead once again
    expect(eventsOf(h, "lock_broken")).toEqual([]);
    expect(existsSync(lockPath(h))).toBe(true);
  });

  it("a pid-less legacy lock nobody waits on is left alone, unless break_without_waiter is set", async () => {
    const h = setup(sessionLock);
    mkdirSync(lockPath(h));
    aged(lockPath(h), 60);
    for (let i = 0; i < 3; i++) await h.service.tick();
    expect(existsSync(lockPath(h))).toBe(true);

    const opted = setup((p) => sessionLock(p, { break_without_waiter: true }));
    mkdirSync(lockPath(opted));
    aged(lockPath(opted), 60);
    await opted.service.tick();
    await opted.service.tick();
    expect(existsSync(lockPath(opted))).toBe(false);
    expect(eventsOf(opted, "lock_broken")[0].summary).toContain("no holder pid");
  });

  it("a lock taken after the process reading is judged on a newer one: the waiter waits on its live holder", async () => {
    const h = setup(sessionLock);
    await request(h);
    // Another launcher starts and takes the lock right after this tick read the process table
    h.procs.afterList = (call) => {
      if (call !== 2) return;
      h.procs.add(4242, "another-launcher --task other", h.clock.now());
      writeFileSync(lockPath(h), lockText(4242, h.clock.now(), "another launcher"));
    };

    expect(await h.service.tick()).toMatchObject({ locksBroken: 0, started: 0 });

    expect(readFileSync(lockPath(h), "utf-8")).toContain("pid=4242");
    expect(runs(h)[0]).toMatchObject({
      state: "waiting_lock",
      waitingLock: { lock: "session-store", holderPid: 4242, holderAlive: true },
    });
    expect(h.procs.listCalls).toBe(3); // the request's reading, the tick's, and one after the lock was read
  });

  it("a claim made after the process reading is judged on a newer one: its live owner keeps it", async () => {
    const h = setup();
    h.procs.afterList = (call) => {
      if (call !== 1) return;
      h.procs.add(7001, "agent-cli run --agent worker-b", h.clock.now());
      h.store.claim("demo", "peer-task", "a-run-not-stored-yet", "worker-b", { pid: 7001, startedAt: h.clock.now() }, h.clock.now(), () => false);
    };

    expect(await h.service.tick()).toMatchObject({ claimsReleased: 0 });
    expect(h.store.getClaim("demo", "peer-task")).toMatchObject({ ownerPid: 7001 });

    h.procs.remove(7001); // its owner dies: now it goes
    expect(await h.service.tick()).toMatchObject({ claimsReleased: 1 });
  });

  it("a `hold: run` lock is owned by the agent's pid while it runs; the next run waits on it, then takes it", async () => {
    const h = setup((p) => sessionLock(p, { hold: "run" }));
    const a = await request(h, "worker-a", "task-1");
    const b = await request(h, "worker-b", "task-2");

    await h.service.tick();

    expect(readLock(lockPath(h))).toMatchObject({ format: "lair", pid: 5001, startedAt: NOW });
    expect(h.store.getRun(a.id)).toMatchObject({ state: "running", pid: 5001 });
    expect(h.store.getRun(b.id)).toMatchObject({
      state: "waiting_lock",
      waitingLock: { lock: "session-store", holderPid: 5001, holderAlive: true },
    });

    h.spawner.exit(5001, 0);
    await at(h, 5 * SEC);

    expect(h.store.getRun(a.id)?.state).toBe("completed");
    expect(h.store.getRun(b.id)).toMatchObject({ state: "running", pid: 5002 });
    expect(readLock(lockPath(h))).toMatchObject({ pid: 5002 });
    expect(eventsOf(h, "lock_broken")).toEqual([]);
  });
});

// ============ 3. NEVER STARTED ============

describe("3. a requested run with no live agent process within N minutes is never-started, then retried", () => {
  it("spawn errors: never-started with the reason, retried after the backoff, and then it starts", async () => {
    const h = setup();
    h.spawner.failAll = "spawn agent-cli ENOENT";
    await request(h);

    await at(h, 0);
    await at(h, 5 * MIN);
    expect(agentView(h.service.status(), "worker-a")).toMatchObject({ state: "starting" });
    expect(agentView(h.service.status(), "worker-a").detail).toContain("spawn error: spawn agent-cli ENOENT");
    await at(h, 10 * MIN);

    const [first, retry] = runs(h);
    expect(first.state).toBe("never_started");
    expect(first.detail).toBe(
      "never started: no live agent process 10 min after starting began: spawn error: spawn agent-cli ENOENT",
    );
    expect(retry).toMatchObject({ state: "queued", startRetries: 1, notBefore: NOW + 11 * MIN });
    const [event] = eventsOf(h, "never_started");
    expect(event.summary).toBe("worker-a never started on feat-login: spawn error: spawn agent-cli ENOENT");
    expect(event.data).toMatchObject({ retry: 1, retryAt: "2026-03-02T12:11:00.000Z" });
    expect(agentView(h.service.status(), "worker-a").state).toBe("never_started");

    h.spawner.failAll = undefined;
    await at(h, 10 * MIN + 30 * SEC); // still in the backoff
    expect(h.spawner.calls).toHaveLength(3);
    await at(h, 11 * MIN);
    expect(h.spawner.calls).toHaveLength(4);
    expect(runs(h)[1]).toMatchObject({ state: "running", pid: 5001 });
    expect(h.store.getClaim("demo", "feat-login")).toMatchObject({ runId: retry.id, ownerPid: 5001 });
  });

  it("the backoff doubles, and after retries.max_retries the task is escalated once", async () => {
    const h = setup();
    h.spawner.failAll = "spawn agent-cli EACCES";
    await request(h);

    for (const minute of [0, 10, 11, 21, 23, 33, 60, 120]) await at(h, minute * MIN);

    expect(runs(h).map((r) => [r.state, r.notBefore - NOW])).toEqual([
      ["never_started", 0],
      ["never_started", 11 * MIN],
      ["never_started", 23 * MIN],
    ]);
    expect(h.spawner.calls).toHaveLength(6);
    expect(eventsOf(h, "escalated")).toHaveLength(1);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Agent worker-a could not finish task feat-login after 3 attempt(s): never started");
    expect(entries[0]).toContain("(escalation)");
    expect(h.store.getClaim("demo", "feat-login")).toBeNull();
  });
});

// ============ 4. HUNG AND DEAD ON START ============

describe("4. hung and dead-on-start: same session K times, then a fresh one, then escalate", () => {
  const sessionFile = (h: Paths) => {
    mkdirSync(h.sessionDir, { recursive: true });
    writeFileSync(join(h.sessionDir, "state.json"), '{"turns": 12}\n');
  };

  it("a hung agent (the watchdog's rule) is stopped and restarted: resume x2, fresh session (moved aside), escalate", async () => {
    const h = setup(() => ({ branch_state_cmd: ["git-state", "{task}"] }));
    sessionFile(h);
    h.runner.stdout = "branch feat-login: 3 commits ahead\n";
    await request(h);

    let t = 0;
    await at(h, t); // spawn 1
    const hangAndRecover = async (backoff: number) => {
      t += 46 * MIN;
      await at(h, t); // hung: SIGTERM
      await at(h, t); // gone: recover
      t += backoff;
      await at(h, t); // the next attempt starts
    };
    await hangAndRecover(10 * SEC);
    await hangAndRecover(20 * SEC);
    await hangAndRecover(40 * SEC);
    t += 46 * MIN;
    await at(h, t);
    await at(h, t); // the fresh session hangs too: escalate
    await at(h, t + 60 * MIN);

    const calls = h.spawner.calls;
    expect(calls).toHaveLength(4);
    const session = calls[0].env.LAIR_SESSION_ID;
    expect(calls[0].argv).not.toContain("--resume");
    expect(calls[1].argv.slice(-2)).toEqual(["--resume", session]);
    expect(calls[2].argv.slice(-2)).toEqual(["--resume", session]);
    expect(calls[3].argv).not.toContain("--resume");
    expect(calls[3].env.LAIR_SESSION_ID).not.toBe(session);
    expect(calls[3].env.AGENT_SESSION_ID).toBe(calls[3].env.LAIR_SESSION_ID);
    expect(calls.map((c) => c.env.LAIR_SESSION_MODE)).toEqual(["new", "resume", "resume", "fresh"]);

    // The broken session was moved aside, never deleted
    const moved = readdirSync(join(h.agentsDir, "sessions"));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^worker-a\.aside-\d{8}T\d{6}Z$/);
    expect(readFileSync(join(h.agentsDir, "sessions", moved[0], "state.json"), "utf-8")).toBe('{"turns": 12}\n');

    // The fresh session starts from a resume summary
    const prompt = promptOf(calls[3]);
    expect(prompt).toContain("# Resume summary (written by Lair)");
    expect(prompt).toContain("branch feat-login: 3 commits ahead");
    expect(prompt).toContain("Build the login form");
    expect(h.runner.calls).toEqual([["git-state", "feat-login"]]);

    expect(eventsOf(h, "hung")).toHaveLength(4);
    expect(eventsOf(h, "hung")[0].summary).toContain("shows no progress for 46 min (limit 45 min)");
    expect(eventsOf(h, "restart_same_session")).toHaveLength(2);
    expect(eventsOf(h, "fresh_session")).toHaveLength(1);
    expect(eventsOf(h, "fresh_session")[0].evidence[0]).toContain(`moved session directory ${h.sessionDir} to`);
    expect(eventsOf(h, "escalated")).toHaveLength(1);
    expect(h.spawner.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM"]);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Agent worker-a could not finish task feat-login after 4 attempt(s): hung");
    expect(h.store.getClaim("demo", "feat-login")).toBeNull();
    expect(agentView(h.service.status(), "worker-a").state).toBe("failed");
  });

  it("an agent WAITING on a gate with no result yet is never restarted, however long it is silent", async () => {
    const h = setup();
    appendFileSync(
      h.queueFile,
      "- WAITING feat-login 20260302T113000Z-feat-login-abc1234-101 by worker-a 11:00Z: gate queued on heavy\n",
    );
    await request(h);
    await at(h, 0);
    await at(h, 120 * MIN);
    await at(h, 240 * MIN);

    expect(h.spawner.kills).toEqual([]);
    expect(eventsOf(h, "hung")).toEqual([]);
    expect(agentView(h.service.status(), "worker-a").state).toBe("working");
  });

  it("a process that ignores SIGTERM gets SIGKILL after stop_grace_seconds", async () => {
    const h = setup();
    h.spawner.ignoreTerm = true;
    await request(h);
    await at(h, 0);
    await at(h, 46 * MIN); // hung: SIGTERM, ignored
    expect(agentView(h.service.status(), "worker-a").state).toBe("hung");
    await at(h, 46 * MIN + 10 * SEC);
    expect(h.spawner.kills).toEqual([{ pid: 5001, signal: "SIGTERM" }]);
    await at(h, 46 * MIN + 31 * SEC);
    expect(h.spawner.kills).toEqual([
      { pid: 5001, signal: "SIGTERM" },
      { pid: 5001, signal: "SIGKILL" },
    ]);
    await at(h, 46 * MIN + 31 * SEC);
    expect(runs(h).map((r) => r.state)).toEqual(["failed", "queued"]);
    expect(runs(h)[1]).toMatchObject({ sessionMode: "resume", sameSessionRestarts: 1 });
  });

  it("a dead-on-start loop (empty log, exits at once) is broken after K same-session tries and one fresh one", async () => {
    const h = setup();
    sessionFile(h);
    h.spawner.behaviour = (pid) => h.spawner.exit(pid, 1);
    await request(h);

    for (const ms of [0, 0, 10 * SEC, 10 * SEC, 30 * SEC, 30 * SEC, 70 * SEC, 70 * SEC, 60 * MIN, 120 * MIN]) {
      await at(h, ms);
    }

    expect(h.spawner.calls).toHaveLength(4);
    expect(h.spawner.calls.map((c) => c.env.LAIR_SESSION_MODE)).toEqual(["new", "resume", "resume", "fresh"]);
    const deaths = eventsOf(h, "dead_on_start");
    expect(deaths).toHaveLength(4);
    expect(deaths[0].summary).toBe("worker-a on feat-login died with an empty log 0 s after it started (exit code 1)");
    expect(eventsOf(h, "escalated")).toHaveLength(1);
    expect(inboxEntries(h)).toHaveLength(1);
    expect(readdirSync(join(h.agentsDir, "sessions"))[0]).toMatch(/^worker-a\.aside-/);
  });

  it("a crash after a while (non-empty log) restarts with the same session", async () => {
    const h = setup();
    h.spawner.behaviour = (_pid, log) => writeLog(h.clock, log, "step 1 of 9\n");
    await request(h);
    await at(h, 0);
    h.spawner.exit(5001, 2);
    await at(h, 5 * MIN);

    const [crash] = eventsOf(h, "crashed");
    expect(crash.summary).toBe("worker-a on feat-login the process ended after 300 s (exit code 2)");
    expect(crash.evidence).toContain("log: step 1 of 9");
    expect(runs(h)[1]).toMatchObject({ state: "queued", sessionMode: "resume", notBefore: NOW + 5 * MIN + 10 * SEC });
  });

  it("after a restart, a run that ended unseen is never restarted: DONE completes it, anything else asks the owner", async () => {
    const h1 = setup();
    await request(h1, "worker-a", "task-1");
    await request(h1, "worker-b", "task-2");
    await h1.service.tick(); // both run (pids 5001 and 5002)
    // Lair restarts; meanwhile both agents end, and worker-b reports its task DONE
    appendFileSync(h1.queueFile, "- DONE task-2 by worker-b 12:05Z: finished\n");
    const h2 = setup(() => ({}), { paths: h1, self: { pid: 200, startedAt: NOW } });

    await h2.service.tick(); // the new server never saw them exit: their exit status is unknown
    await h2.service.tick();

    expect(h2.spawner.calls).toEqual([]);
    const byAgent = Object.fromEntries(runs(h2).map((r) => [r.agent, r]));
    expect(byAgent["worker-b"].state).toBe("completed");
    expect(byAgent["worker-a"]).toMatchObject({ state: "failed" });
    expect(byAgent["worker-a"].detail).toContain("outcome unknown");
    const entries = inboxEntries(h2);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Agent worker-a could not finish task task-1 after 1 attempt(s): it ended while Lair was restarting, and its outcome is unknown");
    expect(h2.store.listClaims("demo")).toEqual([]);
  });
});

// ============ 5. FAILOVER ============

describe("5. provider errors and rate limits fail over to the next configured profile", () => {
  it("a run that exits on a rate limit continues on the fallback CLI, and the switch is recorded", async () => {
    const h = setup(() => FALLBACK);
    h.spawner.behaviour = (pid, log, call) => {
      if (call === 1) {
        writeLog(h.clock, log, "Error: 429 Too Many Requests: rate limit exceeded, retry later\n");
        h.spawner.exit(pid, 1);
      }
    };
    await request(h);

    await at(h, 0); // test-cli starts
    await at(h, 0); // it died on a rate limit: fail over
    await at(h, 0); // other-cli starts

    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["agent-cli", "other-cli"]);
    expect(h.spawner.calls[1].argv.slice(0, 4)).toEqual(["other-cli", "--model", "model-b", "--task-file"]);
    const [switched] = eventsOf(h, "failover");
    expect(switched).toMatchObject({ subject: "provider-a" });
    expect(switched.data).toMatchObject({
      kind: "rate_limit",
      from: { adapter: "test-cli", model: "model-a", provider: "provider-a" },
      to: { adapter: "other-cli", model: "model-b", provider: "provider-b" },
      line: "Error: 429 Too Many Requests: rate limit exceeded, retry later",
    });
    expect(promptOf(h.spawner.calls[1])).toContain("# Resume summary (written by Lair)");
    expect(promptOf(h.spawner.calls[1])).toContain("Build the login form");
    const status = agentView(h.service.status(), "worker-a");
    expect(status.state).toBe("failed_over");
    expect(status.recoveries.map((e) => e.kind)).toContain("failover");
    expect(h.bus).toContain("agent.failover");
  });

  it("a live run whose silent log ends on a rate limit is stopped and failed over; prose about rate limits is not", async () => {
    const h = setup(() => FALLBACK);
    h.spawner.behaviour = (_pid, log, call) =>
      writeLog(
        h.clock,
        log,
        call === 1 ? "working on it\nrate limited by the provider: retry after 3600 s\n" : "added rate limit middleware\n",
      );
    await request(h);
    await at(h, 0);
    await at(h, 3 * MIN); // silent for 3 min on a rate limit line: stop
    expect(h.spawner.kills).toEqual([{ pid: 5001, signal: "SIGTERM" }]);
    await at(h, 3 * MIN);
    await at(h, 3 * MIN);
    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["agent-cli", "other-cli"]);

    await at(h, 10 * MIN);
    expect(h.spawner.kills).toHaveLength(1); // the fallback's own output is just prose
  });

  it("a provider the fleet budget has paused is skipped at start: the run begins on the fallback", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    budget.setProviderBudget({
      provider: "provider-a",
      maxCostPerPeriod: 10,
      period: "monthly",
      currentCost: 10,
      periodStart: new Date().toISOString(),
      paused: true,
    });
    const h = setup(() => FALLBACK, { budget });
    await request(h);

    await h.service.tick();

    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["other-cli"]);
    const [switched] = eventsOf(h, "failover");
    expect(switched.data).toMatchObject({ kind: "unavailable", toIndex: 1 });
    expect(switched.evidence[0]).toContain("the fleet budget has provider provider-a paused or rate limited");
  });

  it("when every profile is failing the owner hears once, the task waits for the cooldown, and the failover cap ends it", async () => {
    const h = setup(() => FALLBACK);
    h.spawner.behaviour = (pid, log) => {
      writeLog(h.clock, log, "Error: 429 Too Many Requests\n");
      h.spawner.exit(pid, 1);
    };
    await request(h);

    for (let i = 0; i < 6; i++) await at(h, 0);
    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["agent-cli", "other-cli"]);
    expect(eventsOf(h, "failover").map((e) => e.data.to === null)).toEqual([false, true]);
    const waiting = runs(h)[2];
    expect(waiting).toMatchObject({ state: "queued", profileIndex: 0, notBefore: NOW + 30 * MIN, failovers: 2 });
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Every configured agent profile for worker-a is failing or rate limited");

    await at(h, 30 * MIN); // provider-a's cooldown is over
    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["agent-cli", "other-cli", "agent-cli"]);
    for (let i = 0; i < 6; i++) await at(h, 30 * MIN);
    // A third failover, then failover.max_failovers (3) is reached: escalated, not looped
    expect(h.spawner.calls).toHaveLength(4);
    const after = inboxEntries(h);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("Agent worker-a could not finish task feat-login after 4 attempt(s): 4 provider errors or rate limits in a row");
    expect(eventsOf(h, "failover").at(-1)?.data).toMatchObject({ capped: true, failovers: 4 });
    expect(h.store.getClaim("demo", "feat-login")).toBeNull();
  });

  it("failing over keeps the recovery counters, is capped per task, and cools a provider only for the agent that hit it", async () => {
    const h = setup(() => ({ ...FALLBACK, failover: { max_failovers: 1 } }));
    h.spawner.behaviour = (pid, log, call) => {
      if (call === 1) h.spawner.exit(pid, 1); // dies on start: a same-session restart
      if (call === 2 || call === 3) {
        writeLog(h.clock, log, "Error: 429 Too Many Requests\n");
        h.spawner.exit(pid, 1);
      }
    };
    await request(h);
    await at(h, 0);
    await at(h, 0); // dead on start: restart in 10 s
    await at(h, 10 * SEC);
    await at(h, 10 * SEC); // a rate limit: fail over

    expect(runs(h)[2]).toMatchObject({ profileIndex: 1, sessionMode: "new", sameSessionRestarts: 1, failovers: 1 });
    await at(h, 10 * SEC);
    await at(h, 10 * SEC); // a rate limit again: the cap (1) is reached
    expect(h.spawner.calls.map((c) => c.argv[0])).toEqual(["agent-cli", "agent-cli", "other-cli"]);
    expect(eventsOf(h, "escalated")).toHaveLength(1);
    expect(inboxEntries(h)[0]).toContain("2 provider errors or rate limits in a row (failover.max_failovers is 1)");

    // provider-a cools down for worker-a only: worker-b still starts on it
    await request(h, "worker-b", "task-b");
    await at(h, 10 * SEC);
    expect(h.spawner.calls).toHaveLength(4);
    expect(h.spawner.calls[3]).toMatchObject({ argv: expect.arrayContaining(["agent-cli"]), env: expect.objectContaining({ LAIR_AGENT: "worker-b" }) });
    expect(eventsOf(h, "failover").filter((e) => e.agent === "worker-b")).toEqual([]);
  });
});

// ============ 6. BUDGETS ============

describe("6. budgets per agent and per project, per day and month, fed by the fleet budget", () => {
  const limits = () => ({
    budgets: {
      agent: { daily_cost: { soft: 5, hard: 8 } },
      project: { monthly_tokens: { soft: 10000, hard: 20000 } },
    },
  });

  it("an agent's soft limit warns once; its hard limit stops its new runs and raises one spend decision; the next day resets it", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const asked: DecisionRequest[] = [];
    const decisions: DecisionInbox = {
      request: async (decision) => {
        asked.push(decision);
        return { id: `decision-${asked.length}`, via: "the decisions module" };
      },
    };
    const h = setup(limits, { budget, decisions });

    budget.recordCost("provider-a", 6, "usage", { project: "demo", agent: "worker-a", tokens: 1000 });
    expect(await h.service.tick()).toMatchObject({ warnings: 1 });
    expect(eventsOf(h, "budget_warning")[0].summary).toBe(
      "budget warning: agent worker-a used 6 cost in day 2026-03-02 (soft limit 5)",
    );
    expect(h.bus).toContain("agent.budget.warning");
    await request(h, "worker-a", "task-1"); // a soft limit doesn't stop runs
    await h.service.tick();
    expect(h.spawner.calls).toHaveLength(1);

    budget.recordCost("provider-a", 3, "usage", { project: "demo", agent: "worker-a", tokens: 500 });
    await h.service.tick();
    await h.service.tick();
    expect(eventsOf(h, "budget_warning")).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      project: "demo",
      kind: "spend",
      key: "budget:agent:worker-a:daily_cost:2026-03-02",
      requestedBy: "agents",
      recommended: "wait",
      onTimeout: "wait",
    });
    expect(asked[0].question).toContain("Agent worker-a used 9 cost in day 2026-03-02 (hard limit 8)");
    expect(asked[0].options.map((o) => o.id)).toEqual(["allow", "wait"]);
    expect(h.spawner.kills).toEqual([]); // a working run continues

    h.spawner.exit(5001, 0);
    await h.service.tick();
    await expect(request(h, "worker-a", "task-2")).rejects.toMatchObject({
      statusCode: 403,
      message: "Over budget: agent worker-a used 9 cost in day 2026-03-02 (hard limit 8)",
    });
    expect(agentView(h.service.status(), "worker-a").state).toBe("over_budget");
    await expect(request(h, "worker-b", "task-3")).resolves.toMatchObject({ state: "queued" });

    // The next UTC day starts a new daily budget
    h.clock.t = Date.parse("2026-03-03T00:05:00.000Z");
    await expect(request(h, "worker-a", "task-2")).resolves.toMatchObject({ state: "queued" });
    expect(agentView(h.service.status(), "worker-a").budget?.lines[0]).toMatchObject({
      metric: "daily_cost",
      period: "2026-03-03",
      used: 0,
      level: "ok",
    });
  });

  it("a project's hard limit holds every agent's new runs (queued ones wait, uncounted) until the next month", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const h = setup(limits, { budget });
    await request(h);
    budget.recordCost("provider-a", 0, "usage", { project: "demo", agent: "worker-b", tokens: 25000 });

    await h.service.tick();
    await at(h, 20 * MIN);

    expect(h.spawner.calls).toEqual([]);
    expect(runs(h)).toHaveLength(1);
    expect(runs(h)[0].detail).toBe(
      "not starting: over budget (the project used 25000 tokens in month 2026-03 (hard limit 20000))",
    );
    expect(agentView(h.service.status(), "worker-a").state).toBe("over_budget");
    await expect(request(h, "worker-b", "task-2")).rejects.toMatchObject({ statusCode: 403 });
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("(spend)");
    expect(entries[0]).toContain("The project used 25000 tokens in month 2026-03 (hard limit 20000)");

    h.clock.t = Date.parse("2026-04-01T00:00:01.000Z");
    await h.service.tick();
    expect(h.spawner.calls).toHaveLength(1);
  });

  it("usage lines in a run's log are recorded through the fleet budget into the ledger, once", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const h = setup(
      () => ({ ...limits(), usage_patterns: ["tokens used: (?<tokens>[\\d,]+)", "cost: \\$(?<cost>[\\d.]+)"] }),
      { budget },
    );
    h.spawner.behaviour = (_pid, log) => writeLog(h.clock, log, "tokens used: 1,200 cost: $0.40\n");
    await request(h);
    await h.service.tick(); // starts; the agent writes a usage line
    await h.service.tick(); // read
    await h.service.tick(); // nothing new

    expect(h.store.usageSince("demo", "worker-a", 0)).toEqual({ tokens: 1200, cost: 0.4 });
    expect(budget.getStatus().totalCostToday).toBeCloseTo(0.4);
    writeLog(h.clock, h.spawner.calls[0].logPath, "tokens used: 300 cost: $0.10\n");
    await h.service.tick();
    expect(h.store.usageSince("demo", null, 0)).toEqual({ tokens: 1500, cost: 0.5 });
    expect(agentView(h.service.status(), "worker-a").budget?.lines[0]).toMatchObject({ metric: "daily_cost", used: 0.5 });
  });

  it("usage is never negative, from a run's log or from the fleet budget: it can't buy budget back", async () => {
    const h = setup(() => ({ usage_patterns: ["tokens used: (?<tokens>-?[\\d,]+)", "cost: \\$(?<cost>-?[\\d.]+)"] }));
    h.spawner.behaviour = (_pid, log) =>
      writeLog(h.clock, log, "tokens used: -50000 cost: $-9.5\ntokens used: 100 cost: $0.25\n");
    await request(h);
    await h.service.tick();
    await h.service.tick();
    expect(h.store.usageSince("demo", "worker-a", 0)).toEqual({ tokens: 100, cost: 0.25 });

    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const fed = setup(() => ({}), { budget });
    budget.recordCost("provider-a", -5, "a refund", { project: "demo", agent: "worker-a", tokens: -1000 });
    expect(fed.store.usageSince("demo", "worker-a", 0)).toEqual({ tokens: 0, cost: 0 });
  });
});

// ============ 7 AND 8. HTTP ============

/** What a browser on the dashboard sends with a same-origin request */
const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
/** The owner's headers per app: the dashboard's, with a signed-in session */
const ownerOf = new WeakMap<FastifyInstance, Record<string, string>>();

/** The agents routes as src/server/index.ts mounts them, with the shared owner credential. */
async function http(h: Harness): Promise<FastifyInstance> {
  const app = Fastify();
  const tokenPath = join(h.dir, "data", "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  await registerAgentsRoutes(app, h.manager, () => "demo", auth);
  await app.ready();
  apps.push(app);
  // Sign in the way the dashboard does: the token for a session, kept by the browser
  const signIn = await app.inject({
    method: "POST",
    url: "/api/owner/sessions",
    headers: DASHBOARD,
    payload: { token: readFileSync(tokenPath, "utf-8").trim() },
  });
  expect(signIn.statusCode).toBe(201);
  ownerOf.set(app, { ...DASHBOARD, [OWNER_SESSION_HEADER]: signIn.json().data.session as string });
  return app;
}

/** POST as the owner, from the dashboard. */
const post = (app: FastifyInstance, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: ownerOf.get(app), ...(payload ? { payload } : {}) });

/** POST without an owner session, with these headers (none: a script or an agent). */
const postAs = (app: FastifyInstance, url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers, payload });

describe("7. API: per-agent state, claims and recoveries; actions need confirmation", () => {
  it("serves state, claims and recoveries, and refuses bad or conflicting requests", async () => {
    const h = setup();
    const app = await http(h);

    const idle = (await app.inject({ url: "/api/agents/status?project=demo" })).json();
    expect(idle.success).toBe(true);
    expect(idle.data.agents.map((a: AgentView) => [a.id, a.state])).toEqual([
      ["worker-a", "idle"],
      ["worker-b", "idle"],
    ]);

    expect((await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "-rf", prompt: "x" })).statusCode).toBe(400);
    expect((await post(app, "/api/agents/runs?project=demo", { agent: "worker-z", task: "t", prompt: "x" })).statusCode).toBe(400);
    expect((await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "t", prompt: "x", extra: 1 })).statusCode).toBe(400);

    const created = await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });
    expect(created.statusCode).toBe(201);
    const conflict = await post(app, "/api/agents/runs?project=demo", { agent: "worker-b", task: "feat-login", prompt: "x" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toContain("already claimed");

    await post(app, "/api/agents/tick?project=demo");
    const status = (await app.inject({ url: "/api/agents/status?project=demo" })).json().data as AgentsStatusView;
    const a = agentView(status, "worker-a");
    expect(a).toMatchObject({ state: "working", run: { task: "feat-login", pid: 5001, state: "running" } });
    expect(a.claims).toEqual([expect.objectContaining({ task: "feat-login", ownerPid: 5001, ownerAlive: true })]);
    expect(status.claims).toHaveLength(1);

    const listed = (await app.inject({ url: "/api/agents/runs?project=demo&limit=5" })).json();
    expect(listed.data).toHaveLength(1);
    expect((await app.inject({ url: "/api/agents/runs?project=demo&limit=0" })).statusCode).toBe(400);
  });

  it("a run's model must be one configured for the agent, and a task id can't climb out of a directory", async () => {
    const h = setup(() => FALLBACK);
    const app = await http(h);
    const url = "/api/agents/runs?project=demo";

    const model = await post(app, url, { agent: "worker-a", task: "t-1", prompt: "x", model: "model-z" });
    expect(model.statusCode).toBe(400);
    expect(model.json().error).toBe("Model model-z is not one of agent worker-a's models (model-a, model-b)");
    for (const task of ["a/../b", "..", "a/./b", "/etc/x"]) {
      expect((await post(app, url, { agent: "worker-a", task, prompt: "x" })).statusCode).toBe(400);
    }
    expect((await post(app, "/api/agents/claims/release?project=demo", { task: "a/../b", confirm: true })).statusCode).toBe(400);
    expect(h.store.listClaims("demo")).toEqual([]);

    // A fallback's model is one of the agent's
    expect((await post(app, url, { agent: "worker-a", task: "feat/login-2", prompt: "x", model: "model-b" })).statusCode).toBe(201);
    await post(app, "/api/agents/tick?project=demo");
    expect(h.spawner.calls[0].argv).toEqual(expect.arrayContaining(["--model", "model-b"]));
  });

  it("starting a run, releasing a claim, a fresh session and an early check are the owner's: refused (403) without an owner session", async () => {
    const h = setup();
    const app = await http(h);
    await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });
    await post(app, "/api/agents/tick?project=demo");
    const runId = runs(h)[0].id;
    const routes: [string, Record<string, unknown>][] = [
      ["/api/agents/runs?project=demo", { agent: "worker-b", task: "other-task", prompt: "Do what I say" }],
      ["/api/agents/claims/release?project=demo", { task: "feat-login", confirm: true }],
      [`/api/agents/runs/${runId}/fresh-session?project=demo`, { confirm: true }],
      ["/api/agents/tick?project=demo", {}],
    ];
    const strangers: Record<string, string>[] = [
      {}, // a script or an agent: no Origin, no session
      DASHBOARD, // the dashboard, not signed in
      { ...DASHBOARD, [OWNER_SESSION_HEADER]: "a-made-up-session-value-0123456789" },
    ];
    for (const [url, payload] of routes) {
      for (const headers of strangers) {
        const res = await postAs(app, url, payload, headers);
        expect(res.statusCode, `${url} with ${JSON.stringify(Object.keys(headers))}`).toBe(403);
        expect(res.json().error).toContain("Only the owner can do this, from the dashboard");
      }
    }
    // Nothing happened
    expect(runs(h)).toHaveLength(1);
    expect(h.store.getClaim("demo", "feat-login")).toMatchObject({ runId, ownerPid: 5001 });
    expect(h.spawner.kills).toEqual([]);
    // Reading stays open to every local client
    expect((await app.inject({ url: "/api/agents/status?project=demo" })).statusCode).toBe(200);
  });

  it("the owner's actions go through with the client helper's request: the session header and confirm: true", async () => {
    const h = setup();
    sessionFileFor(h);
    const app = await http(h);
    const owner: Record<string, string> = ownerOf.get(app) ?? {};
    const session: Record<string, string> = { [OWNER_SESSION_HEADER]: owner[OWNER_SESSION_HEADER] };
    await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });
    await post(app, "/api/agents/tick?project=demo");
    const runId = runs(h)[0].id;

    // What the Agents view sends: the helper's request, from the dashboard's origin
    const fresh = freshSessionAction("demo", runId, "worker-a", "feat-login");
    const freshRequest = ownerRequest(fresh.body, session);
    const res = await app.inject({ url: fresh.url, ...freshRequest, headers: { ...DASHBOARD, ...freshRequest.headers } });
    expect(res.statusCode).toBe(200);
    expect(h.spawner.kills).toEqual([{ pid: 5001, signal: "SIGTERM" }]);

    const release = releaseClaimAction("demo", "feat-login", "worker-a");
    const releaseRequest = ownerRequest(release.body, session);
    const released = await app.inject({ url: release.url, ...releaseRequest, headers: { ...DASHBOARD, ...releaseRequest.headers } });
    expect(released.statusCode).toBe(200);
    expect(h.store.getClaim("demo", "feat-login")).toBeNull();
  });

  it("releasing a claim and starting a fresh session are refused without confirm: true", async () => {
    const h = setup();
    sessionFileFor(h);
    const app = await http(h);
    await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });
    await post(app, "/api/agents/tick?project=demo");
    const runId = runs(h)[0].id;

    const unconfirmed = await post(app, "/api/agents/claims/release?project=demo", { task: "feat-login" });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toContain("confirm: true");
    const freshUnconfirmed = await post(app, `/api/agents/runs/${runId}/fresh-session?project=demo`, {});
    expect(freshUnconfirmed.statusCode).toBe(400);
    expect(h.store.getClaim("demo", "feat-login")).not.toBeNull();
    expect(h.spawner.kills).toEqual([]);

    const fresh = await post(app, `/api/agents/runs/${runId}/fresh-session?project=demo`, { confirm: true });
    expect(fresh.statusCode).toBe(200);
    expect(h.spawner.kills).toEqual([{ pid: 5001, signal: "SIGTERM" }]);
    await at(h, 0); // stopped: queue a fresh session
    await at(h, 10 * SEC);
    expect(h.spawner.calls.map((c) => c.env.LAIR_SESSION_MODE)).toEqual(["new", "fresh"]);
    expect(readdirSync(join(h.agentsDir, "sessions"))[0]).toMatch(/^worker-a\.aside-/);

    const released = await post(app, "/api/agents/claims/release?project=demo", { task: "feat-login", confirm: true });
    expect(released.statusCode).toBe(200);
    await at(h, 10 * SEC);
    expect(h.spawner.kills.at(-1)).toEqual({ pid: 5002, signal: "SIGTERM" });
    expect((await post(app, "/api/agents/claims/release?project=demo", { task: "feat-login", confirm: true })).statusCode).toBe(404);

    const recoveries = (await app.inject({ url: "/api/agents/recoveries?project=demo" })).json().data as { kind: string }[];
    expect(recoveries.map((e) => e.kind)).toEqual(expect.arrayContaining(["fresh_session", "claim_released", "lost_claim"]));
  });

  it("a disabled project answers 404 for actions, a read_only one 403, and cross-site requests are refused", async () => {
    const h = setup();
    h.manager.load([{ name: "off", config: projectConfig(makePaths(), undefined) }]);
    const app = await http(h);
    const off = (await app.inject({ url: "/api/agents/status?project=off" })).json();
    expect(off.data).toMatchObject({ enabled: false, agents: [] });
    expect((await post(app, "/api/agents/runs?project=off", { agent: "worker-a", task: "t", prompt: "x" })).statusCode).toBe(404);

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/agents/runs?project=demo",
      headers: { origin: "http://attacker.example" },
      payload: { agent: "worker-a", task: "t", prompt: "x" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(h.store.listClaims("demo")).toEqual([]);

    const ro = setup(() => ({}), { readOnly: true });
    const roApp = await http(ro);
    expect((await post(roApp, "/api/agents/runs?project=demo", { agent: "worker-a", task: "t", prompt: "x" })).statusCode).toBe(403);
    expect((await roApp.inject({ url: "/api/agents/status?project=demo" })).json().data.readOnly).toBe(true);
  });
});

function sessionFileFor(h: Paths): void {
  mkdirSync(h.sessionDir, { recursive: true });
  writeFileSync(join(h.sessionDir, "state.json"), "{}\n");
}

describe("8. wiring: the router and the service's own tick", () => {
  it("boots the router: a lock held by a dead pid is broken and the run requested over HTTP starts on the HTTP tick", async () => {
    const h = setup((p) => ({ locks: [{ name: "session-store", path: join(p.locksDir, "session.lock") }] }));
    const lock = join(h.locksDir, "session.lock");
    writeFileSync(lock, lockText(4242, NOW - 60 * MIN));
    const app = await http(h);

    const created = await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ state: "queued", agent: "worker-a" });

    const tick = await post(app, "/api/agents/tick?project=demo");
    expect(tick.statusCode).toBe(200);
    expect(tick.json().data).toMatchObject({ locksBroken: 1, started: 1 });

    expect(h.spawner.calls).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
    const status = (await app.inject({ url: "/api/agents/status?project=demo" })).json().data as AgentsStatusView;
    expect(status.locks[0]).toMatchObject({ name: "session-store", breaks: 1, exists: false });
    expect(agentView(status, "worker-a")).toMatchObject({ state: "working" });
    const recoveries = (await app.inject({ url: "/api/agents/recoveries?project=demo" })).json().data as {
      kind: string;
      summary: string;
    }[];
    expect(recoveries.find((e) => e.kind === "lock_broken")?.summary).toBe(
      "broke lock session-store: holder pid 4242 is not running",
    );
  });

  it("the manager's timer ticks on its own: the same scenario without an HTTP tick", async () => {
    const h = setup((p) => ({ locks: [{ name: "session-store", path: join(p.locksDir, "session.lock") }] }));
    writeFileSync(join(h.locksDir, "session.lock"), lockText(4242, NOW - 60 * MIN));
    const app = await http(h);
    await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "feat-login", prompt: "Build it" });

    expect(h.manager.start()).toEqual(["demo"]);
    for (let i = 0; i < 300 && h.spawner.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(h.spawner.calls).toHaveLength(1);
    expect(eventsOf(h, "lock_broken")).toHaveLength(1);
    expect(h.service.running).toBe(true);
    await h.manager.stop();
    expect(h.service.running).toBe(false);
  });

  it("a failing process table fails the tick: nothing is judged, released or broken", async () => {
    const h = setup((p) => ({ locks: [{ name: "session-store", path: join(p.locksDir, "session.lock") }] }));
    writeFileSync(join(h.locksDir, "session.lock"), lockText(4242, NOW - 60 * MIN));
    await request(h);
    h.procs.failing = true;
    const app = await http(h);

    const tick = await post(app, "/api/agents/tick?project=demo");
    expect(tick.statusCode).toBe(500);
    expect(existsSync(join(h.locksDir, "session.lock"))).toBe(true);
    expect(h.spawner.calls).toEqual([]);
  });

  it("the watchdog leaves an agent with an active run to this module: no agent_hung breach for it", async () => {
    const h = setup();
    await request(h);
    await at(h, 0); // worker-a runs here as pid 5001
    h.procs.add(6001, "agent-cli run --agent worker-b --model model-a", NOW); // worker-b runs outside this module
    const watchdogs = new WatchdogManager({
      dbPath: ":memory:",
      probes: { processes: h.procs, fs: new NodeFileSystem(), runner: h.runner, clock: h.clock },
      agents: h.manager,
    });
    watchdogs.load([
      { name: "demo", config: { ...h.config, watchdog: { enabled: true, agent_command: "agent-cli run --agent {agent}" } } },
    ]);
    try {
      h.clock.t = NOW + 46 * MIN; // both silent past hung_minutes
      await watchdogs.get("demo")?.tick();
      const store = watchdogs.getStore();
      expect(store?.listBreaches("demo").map((b) => b.key)).toEqual(["agent_hung:worker-b"]);
      expect(store?.sloStatus("demo").find((s) => s.detector === "agent_hung")?.detail).toContain(
        "left to the agents module: worker-a (run",
      );
    } finally {
      await watchdogs.stop();
    }
  });
});

// ============ 9. THE DECISION INBOX ============

describe("9. the Decision Inbox: decisions are raised there, and the owner's answers resume or stand down the work", () => {
  /** The agents routes and the real Decision Inbox, mounted as src/server/index.ts does. */
  async function withInbox(h: Harness, options: { maxOpenPerSource?: number } = {}) {
    const app = Fastify();
    const tokenPath = join(h.dir, "data", "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    await registerOwnerRoutes(app, auth);
    const inbox = await mountDecisions(app, {
      dbPath: ":memory:",
      humanAuth: auth,
      defaultProject: () => "demo",
      clock: h.clock,
      producers: [h.manager],
      ...options,
    });
    await registerAgentsRoutes(app, h.manager, () => "demo", auth);
    await app.ready();
    apps.push(app);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/owner/sessions",
      headers: DASHBOARD,
      payload: { token: readFileSync(tokenPath, "utf-8").trim() },
    });
    const owner: Record<string, string> = { ...DASHBOARD, [OWNER_SESSION_HEADER]: signIn.json().data.session as string };
    const answer = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/decisions/${id}/answer`, headers: owner, payload });
    return { app, inbox, answer };
  }

  it("an escalated task is a decision; 'fresh_session' starts it again, and when that fails too it asks again", async () => {
    const h = setup();
    const { inbox, answer } = await withInbox(h);
    h.spawner.behaviour = (pid, _log, call) => {
      if (call <= 4 || call === 6) h.spawner.exit(pid, 1); // dead on start (the 5th run lives a while)
    };
    await request(h);
    for (const ms of [0, 0, 10 * SEC, 10 * SEC, 30 * SEC, 30 * SEC, 70 * SEC, 70 * SEC]) await at(h, ms);

    const [asked, ...more] = inbox.list({ project: "demo", status: "open" });
    expect(more).toEqual([]);
    const chainId = runs(h)[0].chainId;
    expect(asked).toMatchObject({
      kind: "escalation",
      source: { module: "agents", ref: `chain:${chainId}` },
      key: `escalation:${chainId}:4`,
      blocks: ["agents:demo:task:feat-login"],
      recommended: { optionId: "release" },
    });
    expect(asked.options.map((o) => o.id)).toEqual(["fresh_session", "release"]);
    expect(asked.title).toContain("Agent worker-a could not finish task feat-login after 4 attempt(s)");
    expect(inboxEntries(h)).toEqual([]); // the inbox file is only the fallback
    expect(h.spawner.calls).toHaveLength(4);

    // The owner answers: start it again in a fresh session
    expect((await answer(asked.id, { optionId: "fresh_session" })).statusCode).toBe(200);
    await at(h, 80 * SEC);
    expect(h.spawner.calls).toHaveLength(5);
    expect(h.spawner.calls[4].env.LAIR_SESSION_MODE).toBe("fresh");
    expect(runs(h).at(-1)).toMatchObject({ state: "running", chainId, freshSessions: 2 });
    expect(eventsOf(h, "decision").at(-1)?.summary).toContain("answered (fresh_session)");

    // It dies on start again: the chain is out of recoveries, so the owner is asked again
    h.spawner.exit(5005, 1);
    await at(h, 90 * SEC);
    const again = inbox.list({ project: "demo", status: "open" });
    expect(again.map((d) => d.key)).toEqual([`escalation:${chainId}:5`]);

    // This time: leave the task unclaimed. Nothing starts again
    expect((await answer(again[0].id, { optionId: "release" })).statusCode).toBe(200);
    for (const ms of [100 * SEC, 30 * MIN]) await at(h, ms);
    expect(h.spawner.calls).toHaveLength(5);
    expect(h.store.getClaim("demo", "feat-login")).toBeNull();
    expect(inbox.list({ project: "demo", status: "open" })).toEqual([]);
  });

  it("a hard budget limit is a spend decision; 'allow' (confirmed) lets the waiting run start for the rest of the period", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const h = setup(() => ({ budgets: { agent: { daily_cost: { hard: 8 } } } }), { budget });
    const { inbox, answer } = await withInbox(h);
    await request(h); // waits: worker-a is over budget once the usage comes in
    budget.recordCost("provider-a", 9, "usage", { project: "demo", agent: "worker-a", tokens: 100 });
    await h.service.tick();
    await h.service.tick();

    expect(h.spawner.calls).toEqual([]);
    const [asked, ...more] = inbox.list({ project: "demo", status: "open" });
    expect(more).toEqual([]);
    expect(asked).toMatchObject({
      kind: "spend",
      source: { module: "agents" },
      key: "budget:agent:worker-a:daily_cost:2026-03-02",
      recommended: { optionId: "wait" },
    });
    expect(asked.options.map((o) => o.id)).toEqual(["allow", "wait"]);

    expect((await answer(asked.id, { optionId: "allow" })).statusCode).toBe(400); // spend needs confirm: true
    expect((await answer(asked.id, { optionId: "allow", confirm: true })).statusCode).toBe(200);
    await h.service.tick();

    expect(h.spawner.calls).toHaveLength(1);
    expect(agentView(h.service.status(), "worker-a").state).toBe("working");
    expect(eventsOf(h, "budget_override")).toHaveLength(1);
    // The next period starts the limit over: the allowance was for 2026-03-02 only
    h.clock.t = Date.parse("2026-03-03T00:05:00.000Z");
    budget.recordCost("provider-a", 9, "usage", { project: "demo", agent: "worker-a", tokens: 100 });
    h.spawner.exit(5001, 0);
    await h.service.tick();
    await expect(request(h, "worker-a", "task-2")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("when the inbox refuses a decision (its cap per module is reached), the inbox file gets it instead", async () => {
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const h = setup(() => ({ budgets: { agent: { daily_cost: { hard: 8 } } } }), { budget });
    const { inbox } = await withInbox(h, { maxOpenPerSource: 1 });
    budget.recordCost("provider-a", 9, "usage", { project: "demo", agent: "worker-a", tokens: 100 });
    budget.recordCost("provider-a", 9, "usage", { project: "demo", agent: "worker-b", tokens: 100 });

    await h.service.tick();

    expect(inbox.list({ project: "demo", status: "open" }).map((d) => d.key)).toEqual([
      "budget:agent:worker-a:daily_cost:2026-03-02",
    ]);
    const entries = inboxEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Agent worker-b used 9 cost in day 2026-03-02 (hard limit 8)");
    expect(eventsOf(h, "decision").map((e) => e.evidence[0])).toEqual([
      "Decision Inbox",
      expect.stringContaining("the Decision Inbox refused it"),
    ]);
  });
});

// ============ 9. PROMPT FILES AND THE START-RUN FORM ============

/** GET as the owner from the dashboard, or with these headers. */
const get = (app: FastifyInstance, url: string, headers: Record<string, string> | undefined = ownerOf.get(app)) =>
  app.inject({ method: "GET", url, headers });

const OUTSIDE_TEXT = "text-of-a-file-outside-prompts-dir";

/** A prompts_dir with one prompt, and a file outside it that must never be read. */
function promptsFixture(h: Paths): { outside: string } {
  mkdirSync(h.promptsDir, { recursive: true });
  writeFileSync(join(h.promptsDir, "feat-login.txt"), "Build the login form\n");
  const outside = join(h.dir, "outside.txt");
  writeFileSync(outside, `${OUTSIDE_TEXT}\n`);
  return { outside };
}

/** The error `run` throws (it must throw). */
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
}

describe("9. prompt files and the start-run form", () => {
  it("listing and reading prompt files are the owner's: refused (403) without an owner session", async () => {
    const h = setup();
    promptsFixture(h);
    const app = await http(h);
    const strangers: Record<string, string>[] = [
      {}, // a script or an agent: no Origin, no session
      DASHBOARD, // the dashboard, not signed in
      { ...DASHBOARD, [OWNER_SESSION_HEADER]: "a-made-up-session-value-0123456789" },
    ];
    for (const url of [promptsUrl("demo"), promptFileUrl("demo", "feat-login.txt")]) {
      for (const headers of strangers) {
        const res = await get(app, url, headers);
        expect(res.statusCode, `${url} with ${JSON.stringify(Object.keys(headers))}`).toBe(403);
        expect(res.json().error).toContain("Only the owner can do this, from the dashboard");
        expect(res.body).not.toContain("feat-login.txt");
        expect(res.body).not.toContain("Build the login form");
      }
    }
    // The owner gets them
    expect((await get(app, promptsUrl("demo"))).statusCode).toBe(200);
    expect((await get(app, promptFileUrl("demo", "feat-login.txt"))).statusCode).toBe(200);
  });

  it("lists basenames only, newest first, and loads one file's text by its basename", async () => {
    const h = setup();
    promptsFixture(h);
    writeFileSync(join(h.promptsDir, "older.md"), "An older prompt\n");
    aged(join(h.promptsDir, "older.md"), 60);
    // Not names a request could ask for: not offered either
    writeFileSync(join(h.promptsDir, ".hidden.txt"), "hidden\n");
    writeFileSync(join(h.promptsDir, "with space.txt"), "spaced\n");
    const app = await http(h);

    const listed = await get(app, promptsUrl("demo"));
    expect(listed.statusCode).toBe(200);
    const files = listed.json().data as PromptFileView[];
    expect(files.map((f) => f.name)).toEqual(["feat-login.txt", "older.md"]);
    expect(files[0]).toMatchObject({ name: "feat-login.txt", size: 21, tooLarge: false });
    expect(Object.keys(files[0]).sort()).toEqual(["modifiedAt", "name", "size", "tooLarge"]);
    expect(listed.body).not.toContain(h.dir);

    const read = await get(app, promptFileUrl("demo", "feat-login.txt"));
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toEqual({ name: "feat-login.txt", size: 21, text: "Build the login form\n" });
    expect(read.body).not.toContain(h.dir);

    expect((await get(app, promptFileUrl("demo", "missing.txt"))).statusCode).toBe(404);
    // No prompts_dir yet: nothing to list
    rmSync(h.promptsDir, { recursive: true, force: true });
    expect((await get(app, promptsUrl("demo"))).json().data).toEqual([]);
    expect(listPromptFiles(h.promptsDir)).toEqual([]);
  });

  it("refuses a name that could leave prompts_dir (400) and reads nothing", async () => {
    const h = setup();
    const { outside } = promptsFixture(h);
    const app = await http(h);
    for (const name of [
      "..",
      "../outside.txt",
      "a/b",
      "/etc/passwd",
      "a\\b",
      ".hidden",
      "-x",
      "x..y",
      "",
      "%2e%2e",
      "a".repeat(256),
    ]) {
      const res = await get(app, promptFileUrl("demo", name));
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json().error).toContain("Invalid prompt file name");
      expect(res.body).not.toContain(OUTSIDE_TEXT);
    }
    // The name as a raw query value, missing, or given twice
    for (const url of [
      "/api/agents/prompts/file?project=demo&name=..%2Foutside.txt",
      "/api/agents/prompts/file?project=demo",
      "/api/agents/prompts/file?project=demo&name=feat-login.txt&name=other.txt",
    ]) {
      const res = await get(app, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.body).not.toContain(OUTSIDE_TEXT);
    }
    // The module itself refuses them too, whatever calls it
    expect(refusal(() => readPromptFile(h.promptsDir, ".."))).toMatchObject({ statusCode: 400 });
    expect(refusal(() => readPromptFile(h.promptsDir, "../outside.txt"))).toBeInstanceOf(PromptFileError);
    expect(readFileSync(outside, "utf-8")).toBe(`${OUTSIDE_TEXT}\n`);
  });

  it("a symlink out of prompts_dir is refused (403) and not listed; one to a file in it is allowed; a directory is refused", async () => {
    const h = setup();
    const { outside } = promptsFixture(h);
    // An agent plants links: to a file outside, to the directory above, and to a prompt of the directory
    symlinkSync(outside, join(h.promptsDir, "planted.txt"));
    symlinkSync(h.dir, join(h.promptsDir, "parent"));
    symlinkSync(join(h.promptsDir, "feat-login.txt"), join(h.promptsDir, "alias.txt"));
    mkdirSync(join(h.promptsDir, "folder.txt"));
    const app = await http(h);

    const files = (await get(app, promptsUrl("demo"))).json().data as PromptFileView[];
    expect(files.map((f) => f.name).sort()).toEqual(["alias.txt", "feat-login.txt"]);

    for (const name of ["planted.txt", "parent"]) {
      const res = await get(app, promptFileUrl("demo", name));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error).toContain("outside prompts_dir");
      expect(res.body).not.toContain(OUTSIDE_TEXT);
      expect(res.body).not.toContain(h.dir);
    }
    const folder = await get(app, promptFileUrl("demo", "folder.txt"));
    expect(folder.statusCode).toBe(403);
    expect(folder.json().error).toContain("not a regular file");

    const alias = await get(app, promptFileUrl("demo", "alias.txt"));
    expect(alias.statusCode).toBe(200);
    expect(alias.json().data).toEqual({ name: "alias.txt", size: 21, text: "Build the login form\n" });
  });

  it("caps a prompt file at the size of a run's prompt: 200000 bytes load (and start a run), one more is refused (413)", async () => {
    const h = setup();
    promptsFixture(h);
    expect(MAX_PROMPT_FILE_BYTES).toBe(200_000);
    writeFileSync(join(h.promptsDir, "largest.txt"), "a".repeat(MAX_PROMPT_FILE_BYTES));
    writeFileSync(join(h.promptsDir, "too-large.txt"), "a".repeat(MAX_PROMPT_FILE_BYTES + 1));
    const app = await http(h);

    const files = (await get(app, promptsUrl("demo"))).json().data as PromptFileView[];
    expect(files.find((f) => f.name === "largest.txt")).toMatchObject({ size: 200_000, tooLarge: false });
    expect(files.find((f) => f.name === "too-large.txt")).toMatchObject({ size: 200_001, tooLarge: true });

    const largest = await get(app, promptFileUrl("demo", "largest.txt"));
    expect(largest.statusCode).toBe(200);
    const text = largest.json().data.text as string;
    expect(text).toHaveLength(200_000);
    const tooLarge = await get(app, promptFileUrl("demo", "too-large.txt"));
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error).toContain("larger than 200000 bytes");
    expect(tooLarge.body).not.toContain("a".repeat(1000));

    // What loads is a prompt a run accepts
    const run = await post(app, "/api/agents/runs?project=demo", { agent: "worker-a", task: "big-task", prompt: text });
    expect(run.statusCode).toBe(201);
  });

  it("the form's request starts the run: the client helper's body with the owner session, the chosen model on the next check", async () => {
    const h = setup(() => FALLBACK);
    promptsFixture(h);
    const app = await http(h);
    const owner: Record<string, string> = ownerOf.get(app) ?? {};
    const session: Record<string, string> = { [OWNER_SESSION_HEADER]: owner[OWNER_SESSION_HEADER] };

    // What the Agents view does: load a prompt file, then send startRunAction with this browser's owner session
    const loaded = await app.inject({ method: "GET", url: promptFileUrl("demo", "feat-login.txt"), headers: { ...DASHBOARD, ...session } });
    const prompt = loaded.json().data.text as string;
    const chosen = startRunAction("demo", { agent: "worker-a", task: "feat-login", prompt, model: "model-b" });
    const chosenRequest = ownerRequest(chosen.body, session);
    const res = await app.inject({ url: chosen.url, ...chosenRequest, headers: { ...DASHBOARD, ...chosenRequest.headers } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ agent: "worker-a", task: "feat-login", state: "queued" });

    // The default model: the form sends no model
    const byDefault = startRunAction("demo", { agent: "worker-b", task: "feat-signup", prompt: "Build the signup form", model: "" });
    expect(byDefault.body).not.toHaveProperty("model");
    const defaultRequest = ownerRequest(byDefault.body, session);
    const second = await app.inject({ url: byDefault.url, ...defaultRequest, headers: { ...DASHBOARD, ...defaultRequest.headers } });
    expect(second.statusCode).toBe(201);

    // Without the owner session the same request is refused, and nothing more is claimed
    const stranger = ownerRequest(startRunAction("demo", { agent: "worker-a", task: "other", prompt: "x" }).body, {});
    expect((await app.inject({ url: chosen.url, ...stranger, headers: { ...DASHBOARD, ...stranger.headers } })).statusCode).toBe(403);
    expect(h.store.listClaims("demo").map((c) => c.task).sort()).toEqual(["feat-login", "feat-signup"]);

    await post(app, "/api/agents/tick?project=demo");
    expect(h.spawner.calls).toHaveLength(2);
    const spawnOf = (agent: string) => {
      const call = h.spawner.calls.find((c) => c.env.LAIR_AGENT === agent);
      if (!call) throw new Error(`no spawn for ${agent}`);
      return call;
    };
    expect(spawnOf("worker-a").argv).toEqual(expect.arrayContaining(["--agent", "worker-a", "--model", "model-b"]));
    expect(promptOf(spawnOf("worker-a"))).toContain("Build the login form");
    expect(spawnOf("worker-b").argv).toEqual(expect.arrayContaining(["--agent", "worker-b", "--model", "model-a"]));
  });
});

// ============ 10. THE DRAGONS VIEW ============

describe("10. the Dragons view: a dragon this module runs is running, managed by Lair", () => {
  it("shows the run and the agent's state from the request to the end of the run", async () => {
    const h = setup();
    // As src/server/index.ts gives the data service the agents module's runs
    const data = new DataService(h.config, { managedRuns: () => h.manager.managedRuns("demo") });
    writeFileSync(join(h.agentsDir, "dragons.txt"), "worker-b\tB\tunassigned\n");
    const dragon = (id: string) => data.getDragons().find((d) => d.id === id);

    expect(dragon("worker-a")).toBeUndefined(); // in dragons: only, and not running: not listed
    const run = await request(h);
    // Requested: shown (though dragons.txt doesn't list it), running, starting
    expect(dragon("worker-a")).toMatchObject({
      running: true,
      managedRun: { runId: run.id, task: "feat-login", state: "starting" },
    });

    await h.service.tick();
    expect(h.store.getRun(run.id)).toMatchObject({ state: "running", pid: 5001 });
    expect(dragon("worker-a")).toMatchObject({ running: true, managedRun: { runId: run.id, state: "working" } });
    expect(dragon("worker-b")).toMatchObject({ running: false });
    expect(dragon("worker-b")?.managedRun).toBeUndefined();

    h.spawner.exit(5001, 0);
    await h.service.tick();
    expect(h.store.getRun(run.id)?.state).toBe("completed");
    expect(h.manager.managedRuns("demo").size).toBe(0);
    expect(dragon("worker-a")).toBeUndefined();
    // A project without the module has no managed runs
    expect(h.manager.managedRuns("off").size).toBe(0);
  });
});
