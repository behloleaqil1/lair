/**
 * AI spend, part 1 "measure" (docs/design/ai-spend.md §4.1, §4.3, §7 PR 1): AT-1 to AT-5, AT-7, AT-21 to AT-23 and
 * AT-33, plus the run origins and spend.recordCall.
 *
 * The production AgentsService drives every run, as AgentsManager wires it: a run is requested, the tick spawns it,
 * the fake agent CLI writes its log (and its queue line) and exits, and the tick that ends it writes the spend row.
 * Only the process table, the spawner and the clock are fake; files and the SQLite store are real. The logs are real
 * agent CLI output, scrubbed of paths and names (fixtures/agents-usage/):
 * - claude-stream-json-run.jsonl: a `claude -p --output-format stream-json --verbose` run with one result event
 *   (cost 0.5177073; 60 input, 55,895 cache write, 1,634,873 cache read, 13,052 output tokens; 31 turns);
 * - claude-stream-json-four-results.jsonl: one process that wrote four result events (each `usage` counts since the
 *   previous one; the last `modelUsage` and `total_cost_usd` are the process's totals);
 * - claude-stream-json-usage-limit.jsonl: a run that hit a usage limit at once (is_error, cost 0, empty modelUsage);
 * - kiro-requests-30.txt: a kiro CLI run with 30 request lines, ending on the provider's DAILY_REQUEST_COUNT 429.
 * Text values are replaced; numbers, event types and model names are the CLIs' own. Fields of a result event no
 * parser reads (subagent stats, usage iterations, per-model window sizes) are left out, to keep each line short.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { stringify } from "yaml";
import { HumanAuth, OWNER_SESSION_HEADER, registerOwnerRoutes } from "../human-auth/index.js";
import { registerAgentsRoutes } from "./routes.js";
import type { AgentAdapter, ProjectConfig } from "../../shared/types.js";
import type { AgentEventKind } from "../../shared/agents-types.js";
import { EventBus } from "../core/event-bus.js";
import { BudgetManager } from "../fleet/budget.js";
import { loadProjectConfig } from "../config.js";
import { ConfigReloader, serverModules } from "../reload/index.js";
import { NodeFileSystem, type Clock, type CommandOutput, type CommandRunner, type ProcessInfo, type ProcessTable } from "../watchdog/probes.js";
import { parseAgentsConfig } from "./config.js";
import type { DecisionInbox, DecisionRequest } from "./decisions.js";
import type { AgentProbes, ProcessOwner, ProcessSpawner, SpawnOptions, SystemInfo, MemoryReading } from "./probes.js";
import { AgentsManager, type AgentsService } from "./service.js";
import { KIRO_REQUEST_PATTERN, MAX_REQUEST_PATTERN_CHARS, SCAN_BYTES_PER_TICK, originOf } from "./spend.js";
import { blockerKey, CLASSIFY_WAIT_MS, SpendClassifier, type ModuleVerdict, type SpendFacts } from "./spend-classify.js";
import type { Decision } from "../../shared/decision-types.js";
import { AgentsStore, SCHEMA_VERSION } from "./store.js";
import type { AgentEvent, AgentRun, SpendRow } from "./types.js";

// ============ BOUNDARY FAKES ============

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SEC = 1000;
const MIN = 60_000;
const SELF: ProcessOwner = { pid: 100, startedAt: NOW - 60 * MIN };

class FakeClock implements Clock {
  t = NOW;
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

/** Starts fake agent CLIs: each does what `behaviour` says at once (writes its log and queue line, exits). */
class FakeSpawner implements ProcessSpawner {
  calls: { argv: string[]; logPath: string; pid: number }[] = [];
  private exits = new Map<number, number | null>();
  private started = new Set<number>();
  nextPid = 5001;
  behaviour?: (pid: number, logPath: string, argv: string[]) => void;
  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}
  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    writeLog(this.clock, options.logPath, "");
    this.calls.push({ argv: [...argv], logPath: options.logPath, pid });
    this.started.add(pid);
    this.procs.procs.set(pid, { startedAt: this.clock.now(), command: argv.join(" ") });
    this.behaviour?.(pid, options.logPath, argv);
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

const SYSTEM: SystemInfo = {
  cpuCount: () => 4,
  loadAvg1: () => 0.5,
  totalMemory: () => 16e9,
  memory: async (): Promise<MemoryReading> => ({ available: 8e9 }),
};

function writeLog(clock: FakeClock, path: string, text: string): void {
  appendFileSync(path, text);
  const t = new Date(clock.now());
  utimesSync(path, t, t);
}

// ============ FIXTURES ============

const fixture = (name: string) => readFileSync(join(process.cwd(), "fixtures", "agents-usage", name), "utf-8");
const CLAUDE_RUN = fixture("claude-stream-json-run.jsonl");
const CLAUDE_FOUR = fixture("claude-stream-json-four-results.jsonl");
const CLAUDE_LIMIT = fixture("claude-stream-json-usage-limit.jsonl");
const KIRO_30 = fixture("kiro-requests-30.txt");

const lines = (text: string) => text.split("\n").filter((l) => l.length > 0);
const events = (text: string) => lines(text).map((l) => JSON.parse(l) as Record<string, unknown>);
/** The fixture with its (last) result event replaced by `change(result)` */
function withResult(text: string, change: (result: Record<string, unknown>) => unknown): string {
  const all = lines(text);
  const at = all.map((l) => (JSON.parse(l) as { type?: string }).type).lastIndexOf("result");
  const result = JSON.parse(all[at]) as Record<string, unknown>;
  const changed = change(result);
  all[at] = typeof changed === "string" ? changed : JSON.stringify(changed);
  return `${all.join("\n")}\n`;
}

/** A prompt marker: no spend row or response may ever hold prompt text */
const PROMPT_MARKER = "PROMPT-MARKER-7f3a";

const ADAPTERS: Record<string, AgentAdapter> = {
  "claude-cli": {
    id: "claude-cli",
    name: "Claude-style CLI",
    start_cmd: "claude-cli run --model {model} --prompt {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    resume_flag: "--resume {session_id}",
    usage_parser: "claude-stream-json",
  },
  // An adapter with the built-in kiro id and no usage_parser: the built-in default (request-lines) applies
  kiro: {
    id: "kiro",
    name: "Kiro CLI",
    start_cmd: "kiro-cli chat --no-interactive --model {model} {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
  },
  "plain-cli": {
    id: "plain-cli",
    name: "Plain CLI",
    start_cmd: "plain-cli --model {model} --task-file {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
  },
};

interface Paths {
  dir: string;
  queueFile: string;
  dbPath: string;
}

interface Harness extends Paths {
  config: ProjectConfig;
  clock: FakeClock;
  procs: FakeProcessTable;
  spawner: FakeSpawner;
  manager: AgentsManager;
  service: AgentsService;
  store: AgentsStore;
  asked: DecisionRequest[];
  probes: AgentProbes;
  events: EventBus;
}

const dirs: string[] = [];
const managers: AgentsManager[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const manager of managers.splice(0)) await manager.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "lair-spend-"));
  dirs.push(dir);
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "gates", "results"), { recursive: true });
  const queueFile = join(dir, "queue.md");
  writeFileSync(queueFile, "# Queue\n");
  return { dir, queueFile, dbPath: join(dir, "data", "agents.db") };
}

function projectConfig(p: Paths, agents: Record<string, unknown>, adapters: Record<string, AgentAdapter> = ADAPTERS): ProjectConfig {
  return {
    name: "Demo",
    repo: p.dir,
    github: "example/demo",
    queue_file: p.queueFile,
    agents_dir: join(p.dir, "agents"),
    gates_dir: join(p.dir, "gates"),
    inbox_file: join(p.dir, "inbox.md"),
    prompts_dir: join(p.dir, "prompts"),
    machines: {},
    dragons: {
      "worker-a": { name: "A", model: "model-a", machine: "local", instructions: "", adapter: "claude-cli" },
      "worker-b": { name: "B", model: "model-a", machine: "local", instructions: "", adapter: "claude-cli" },
      "builder-k": { name: "K", model: "model-k", machine: "local", instructions: "", adapter: "kiro" },
      "worker-p": { name: "P", model: "model-p", machine: "local", instructions: "", adapter: "plain-cli" },
    },
    agent_adapters: adapters,
    agents: {
      enabled: true,
      interval_seconds: 3600,
      hung_minutes: 45,
      dead_on_start_seconds: 5,
      providers: { "claude-cli": "provider-c", kiro: "provider-k" },
      ...agents,
    },
  } as unknown as ProjectConfig;
}

function setup(
  agents: Record<string, unknown> = {},
  options: { paths?: Paths; budget?: BudgetManager; adapters?: Record<string, AgentAdapter>; clock?: FakeClock; inbox?: DecisionInbox; events?: EventBus; facts?: SpendFacts } = {},
): Harness {
  const paths = options.paths ?? makePaths();
  const config = projectConfig(paths, agents, options.adapters);
  const clock = options.clock ?? new FakeClock();
  const procs = new FakeProcessTable(clock);
  const spawner = new FakeSpawner(procs, clock);
  const asked: DecisionRequest[] = [];
  const decisions: DecisionInbox = options.inbox ?? {
    request: async (decision) => {
      asked.push(decision);
      return { id: `decision-${asked.length}`, via: "the decisions module" };
    },
  };
  const probes: AgentProbes = { processes: procs, fs: new NodeFileSystem(), runner: new NoCommands(), clock, spawner, self: SELF, systemInfo: SYSTEM };
  const events = options.events ?? new EventBus();
  const manager = new AgentsManager({ dbPath: paths.dbPath, probes, events, budget: options.budget, decisions });
  managers.push(manager);
  if (options.facts) manager.useSpendFacts(options.facts);
  manager.load([{ name: "demo", config }]);
  const service = manager.get("demo");
  const store = manager.getStore();
  if (!service || !store) throw new Error(`agents not enabled: ${manager.status("demo").errors.join("; ")}`);
  return { ...paths, config, clock, procs, spawner, manager, service, store, asked, probes, events };
}

const SPEND_ON = { spend: { enabled: true } };

/**
 * One run, start to end: requested, spawned (its CLI writes `log` and, when given, `line` to the queue, and exits
 * with `exit`), then ended by the next tick, which writes its spend row. Runs for 90 s.
 */
async function oneRun(
  h: Harness,
  o: { agent?: string; task?: string; log: string; line?: string; exit?: number | null; prompt?: string },
): Promise<AgentRun> {
  const agent = o.agent ?? "worker-a";
  const task = o.task ?? "feat-login";
  h.spawner.behaviour = (pid, logPath) => {
    writeLog(h.clock, logPath, o.log);
    if (o.line) appendFileSync(h.queueFile, `${o.line}\n`);
    h.spawner.exit(pid, o.exit === undefined ? 0 : o.exit);
  };
  const view = await h.service.requestRun({ agent, task, prompt: o.prompt ?? `Build the login form ${PROMPT_MARKER}` });
  await h.service.tick(); // spawns: the CLI writes and exits
  h.spawner.behaviour = undefined;
  h.clock.t += 90 * SEC;
  await h.service.tick(); // the end, and its spend row
  return h.store.getRun(view.id)!;
}

const eventsOf = (h: Harness, kind: AgentEventKind): AgentEvent[] => h.store.listEvents("demo", { kinds: [kind], limit: 500 }).reverse();
const spendRows = (h: Harness): SpendRow[] => h.store.listSpend("demo", { limit: 500 }).reverse();

/** The ledger rows of the db (a read-only look, as an operator would take) */
function ledger(dbPath: string): { run_id: string | null; tokens: number; cost: number; reason: string | null; agent: string | null }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT run_id, tokens, cost, reason, agent FROM agents_usage ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}
function pendingCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM agents_spend_pending").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// ============ AT-1: claude-stream-json, a real result event ============

describe("AT-1: an adapter's stream-json result event is the run's usage", () => {
  it("one spend row (productive/done, reported, the event's numbers) and one ledger row with cache reads left out of its tokens", async () => {
    const h = setup(SPEND_ON);
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });

    expect(run.state).toBe("completed");
    const rows = spendRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: run.id,
      agent: "worker-a",
      task: "feat-login",
      chainId: run.chainId,
      origin: "other",
      adapter: "claude-cli",
      provider: "provider-c",
      model: "model-a",
      class: "productive",
      reason: "done",
      sessionMode: "new",
      reload: false,
      lairRestart: false,
      usageSource: "reported",
      inputTokens: 60,
      cacheWriteTokens: 55_895,
      cacheReadTokens: 1_634_873,
      outputTokens: 13_052,
      tokens: 69_007,
      requests: null,
      turns: 31,
      runtimeS: 90,
      startedAt: NOW,
      endedAt: NOW + 90 * SEC,
      usageRecorded: true,
      backfilled: false,
    });
    expect(rows[0].cost).toBeCloseTo(0.5177073, 7);
    // The prompt file's size, never its text
    expect(rows[0].contextBytes).toBe(Buffer.byteLength(readFileSync(h.spawner.calls[0].argv.at(-1)!, "utf-8")));
    expect(JSON.stringify(rows)).not.toContain(PROMPT_MARKER);

    const usage = ledger(h.dbPath);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ run_id: run.id, agent: "worker-a", tokens: 69_007 });
    expect(usage[0].cost).toBeCloseTo(0.5177073, 7);
    expect(h.store.usageSince("demo", "worker-a", 0).tokens).toBe(69_007);
    expect(pendingCount(h.dbPath)).toBe(0);
  });

  for (const guardMode of [undefined, "observe", "act", "off"] as const) {
    it(`a hard token limit the reported usage passes blocks new runs as before, with budgets.guard_mode ${guardMode ?? "unset"}`, async () => {
      const budgets = { ...(guardMode ? { guard_mode: guardMode } : {}), project: { daily_tokens: { hard: 50_000 } } };
      const h = setup({ ...SPEND_ON, budgets });
      await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
      await h.service.tick();
      await h.service.tick();

      // Today's blocking: one spend decision, one budget_exceeded, new runs refused; guard_mode doesn't change it
      const spend = h.asked.filter((d) => d.kind === "spend");
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ key: "budget:project:daily_tokens:2026-03-02", recommended: "wait" });
      expect(eventsOf(h, "budget_exceeded")).toHaveLength(1);
      expect(h.manager.status("demo").projectBudget).toMatchObject({ blocked: true, lines: [{ metric: "daily_tokens", used: 69_007, level: "hard" }] });
      await expect(h.service.requestRun({ agent: "worker-b", task: "task-2", prompt: "Next" })).rejects.toMatchObject({
        statusCode: 403,
        message: "Over budget: the project used 69007 tokens in day 2026-03-02 (hard limit 50000)",
      });
      expect(eventsOf(h, "guard_would")).toEqual([]);
      expect(eventsOf(h, "guard_did")).toEqual([]);
      expect(h.asked.filter((d) => d.attention === "notice")).toEqual([]);
    });
  }

  it("a hard limit configured the way it was before AI spend (usage_patterns, no guard_mode, spend off) still blocks", async () => {
    const h = setup({ usage_patterns: ["cost: \\$(?<cost>[0-9.]+)"], budgets: { agent: { daily_cost: { hard: 1 } } } });
    await oneRun(h, { agent: "worker-p", task: "feat-p", log: "working\ncost: $2.50\n", line: "- DONE feat-p by worker-p" });
    await h.service.tick();
    expect(h.store.usageSince("demo", "worker-p", 0)).toEqual({ tokens: 0, cost: 2.5 });
    expect(h.asked.filter((d) => d.kind === "spend")).toHaveLength(1);
    await expect(h.service.requestRun({ agent: "worker-p", task: "feat-q", prompt: "Next" })).rejects.toMatchObject({ statusCode: 403 });
    expect(spendRows(h)).toEqual([]);
  });
});

// ============ AT-2: once per run, across a restart ============

describe("AT-2: a run's spend row and usage are written once, also across a restart", () => {
  it("a log too big for one tick is read over several; a restart in between still gives one row and one ledger row", async () => {
    const h = setup(SPEND_ON);
    // The real log, its assistant events repeated until it is over one tick's read budget
    const all = lines(CLAUDE_RUN);
    const assistant = all.find((l) => l.includes('"type":"assistant"'))!;
    const filler = Array.from({ length: Math.ceil((SCAN_BYTES_PER_TICK * 1.3) / assistant.length) }, () => assistant);
    const big = [...all.slice(0, -1), ...filler, all.at(-1)!].join("\n") + "\n";
    expect(big.length).toBeGreaterThan(SCAN_BYTES_PER_TICK);

    const run = await oneRun(h, { log: big, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    expect(run.state).toBe("completed");
    // Not finished in the tick that ended it: owed, nothing written yet
    expect(spendRows(h)).toEqual([]);
    expect(pendingCount(h.dbPath)).toBe(1);
    expect(ledger(h.dbPath)).toEqual([]);

    // Lair restarts: a new server on the same store
    await h.manager.stop();
    const again = setup(SPEND_ON, { paths: { dir: h.dir, queueFile: h.queueFile, dbPath: h.dbPath }, clock: h.clock });
    await again.service.tick();
    await again.service.tick();

    const rows = spendRows(again);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: run.id, class: "productive", reason: "done", inputTokens: 60, outputTokens: 13_052, turns: 31, tokens: 69_007 });
    const usage = ledger(again.dbPath);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ run_id: run.id, tokens: 69_007 });
    expect(pendingCount(again.dbPath)).toBe(0);

    // The same end marked again (a crash between the end and the save, say) writes nothing more
    again.store.markSpendPending("demo", run.id, run.endedAt!);
    await again.service.tick();
    expect(spendRows(again)).toHaveLength(1);
    expect(ledger(again.dbPath)).toHaveLength(1);
    expect(pendingCount(again.dbPath)).toBe(0);
    // And the store itself refuses a second row for the run: its usage isn't added twice
    expect(again.store.recordSpend(rows[0], { project: "demo", provider: "provider-c", runId: run.id, tokens: 5, cost: 5, at: NOW })).toBe(false);
    expect(ledger(again.dbPath)).toHaveLength(1);
  });
});

describe("an end whose mark can't be written is marked again, then given up with an event", () => {
  it("a mark that fails once is written again by the next drain: the row is not lost", async () => {
    const h = setup(SPEND_ON);
    const mark = h.store.markSpendPending.bind(h.store);
    let failures = 1;
    h.store.markSpendPending = (project, runId, endedAt) => {
      if (failures-- > 0) throw new Error("database is locked");
      mark(project, runId, endedAt);
    };
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    expect(spendRows(h)).toEqual([expect.objectContaining({ runId: run.id, class: "productive", tokens: 69_007 })]);
    expect(eventsOf(h, "usage_refused")).toEqual([]);
  });

  it("a mark that keeps failing is given up after five attempts with a usage_refused event saying why", async () => {
    const h = setup(SPEND_ON);
    h.store.markSpendPending = () => {
      throw new Error("database or disk is full");
    };
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    for (let i = 0; i < 4; i++) await h.service.tick();
    expect(spendRows(h)).toEqual([]);
    const refused = eventsOf(h, "usage_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ runId: run.id, agent: "worker-a", task: "feat-login", data: { stage: "mark", attempts: 5, why: "database or disk is full" } });
  });
});

describe("a row that can't be written is retried with a backoff, then given up with an event; the tick never fails", () => {
  it("five failed writes: retried after 30 s, 60 s, ... then the mark is dropped and usage_refused says why", async () => {
    const h = setup(SPEND_ON);
    // The one fake here: the store's write fails (a full disk, say)
    const write = h.store.recordSpend.bind(h.store);
    let failing = true;
    h.store.recordSpend = (row, usage) => {
      if (failing) throw new Error("database or disk is full");
      return write(row, usage);
    };
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    expect(run.state).toBe("completed");
    expect(pendingCount(h.dbPath)).toBe(1);
    await h.service.tick(); // within its backoff: not tried
    for (const wait of [30, 60, 120, 240]) {
      h.clock.t += wait * SEC;
      await h.service.tick();
    }
    expect(pendingCount(h.dbPath)).toBe(0);
    expect(spendRows(h)).toEqual([]);
    expect(ledger(h.dbPath)).toEqual([]);
    const [gaveUp] = eventsOf(h, "usage_refused");
    expect(gaveUp).toMatchObject({ runId: run.id, data: { attempts: 5 } });
    expect(gaveUp.summary).toContain("database or disk is full");
    // The next run is recorded once writing works again
    failing = false;
    await oneRun(h, { agent: "worker-b", task: "feat-2", log: CLAUDE_RUN });
    expect(spendRows(h)).toHaveLength(1);
  });
});

// ============ AT-3: only result events count ============

describe("AT-3: the per-message usage of assistant events is never counted", () => {
  it("one process's four result events: its tokens and cost are the last one's totals, its turns their sum", async () => {
    const h = setup(SPEND_ON);
    const run = await oneRun(h, { log: CLAUDE_FOUR, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    const [row] = spendRows(h);

    const results = events(CLAUDE_FOUR).filter((e) => e.type === "result");
    expect(results).toHaveLength(4);
    // What the fixture says: each result's usage counts since the previous one; modelUsage is the running total
    expect(results.map((r) => (r.usage as { input_tokens: number }).input_tokens)).toEqual([34, 6, 12, 8]);
    expect(row).toMatchObject({ runId: run.id, usageSource: "reported", inputTokens: 60, cacheWriteTokens: 44_155, cacheReadTokens: 1_226_332, outputTokens: 7_128, turns: 27 });
    expect(row.cost).toBeCloseTo(0.3706532, 7);
    expect(row.tokens).toBe(60 + 44_155 + 7_128);

    // The assistant events' own usage, summed, is another (wrong) number: not what was recorded
    const assistantOutput = events(CLAUDE_FOUR)
      .filter((e) => e.type === "assistant")
      .reduce((sum, e) => sum + ((e.message as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0), 0);
    expect(assistantOutput).not.toBe(7_128);
    expect(ledger(h.dbPath)).toEqual([expect.objectContaining({ run_id: run.id, tokens: 60 + 44_155 + 7_128 })]);
  });

  it("claude-json: the one JSON object a `--output-format json` run writes", async () => {
    const adapters = { ...ADAPTERS, "plain-cli": { ...ADAPTERS["plain-cli"], usage_parser: "claude-json" } } as Record<string, AgentAdapter>;
    const h = setup(SPEND_ON, { adapters });
    const result = lines(CLAUDE_RUN).find((l) => l.includes('"type":"result"'))!;
    await oneRun(h, { agent: "worker-p", task: "feat-json", log: `${result}\n`, line: "- DONE feat-json by worker-p" });
    expect(spendRows(h)[0]).toMatchObject({ usageSource: "reported", inputTokens: 60, cacheReadTokens: 1_634_873, outputTokens: 13_052, turns: 31, tokens: 69_007 });
  });

  it("a run that hit a usage limit at once: reported, cost 0, its model from the profile", async () => {
    const h = setup(SPEND_ON);
    await oneRun(h, { log: CLAUDE_LIMIT, exit: 1 });
    const [row] = spendRows(h);
    expect(row).toMatchObject({ usageSource: "reported", cost: 0, tokens: 0, turns: 1, model: "model-a", class: "no_result" });
  });
});

// ============ AT-4: logs are untrusted ============

describe("AT-4: values from a log are checked; nothing throws", () => {
  it("negative or non-numeric values count as 0", async () => {
    const h = setup(SPEND_ON);
    const log = withResult(CLAUDE_RUN, (r) => {
      const model = (r.modelUsage as Record<string, Record<string, unknown>>)["claude-sonnet-5-5"];
      model.inputTokens = -60;
      model.outputTokens = "13052";
      model.cacheReadInputTokens = null;
      r.total_cost_usd = -3;
      r.num_turns = "31";
      return r;
    });
    await oneRun(h, { log, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    expect(spendRows(h)[0]).toMatchObject({ usageSource: "reported", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 55_895, cost: 0, turns: 0, tokens: 55_895 });
    expect(eventsOf(h, "usage_refused")).toEqual([]);
  });

  for (const [what, change, why] of [
    ["a cost of 1e9", (r: Record<string, unknown>) => ({ ...r, total_cost_usd: 1e9 }), "over the cap per run"],
    [
      "tokens over 1e10",
      (r: Record<string, unknown>) => {
        (r.modelUsage as Record<string, Record<string, unknown>>)["claude-sonnet-5-5"].cacheReadInputTokens = 2e10;
        return r;
      },
      "over the cap per run",
    ],
    ["a result line over 1 MB", (r: Record<string, unknown>) => ({ ...r, result: "x".repeat(1_100_000) }), "a line over 1 MB may be its result event"],
    ["a result line cut short (not JSON)", (r: Record<string, unknown>) => JSON.stringify(r).slice(0, -1), "not valid JSON"],
  ] as const) {
    it(`${what}: the row says not reported (usage_source none), the ledger gets nothing, and an event says why`, async () => {
      const h = setup(SPEND_ON);
      const run = await oneRun(h, { log: withResult(CLAUDE_RUN, change), line: "- DONE feat-login by worker-a 12:05Z: merged" });
      const [row] = spendRows(h);
      expect(row).toMatchObject({ runId: run.id, class: "productive", usageSource: "none", inputTokens: null, tokens: null, cost: null, turns: null });
      expect(ledger(h.dbPath)).toEqual([]);
      const [refused] = eventsOf(h, "usage_refused");
      expect(refused).toMatchObject({ runId: run.id, data: { parser: "claude-stream-json" } });
      expect(String(refused.data.why)).toContain(why);
    });
  }

  it("a log that is gone by the time it is read, and a run that never started: rows with usage none", async () => {
    const h = setup(SPEND_ON);
    h.spawner.behaviour = (pid, logPath) => {
      rmSync(logPath);
      h.spawner.exit(pid, 0);
    };
    await h.service.requestRun({ agent: "worker-a", task: "feat-gone", prompt: "x" });
    await h.service.tick();
    h.clock.t += 90 * SEC;
    await h.service.tick();
    expect(spendRows(h)[0]).toMatchObject({ task: "feat-gone", usageSource: "none", class: "idle", reason: "no_line" });
    expect(String(eventsOf(h, "usage_refused")[0].data.why)).toContain("can't be read");

    // A run whose claim is released before it starts: never spawned, no log
    const queued = await h.service.requestRun({ agent: "worker-b", task: "feat-never", prompt: "x" });
    await h.service.releaseClaim("feat-never");
    await h.service.tick();
    expect(h.store.getSpend(queued.id)).toMatchObject({ usageSource: "none", class: "no_result", reason: "stopped", runtimeS: 0, startedAt: null, contextBytes: 0 });
  });
});

// ============ AT-5: request lines ============

describe("AT-5: an adapter that reports no tokens: its requests, never an estimate", () => {
  it("the kiro adapter's built-in request-lines parser counts a real log's 30 requests; tokens and cost are not reported", async () => {
    const h = setup({ ...SPEND_ON, budgets: { guard_mode: "act", project: { daily_tokens: { hard: 10 } } } });
    // An agent that writes the command's name in its own prose is not a request
    const log = `${KIRO_30}Agent text: the CLI logs GenerateAssistantResponseCommand done for each request.\n`;
    const run = await oneRun(h, { agent: "builder-k", task: "feat-k", log, exit: 1 });

    const [row] = spendRows(h);
    expect(row).toMatchObject({ runId: run.id, adapter: "kiro", provider: "provider-k", usageSource: "requests", requests: 30, inputTokens: null, tokens: null, cost: null, turns: null });
    expect(ledger(h.dbPath)).toEqual([]);
    // A token limit has nothing to count: nothing blocks
    await h.service.tick();
    expect(eventsOf(h, "budget_exceeded")).toEqual([]);
    await expect(h.service.requestRun({ agent: "worker-a", task: "next", prompt: "Next" })).resolves.toMatchObject({ state: "queued" });
  });

  it("an adapter's own request_pattern is tested line by line (case-sensitive, ^ and $ per line)", async () => {
    const adapters = { ...ADAPTERS, "plain-cli": { ...ADAPTERS["plain-cli"], usage_parser: "request-lines", request_pattern: "^\\[tool\\] Read File$" } } as Record<string, AgentAdapter>;
    const h = setup(SPEND_ON, { adapters });
    await oneRun(h, { agent: "worker-p", task: "feat-p", log: `${KIRO_30}[TOOL] read file\n`, exit: 0 });
    expect(spendRows(h)[0]).toMatchObject({ usageSource: "requests", requests: lines(KIRO_30).filter((l) => l === "[tool] Read File").length });
    expect(spendRows(h)[0].requests).toBe(23);
  });

  it("a request_pattern that backtracks badly on a log line (not on the load-time probe) is stopped after its time: the usage is refused, the tick goes on", async () => {
    const adapters = { ...ADAPTERS, "plain-cli": { ...ADAPTERS["plain-cli"], usage_parser: "request-lines", request_pattern: "^(q+)+$" } } as Record<string, AgentAdapter>;
    const h = setup(SPEND_ON, { adapters });
    const started = Date.now();
    const run = await oneRun(h, { agent: "worker-p", task: "feat-slow", log: `${"q".repeat(40)}!\nrequest\n` });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(spendRows(h)[0]).toMatchObject({ runId: run.id, usageSource: "none", requests: null });
    expect(String(eventsOf(h, "usage_refused")[0].data.why)).toContain("took over 250 ms");
  });

  it("a pattern's time is bounded per tick over all owed rows: past it the rest waits for the next tick", async () => {
    const slow = { usage_parser: "request-lines", request_pattern: "^(q+)+$" };
    const adapters = { ...ADAPTERS, "claude-cli": { ...ADAPTERS["claude-cli"], ...slow }, "plain-cli": { ...ADAPTERS["plain-cli"], ...slow } } as Record<string, AgentAdapter>;
    const h = setup(SPEND_ON, { adapters });
    h.spawner.behaviour = (pid, logPath) => {
      writeLog(h.clock, logPath, `${"q".repeat(40)}!\n`);
      h.spawner.exit(pid, 0);
    };
    for (const [agent, task] of [["worker-a", "t-1"], ["worker-b", "t-2"], ["worker-p", "t-3"]]) {
      await h.service.requestRun({ agent, task, prompt: "x" });
    }
    await h.service.tick();
    h.clock.t += 90 * SEC;
    await h.service.tick(); // all three end: each read would take the whole 250 ms timeout
    // Two timeouts reach the 300 ms bound: the third run's row waits
    expect(spendRows(h)).toHaveLength(2);
    expect(pendingCount(h.dbPath)).toBe(1);
    await h.service.tick();
    expect(spendRows(h)).toHaveLength(3);
    expect(spendRows(h).every((r) => r.usageSource === "none")).toBe(true);
    expect(eventsOf(h, "usage_refused")).toHaveLength(3);
  });

  it("the built-in pattern is the kiro CLI's request line, found mid-line too", () => {
    const re = new RegExp(KIRO_REQUEST_PATTERN);
    expect(lines(KIRO_30).filter((l) => re.test(l))).toHaveLength(30);
    expect(re.test("Agent text.[INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=24")).toBe(true);
    expect(re.test("the CLI logs GenerateAssistantResponseCommand done for each request")).toBe(false);
  });

  it("an adapter with no parser: runtime and prompt size only, tokens and cost not reported", async () => {
    const h = setup(SPEND_ON);
    await oneRun(h, { agent: "worker-p", task: "feat-p", log: "working\nall done\n", line: "- DONE feat-p by worker-p" });
    expect(spendRows(h)[0]).toMatchObject({ adapter: "plain-cli", usageSource: "none", tokens: null, cost: null, requests: null, runtimeS: 90, class: "productive", reason: "done" });
    expect(spendRows(h)[0].contextBytes).toBeGreaterThan(0);
    expect(eventsOf(h, "usage_refused")).toEqual([]);
  });
});

// ============ AT-7: counted once ============

describe("AT-7: a parser and usage_patterns that would both match count once, by the parser", () => {
  const PATTERNS = { usage_patterns: ['"total_cost_usd":(?<cost>[0-9.]+)'] };

  it("with spend on, readUsage skips the parser's run: one ledger row, the parser's", async () => {
    const h = setup({ ...SPEND_ON, ...PATTERNS });
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    const usage = ledger(h.dbPath);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ run_id: run.id, tokens: 69_007, reason: `usage of run ${run.id.slice(0, 8)} (claude-stream-json)` });
  });

  it("an adapter on the patterns parser (no usage_parser, usage_patterns set) is read while it works; its row takes the ledger's total", async () => {
    const h = setup({ ...SPEND_ON, usage_patterns: ["tokens used: (?<tokens>[0-9]+) cost: \\$(?<cost>[0-9.]+)"] });
    const run = await oneRun(h, { agent: "worker-p", task: "feat-p", log: "tokens used: 1200 cost: $0.40\n" });
    const usage = ledger(h.dbPath);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ run_id: run.id, tokens: 1200, reason: expect.stringContaining("usage in ") });
    expect(spendRows(h)[0]).toMatchObject({ usageSource: "reported", tokens: 1200, cost: 0.4, inputTokens: null, turns: null });
  });
});

// ============ AT-21: spend off ============

describe("AT-21: with agents.spend off, nothing new is read or written", () => {
  it("no spend rows, no marks, no usage events, recordCall writes nothing; usage_patterns are read as before", async () => {
    const h = setup({ usage_patterns: ['"total_cost_usd":(?<cost>[0-9.]+)'] });
    const run = await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
    expect(run.state).toBe("completed");
    expect(spendRows(h)).toEqual([]);
    expect(pendingCount(h.dbPath)).toBe(0);
    expect(eventsOf(h, "usage_refused")).toEqual([]);
    // Today's path: usage_patterns read while the run worked (the parser is not used)
    expect(ledger(h.dbPath)).toEqual([expect.objectContaining({ run_id: run.id, reason: expect.stringContaining("usage in ") })]);
    expect(h.manager.recordCall("demo", { module: "brain", provider: "local", tokens: 0, cost: 0 })).toBe(false);
    expect(ledger(h.dbPath)).toHaveLength(1);
  });
});

// ============ AT-22: store migration ============

/** The agents store's tables and indexes as each version created them (git history of store.ts) */
const V1_SCHEMA = `
  CREATE TABLE agents_runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, agent TEXT NOT NULL,
    chain_id TEXT NOT NULL, state TEXT NOT NULL, requested_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX idx_agents_runs_state ON agents_runs(project, state);
  CREATE INDEX idx_agents_runs_agent ON agents_runs(project, agent, requested_at);
  CREATE INDEX idx_agents_runs_chain ON agents_runs(chain_id);
  CREATE TABLE agents_claims (project TEXT NOT NULL, task TEXT NOT NULL, run_id TEXT NOT NULL, agent TEXT NOT NULL,
    owner_pid INTEGER NOT NULL, owner_started_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY (project, task));
  CREATE TABLE agents_events (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT, task TEXT,
    run_id TEXT, subject TEXT, summary TEXT NOT NULL, evidence TEXT NOT NULL, data TEXT NOT NULL, dedupe_key TEXT, at INTEGER NOT NULL);
  CREATE INDEX idx_agents_events_project ON agents_events(project, at);
  CREATE UNIQUE INDEX idx_agents_events_dedupe ON agents_events(project, dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE TABLE agents_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, agent TEXT, provider TEXT NOT NULL,
    run_id TEXT, tokens INTEGER NOT NULL, cost REAL NOT NULL, at INTEGER NOT NULL, reason TEXT);
  CREATE INDEX idx_agents_usage ON agents_usage(project, at);`;
const V2_SCHEMA = `${V1_SCHEMA}
  CREATE INDEX idx_agents_runs_task ON agents_runs(project, task, requested_at);
  CREATE INDEX idx_agents_events_task ON agents_events(project, task, kind, at);
  CREATE INDEX idx_agents_events_run ON agents_events(project, run_id);`;
const V3_SCHEMA = `${V2_SCHEMA}
  CREATE TABLE agents_hung_info (project TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, last_lines TEXT NOT NULL,
    last_tool TEXT, hung_minutes INTEGER NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY (project, agent, task));`;

function oldStore(path: string, version: 1 | 2 | 3): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(version === 1 ? V1_SCHEMA : version === 2 ? V2_SCHEMA : V3_SCHEMA);
  const run = { id: "run-1", project: "demo", task: "feat-login", agent: "worker-a", chainId: "run-1", state: "completed", requestedAt: NOW };
  db.prepare("INSERT INTO agents_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("run-1", "demo", "feat-login", "worker-a", "run-1", "completed", NOW, JSON.stringify(run));
  db.prepare("INSERT INTO agents_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "event-1", "demo", "completed", "worker-a", "feat-login", "run-1", null, "worker-a finished feat-login", "[]", "{}", null, NOW,
  );
  db.prepare("INSERT INTO agents_usage (project, agent, provider, run_id, tokens, cost, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "demo", "worker-a", "provider-c", "run-1", 1234, 0.5, NOW, "usage in worker-a.log",
  );
  if (version === 3) {
    db.prepare("INSERT INTO agents_hung_info VALUES (?, ?, ?, ?, ?, ?, ?)").run("demo", "worker-a", "feat-login", "last line", null, 45, NOW);
  }
  db.pragma(`user_version = ${version}`);
  db.close();
}

describe("AT-22: agents stores of every older version migrate to v4", () => {
  for (const version of [1, 2, 3] as const) {
    it(`a v${version} file keeps its runs, events and usage and gains the spend tables`, async () => {
      const p = makePaths();
      oldStore(p.dbPath, version);
      // Opened the way the server opens it: AgentsManager on data/agents.db
      const h = setup(SPEND_ON, { paths: p });
      expect(SCHEMA_VERSION).toBe(4);
      expect(h.store.getRun("run-1")).toMatchObject({ id: "run-1", state: "completed" });
      expect(h.store.listEvents("demo", { kinds: ["completed"] })).toHaveLength(1);
      expect(h.store.usageSince("demo", "worker-a", 0)).toEqual({ tokens: 1234, cost: 0.5 });
      if (version === 3) expect(h.store.getHungInfo("demo", "worker-a", "feat-login")).toMatchObject({ lastLines: "last line" });
      const db = new Database(p.dbPath, { readonly: true });
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(4);
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        expect(tables).toEqual(expect.arrayContaining(["agents_spend", "agents_spend_daily", "agents_spend_pending", "agents_hung_info"]));
        const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((t) => t.name);
        expect(indexes).toEqual(expect.arrayContaining(["idx_agents_spend_time", "idx_agents_spend_task", "idx_agents_spend_pending", "idx_agents_runs_task", "idx_agents_events_run"]));
      } finally {
        db.close();
      }
      // And it records spend from then on
      await oneRun(h, { log: CLAUDE_RUN, line: "- DONE feat-login by worker-a 12:05Z: merged" });
      expect(spendRows(h)).toHaveLength(1);
      expect(h.store.usageSince("demo", "worker-a", 0).tokens).toBe(1234 + 69_007);
    });
  }
});

// ============ AT-23: config errors name their keys ============

describe("AT-23: a bad usage config is refused at load, naming each key", () => {
  const project = (adapter: Record<string, unknown>) => projectConfig(makePaths(), {}, { ...ADAPTERS, "plain-cli": { ...ADAPTERS["plain-cli"], ...adapter } as AgentAdapter });
  const errorsOf = (raw: Record<string, unknown>, config: ProjectConfig) => {
    const parsed = parseAgentsConfig(raw, config);
    return parsed.ok ? [] : parsed.errors;
  };

  it("refuses each bad key with its path", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ usage_parser: "request-lines", request_pattern: "([a-z" }, "agent_adapters.plain-cli.request_pattern: not a valid regular expression"],
      [{ usage_parser: "request-lines", request_pattern: "x".repeat(MAX_REQUEST_PATTERN_CHARS + 1) }, "agent_adapters.plain-cli.request_pattern: at most 500 characters"],
      [{ usage_parser: "request-lines", request_pattern: "a*" }, "agent_adapters.plain-cli.request_pattern: it matches an empty line"],
      [{ usage_parser: "request-lines", request_pattern: "^(a+)+$" }, "agent_adapters.plain-cli.request_pattern: it takes over 100 ms on a short line"],
      [{ usage_parser: "request-lines" }, "agent_adapters.plain-cli.request_pattern: usage_parser request-lines needs a request_pattern"],
      [{ usage_parser: "claude-stream-json", request_pattern: "x" }, "agent_adapters.plain-cli.request_pattern: only read with usage_parser: request-lines"],
      [{ usage_parser: "tokens-guess" }, "agent_adapters.plain-cli.usage_parser: one of claude-stream-json, claude-json, request-lines, patterns, none"],
      [{ estimate: { tokens_per_request: 2000 } }, "agent_adapters.plain-cli.estimate: Lair never estimates usage"],
    ];
    for (const [adapter, error] of cases) {
      const errors = errorsOf({ enabled: true }, project(adapter));
      expect(errors, JSON.stringify(adapter)).toEqual([expect.stringContaining(error)]);
    }
    // agents.spend's own keys (the classification part): each refused naming it
    expect(errorsOf({ enabled: true, spend: { enabled: true, notice: { waste_share: 2 } } }, project({}))).toEqual([
      expect.stringContaining("agents.spend.notice.waste_share: a share in (0, 1]"),
    ]);
    expect(errorsOf({ enabled: true, spend: { enabled: true, notice: { waste_share: 0 } } }, project({}))).toEqual([
      expect.stringContaining("agents.spend.notice.waste_share"),
    ]);
    expect(errorsOf({ enabled: true, spend: { retention_days: 90, aggregate_days: 30 } }, project({}))).toEqual([
      expect.stringContaining("agents.spend.aggregate_days: at least agents.spend.retention_days"),
    ]);
    expect(errorsOf({ enabled: true, spend: { daily_summary_utc: "24:05" } }, project({}))).toEqual([expect.stringContaining("agents.spend.daily_summary_utc")]);
    // Keys of later parts are unknown here: refused too, naming them
    expect(errorsOf({ enabled: true, spend: { enabled: true, guards: {} } }, project({}))).toEqual([expect.stringMatching(/^agents\.spend: .*guards/)]);
    expect(errorsOf({ enabled: true, budgets: { guard_mode: "block" } }, project({}))).toEqual([expect.stringContaining("agents.budgets.guard_mode")]);
  });

  it("a reload with a bad request_pattern is refused, naming the key, and the previous config stays live", async () => {
    const root = mkdtempSync(join(tmpdir(), "lair-spend-reload-"));
    dirs.push(root);
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });
    const p: Paths = { dir: root, queueFile: join(root, "queue.md"), dbPath: join(root, "data", "agents.db") };
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "gates", "results"), { recursive: true });
    writeFileSync(p.queueFile, "# Queue\n");
    const file = join(projects, "demo.yaml");
    const write = (pattern: string) => {
      const config = projectConfig(p, SPEND_ON, { ...ADAPTERS, "plain-cli": { ...ADAPTERS["plain-cli"], usage_parser: "request-lines", request_pattern: pattern } });
      writeFileSync(file, stringify({ ...config, name: "Demo" }));
    };
    write("^request done$");
    const clock = new FakeClock();
    const procs = new FakeProcessTable(clock);
    const probes: AgentProbes = { processes: procs, fs: new NodeFileSystem(), runner: new NoCommands(), clock, spawner: new FakeSpawner(procs, clock), self: SELF, systemInfo: SYSTEM };
    const manager = new AgentsManager({ dbPath: p.dbPath, probes });
    managers.push(manager);
    const initial = [{ name: "demo", config: loadProjectConfig("demo", projects) }];
    manager.load(initial);
    manager.start();
    const reloader = new ConfigReloader({ modules: serverModules({ agents: manager }), initial, projectsDir: projects, debounceMs: 100, cwd: root, log: { log: () => undefined, warn: () => undefined } });
    reloader.start();
    await reloader.ready();
    cleanups.push(() => reloader.stop());
    const live = manager.get("demo")!;
    expect(live.settings.spend.parsers["plain-cli"].requestPattern?.source).toBe("^request done$");

    write("(unclosed");
    const until = Date.now() + 8000;
    while (reloader.status().problems.length === 0) {
      if (Date.now() > until) throw new Error("the reload was not refused");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reloader.status().problems[0].error).toContain("agent_adapters.plain-cli.request_pattern: not a valid regular expression");
    expect(reloader.status().problems[0].previousRunning).toBe(true);
    expect(manager.get("demo")).toBe(live);
    expect(live.running).toBe(true);
  });
});

// ============ AT-33: guards need spend ============

describe("AT-33: a guard (or a request or minute budget) needs agents.spend; budgets.guard_mode doesn't", () => {
  const config = projectConfig(makePaths(), {});
  const errorsOf = (raw: Record<string, unknown>) => {
    const parsed = parseAgentsConfig(raw, config);
    return parsed.ok ? [] : parsed.errors;
  };

  it("a guard mode other than off with spend off is refused, naming both keys", () => {
    const errors = errorsOf({ enabled: true, failover: { quota: { mode: "observe" } } });
    expect(errors).toContain("agents.failover.quota.mode: observe needs agents.spend.enabled: true (a guard's verdicts and counts are written by spend)");
    for (const raw of [
      { recovery: { hung_repeat: { mode: "act" } } },
      { fill: { wake: { events: { mode: "observe" } } } },
      { spend: { guards: { task_no_result_cap: { mode: "observe" } } } },
    ]) {
      expect(errorsOf({ enabled: true, ...raw }).some((e) => /needs agents\.spend\.enabled: true/.test(e)), JSON.stringify(raw)).toBe(true);
    }
    // off is no guard at all
    expect(errorsOf({ enabled: true, failover: { quota: { mode: "off" } } }).some((e) => e.includes("needs agents.spend"))).toBe(false);
  });

  it("a daily_requests or daily_minutes limit with spend off is refused, naming both keys", () => {
    expect(errorsOf({ enabled: true, budgets: { project: { daily_requests: { soft: 800 } } } })).toContain(
      "agents.budgets.project.daily_requests: needs agents.spend.enabled: true (counted from the spend records)",
    );
    expect(errorsOf({ enabled: true, budgets: { per_agent: { "worker-a": { monthly_minutes: { hard: 60 } } } } })).toContain(
      "agents.budgets.per_agent.worker-a.monthly_minutes: needs agents.spend.enabled: true (counted from the spend records)",
    );
  });

  it("budgets.guard_mode observe with a daily_cost hard limit loads with spend off, and the cost limit blocks as before", async () => {
    expect(errorsOf({ enabled: true, budgets: { guard_mode: "observe", project: { daily_cost: { hard: 50 } } } })).toEqual([]);
    const budget = new BudgetManager({ enabled: true, maxDailyCost: 1000, providers: [] });
    const h = setup({ budgets: { guard_mode: "observe", project: { daily_cost: { hard: 5 } } } }, { budget });
    budget.recordCost("provider-c", 6, "usage", { project: "demo", agent: "worker-a", tokens: 10 });
    await h.service.tick();
    expect(h.asked.filter((d) => d.kind === "spend")).toHaveLength(1);
    await expect(h.service.requestRun({ agent: "worker-b", task: "task-2", prompt: "Next" })).rejects.toMatchObject({ statusCode: 403 });
    expect(eventsOf(h, "guard_would")).toEqual([]);
    expect(spendRows(h)).toEqual([]);
  });
});

// ============ ORIGINS, CLASSES, CALLS ============

describe("run origins and the classes this part can tell", () => {
  it("the owner's run (POST /api/agents/runs) is origin owner; a module can't claim fill or owner", async () => {
    const h = setup(SPEND_ON);
    const app = Fastify();
    cleanups.push(() => app.close());
    const tokenPath = join(h.dir, "data", "owner.token");
    const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
    await registerOwnerRoutes(app, auth);
    await registerAgentsRoutes(app, h.manager, () => "demo", auth);
    await app.ready();
    const browser = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
    const signIn = await app.inject({ method: "POST", url: "/api/owner/sessions", headers: browser, payload: { token: readFileSync(tokenPath, "utf-8").trim() } });
    const owner = { ...browser, [OWNER_SESSION_HEADER]: signIn.json().data.session as string };
    const posted = await app.inject({ method: "POST", url: "/api/agents/runs?project=demo", headers: owner, payload: { agent: "worker-a", task: "feat-owner", prompt: "Build it" } });
    expect(posted.statusCode).toBe(201);
    expect(h.store.getRun(posted.json().data.id)?.origin).toBe("owner");

    await expect(h.manager.requestRun("demo", { agent: "worker-a", task: "x", prompt: "y" }, { origin: "owner" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.manager.requestRun("demo", { agent: "worker-a", task: "x", prompt: "y" }, { origin: "fill" })).rejects.toMatchObject({ statusCode: 400 });
    const review = await h.manager.requestRun("demo", { agent: "worker-b", task: "review-42-abcdef12", prompt: "Review it" }, { origin: "review" });
    expect(h.store.getRun(review.id)?.origin).toBe("review");
  });

  it("a run with no origin goes by its task id's prefix", () => {
    const run = (task: string, origin?: AgentRun["origin"]) => ({ task, origin }) as AgentRun;
    expect(originOf(run("review-42-abcdef12"))).toBe("review");
    expect(originOf(run("planner-20260302T120000Z-abc123"))).toBe("planner");
    expect(originOf(run("verifier-20260302T120000Z-abc123"))).toBe("verifier");
    expect(originOf(run("supervisor-digest-20260302"))).toBe("supervisor");
    expect(originOf(run("feat-login"))).toBe("other");
    expect(originOf(run("review-42-abcdef12", "fill"))).toBe("fill");
  });

  it("failed ends are no_result by their kind; a module run with nothing wired to tell is unclassified", async () => {
    const h = setup(SPEND_ON);
    await oneRun(h, { task: "feat-crash", log: "working\nsegmentation fault\n", exit: 2 });
    expect(spendRows(h).find((r) => r.task === "feat-crash")).toMatchObject({ class: "no_result", reason: "crashed" });
    // A WAITING line that names nothing Lair watches (no wake capture, no fill.wake.file)
    await oneRun(h, { agent: "worker-b", task: "feat-wait", log: CLAUDE_RUN, line: "- WAITING feat-wait by worker-b: gate queued" });
    expect(spendRows(h).find((r) => r.task === "feat-wait")).toMatchObject({ class: "idle", reason: "waiting_unnamed" });
    await oneRun(h, { agent: "worker-p", task: "feat-blocked", log: "x\n", line: "- BLOCKED feat-blocked by worker-p: needs a key" });
    expect(spendRows(h).find((r) => r.task === "feat-blocked")).toMatchObject({ class: "productive", reason: "blocked" });

    const classifier = new SpendClassifier({ project: "demo", store: h.store, wakeWatched: () => false, facts: () => undefined });
    const ended = { id: "r-1", state: "completed", endKind: "completed", task: "review-1-abcdef12", agent: "worker-a", chainId: "c-1", requestedAt: NOW } as AgentRun;
    expect(classifier.atEnd(ended, "completed", "review", null, NOW, true)).toMatchObject({ class: "unclassified", reason: "pending", pr: 1, headSha: "abcdef12" });
    expect(classifier.atEnd(ended, "completed", "owner", null, NOW, true)).toMatchObject({ class: "idle", reason: "no_line" });
    expect(classifier.atEnd(ended, "completed", "fill", { kind: "done", line: "- READY feat by worker-a: PR #4" }, NOW, true)).toMatchObject({ class: "productive", reason: "ready" });
    for (const end of ["hung", "rate_limit", "provider_error", "unreachable", "exit_unknown", "lost", "vars_lost", "lost_claim", "stopped", "never_started", "dead_on_start"] as const) {
      expect(classifier.atEnd({ ...ended, state: "failed", endKind: end }, end, "fill", null, NOW, true)).toMatchObject({ class: "no_result", reason: end });
    }
  });

  it("a restart after a failure is a reload; a run ended while Lair was down is a lair_restart", async () => {
    const h = setup({ ...SPEND_ON, recovery: { same_session_restarts: 1, fresh_sessions: 0, backoff_seconds: 0, max_backoff_seconds: 0 } });
    await oneRun(h, { task: "feat-twice", log: "working\nsegmentation fault\n", exit: 2 });
    h.spawner.behaviour = (pid, logPath) => {
      writeLog(h.clock, logPath, CLAUDE_RUN);
      appendFileSync(h.queueFile, "- DONE feat-twice by worker-a\n");
      h.spawner.exit(pid, 0);
    };
    await h.service.tick();
    h.clock.t += 90 * SEC;
    await h.service.tick();
    const rows = spendRows(h).filter((r) => r.task === "feat-twice");
    expect(rows.map((r) => [r.sessionMode, r.class, r.reload])).toEqual([
      ["new", "no_result", false],
      ["resume", "productive", true],
    ]);
  });
});

describe("spend.recordCall: a module's model call without an agent run", () => {
  it("writes one ledger row (run_id null, reason call:<module>) while spend is on; refuses bad input", async () => {
    const h = setup(SPEND_ON);
    expect(h.manager.recordCall("demo", { module: "brain", provider: "local", tokens: 0, cost: 0 })).toBe(true);
    expect(h.manager.recordCall("demo", { module: "planner", provider: "provider-c", tokens: 1200, cost: 0.02 })).toBe(true);
    expect(ledger(h.dbPath)).toEqual([
      { run_id: null, agent: null, tokens: 0, cost: 0, reason: "call:brain" },
      { run_id: null, agent: null, tokens: 1200, cost: 0.02, reason: "call:planner" },
    ]);
    // The token budgets count it
    expect(h.store.usageSince("demo", null, 0)).toEqual({ tokens: 1200, cost: 0.02 });
    for (const bad of [
      { module: "Brain!", provider: "local" },
      { module: "brain", provider: "-x" },
      { module: "brain", provider: "local", tokens: -1 },
      { module: "brain", provider: "local", cost: Number.NaN },
      { module: "brain", provider: "local", cost: 1e6 },
    ]) {
      expect(h.manager.recordCall("demo", bad), JSON.stringify(bad)).toBe(false);
    }
    expect(h.manager.recordCall("other-project", { module: "brain", provider: "local" })).toBe(false);
    expect(ledger(h.dbPath)).toHaveLength(2);
  });
});

// ============ PART 2: CLASSIFY, API, DAILY SUMMARY, NOTICES (§7 PR 2) ============

const DAY = 24 * 60 * MIN;
const byTask = (h: Harness, task: string): SpendRow[] => spendRows(h).filter((r) => r.task === task);

/** A Decision Inbox stand-in that keeps what it is asked, and answers find, open and withdraw as the real one does */
function memoryInbox() {
  const kept: { id: string; status: string; key: string; kind: string; title: string; source: { module: string; project: string; ref: string }; request: DecisionRequest }[] = [];
  const inbox: DecisionInbox = {
    request: async (request) => {
      const decision = {
        id: `decision-${kept.length + 1}`,
        status: "open",
        key: request.key,
        kind: request.kind,
        title: request.question,
        source: { module: "agents", project: request.project, ref: request.ref ?? "" },
        request,
      };
      kept.push(decision);
      return { id: decision.id, via: "the decisions module" };
    },
    find: (_project, key) => ([...kept].reverse().find((d) => d.key === key) ?? null) as unknown as Decision | null,
    open: () => kept.filter((d) => d.status === "open") as unknown as Decision[],
    withdraw: async (id) => {
      const decision = kept.find((d) => d.id === id);
      if (decision) decision.status = "withdrawn";
    },
  };
  return { inbox, kept };
}

/** A module's run (review, planner, verifier, supervisor): requested in-process, its CLI works and exits 0 */
async function moduleRun(h: Harness, origin: "review" | "planner" | "verifier" | "supervisor", task: string): Promise<AgentRun> {
  h.spawner.behaviour = (pid, logPath) => {
    writeLog(h.clock, logPath, "worked\n");
    h.spawner.exit(pid, 0);
  };
  const view = await h.manager.requestRun("demo", { agent: "worker-b", task, prompt: `Do it ${PROMPT_MARKER}` }, { origin });
  await h.service.tick();
  h.spawner.behaviour = undefined;
  h.clock.t += 90 * SEC;
  await h.service.tick();
  return h.store.getRun(view.id)!;
}

async function ownerApp(h: Harness) {
  const app = Fastify();
  cleanups.push(() => app.close());
  const tokenPath = join(h.dir, "data", "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  await registerOwnerRoutes(app, auth);
  await registerAgentsRoutes(app, h.manager, () => "demo", auth);
  await app.ready();
  const browser = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
  const signIn = await app.inject({ method: "POST", url: "/api/owner/sessions", headers: browser, payload: { token: readFileSync(tokenPath, "utf-8").trim() } });
  const owner = { ...browser, [OWNER_SESSION_HEADER]: signIn.json().data.session as string };
  return { app, browser, owner };
}

describe("AT-8: a builder's runs get one class and reason each", () => {
  it("DONE, no line, a crash, a rate limit and a transient death: productive/done, idle/no_line, no_result by the end", async () => {
    const h = setup(SPEND_ON);
    await oneRun(h, { task: "t-done", log: "x\n", line: "- DONE t-done by worker-a 12:01Z: merged" });
    await oneRun(h, { task: "t-quiet", log: "x\n" });
    await oneRun(h, { task: "t-crash", log: "working\nsegmentation fault\n", exit: 2 });
    await oneRun(h, { agent: "worker-p", task: "t-limit", log: "Error: 429 Too Many Requests: rate limit exceeded, retry later\n", exit: 1 });
    await oneRun(h, { agent: "builder-k", task: "t-net", log: "error: connect ECONNRESET 10.0.0.1:443\n", exit: 1 });
    const first = (task: string) => byTask(h, task)[0];
    expect(first("t-done")).toMatchObject({ class: "productive", reason: "done", origin: "other" });
    expect(first("t-quiet")).toMatchObject({ class: "idle", reason: "no_line" });
    expect(first("t-crash")).toMatchObject({ class: "no_result", reason: "crashed", lairRestart: false });
    expect(first("t-limit")).toMatchObject({ class: "no_result", reason: "rate_limit" });
    expect(first("t-net")).toMatchObject({ class: "no_result", reason: "unreachable" });
  });

  it("a hung run is no_result/hung; its resume in the same session is a reload", async () => {
    const h = setup({ ...SPEND_ON, recovery: { same_session_restarts: 1, fresh_sessions: 0, backoff_seconds: 0, max_backoff_seconds: 0 } });
    let spawned = 0;
    h.spawner.behaviour = (pid, logPath) => {
      spawned++;
      if (spawned === 1) return writeLog(h.clock, logPath, "working\n"); // then silent
      writeLog(h.clock, logPath, "resumed\n");
      appendFileSync(h.queueFile, "- DONE t-hang by worker-a 13:00Z: merged\n");
      h.spawner.exit(pid, 0);
    };
    await h.service.requestRun({ agent: "worker-a", task: "t-hang", prompt: "Build it" });
    await h.service.tick();
    h.clock.t += 46 * MIN;
    for (let i = 0; i < 8 && byTask(h, "t-hang").length < 2; i++) {
      await h.service.tick();
      h.clock.t += 30 * SEC;
    }
    expect(byTask(h, "t-hang").map((r) => [r.sessionMode, r.class, r.reason, r.reload])).toEqual([
      ["new", "no_result", "hung", false],
      ["resume", "productive", "done", true],
    ]);
  });

  it("a run that ended while Lair was down with no line, and a module run whose variables a restart lost: no_result, lair_restart", async () => {
    const h = setup(SPEND_ON);
    h.spawner.behaviour = (_pid, logPath) => writeLog(h.clock, logPath, "working\n"); // runs on past the restart
    await h.service.requestRun({ agent: "worker-a", task: "t-gone", prompt: "Build it" });
    await h.service.tick();
    await h.manager.requestRun("demo", { agent: "worker-b", task: "review-7-abcdef12", prompt: "Review it", variables: { LAIR_REVIEW_TOKEN: "t" } }, { origin: "review" });
    // Lair restarts (on_restart: adopt): the run's process ends meanwhile, and the queued run's variables are gone
    await h.manager.stop();
    h.clock.t += 5 * MIN;
    const again = setup(SPEND_ON, { paths: { dir: h.dir, queueFile: h.queueFile, dbPath: h.dbPath }, clock: h.clock });
    for (let i = 0; i < 3; i++) {
      await again.service.tick();
      again.clock.t += 30 * SEC;
    }
    expect(byTask(again, "t-gone")[0]).toMatchObject({ class: "no_result", reason: "exit_unknown", lairRestart: true });
    expect(byTask(again, "review-7-abcdef12")[0]).toMatchObject({ class: "no_result", reason: "vars_lost", lairRestart: true, origin: "review", pr: 7, headSha: "abcdef12" });
  });

  it("WAITING on a gate it queued is productive (gate_queued); the next run waiting on the same gate is idle (waiting_same)", async () => {
    const paths = makePaths();
    const WAITS_ON_GATE = "^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)";
    const GATE = "20260302T120100Z-t-wait-abcdef12-4242";
    mkdirSync(join(paths.dir, "prompts"), { recursive: true });
    writeFileSync(join(paths.dir, "prompts", "worker.txt"), "Build what the task says.\n");
    writeFileSync(join(paths.dir, "tasks.txt"), "worker-a|A|t-wait|Wait task\n");
    const h = setup(
      {
        ...SPEND_ON,
        fill: {
          enabled: true,
          tasks_file: join(paths.dir, "tasks.txt"),
          agents: ["worker-a"],
          prompt_files: ["{prompts_dir}/worker.txt"],
          max_active: 1,
          interval_seconds: 1,
          waiting_pattern: WAITS_ON_GATE,
          wake: { file: "{gates_dir}/results/{wake}.rc" },
        },
      },
      { paths },
    );
    const waitRun = async (stamp: string) => {
      h.spawner.behaviour = (pid, logPath) => {
        writeLog(h.clock, logPath, "queued the gate\n");
        appendFileSync(h.queueFile, `- WAITING t-wait ${GATE} by worker-a ${stamp}: gate queued\n`);
        h.spawner.exit(pid, 0);
      };
      await h.service.tick();
      h.spawner.behaviour = undefined;
      h.clock.t += MIN;
      await h.service.tick();
    };
    await h.service.checkFill();
    await waitRun("12:01Z");
    // Written before fill looked at the wait: its class waits for fill's record
    expect(byTask(h, "t-wait")[0]).toMatchObject({ class: "unclassified", reason: "pending" });
    await h.service.checkFill(); // fill: waiting on the gate, whose result isn't there
    expect(eventsOf(h, "fill_wake_absent")).toHaveLength(1);
    await h.service.tick();
    expect(byTask(h, "t-wait")[0]).toMatchObject({ class: "productive", reason: "gate_queued" });

    // The gate's result comes: fill starts the task again, and that run waits on the same gate
    writeFileSync(join(paths.dir, "gates", "results", `${GATE}.rc`), "0\n");
    h.clock.t += MIN;
    await h.service.checkFill();
    await waitRun("12:10Z");
    const rows = byTask(h, "t-wait");
    expect(rows.map((r) => [r.class, r.reason, r.origin])).toEqual([
      ["productive", "gate_queued", "fill"],
      ["idle", "waiting_same", "fill"],
    ]);
  });
});

describe("AT-9: a module's run is classified by what its module recorded", () => {
  it("review, planner, verifier and supervisor runs: productive with a record, idle without; pending until the module has read it", async () => {
    const verdicts = new Map<string, ModuleVerdict | null>([
      ["review-41-abcdef12", "productive"],
      ["review-42-bcdef123", "idle"],
      ["planner-1", "productive"],
      ["planner-2", "idle"],
      ["planner-3", "pending"],
      ["verifier-1", "productive"],
      ["verifier-2", "idle"],
      ["supervisor-ask-1", "productive"],
      ["supervisor-ask-2", "pending"],
    ]);
    const look = (_project: string, run: { task: string }) => verdicts.get(run.task) ?? null;
    const facts: SpendFacts = {
      review: (_project, run, _pr, head) => ({ verdict: (verdicts.get(run.task) ?? "idle") as ModuleVerdict, headSha: `${head}00000000000000000000000000000000` }),
      planner: look,
      verifier: look,
      supervisor: look,
    };
    const h = setup(SPEND_ON, { facts });
    const origins: [string, "review" | "planner" | "verifier" | "supervisor"][] = [
      ["review-41-abcdef12", "review"],
      ["review-42-bcdef123", "review"],
      ["planner-1", "planner"],
      ["planner-2", "planner"],
      ["planner-3", "planner"],
      ["verifier-1", "verifier"],
      ["verifier-2", "verifier"],
      ["supervisor-ask-1", "supervisor"],
      ["supervisor-ask-2", "supervisor"],
    ];
    for (const [task, origin] of origins) await moduleRun(h, origin, task);
    const of = (task: string) => byTask(h, task)[0];
    expect(of("review-41-abcdef12")).toMatchObject({ class: "productive", reason: "review_recorded", origin: "review", pr: 41, headSha: `abcdef12${"0".repeat(32)}` });
    expect(of("review-42-bcdef123")).toMatchObject({ class: "idle", reason: "no_review", origin: "review", pr: 42 });
    expect(of("planner-1")).toMatchObject({ class: "productive", reason: "proposals", origin: "planner" });
    expect(of("planner-2")).toMatchObject({ class: "idle", reason: "no_proposals", origin: "planner" });
    expect(of("verifier-1")).toMatchObject({ class: "productive", reason: "verdicts", origin: "verifier" });
    expect(of("verifier-2")).toMatchObject({ class: "idle", reason: "no_verdicts", origin: "verifier" });
    expect(of("supervisor-ask-1")).toMatchObject({ class: "productive", reason: "answered", origin: "supervisor" });
    // Not read by their modules yet
    expect(of("planner-3")).toMatchObject({ class: "unclassified", reason: "pending" });
    expect(of("supervisor-ask-2")).toMatchObject({ class: "unclassified", reason: "pending" });

    // The planner reads its run's output: the next tick classifies it; the question never gets its answer
    verdicts.set("planner-3", "productive");
    await h.service.tick();
    expect(of("planner-3")).toMatchObject({ class: "productive", reason: "proposals" });
    expect(of("supervisor-ask-2")).toMatchObject({ class: "unclassified", reason: "pending" });
    h.clock.t += CLASSIFY_WAIT_MS;
    await h.service.tick();
    expect(of("supervisor-ask-2")).toMatchObject({ class: "idle", reason: "no_answer" });
    // A classified row is never changed again
    verdicts.set("supervisor-ask-2", "productive");
    await h.service.tick();
    expect(of("supervisor-ask-2")).toMatchObject({ class: "idle", reason: "no_answer" });
  });

  it("without the module wired, its runs stay unclassified (nothing is guessed)", async () => {
    const h = setup(SPEND_ON);
    await moduleRun(h, "planner", "planner-9");
    h.clock.t += CLASSIFY_WAIT_MS;
    await h.service.tick();
    expect(byTask(h, "planner-9")[0]).toMatchObject({ class: "unclassified", reason: "pending" });
  });
});

describe("AT-31: a repeat BLOCKED with nothing pushed since is idle; only a key of the blocker is kept", () => {
  it("first productive, the same blocker at the same head idle, after the PR moved productive again", async () => {
    let head = "a".repeat(40);
    const h = setup(SPEND_ON, { facts: { prHead: (_project, pr) => (pr === 42 ? head : null) } });
    const BLOCKER = "waiting for PR #42 to be reviewed by the owner";
    await oneRun(h, { task: "t-block", log: "x\n", line: `- BLOCKED t-block by worker-a 12:01Z: ${BLOCKER}` });
    await oneRun(h, { agent: "worker-b", task: "t-block", log: "x\n", line: `- BLOCKED t-block by worker-b (2026-03-02 13:15Z): ${BLOCKER.replace("reviewed", "reviewed ")}` });
    head = "b".repeat(40);
    await oneRun(h, { task: "t-block", log: "x\n", line: `- BLOCKED t-block by worker-a 14:30Z: ${BLOCKER}` });
    const rows = byTask(h, "t-block");
    expect(rows.map((r) => [r.class, r.reason, r.pr, r.headSha])).toEqual([
      ["productive", "blocked", 42, "a".repeat(40)],
      ["idle", "blocked_repeat", 42, "a".repeat(40)],
      ["productive", "blocked", 42, "b".repeat(40)],
    ]);
    expect(new Set(rows.map((r) => r.blockerKey)).size).toBe(1);
    expect(rows[0].blockerKey).toMatch(/^[0-9a-f]{64}$/);
    // A DONE in between is a push: the same blocker after it is new information again
    await oneRun(h, { task: "t-block", log: "x\n", line: "- DONE t-block by worker-a 15:00Z: part one merged" });
    await oneRun(h, { task: "t-block", log: "x\n", line: `- BLOCKED t-block by worker-a 15:30Z: ${BLOCKER}` });
    expect(byTask(h, "t-block").at(-1)).toMatchObject({ class: "productive", reason: "blocked" });
    // Another blocker is another key
    expect(blockerKey(`- BLOCKED t-block by worker-a 16:00Z: needs the signing key`, null, null)).not.toBe(rows[0].blockerKey);

    const { app, owner } = await ownerApp(h);
    const response = await app.inject({ method: "GET", url: "/api/agents/spend/runs?project=demo&task=t-block", headers: owner });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(5);
    expect(response.body).not.toContain("waiting for PR");
    expect(response.body).not.toContain(PROMPT_MARKER);
    const db = new Database(h.dbPath, { readonly: true });
    try {
      expect(JSON.stringify(db.prepare("SELECT * FROM agents_spend").all())).not.toContain("waiting for PR");
    } finally {
      db.close();
    }
  });
});

describe("AT-10: GET /api/agents/spend is the owner's, numbers only", () => {
  it("totals, waste share, top tasks and each guard's mode for 7 days; refused without the owner, for a bad window and for a long window by task", async () => {
    const h = setup(SPEND_ON);
    h.clock.t = NOW - 2 * DAY;
    await oneRun(h, { task: "t-a", log: "x\n", line: "- DONE t-a by worker-a 12:01Z: merged" });
    h.clock.t = NOW - DAY;
    await oneRun(h, { task: "t-b", log: "x\n" });
    await oneRun(h, { task: "t-b", log: "segfault\n", exit: 2 });
    h.clock.t = NOW;
    await oneRun(h, { agent: "builder-k", task: "t-c", log: KIRO_30 });
    const { app, browser, owner } = await ownerApp(h);

    const ok = await app.inject({ method: "GET", url: "/api/agents/spend?project=demo&window=7d&by=task", headers: owner });
    expect(ok.statusCode).toBe(200);
    const report = ok.json().data;
    expect(report).toMatchObject({ window: "7d", by: "task", source: "runs", unit: "requests" });
    expect(report.totals.runs).toBeGreaterThanOrEqual(4);
    expect(report.productive.runs).toBe(1);
    expect(report.idle.runs).toBeGreaterThanOrEqual(1);
    expect(report.waste.runs).toBeGreaterThan(0);
    expect(report.groups.map((g: { key: string }) => g.key)).toEqual(expect.arrayContaining(["t-a", "t-b", "t-c"]));
    // The request-lines adapter reports no tokens: not reported, never estimated
    const kiro = report.groups.find((g: { key: string }) => g.key === "t-c");
    expect(kiro.totals).toMatchObject({ requests: 30, tokens: null, cost: null, reported: false });
    expect(report.topTasks[0]).toMatchObject({ task: "t-b" });
    expect(report.guards.map((g: { guard: string }) => g.guard)).toContain("task_no_result_cap");
    expect(report.guards.find((g: { guard: string }) => g.guard === "budget")).toMatchObject({ key: "agents.budgets.guard_mode", mode: "observe", would: 0, did: 0 });
    expect(ok.body).not.toContain(PROMPT_MARKER);

    for (const url of ["/api/agents/spend?project=demo&window=7d", "/api/agents/spend/runs?project=demo"]) {
      expect([401, 403]).toContain((await app.inject({ method: "GET", url, headers: browser })).statusCode);
    }
    const year = await app.inject({ method: "GET", url: "/api/agents/spend?project=demo&window=year", headers: owner });
    expect(year.statusCode).toBe(400);
    expect(year.json().error).toContain("window");
    const long = await app.inject({ method: "GET", url: "/api/agents/spend?project=demo&window=1y&by=task", headers: owner });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toContain("no per-task detail");
    const longByAgent = await app.inject({ method: "GET", url: "/api/agents/spend?project=demo&window=1y&by=agent", headers: owner });
    expect(longByAgent.statusCode).toBe(200);
    expect(longByAgent.json().data).toMatchObject({ source: "aggregates", topTasks: null });
  });

  it("with agents.spend off the routes say so (404)", async () => {
    const h = setup();
    const { app, owner } = await ownerApp(h);
    for (const url of ["/api/agents/spend?project=demo", "/api/agents/spend/runs?project=demo"]) {
      const response = await app.inject({ method: "GET", url, headers: owner });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toContain("agents.spend.enabled is off");
    }
  });
});

describe("AT-11: one daily summary per day, also across a restart", () => {
  it("past 00:05 UTC the day before is summed up once: one spend_daily event and one agents.spend.daily", async () => {
    const events = new EventBus();
    const daily: Record<string, unknown>[] = [];
    events.on("agents.spend.daily", (event) => {
      daily.push(event.data);
    });
    const h = setup(SPEND_ON, { events });
    await oneRun(h, { task: "t-a", log: "x\n", line: "- DONE t-a by worker-a 12:01Z: merged" });
    await oneRun(h, { task: "t-b", log: "x\n" });
    const ofDay = () => eventsOf(h, "spend_daily").filter((e) => e.data.day === "2026-03-02");
    h.clock.t = Date.parse("2026-03-03T00:04:00Z");
    await h.service.tick();
    expect(ofDay()).toEqual([]);
    h.clock.t = Date.parse("2026-03-03T00:05:30Z");
    await h.service.tick();
    await h.service.tick();
    expect(ofDay()).toHaveLength(1);
    expect(ofDay()[0].data).toMatchObject({ day: "2026-03-02", totals: { runs: 2 }, productive: { runs: 1 }, idle: { runs: 1 } });
    // Lair restarts at 00:06
    await h.manager.stop();
    h.clock.t = Date.parse("2026-03-03T00:06:00Z");
    const again = setup(SPEND_ON, { paths: { dir: h.dir, queueFile: h.queueFile, dbPath: h.dbPath }, clock: h.clock, events });
    await again.service.tick();
    expect(eventsOf(again, "spend_daily").filter((e) => e.data.day === "2026-03-02")).toHaveLength(1);
    expect(daily.filter((d) => d.day === "2026-03-02")).toHaveLength(1);
    expect(daily.find((d) => d.day === "2026-03-02")).toMatchObject({ project: "demo", totals: { runs: 2 } });
    expect(JSON.stringify(daily)).not.toContain(PROMPT_MARKER);
    // Its aggregates are written
    const db = new Database(h.dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT SUM(runs) AS n FROM agents_spend_daily WHERE day = '2026-03-02'").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});

describe("AT-12: the notices", () => {
  it("spend_waste: a notice once today's waste share passes the threshold with enough runs; withdrawn the next day", async () => {
    const { inbox, kept } = memoryInbox();
    const h = setup({ spend: { enabled: true, notice: { waste_share: 0.5, min_runs: 20 } } }, { inbox });
    const runs = async (productive: number, idle: number) => {
      for (let i = 0; i < productive; i++) {
        const task = `t-p${kept.length}-${spendRows(h).length}`;
        await oneRun(h, { task, log: "x\n", line: `- DONE ${task} by worker-a 12:01Z: merged` });
      }
      for (let i = 0; i < idle; i++) await oneRun(h, { agent: "worker-b", task: `t-i-${spendRows(h).length}`, log: "x\n" });
    };
    // 19 runs, more than half of them idle: too few runs for a notice
    await runs(9, 10);
    await h.service.tick();
    expect(kept.filter((d) => d.key.startsWith("spend_waste:"))).toEqual([]);
    // 25 runs, 14 idle
    await runs(2, 4);
    await h.service.tick();
    await h.service.tick();
    const notices = kept.filter((d) => d.key.startsWith("spend_waste:"));
    expect(notices).toHaveLength(1);
    expect(notices[0].request).toMatchObject({ attention: "notice", kind: "other", key: "spend_waste:2026-03-02", ref: "spend:waste:2026-03-02" });
    // Raised at the first check that found at least 20 runs and half or more of the minutes idle
    expect(notices[0].request.question).toMatch(/^AI spend: (5\d|60) % of today's minutes went to idle or no-result runs$/);
    expect(notices[0].request.context).not.toContain(PROMPT_MARKER);
    // The next day's first tick withdraws it
    h.clock.t = Date.parse("2026-03-03T00:10:00Z");
    await h.service.tick();
    expect(notices[0].status).toBe("withdrawn");
  });

  it("spend_task_attempts: a notice once a task's attempts without a completion reach the threshold; withdrawn when it completes", async () => {
    const { inbox, kept } = memoryInbox();
    const h = setup({ spend: { enabled: true, notice: { task_attempts: 3 } } }, { inbox });
    await oneRun(h, { task: "t-hard", log: "x\n" });
    await oneRun(h, { agent: "worker-b", task: "t-hard", log: "x\n" });
    await h.service.tick();
    expect(kept).toEqual([]);
    await oneRun(h, { task: "t-hard", log: "x\n" });
    await h.service.tick();
    const notice = kept.find((d) => d.key.startsWith("spend_task_attempts:t-hard:"));
    expect(notice?.request).toMatchObject({ attention: "notice", ref: expect.stringMatching(/^spend:attempts:0:t-hard$/) });
    expect(notice?.request.question).toContain("t-hard took 3 runs");
    await h.service.tick();
    expect(kept.filter((d) => d.key.startsWith("spend_task_attempts:"))).toHaveLength(1);
    await oneRun(h, { task: "t-hard", log: "x\n", line: "- DONE t-hard by worker-a 13:00Z: merged" });
    await h.service.tick();
    expect(notice?.status).toBe("withdrawn");
  });
});

/** A spend row as a run of `task` that ended at `endedAt` would have it (for the retention fixtures) */
function fixtureRow(runId: string, endedAt: number, cost: number, cls: SpendRow["class"] = "productive", reason = "done"): SpendRow {
  return {
    runId,
    project: "demo",
    agent: "worker-a",
    task: `t-${runId}`,
    chainId: runId,
    origin: "fill",
    adapter: "claude-cli",
    provider: "provider-c",
    model: "model-a",
    startedAt: endedAt - 60_000,
    endedAt,
    runtimeS: 60,
    class: cls,
    reason,
    sessionMode: "new",
    reload: false,
    lairRestart: false,
    usageSource: "reported",
    inputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 100,
    outputTokens: 5,
    tokens: 15,
    requests: null,
    turns: 1,
    cost,
    contextBytes: 100,
    pr: null,
    headSha: null,
    blockerKey: null,
    backfilled: false,
    usageRecorded: true,
  };
}

describe("AT-29: retention aggregates each day again before its runs go", () => {
  it("rows past 90 days go after their day is aggregated (late rows too); aggregates past 365 days go; a second run changes nothing", async () => {
    const paths = makePaths();
    const store = new AgentsStore(paths.dbPath);
    const at = (days: number) => NOW - days * DAY;
    store.recordSpend(fixtureRow("old-1", at(400), 1), null);
    store.recordSpend(fixtureRow("old-2", at(400) + MIN, 2), null);
    store.recordSpend(fixtureRow("d100", at(100), 3), null);
    store.recordSpend(fixtureRow("d101", at(101), 4), null);
    // d101's aggregate was written before a late row of that day arrived
    const d101 = new Date(at(101)).toISOString().slice(0, 10);
    store.aggregateSpendDay("demo", d101, Date.parse(`${d101}T00:00:00Z`), false);
    store.recordSpend(fixtureRow("d101-late", at(101) + 2 * MIN, 5, "no_result", "exit_unknown"), null);
    store.recordSpend(fixtureRow("d1", at(1), 6), null);
    store.recordSpend(fixtureRow("d0", NOW - MIN, 7), null);
    store.close();

    const h = setup(SPEND_ON, { paths });
    await h.service.tick();
    const look = () => {
      const db = new Database(h.dbPath, { readonly: true });
      try {
        return {
          runs: (db.prepare("SELECT run_id FROM agents_spend ORDER BY run_id").all() as { run_id: string }[]).map((r) => r.run_id),
          daily: db.prepare("SELECT day, class, reason, runs, cost FROM agents_spend_daily ORDER BY day, class").all(),
        };
      } finally {
        db.close();
      }
    };
    const first = look();
    expect(first.runs).toEqual(["d0", "d1"]);
    const d100 = new Date(at(100)).toISOString().slice(0, 10);
    const d1 = new Date(at(1)).toISOString().slice(0, 10);
    expect(first.daily).toEqual([
      { day: d101, class: "no_result", reason: "exit_unknown", runs: 1, cost: 5 },
      { day: d101, class: "productive", reason: "done", runs: 1, cost: 4 },
      { day: d100, class: "productive", reason: "done", runs: 1, cost: 3 },
      { day: d1, class: "productive", reason: "done", runs: 1, cost: 6 },
    ]);
    // The 1-year window: the aggregates, plus today's runs (not aggregated yet): the sum of the rows within a year
    const year = h.service.spendReport("1y", "project");
    expect(year).toMatchObject({ source: "aggregates", totals: { runs: 5, cost: 25 } });
    expect(year.noResult).toMatchObject({ runs: 1, cost: 5 });

    // Run twice (a restart, the same day): nothing more is written or deleted
    await h.service.tick();
    await h.manager.stop();
    const again = setup(SPEND_ON, { paths, clock: h.clock });
    await again.service.tick();
    expect(look()).toEqual(first);
  });
});

describe("AT-34: the first enable classifies the runs of the last backfill_days", () => {
  it("runs of the last 7 days get backfilled rows (usage none), older ones none; a second start adds nothing", async () => {
    const paths = makePaths();
    const NO_RESTARTS = { recovery: { same_session_restarts: 0, fresh_sessions: 0, backoff_seconds: 0, max_backoff_seconds: 0 } };
    const off = setup(NO_RESTARTS, { paths });
    for (let i = 0; i < 10; i++) {
      off.clock.t = NOW - (10 - i) * DAY;
      await oneRun(off, { task: `t-day${i}`, log: CLAUDE_RUN, exit: i === 9 ? 0 : 2, line: i === 9 ? "- DONE t-day9 by worker-a 12:01Z: merged" : undefined });
    }
    expect(spendRows(off)).toEqual([]);
    await off.manager.stop();

    const clock = new FakeClock();
    const on = setup({ ...SPEND_ON, ...NO_RESTARTS }, { paths, clock });
    await on.service.tick();
    await on.service.tick();
    const rows = spendRows(on);
    expect(rows.map((r) => r.task)).toEqual(["t-day3", "t-day4", "t-day5", "t-day6", "t-day7", "t-day8", "t-day9"]);
    for (const row of rows) expect(row).toMatchObject({ backfilled: true, usageSource: "none", tokens: null, cost: null, usageRecorded: true });
    expect(rows[0]).toMatchObject({ class: "no_result", reason: "crashed" });
    // Its DONE line was never recorded by Lair (no fill): not guessed, and the queue file isn't read again for it
    expect(rows.at(-1)).toMatchObject({ class: "unclassified", reason: "not_recorded" });
    expect(ledger(on.dbPath)).toEqual([]);
    expect(eventsOf(on, "spend_backfill").map((e) => e.dedupeKey)).toEqual(["spend_backfill:start", "spend_backfill:done"]);

    await on.manager.stop();
    const again = setup({ ...SPEND_ON, ...NO_RESTARTS }, { paths, clock });
    await again.service.tick();
    expect(spendRows(again)).toEqual(rows);
  });
});

describe("first enable and late facts (the #306 review's follow-ups)", () => {
  const NO_RESTARTS = { recovery: { same_session_restarts: 0, fresh_sessions: 0, backoff_seconds: 0, max_backoff_seconds: 0 } };

  it("S1: with more runs than one tick's backfill, the day before is summed up once it is done; 1y counts a row that came after its day's summary", async () => {
    const paths = makePaths();
    const off = setup(NO_RESTARTS, { paths });
    off.clock.t = NOW - 3 * DAY;
    const base = await oneRun(off, { task: "t-base", log: CLAUDE_RUN, exit: 2 });
    await off.manager.stop();
    // More runs as Lair records them: 200 six days ago, then 30 the day before (the backfill, oldest first, reaches them last)
    const store = new AgentsStore(paths.dbPath);
    const copy = (i: number, endedAt: number) =>
      store.insertRun({ ...base, id: `copy-${String(i).padStart(3, "0")}`, chainId: `copy-${i}`, task: `t-copy${i}`, requestedAt: endedAt - 90 * SEC, spawnedAt: endedAt - 89 * SEC, endedAt });
    for (let i = 0; i < 200; i++) copy(i, NOW - 6 * DAY + i * MIN);
    for (let i = 0; i < 30; i++) copy(200 + i, Date.parse("2026-03-01T10:00:00Z") + i * MIN);
    store.close();

    const on = setup({ ...SPEND_ON, ...NO_RESTARTS }, { paths });
    await on.service.tick();
    // One tick's backfill: the 200 oldest. The day before isn't summed up from part of its runs
    expect(spendRows(on)).toHaveLength(200);
    expect(eventsOf(on, "spend_daily")).toEqual([]);
    await on.service.tick();
    expect(spendRows(on)).toHaveLength(231);
    const daily = eventsOf(on, "spend_daily");
    expect(daily).toHaveLength(1);
    expect(daily[0].data).toMatchObject({ day: "2026-03-01", totals: { runs: 30 }, noResult: { runs: 30 } });
    await on.service.tick();
    expect(eventsOf(on, "spend_daily")).toHaveLength(1);

    // A row of that day lands after its summary (an exit-unknown run seen late): every window counts it at once
    on.store.recordSpend(fixtureRow("late-1", Date.parse("2026-03-01T23:00:00Z"), 1, "no_result", "exit_unknown"), null);
    expect(on.service.spendReport("7d", "project").totals.runs).toBe(232);
    const year = on.service.spendReport("1y", "project");
    expect(year).toMatchObject({ source: "aggregates", totals: { runs: 232 } });
    expect(year.groups[0]).toMatchObject({ key: "demo", totals: { runs: 232 }, unclassified: { runs: 0 } });
  });

  it("S4: a run that ended while spend was on is drain's: the backfill leaves it, and its row keeps the usage its log reports", async () => {
    // A clock that moves on every read, as a real one does between the end and the backfill's start in one tick
    class MovingClock extends FakeClock {
      now(): number {
        return ++this.t;
      }
    }
    const paths = makePaths();
    const clock = new MovingClock();
    const off = setup(NO_RESTARTS, { paths, clock });
    const all = lines(CLAUDE_RUN);
    const assistant = all.find((l) => l.includes('"type":"assistant"'))!;
    const filler = Array.from({ length: Math.ceil((SCAN_BYTES_PER_TICK * 1.3) / assistant.length) }, () => assistant);
    const big = [...all.slice(0, -1), ...filler, all.at(-1)!].join("\n") + "\n";
    off.spawner.behaviour = (_pid, logPath) => writeLog(off.clock, logPath, big); // runs on past the restart
    const view = await off.service.requestRun({ agent: "worker-a", task: "t-long", prompt: "Build it" });
    await off.service.tick();
    // Lair restarts with spend turned on for the first time; the run's process ended meanwhile
    await off.manager.stop();
    clock.t += 5 * MIN;
    const on = setup({ ...SPEND_ON, ...NO_RESTARTS }, { paths, clock });
    await on.service.tick();
    const ended = on.store.getRun(view.id)!;
    expect(ended.endedAt).toBeDefined();
    const start = eventsOf(on, "spend_backfill").find((e) => e.dedupeKey === "spend_backfill:start")!;
    expect(ended.endedAt!).toBeLessThan(Number(start.data.to)); // inside the backfill's window
    // Its log is longer than one tick reads: owed, and the backfill wrote nothing for it
    expect(on.store.getSpend(view.id)).toBeNull();
    expect(pendingCount(on.dbPath)).toBe(1);
    for (let i = 0; i < 3; i++) await on.service.tick();
    expect(on.store.getSpend(view.id)).toMatchObject({ backfilled: false, usageSource: "reported", tokens: 69_007, outputTokens: 13_052 });
    expect(ledger(on.dbPath).filter((r) => r.run_id === view.id)).toHaveLength(1);
  });

  it("S2: a repeat BLOCKED waiting on a run before it keeps its key and is classified blocked_repeat; a not_recorded row isn't waited on", async () => {
    const paths = makePaths();
    const GATE = "20260302T120100Z-t-key-abcdef12-4242";
    writeFileSync(join(paths.dir, "tasks.txt"), "");
    mkdirSync(join(paths.dir, "prompts"), { recursive: true });
    writeFileSync(join(paths.dir, "prompts", "worker.txt"), "Build what the task says.\n");
    const h = setup(
      {
        ...SPEND_ON,
        fill: {
          enabled: true,
          tasks_file: join(paths.dir, "tasks.txt"),
          agents: ["worker-a"],
          prompt_files: ["{prompts_dir}/worker.txt"],
          waiting_pattern: "^-\\s+WAITING\\s+{task}(?:\\s+(?<wake>\\d{8}T\\d{6}Z-\\S+))?(?=\\s|$)",
          wake: { file: "{gates_dir}/results/{wake}.rc" },
        },
      },
      { paths },
    );
    const BLOCKER = "needs the signing key from the owner";
    const first = await oneRun(h, { task: "t-key", log: "x\n", line: `- BLOCKED t-key by worker-a 12:01Z: ${BLOCKER}` });
    // A WAITING run fill hasn't looked at: its class waits (30 min at most)
    const wait = await oneRun(h, { task: "t-key", log: "x\n", line: `- WAITING t-key ${GATE} by worker-a 12:05Z: gate queued` });
    expect(h.store.getSpend(wait.id)).toMatchObject({ class: "unclassified", reason: "pending" });
    const repeat = await oneRun(h, { task: "t-key", log: "x\n", line: `- BLOCKED t-key by worker-a 12:09Z: ${BLOCKER}` });
    const key = h.store.getSpend(first.id)!.blockerKey;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // It waits for the row before it, and keeps its key meanwhile
    expect(h.store.getSpend(repeat.id)).toMatchObject({ class: "unclassified", reason: "pending", blockerKey: key });
    h.clock.t += CLASSIFY_WAIT_MS;
    await h.service.tick();
    expect(h.store.getSpend(wait.id)).toMatchObject({ class: "idle", reason: "waiting_unnamed" });
    expect(h.store.getSpend(repeat.id)).toMatchObject({ class: "idle", reason: "blocked_repeat", blockerKey: key });

    // A backfilled row whose line was never recorded (it never gets a class) is not waited on
    h.store.recordSpend({ ...fixtureRow("old-done", h.clock.t, 0, "unclassified", "not_recorded"), task: "t-key", backfilled: true }, null);
    h.clock.t += MIN;
    const third = await oneRun(h, { task: "t-key", log: "x\n", line: `- BLOCKED t-key by worker-a 13:00Z: ${BLOCKER}` });
    expect(h.store.getSpend(third.id)).toMatchObject({ class: "idle", reason: "blocked_repeat", blockerKey: key });
  });

  it("L2, L3: a row still pending from before the classify lookback is classified once after a start; groups count unclassified runs", async () => {
    const verdicts = new Map<string, ModuleVerdict | null>([["planner-7", "pending"]]);
    const facts: SpendFacts = { planner: (_project, run) => verdicts.get(run.task) ?? null };
    const h = setup(SPEND_ON, { facts });
    const run = await moduleRun(h, "planner", "planner-7");
    expect(h.store.getSpend(run.id)).toMatchObject({ class: "unclassified", reason: "pending" });
    expect(h.service.spendReport("today", "origin").groups.find((g) => g.key === "planner")).toMatchObject({ totals: { runs: 1 }, unclassified: { runs: 1 } });
    // Lair is down for three days; the planner's record of the run is there when it is back
    await h.manager.stop();
    h.clock.t += 3 * DAY;
    verdicts.set("planner-7", "productive");
    const again = setup(SPEND_ON, { paths: { dir: h.dir, queueFile: h.queueFile, dbPath: h.dbPath }, clock: h.clock, facts });
    await again.service.tick();
    expect(again.store.getSpend(run.id)).toMatchObject({ class: "productive", reason: "proposals" });
  });

  it("L5: an empty window and a day with no runs", async () => {
    const h = setup(SPEND_ON);
    const today = h.service.spendReport("today", "task");
    expect(today).toMatchObject({ unit: "runs", wasteShare: null, totals: { runs: 0 }, groups: [], reasons: [], topTasks: [] });
    await h.service.tick();
    const daily = eventsOf(h, "spend_daily");
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ summary: "AI spend 2026-03-01: 0 run(s), no runs", data: { day: "2026-03-01", totals: { runs: 0 }, wasteShare: null } });
  });
});
