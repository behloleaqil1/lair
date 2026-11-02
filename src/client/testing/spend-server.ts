/**
 * A Lair server for the AI spend panel's DOM tests (docs/design/ai-spend.md AT-35), through the production code: the
 * real AgentsManager and AgentsService on a real SQLite store and real files in a temporary directory, behind the
 * real agents routes and HumanAuth. Runs go as the server runs them: requested, spawned, their log written, ended by
 * the next tick, which writes their spend rows. The one fake boundary is the agent CLI: the process spawner and
 * process table, on a clock the test moves. The logs are the sanitized real CLI output in fixtures/agents-usage/: a
 * Claude Code stream-json run (its result event reports tokens and cost) and a kiro CLI run (30 request lines, no
 * tokens, ending on the provider's DAILY_REQUEST_COUNT 429).
 *
 * The page's fetch goes to it as a same-origin browser request does (`requests` lists each one); `fallback` answers
 * the rest of what a view reads (Home's other cards).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HumanAuth, registerOwnerRoutes } from "../../server/human-auth/index.js";
import { registerAgentsRoutes } from "../../server/agents/routes.js";
import { AgentsManager, type AgentsService } from "../../server/agents/service.js";
import { EventBus } from "../../server/core/event-bus.js";
import { NodeFileSystem, type Clock, type CommandOutput, type CommandRunner, type ProcessInfo, type ProcessTable } from "../../server/watchdog/probes.js";
import type { AgentProbes, ProcessOwner, ProcessSpawner, SpawnOptions, SystemInfo } from "../../server/agents/probes.js";
import type { DecisionInbox } from "../../server/agents/decisions.js";
import type { AgentAdapter, ProjectConfig } from "../../shared/types.js";
import { signIn } from "../owner-session";

export const SPEND_NOW = Date.parse("2026-03-02T12:00:00.000Z");
const DAY = 86_400_000;
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };

class FakeClock implements Clock {
  t = SPEND_NOW;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

class FakeProcessTable implements ProcessTable {
  procs = new Map<number, { startedAt: number; command: string }>();
  constructor(private clock: FakeClock) {}
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

/** The agent CLI: each start does what `behaviour` says at once (writes its log and queue line, exits) */
class FakeSpawner implements ProcessSpawner {
  private exits = new Map<number, number | null>();
  private started = new Set<number>();
  nextPid = 5001;
  behaviour?: (pid: number, logPath: string) => void;
  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}
  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    writeLog(this.clock, options.logPath, "");
    this.started.add(pid);
    this.procs.procs.set(pid, { startedAt: this.clock.now(), command: argv.join(" ") });
    this.behaviour?.(pid, options.logPath);
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
    this.procs.procs.delete(pid);
    if (this.started.has(pid)) this.exits.set(pid, code);
  }
}

class NoCommands implements CommandRunner {
  async run(): Promise<CommandOutput> {
    return { code: 0, stdout: "", stderr: "" };
  }
}

const SYSTEM: SystemInfo = { cpuCount: () => 4, loadAvg1: () => 0.5, totalMemory: () => 16e9, memory: async () => ({ available: 8e9 }) };

function writeLog(clock: FakeClock, path: string, text: string): void {
  appendFileSync(path, text);
  const t = new Date(clock.now());
  utimesSync(path, t, t);
}

const fixture = (name: string) => readFileSync(join(process.cwd(), "fixtures", "agents-usage", name), "utf-8");

const ADAPTERS: Record<string, AgentAdapter> = {
  // Claude Code's stream-json output: its result event reports tokens and cost
  "claude-cli": {
    id: "claude-cli",
    name: "Claude-style CLI",
    start_cmd: "claude-cli run --model {model} --prompt {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    usage_parser: "claude-stream-json",
  },
  // The built-in kiro id with no usage_parser: request-lines, so requests only (tokens and cost not reported)
  kiro: {
    id: "kiro",
    name: "Kiro CLI",
    start_cmd: "kiro-cli chat --no-interactive --model {model} {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
  },
};

export interface SpendServer {
  dir: string;
  app: FastifyInstance;
  service: AgentsService;
  /** "GET /api/agents/spend?window=today&by=agent&project=demo", ... in the order the page asked */
  requests: string[];
  /** What the page's fetch is */
  fetch: typeof fetch;
  /** Sign this browser in as the owner (through the real route) */
  signIn(): Promise<void>;
  close(): Promise<void>;
}

export interface SpendServerOptions {
  /** agents.spend.enabled; with it off, every guard stays off too (the config refuses them otherwise) */
  spend: boolean;
  /** Answers what the agents and owner routes don't (the other cards of a view) */
  fallback?: typeof fetch;
}

/**
 * Project "demo" with agents.spend as given and, with it on, G1, G2 and G4 in observe (the budgets' guard_mode is
 * observe by default). With spend on, four runs end: two days before, a run of worker-c that crashed; today, one of
 * worker-c that finished its task (DONE, its cost reported), one of worker-c with no queue line (idle, its cost
 * reported), and one of builder-k on the kiro CLI that ended on the provider's quota line (30 requests, no tokens or
 * cost; G1 records a would_cool).
 */
export async function spendServer(options: SpendServerOptions): Promise<SpendServer> {
  const dir = mkdtempSync(join(tmpdir(), "lair-spend-ui-"));
  for (const d of [join(dir, "agents"), join(dir, "gates", "results"), join(dir, "data")]) mkdirSync(d, { recursive: true });
  const queueFile = join(dir, "queue.md");
  writeFileSync(queueFile, "# Queue\n");
  const config = {
    name: "Demo",
    repo: dir,
    github: "example/demo",
    queue_file: queueFile,
    agents_dir: join(dir, "agents"),
    gates_dir: join(dir, "gates"),
    inbox_file: join(dir, "inbox.md"),
    prompts_dir: join(dir, "prompts"),
    machines: {},
    dragons: {
      "worker-c": { name: "C", model: "model-c", machine: "local", instructions: "", adapter: "claude-cli" },
      "builder-k": { name: "K", model: "model-k", machine: "local", instructions: "", adapter: "kiro" },
    },
    agent_adapters: ADAPTERS,
    agents: {
      enabled: true,
      interval_seconds: 3600,
      hung_minutes: 45,
      dead_on_start_seconds: 5,
      providers: { "claude-cli": "provider-c", kiro: "provider-k" },
      ...(options.spend
        ? {
            spend: { enabled: true, guards: { task_no_result_cap: { mode: "observe" } } },
            failover: { quota: { mode: "observe" } },
            // No restarts: a failed run is escalated, so no later tick starts it again and the rows stay as described
            recovery: { same_session_restarts: 0, fresh_sessions: 0, hung_repeat: { mode: "observe" } },
          }
        : {}),
    },
  } as unknown as ProjectConfig;

  const clock = new FakeClock();
  const procs = new FakeProcessTable(clock);
  const spawner = new FakeSpawner(procs, clock);
  // Decisions (G1's would_cool notice) are kept nowhere: the panel doesn't read them
  const decisions: DecisionInbox = { request: async () => ({ id: "decision-1", via: "the decisions module" }) };
  const probes: AgentProbes = { processes: procs, fs: new NodeFileSystem(), runner: new NoCommands(), clock, spawner, self: { pid: 100, startedAt: SPEND_NOW - DAY }, systemInfo: SYSTEM };
  const manager = new AgentsManager({ dbPath: join(dir, "data", "agents.db"), probes, events: new EventBus(), decisions });
  manager.load([{ name: "demo", config }]);
  const service = manager.get("demo");
  if (!service) throw new Error(`agents not enabled: ${manager.status("demo").errors.join("; ")}`);

  /** One run, start to end: its CLI writes `log` (and `line` to the queue) and exits with `exit`; the next tick ends it */
  const run = async (agent: string, task: string, log: string, o: { line?: string; exit?: number } = {}) => {
    spawner.behaviour = (pid, logPath) => {
      writeLog(clock, logPath, log);
      if (o.line) appendFileSync(queueFile, `${o.line}\n`);
      spawner.exit(pid, o.exit ?? 0);
    };
    await service.requestRun({ agent, task, prompt: `Work on ${task}` });
    await service.tick();
    spawner.behaviour = undefined;
    clock.t += 90_000;
    await service.tick();
  };
  if (options.spend) {
    const claude = fixture("claude-stream-json-run.jsonl");
    clock.t = SPEND_NOW - 2 * DAY;
    await run("worker-c", "t-old", "working\nsegmentation fault\n", { exit: 2 });
    clock.t = SPEND_NOW;
    await run("worker-c", "t-docs", claude, { line: "- DONE t-docs by worker-c 12:01Z: merged" });
    await run("worker-c", "t-notes", claude);
    await run("builder-k", "t-api", fixture("kiro-requests-30.txt"), { exit: 1 });
  }

  const auth = HumanAuth.open({ tokenPath: join(dir, "data", "owner.token"), dbPath: ":memory:" });
  const token = readFileSync(join(dir, "data", "owner.token"), "utf-8").trim();
  const app = Fastify({ logger: false });
  await registerOwnerRoutes(app, auth);
  await registerAgentsRoutes(app, manager, () => "demo", auth);
  await app.ready();

  const requests: string[] = [];
  const pageFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
    const method = (init.method ?? "GET") as "GET" | "POST";
    const path = new URL(url, "http://lair.test").pathname;
    if (!path.startsWith("/api/agents") && !path.startsWith("/api/owner")) {
      if (options.fallback) return options.fallback(input, init);
      return new Response(JSON.stringify({ success: false, error: `Not served here: ${path}` }), { status: 404 });
    }
    requests.push(`${method} ${url}`);
    const res = await app.inject({
      method,
      url,
      headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER },
      payload: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return {
    dir,
    app,
    service,
    requests,
    fetch: pageFetch,
    signIn: async () => {
      await signIn(token);
    },
    close: async () => {
      await app.close();
      auth.close();
      await manager.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
