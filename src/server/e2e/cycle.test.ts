/**
 * End-to-end: tasks through Lair's whole agent cycle on a fake project,
 * driven through the owner's HTTP API as the dashboard drives it.
 *
 *   task in the tasks file -> fill starts a run -> the agent reports WAITING on
 *   a gate -> Lair restarts -> the gate system writes its result -> fill wakes
 *   the task -> a second run reports DONE -> the task is done, never started again
 *
 *   a BLOCKED report -> held, with one decision in the Decision Inbox -> the
 *   owner releases it over HTTP -> the decision is withdrawn, the task runs again
 *
 * Real: the agents module as the server wires it (AgentsManager, its SQLite
 * store, the event bus), the owner routes with a signed-in owner session, the
 * Decision Inbox, files on disk. Fake: only the machine boundary, i.e. the
 * process spawner (the agent CLI: a started process writes its log, reports a
 * line in the queue file and exits), the process table and the clock. The gate
 * system is a result file where the project's wake config looks.
 *
 * Every step asserts Lair's own state: the runs and their states, the claim,
 * the events in the store and on the bus, the fill status the API serves, what
 * was spawned and the decisions raised; never a file the test wrote itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentAdapter, ProjectConfig } from "../../shared/types.js";
import type { AgentEventKind, AgentsStatusView, FillLineView } from "../../shared/agents-types.js";
import { EventBus } from "../core/event-bus.js";
import { NodeFileSystem, type Clock, type CommandOutput, type CommandRunner, type ProcessInfo, type ProcessTable } from "../watchdog/probes.js";
import { AgentsManager, type AgentsService } from "../agents/service.js";
import { registerAgentsRoutes } from "../agents/routes.js";
import type { AgentProbes, MemoryReading, ProcessOwner, ProcessSpawner, SpawnOptions, SystemInfo } from "../agents/probes.js";
import type { AgentsStore } from "../agents/store.js";
import type { AgentEvent, AgentRun } from "../agents/types.js";
import type { DecisionInbox } from "../decisions/service.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { mountDecisions } from "../decisions/index.js";
import { ownerRequest, releaseFillHoldAction } from "../../client/agents-actions";

const NOW = Date.parse("2026-06-15T10:00:00.000Z");
const MIN = 60_000;
const PROJECT = "e2e";
const GATE = "20260615T100100Z-feat-search-abcdef12-1";
const PROMPT = "You are worker A: build what the task says.\n";

// ============ THE MACHINE BOUNDARY ============

class FakeClock implements Clock {
  t = NOW;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

/** The machine's processes, with start times: `ps` elapsed times grow with the clock */
class FakeProcessTable implements ProcessTable {
  private procs = new Map<number, { startedAt: number; command: string }>();
  constructor(private clock: FakeClock) {}
  add(pid: number, command: string, startedAt: number): void {
    this.procs.set(pid, { startedAt, command });
  }
  remove(pid: number): void {
    this.procs.delete(pid);
  }
  async list(): Promise<ProcessInfo[]> {
    return [...this.procs.entries()].map(([pid, p]) => ({
      pid,
      ppid: 1,
      elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - p.startedAt) / 1000)),
      argv: p.command.split(" "),
      command: p.command,
    }));
  }
}

interface SpawnCall {
  pid: number;
  argv: string[];
  env: Record<string, string>;
}

/** The agent CLI: a started process writes its log; `report` is it writing a queue line and exiting. */
class FakeAgentCli implements ProcessSpawner {
  calls: SpawnCall[] = [];
  private exits = new Map<number, number | null>();
  private started = new Set<number>();
  private nextPid = 5001;
  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}

  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    this.calls.push({ pid, argv: [...argv], env: { ...options.env } });
    writeFileSync(options.logPath, "working\n");
    const t = new Date(this.clock.now());
    utimesSync(options.logPath, t, t);
    this.started.add(pid);
    this.procs.add(pid, argv.join(" "), this.clock.now());
    return { pid, startedAt: this.clock.now() };
  }

  /** The agent writes its report to the project's queue file, then exits with `code` */
  report(queueFile: string, pid: number, line: string, code = 0): void {
    appendFileSync(queueFile, `${line}\n`);
    this.procs.remove(pid);
    this.exits.set(pid, code);
  }

  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }
  knows(pid: number): boolean {
    return this.started.has(pid);
  }
  kill(pid: number): boolean {
    this.procs.remove(pid);
    this.exits.set(pid, null);
    return true;
  }
  forget(pid: number): void {
    this.exits.delete(pid);
    this.started.delete(pid);
  }
}

/** No capacity command is configured: a command run would be a fault, and the test asserts none */
class NoCommands implements CommandRunner {
  calls: string[][] = [];
  async run(argv: string[]): Promise<CommandOutput> {
    this.calls.push([...argv]);
    return { code: 127, stdout: "", stderr: "no commands in this test" };
  }
}

class IdleMachine implements SystemInfo {
  cpuCount(): number {
    return 4;
  }
  loadAvg1(): number {
    return 0.5;
  }
  totalMemory(): number {
    return 16 * 1024 ** 3;
  }
  async memory(): Promise<MemoryReading> {
    return { available: 8 * 1024 ** 3 };
  }
}

// ============ THE FAKE PROJECT ============

interface Project {
  dir: string;
  queueFile: string;
  tasksFile: string;
  gatesDir: string;
  promptsDir: string;
  dbPath: string;
}

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
};

const dirs: string[] = [];

function fakeProject(): Project {
  const dir = mkdtempSync(join(tmpdir(), "lair-e2e-"));
  dirs.push(dir);
  const project: Project = {
    dir,
    queueFile: join(dir, "queue.md"),
    tasksFile: join(dir, "tasks.txt"),
    gatesDir: join(dir, "gates"),
    promptsDir: join(dir, "prompts"),
    dbPath: join(dir, "data", "agents.db"),
  };
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(project.gatesDir, "results"), { recursive: true });
  mkdirSync(project.promptsDir, { recursive: true });
  writeFileSync(join(project.promptsDir, "worker-a.txt"), PROMPT);
  writeFileSync(project.queueFile, "# Queue\n");
  // worker-b is not on fill's list: fill must leave its task alone
  writeFileSync(project.tasksFile, "worker-a|Alice|feat-search|Fix the search results\nworker-b|Bob|feat-other|Not fill's to start\n");
  return project;
}

function projectConfig(p: Project): ProjectConfig {
  return {
    name: "E2E",
    repo: p.dir,
    github: "example/e2e",
    queue_file: p.queueFile,
    agents_dir: join(p.dir, "agents"),
    gates_dir: p.gatesDir,
    prompts_dir: p.promptsDir,
    machines: {},
    read_only: false,
    inbox_file: join(p.dir, "inbox.md"),
    dragons: {
      "worker-a": { name: "A", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
      "worker-b": { name: "B", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
    },
    agent_adapters: ADAPTERS,
    agents: {
      enabled: true,
      interval_seconds: 1,
      start_timeout_minutes: 10,
      dead_on_start_seconds: 60,
      hung_minutes: 45,
      stop_grace_seconds: 30,
      session_dir: "{agents_dir}/sessions/{agent}",
      recovery: { same_session_restarts: 2, fresh_sessions: 1, backoff_seconds: 10, max_backoff_seconds: 600 },
      retries: { max_retries: 2, backoff_seconds: 60, max_backoff_seconds: 3600 },
      fill: {
        enabled: true,
        tasks_file: p.tasksFile,
        agents: ["worker-a"],
        prompt_files: ["{prompts_dir}/{agent}.txt"],
        max_active: 2,
        interval_seconds: 60,
        // The project's queue format: WAITING <task> <gate id>, and the gate system's result file
        waiting_pattern: "^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)",
        wake: { file: "{gates_dir}/results/{wake}.rc" },
      },
    },
  } as unknown as ProjectConfig;
}

// ============ LAIR, AS THE SERVER WIRES IT ============

const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

interface Lair {
  clock: FakeClock;
  agentCli: FakeAgentCli;
  commands: NoCommands;
  manager: AgentsManager;
  service: AgentsService;
  store: AgentsStore;
  inbox: DecisionInbox;
  app: FastifyInstance;
  /** Event types published on the bus, in order */
  bus: string[];
  owner: Record<string, string>;
}

const running: Lair[] = [];

afterEach(async () => {
  for (const lair of [...running]) await stopLair(lair);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function stopLair(lair: Lair): Promise<void> {
  const i = running.indexOf(lair);
  if (i >= 0) running.splice(i, 1);
  await lair.app.close();
  await lair.manager.stop();
}

/** The machine Lair runs on: it outlives a restart of Lair */
interface Machine {
  clock: FakeClock;
  procs: FakeProcessTable;
  agentCli: FakeAgentCli;
}

function machine(): Machine {
  const clock = new FakeClock();
  const procs = new FakeProcessTable(clock);
  return { clock, procs, agentCli: new FakeAgentCli(procs, clock) };
}

/** A Lair server on the project and machine: `self` is its own process (a restart is a new one on the same data). */
async function startLair(p: Project, m: Machine, self: ProcessOwner = { pid: 100, startedAt: NOW - 60 * MIN }): Promise<Lair> {
  const { clock, procs, agentCli } = m;
  const commands = new NoCommands();
  const events = new EventBus();
  const bus: string[] = [];
  events.on("*", (event) => {
    bus.push(event.type);
  });
  const probes: AgentProbes = {
    processes: procs,
    fs: new NodeFileSystem(),
    runner: commands,
    clock,
    spawner: agentCli,
    self,
    systemInfo: new IdleMachine(),
  };
  const manager = new AgentsManager({ dbPath: p.dbPath, probes, events });
  manager.load([{ name: PROJECT, config: projectConfig(p) }]);
  const service = manager.get(PROJECT);
  const store = manager.getStore();
  if (!service || !store) throw new Error(`agents not enabled: ${manager.status(PROJECT).errors.join("; ")}`);

  const app = Fastify();
  const tokenPath = join(p.dir, "data", "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  const inbox = await mountDecisions(app, { dbPath: ":memory:", humanAuth: auth, defaultProject: () => PROJECT, clock, producers: [manager] });
  await registerAgentsRoutes(app, manager, () => PROJECT, auth);
  await app.ready();
  const signIn = await app.inject({
    method: "POST",
    url: "/api/owner/sessions",
    headers: DASHBOARD,
    payload: { token: readFileSync(tokenPath, "utf-8").trim() },
  });
  expect(signIn.statusCode).toBe(201);
  const owner = { ...DASHBOARD, [OWNER_SESSION_HEADER]: signIn.json().data.session as string };
  const lair: Lair = { clock, agentCli, commands, manager, service, store, inbox, app, bus, owner };
  running.push(lair);
  return lair;
}

/** The owner's "check now" from the dashboard, at NOW + ms: a tick, then a fill check */
async function checkNow(lair: Lair, ms: number): Promise<void> {
  lair.clock.t = NOW + ms;
  const res = await lair.app.inject({ method: "POST", url: `/api/agents/tick?project=${PROJECT}`, headers: lair.owner });
  expect(res.statusCode, res.body).toBe(200);
}

/** The fill status the dashboard reads */
async function fillLine(lair: Lair, task: string): Promise<FillLineView> {
  const res = await lair.app.inject({ url: `/api/agents/status?project=${PROJECT}` });
  expect(res.statusCode).toBe(200);
  const line = (res.json().data as AgentsStatusView).fill?.lines.find((l) => l.task === task);
  if (!line) throw new Error(`no fill line for ${task}`);
  return line;
}

const runs = (lair: Lair): AgentRun[] => lair.store.listRuns(PROJECT, { limit: 100 }).reverse();
const eventsOf = (lair: Lair, kind: AgentEventKind): AgentEvent[] => lair.store.listEvents(PROJECT, { kinds: [kind], limit: 100 }).reverse();
const openDecisions = (lair: Lair) => lair.inbox.list({ project: PROJECT, status: "open" });

/** The run's prompt, as the agent CLI was given it */
const promptOf = (call: SpawnCall) => readFileSync(call.argv[call.argv.indexOf("--prompt") + 1], "utf-8");

// ============ THE CYCLE ============

describe("e2e: a task through Lair's agent cycle on a fake project", () => {
  it("task -> run -> WAITING on a gate -> restart -> gate result -> run -> DONE -> done, never started again", async () => {
    const p = fakeProject();
    const m = machine();
    let lair = await startLair(p, m);

    // The owner's check now: fill takes the allowlisted task and queues a run, claimed for it
    await checkNow(lair, 0);
    let line = await fillLine(lair, "feat-search");
    expect(line).toMatchObject({ state: "started", agent: "worker-a", description: "Fix the search results" });
    const [first] = runs(lair);
    expect(first).toMatchObject({ agent: "worker-a", task: "feat-search", origin: "fill", state: "queued" });
    expect(line.runId).toBe(first.id);
    expect(lair.store.getClaim(PROJECT, "feat-search")).toMatchObject({ runId: first.id });
    expect(eventsOf(lair, "fill_started").map((e) => e.runId)).toEqual([first.id]);
    expect(lair.bus).toContain("agents.fill_started");
    // worker-b's task is not fill's to start: no run, no claim
    expect(await fillLine(lair, "feat-other")).toMatchObject({ state: "not_allowlisted", runId: null });
    expect(lair.store.getClaim(PROJECT, "feat-other")).toBeNull();

    // The next check starts the agent CLI with the task and fill's prompt
    await checkNow(lair, 0);
    expect(lair.agentCli.calls).toHaveLength(1);
    const [call1] = lair.agentCli.calls;
    expect(call1.env).toMatchObject({ LAIR_TASK: "feat-search", LAIR_AGENT: "worker-a" });
    expect(promptOf(call1)).toBe(PROMPT);
    expect(runs(lair)[0]).toMatchObject({ id: first.id, state: "running", pid: call1.pid });
    expect(lair.bus).toContain("agent.run.started");

    // The agent queues a gate, reports WAITING on it and exits: the run ends, the task waits on the gate
    lair.agentCli.report(p.queueFile, call1.pid, `- WAITING feat-search ${GATE} by worker-a 10:01Z: gate queued`);
    await checkNow(lair, MIN);
    expect(runs(lair)[0].state).toBe("completed");
    expect(lair.bus).toContain("agent.run.ended");
    line = await fillLine(lair, "feat-search");
    expect(line).toMatchObject({ state: "held", hold: "waiting", waiting: { wake: GATE, fallbackAt: null, refused: null } });
    for (const minute of [10, 20]) await checkNow(lair, minute * MIN);
    expect(lair.agentCli.calls).toHaveLength(1);
    expect(runs(lair)).toHaveLength(1);
    // Waiting on a gate needs no owner: nothing asked
    expect(openDecisions(lair)).toEqual([]);

    // Lair restarts while the task waits: a new server process on the same data keeps waiting
    const { agentCli } = m;
    await stopLair(lair);
    m.clock.t = NOW + 25 * MIN;
    lair = await startLair(p, m, { pid: 200, startedAt: NOW + 25 * MIN });
    await checkNow(lair, 26 * MIN);
    expect(await fillLine(lair, "feat-search")).toMatchObject({ state: "held", hold: "waiting", waiting: { wake: GATE } });
    expect(runs(lair)).toHaveLength(1);

    // The gate system writes its result: fill wakes the task once, and the next check starts it again
    const result = join(p.gatesDir, "results", `${GATE}.rc`);
    writeFileSync(result, "0\n");
    utimesSync(result, new Date(NOW + 30 * MIN), new Date(NOW + 30 * MIN));
    await checkNow(lair, 31 * MIN);
    expect(eventsOf(lair, "fill_woken")).toHaveLength(1);
    expect(await fillLine(lair, "feat-search")).toMatchObject({ state: "started" });
    await checkNow(lair, 31 * MIN);
    expect(agentCli.calls).toHaveLength(2);
    const call2 = agentCli.calls[1];
    expect(call2.env).toMatchObject({ LAIR_TASK: "feat-search", LAIR_AGENT: "worker-a" });
    const second = runs(lair)[1];
    expect(second).toMatchObject({ task: "feat-search", origin: "fill", state: "running", pid: call2.pid });

    // The agent reports DONE and exits: the run completes, the task is done
    agentCli.report(p.queueFile, call2.pid, "- DONE feat-search by worker-a 10:40Z: merged");
    await checkNow(lair, 40 * MIN);
    expect(runs(lair)[1].state).toBe("completed");
    line = await fillLine(lair, "feat-search");
    expect(line).toMatchObject({ state: "done", detail: "done: - DONE feat-search by worker-a 10:40Z: merged" });
    expect(eventsOf(lair, "fill_done")).toHaveLength(1);

    // Done stays done: later checks start nothing, ask nothing, and run no command
    for (const minute of [50, 120, 600]) await checkNow(lair, minute * MIN);
    expect(agentCli.calls).toHaveLength(2);
    expect(runs(lair)).toHaveLength(2);
    expect((await fillLine(lair, "feat-search")).state).toBe("done");
    expect(eventsOf(lair, "fill_done")).toHaveLength(1);
    expect(openDecisions(lair)).toEqual([]);
    expect(lair.commands.calls).toEqual([]);
  });

  it("a BLOCKED report is held with one decision; the owner's release over HTTP withdraws it and the task runs again", async () => {
    const p = fakeProject();
    const lair = await startLair(p, machine());
    await checkNow(lair, 0);
    await checkNow(lair, 0);
    const [call1] = lair.agentCli.calls;
    const [run] = runs(lair);
    expect(run).toMatchObject({ state: "running", pid: call1.pid });

    // The agent can't go on without the owner: it says so and exits
    lair.agentCli.report(p.queueFile, call1.pid, "- BLOCKED feat-search by worker-a: needs the search service's API key from the owner");
    await checkNow(lair, MIN);
    expect(runs(lair)[0].state).toBe("completed");
    let line = await fillLine(lair, "feat-search");
    expect(line).toMatchObject({ state: "held", hold: "blocked", releasable: true, runId: run.id });
    const [asked, ...more] = openDecisions(lair);
    expect(more).toEqual([]);
    expect(asked).toMatchObject({ key: `fill:feat-search:blocked:${run.id}` });
    expect(asked.context).toContain("needs the search service's API key from the owner");
    expect(line.decisionId).toBe(asked.id);
    expect(eventsOf(lair, "fill_held").map((e) => e.data.hold)).toEqual(["blocked"]);
    expect(lair.bus).toContain("agents.fill_held");

    // Held is held: hours of checks start nothing and ask nothing more
    for (const minute of [10, 60, 600]) await checkNow(lair, minute * MIN);
    expect(lair.agentCli.calls).toHaveLength(1);
    expect(openDecisions(lair)).toHaveLength(1);

    // Releasing is the owner's: refused without the owner session
    const release = releaseFillHoldAction(PROJECT, "feat-search", "worker-a");
    const anonymous = await lair.app.inject({ method: "POST", url: release.url, headers: DASHBOARD, payload: release.body });
    expect(anonymous.statusCode).toBe(403);
    expect(openDecisions(lair)).toHaveLength(1);

    // The owner releases it from the dashboard: the decision is withdrawn, fill starts the task again
    const sent = ownerRequest(release.body, { [OWNER_SESSION_HEADER]: lair.owner[OWNER_SESSION_HEADER] });
    const released = await lair.app.inject({ url: release.url, ...sent, headers: { ...DASHBOARD, ...sent.headers } });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().data).toEqual({ task: "feat-search", runId: run.id });
    await checkNow(lair, 601 * MIN);
    expect(openDecisions(lair)).toEqual([]);
    line = await fillLine(lair, "feat-search");
    expect(line.state).toBe("started");
    await checkNow(lair, 601 * MIN);
    expect(lair.agentCli.calls).toHaveLength(2);
    expect(promptOf(lair.agentCli.calls[1])).toBe(PROMPT);
    expect(runs(lair).map((r) => r.state)).toEqual(["completed", "running"]);
  });
});
