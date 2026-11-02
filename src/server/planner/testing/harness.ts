/**
 * The planner's test harness. Only the system boundary is fake: the process
 * table, the process spawner (which, like an agent CLI, writes its log and
 * exits when the test says so) and the clock. The agents module, the
 * planner, the Decision Inbox, the owner credential, SQLite stores and files
 * (in a temp dir) are the production ones, wired as src/server/index.ts
 * wires them.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentAdapter, ProjectConfig } from "../../../shared/types.js";
import { EventBus } from "../../core/event-bus.js";
import { AgentsManager, registerAgentsRoutes, type AgentsService } from "../../agents/index.js";
import type { AgentProbes, ProcessOwner, ProcessSpawner, SpawnOptions } from "../../agents/probes.js";
import type { AgentsStore } from "../../agents/store.js";
import { mountDecisions, type DecisionInbox } from "../../decisions/index.js";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../../human-auth/index.js";
import {
  NodeFileSystem,
  type Clock,
  type CommandOutput,
  type CommandRunner,
  type ProcessInfo,
  type ProcessTable,
} from "../../watchdog/probes.js";
import { mountPlanner, plannerAgentsFrom, type PlannerManager, type PlannerService } from "../index.js";
import type { BusLineSource } from "../../bus/consumers.js";

export const NOW = Date.parse("2026-03-02T12:00:00.000Z");
export const SEC = 1000;
export const MIN = 60_000;
const SELF: ProcessOwner = { pid: 100, startedAt: NOW - 60 * MIN };
export const DASHBOARD = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

export class FakeClock implements Clock {
  t = NOW;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

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

export interface SpawnCall {
  argv: string[];
  env: Record<string, string>;
  logPath: string;
  pid: number;
}

export class FakeSpawner implements ProcessSpawner {
  calls: SpawnCall[] = [];
  private exits = new Map<number, number | null>();
  private started = new Set<number>();
  nextPid = 5001;
  /** What a started process does at once (write its proposal file, say) */
  behaviour?: (call: SpawnCall) => void;

  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}

  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    const call: SpawnCall = { argv: [...argv], env: { ...options.env }, logPath: options.logPath, pid };
    this.calls.push(call);
    appendFileSync(options.logPath, "starting\n");
    const t = new Date(this.clock.now());
    utimesSync(options.logPath, t, t);
    this.started.add(pid);
    this.procs.add(pid, argv.join(" "), this.clock.now());
    this.behaviour?.(call);
    return { pid, startedAt: this.clock.now() };
  }
  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }
  knows(pid: number): boolean {
    return this.started.has(pid);
  }
  kill(pid: number): boolean {
    this.exit(pid, null);
    return true;
  }
  forget(pid: number): void {
    this.exits.delete(pid);
    this.started.delete(pid);
  }
  exit(pid: number, code: number | null): void {
    this.procs.remove(pid);
    this.exits.set(pid, code);
  }
}

class FakeRunner implements CommandRunner {
  async run(): Promise<CommandOutput> {
    return { code: 0, stdout: "", stderr: "" };
  }
}

const ADAPTERS: Record<string, AgentAdapter> = {
  "test-cli": {
    id: "test-cli",
    name: "Test CLI",
    start_cmd: "agent-cli run --agent {agent_id} --model {model} --prompt {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    log_dir: "logs",
  },
};

export interface Paths {
  dir: string;
  repo: string;
  work: string;
  agentsDir: string;
  promptsDir: string;
  queueFile: string;
  inboxFile: string;
  outboxFile: string;
  tasksFile: string;
  planFile: string;
  backlogFile: string;
}

export interface Harness extends Paths {
  config: ProjectConfig;
  clock: FakeClock;
  spawner: FakeSpawner;
  agents: AgentsManager;
  agentsService: AgentsService;
  agentsStore: AgentsStore;
  planner: PlannerManager;
  service: PlannerService;
  inbox: DecisionInbox;
  app: FastifyInstance;
  owner: Record<string, string>;
  bus: { type: string; data: Record<string, unknown> }[];
  /** The event bus the agents module and the planner emit on (other modules' tests subscribe to it) */
  events: EventBus;
  /** Answer a decision as the owner, over HTTP */
  answer(id: string, optionId: string): Promise<number>;
  /** Restart: a new agents manager, planner and inbox on the same data */
  dbs: { agents: string; planner: string; decisions: string; owner: string };
}

const cleanups: (() => Promise<void> | void)[] = [];

export async function cleanup(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

export function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "lair-planner-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const work = join(dir, "work");
  const paths: Paths = {
    dir,
    repo,
    work,
    agentsDir: join(work, "agents"),
    promptsDir: join(work, "prompts"),
    queueFile: join(work, "queue.md"),
    inboxFile: join(work, "owner-inbox.md"),
    outboxFile: join(work, "owner-outbox.md"),
    tasksFile: join(work, "tasks.txt"),
    planFile: join(repo, "docs", "plan.md"),
    backlogFile: join(repo, "docs", "backlog.md"),
  };
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });
  mkdirSync(paths.promptsDir, { recursive: true });
  writeFileSync(paths.queueFile, "# Queue\n");
  writeFileSync(paths.tasksFile, "# agent|name|task|description\n");
  writeFileSync(paths.planFile, "# Plan\n");
  writeFileSync(join(paths.promptsDir, "planner.md"), "You are the planner. Keep the task list current.\n");
  writeFileSync(join(paths.promptsDir, "worker.txt"), "You are a worker: do the task in LAIR_TASK.\n");
  return paths;
}

export function projectConfig(p: Paths, planner: Record<string, unknown>, extra: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "Demo",
    repo: p.repo,
    github: "example/demo",
    queue_file: p.queueFile,
    agents_dir: p.agentsDir,
    gates_dir: join(p.work, "gates"),
    machines: {},
    read_only: false,
    inbox_file: p.inboxFile,
    outbox_file: p.outboxFile,
    prompts_dir: p.promptsDir,
    dragons: {
      "worker-a": { id: "worker-a", name: "Alice", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
      "worker-b": { id: "worker-b", name: "Bob", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
      planner: { id: "planner", name: "Planner", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" },
    },
    agent_adapters: ADAPTERS,
    agents: {
      enabled: true,
      interval_seconds: 1,
      dead_on_start_seconds: 30,
      fill: {
        enabled: false,
        tasks_file: p.tasksFile,
        agents: ["worker-a", "worker-b"],
        prompt_files: ["{prompts_dir}/worker.txt"],
      },
    },
    planner,
    ...extra,
  } as unknown as ProjectConfig;
}

/** A planner block with the demo's sources and planner agent; `over` replaces keys. */
export function plannerBlock(p: Paths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    mode: "act",
    roots: [p.work],
    sources: [
      { kind: "markdown_plan", paths: [p.planFile] },
      { kind: "owner_messages" },
      { kind: "queue_events" },
    ],
    agent: { id: "planner", prompt_file: "planner.md", min_interval_seconds: 600, debounce_seconds: 30, max_proposals: 5 },
    ...over,
  };
}

export async function setup(
  p: Paths,
  planner: Record<string, unknown>,
  options: {
    clock?: FakeClock;
    dbs?: Harness["dbs"];
    extra?: Partial<ProjectConfig>;
    /** The project's bus as fill and the planner read it (bus.consume observe or on); no bus without it */
    bus?: (project: string) => BusLineSource | null;
  } = {},
): Promise<Harness> {
  const config = projectConfig(p, planner, options.extra);
  const clock = options.clock ?? new FakeClock();
  const procs = new FakeProcessTable(clock);
  const spawner = new FakeSpawner(procs, clock);
  const events = new EventBus();
  const bus: Harness["bus"] = [];
  events.on("*", (event) => {
    bus.push({ type: event.type, data: event.data });
  });
  const probes: AgentProbes = { processes: procs, fs: new NodeFileSystem(), runner: new FakeRunner(), clock, spawner, self: SELF, systemInfo: { cpuCount: () => 4, loadAvg1: () => 0.5, totalMemory: () => 16e9, memory: async () => ({ available: 8e9 }) } };
  const dbs = options.dbs ?? {
    agents: join(p.dir, "data", "agents.db"),
    planner: join(p.dir, "data", "planner.db"),
    decisions: join(p.dir, "data", "decisions.db"),
    owner: join(p.dir, "data", "owner.token"),
  };
  const busSource = options.bus;
  const agents = new AgentsManager({
    dbPath: dbs.agents,
    probes,
    events,
    bus: busSource ? { lineSource: busSource, mintToken: () => null, revokeTokens: () => {}, sweepTokens: async () => {} } : undefined,
  });
  agents.load([{ name: "demo", config }]);
  const app = Fastify();
  const auth = HumanAuth.open({ tokenPath: dbs.owner, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  const inbox = await mountDecisions(app, {
    dbPath: dbs.decisions,
    humanAuth: auth,
    defaultProject: () => "demo",
    clock,
    events,
    producers: [agents],
  });
  await registerAgentsRoutes(app, agents, () => "demo", auth);
  const plannerManager = await mountPlanner(app, {
    dbPath: dbs.planner,
    agents: plannerAgentsFrom(agents),
    events,
    clock,
    projects: [{ name: "demo", config }],
    defaultProject: () => "demo",
    humanAuth: auth,
    bus: busSource,
  });
  plannerManager.useDecisions(inbox);
  await app.ready();
  cleanups.push(async () => {
    await plannerManager.stop();
    await agents.stop();
    await app.close();
  });
  const signIn = await app.inject({
    method: "POST",
    url: "/api/owner/sessions",
    headers: DASHBOARD,
    payload: { token: readFileSync(dbs.owner, "utf-8").trim() },
  });
  const owner = { ...DASHBOARD, [OWNER_SESSION_HEADER]: signIn.json().data.session as string };
  const agentsService = agents.get("demo");
  const agentsStore = agents.getStore();
  const service = plannerManager.get("demo");
  if (!agentsService || !agentsStore) throw new Error(`agents not enabled: ${agents.status("demo").errors.join("; ")}`);
  if (!service) throw new Error(`planner not enabled: ${plannerManager.status("demo").errors.join("; ")}`);
  const answer = async (id: string, optionId: string) =>
    (await app.inject({ method: "POST", url: `/api/decisions/${id}/answer`, headers: owner, payload: { optionId } })).statusCode;
  return {
    ...p,
    config,
    clock,
    spawner,
    agents,
    agentsService,
    agentsStore,
    planner: plannerManager,
    service,
    inbox,
    app,
    owner,
    bus,
    events,
    answer,
    dbs,
  };
}

export const tasks = (p: Paths, ...lines: string[]) => writeFileSync(p.tasksFile, `# agent|name|task|description\n${lines.join("\n")}\n`);
export const queue = (p: Paths, ...lines: string[]) => appendFileSync(p.queueFile, `${lines.join("\n")}\n`);
export const tasksText = (p: Paths) => readFileSync(p.tasksFile, "utf-8");

/** The proposal file path Lair put in a planner run's prompt. */
export function proposalPathOf(call: SpawnCall): string {
  const promptFile = call.argv[call.argv.indexOf("--prompt") + 1];
  const match = /Write your proposals as JSON to this file, and nothing else: (\S+)/.exec(readFileSync(promptFile, "utf-8"));
  if (!match) throw new Error("no proposal path in the prompt");
  return match[1];
}

export function promptOf(call: SpawnCall): string {
  return readFileSync(call.argv[call.argv.indexOf("--prompt") + 1], "utf-8");
}

/** Move the clock to NOW + ms. */
export function at(h: Harness, ms: number): void {
  h.clock.t = NOW + ms;
}

/**
 * Let the planner agent's run happen: the agents tick spawns it (its
 * behaviour writes what it writes), then it logs, and exits 0 a minute
 * later; the next agents tick sees it completed.
 */
export async function runPlannerAgent(h: Harness, write: (call: SpawnCall) => void, exitCode = 0): Promise<SpawnCall> {
  const before = h.spawner.calls.length;
  h.spawner.behaviour = (call) => {
    if (call.env.LAIR_AGENT === "planner") write(call);
  };
  await h.agentsService.tick();
  const call = h.spawner.calls[before];
  if (!call) throw new Error("the planner agent was not spawned");
  h.spawner.behaviour = undefined;
  h.clock.t += 2 * MIN;
  appendFileSync(call.logPath, "worked\n");
  const t = new Date(h.clock.now());
  utimesSync(call.logPath, t, t);
  h.spawner.exit(call.pid, exitCode);
  await h.agentsService.tick();
  return call;
}

export function writeProposals(call: SpawnCall, proposals: unknown): void {
  writeFileSync(proposalPathOf(call), typeof proposals === "string" ? proposals : JSON.stringify(proposals));
}
