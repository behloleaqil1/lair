/**
 * The self-checks through the production runner (Supervisor): each check's
 * thresholds and status, a slow measure timed out and a failing one kept
 * from the others, the schedule, and a failing check's one notice. Only the
 * clock and the OS measures are fakes; the stores, the Decision Inbox, the
 * watchdog, placement and the file watcher are the real ones, on files in a
 * temp dir.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { CheckResult } from "../../shared/supervisor-types.js";
import type { AgentRun } from "../agents/types.js";
import { AgentsStore } from "../agents/store.js";
import { SpawnToolRunner } from "../ai/runner.js";
import { CommandTimeoutLog, commandTimeouts } from "../core/command-timeouts.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import { PlacementManager } from "../placement/service.js";
import { NodeQueueFiles } from "../placement/probes.js";
import { ExecFileRunner, type CommandOutput, type CommandRunner } from "../watchdog/probes.js";
import { WatchdogManager } from "../watchdog/service.js";
import { FileWatcherService } from "../services/file-watcher.js";
import type { LairWebSocketServer } from "../websocket.js";
import type { CheckSources } from "./checks.js";
import { RequestLatency } from "./latency.js";
import { SystemMeasures, countLsofDescriptors, parseProcLimits, type DiskSpace, type LoopDelay, type OpenFiles, type OsMeasures } from "./measures.js";
import { moduleReports } from "./modules.js";
import { FIRST_ROUND_MS, Supervisor, TICK_MS } from "./service.js";

const T0 = Date.parse("2026-10-28T09:00:00Z");
const MIN = 60_000;
const GIB = 1024 ** 3;
const MB = 1024 ** 2;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeClock {
  t = T0;
  now(): number {
    return this.t;
  }
}

/** The OS measures, as the test sets them (a promise stands for a measure still running) */
class FakeMeasures implements OsMeasures {
  delay: LoopDelay | null = { p99Ms: 5, maxMs: 8, meanMs: 2 };
  delayThrows = false;
  files: OpenFiles | null | Promise<OpenFiles | null> = { open: 50, limit: 1000, source: "proc" };
  disk: DiskSpace | null = { freeBytes: 50 * GIB, totalBytes: 100 * GIB };
  delayCalls = 0;

  eventLoopDelay(): LoopDelay | null {
    this.delayCalls++;
    if (this.delayThrows) throw new Error("the histogram broke: token=abc123secret");
    return this.delay;
  }
  async openFiles(): Promise<OpenFiles | null> {
    return this.files;
  }
  async diskSpace(): Promise<DiskSpace | null> {
    return this.disk;
  }
}

function projectConfig(root: string, extra: Record<string, unknown> = {}): ProjectConfig {
  return {
    name: "Demo",
    repo: root,
    github: "example/demo",
    queue_file: join(root, "queue.md"),
    agents_dir: join(root, "agents"),
    gates_dir: join(root, "gates"),
    machines: {},
    dragons: {},
    ...extra,
  } as ProjectConfig;
}

interface HarnessOptions {
  supervisor?: Record<string, unknown>;
  /** Other projects than demo (the default project) */
  others?: Record<string, ProjectConfig>;
  sources?: Partial<CheckSources>;
  inbox?: boolean;
  clock?: { now(): number };
}

function harness(options: HarnessOptions = {}) {
  const root = tempDir("lair-supervisor-");
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const fake = new FakeClock();
  const clock = options.clock ?? fake;
  const measures = new FakeMeasures();
  const latency = new RequestLatency(() => clock.now());
  const timeouts = new CommandTimeoutLog(() => clock.now());
  const configs: Record<string, ProjectConfig> = {
    demo: projectConfig(root, options.supervisor ? { supervisor: options.supervisor } : {}),
    ...(options.others ?? {}),
  };
  let inbox: DecisionInbox | null = null;
  if (options.inbox) {
    const store = new DecisionStore(":memory:");
    inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), clock });
    cleanups.push(() => store.close());
  }
  const sources: CheckSources = {
    dataDir,
    config: (project) => {
      const config = configs[project];
      if (!config) throw new Error(`no project ${project}`);
      return config;
    },
    ...options.sources,
  };
  const make = () => {
    const s = new Supervisor({ sources, defaultProject: () => "demo", measures, latency, timeouts, clock, log: { warn: () => undefined } });
    s.load(Object.entries(configs).map(([name, config]) => ({ name, config })));
    if (inbox) s.useDecisions(inbox);
    cleanups.push(() => s.stop());
    return s;
  };
  const supervisor = make();
  return { root, dataDir, fake, measures, latency, timeouts, configs, inbox, supervisor, make };
}

type Harness = ReturnType<typeof harness>;

function server(h: Harness, id: string, s: Supervisor = h.supervisor): CheckResult | undefined {
  return s.diagnostics().server.find((c) => c.id === id);
}

function inProject(h: Harness, id: string, project = "demo"): CheckResult | undefined {
  return h.supervisor
    .diagnostics(project)
    .projects.find((p) => p.project === project)
    ?.checks.find((c) => c.id === id);
}

/** A round of every check, 11 s after the last (runNow reruns at most every 10 s). */
async function round(h: Harness, advanceMs = 11_000): Promise<void> {
  h.fake.t += advanceMs;
  await h.supervisor.runNow();
}

function sized(path: string, bytes: number): void {
  writeFileSync(path, "");
  truncateSync(path, bytes);
}

describe("the server's checks", () => {
  it("grade each measure against its thresholds: ok, warning, failing, unknown", async () => {
    const h = harness({
      supervisor: {
        checks: {
          store_size: { warning_mb: 1, failing_mb: 2, wal_warning_mb: 1, wal_failing_mb: 2 },
          command_timeouts: { warning: 2, failing: 4, window_minutes: 15 },
        },
      },
    });

    // Every measure well within its limits
    h.measures.delay = { p99Ms: 50, maxMs: 60, meanMs: 10 };
    for (let i = 0; i < 25; i++) h.latency.record(100, "/api/dragons");
    h.measures.files = { open: 100, limit: 1000, source: "proc" };
    h.measures.disk = { freeBytes: 50 * GIB, totalBytes: 100 * GIB };
    sized(join(h.dataDir, "small.db"), 100 * 1024);
    await round(h);
    expect(server(h, "event_loop_lag")).toMatchObject({
      status: "ok",
      values: { p99_ms: 50, max_ms: 60 },
      thresholds: { warning_ms: 200, failing_ms: 1000 },
      fix: null,
    });
    expect(server(h, "request_latency")).toMatchObject({ status: "ok", values: { requests: 25, p95_ms: 100 } });
    expect(server(h, "open_files")).toMatchObject({ status: "ok", values: { open: 100, limit: 1000, percent: 10 } });
    expect(server(h, "disk_free")).toMatchObject({ status: "ok", values: { free_gib: 50, free_percent: 50 } });
    expect(server(h, "store_size")).toMatchObject({ status: "ok", values: { stores: 1, largest: "small.db" }, thresholds: { warning_mb: 1 } });
    expect(server(h, "command_timeouts")).toMatchObject({ status: "ok", values: { timeouts: 0 } });

    // Past the warning thresholds
    h.measures.delay = { p99Ms: 300, maxMs: 450, meanMs: 40 };
    for (let i = 0; i < 25; i++) h.latency.record(2000, "/api/gates");
    h.measures.files = { open: 750, limit: 1000, source: "proc" };
    h.measures.disk = { freeBytes: 8 * GIB, totalBytes: 100 * GIB };
    sized(join(h.dataDir, "big.db"), 1.5 * MB);
    h.timeouts.note("git", "/usr/bin/git");
    h.timeouts.note("probe", "ssh");
    await round(h);
    const warnings = ["event_loop_lag", "request_latency", "open_files", "disk_free", "store_size", "command_timeouts"].map((id) => [
      id,
      server(h, id)?.status,
    ]);
    expect(warnings).toEqual(warnings.map(([id]) => [id, "warning"]));
    expect(server(h, "request_latency")?.values).toMatchObject({ requests: 50, p95_ms: 2000, slowest_route: "/api/gates" });
    expect(server(h, "store_size")?.values).toMatchObject({ largest: "big.db", largest_mb: 1.5 });
    expect(server(h, "command_timeouts")?.values).toMatchObject({ timeouts: 2, git: 1, probe: 1, programs: "git, ssh" });
    for (const id of ["event_loop_lag", "open_files", "disk_free"]) expect(server(h, id)?.fix, id).toBeTruthy();

    // Past the failing thresholds
    h.measures.delay = { p99Ms: 1500, maxMs: 2400, meanMs: 300 };
    for (let i = 0; i < 50; i++) h.latency.record(6000, "/api/overview");
    h.measures.files = { open: 950, limit: 1000, source: "lsof" };
    h.measures.disk = { freeBytes: 1 * GIB, totalBytes: 100 * GIB };
    sized(join(h.dataDir, "big.db-wal"), 2.5 * MB);
    h.timeouts.note("status", "gh");
    h.timeouts.note("tool", "agent-cli");
    await round(h);
    const failing = ["event_loop_lag", "request_latency", "open_files", "disk_free", "store_size", "command_timeouts"].map((id) => [
      id,
      server(h, id)?.status,
    ]);
    expect(failing).toEqual(failing.map(([id]) => [id, "failing"]));
    expect(server(h, "event_loop_lag")?.explanation).toContain("2400 ms");
    expect(server(h, "store_size")?.values).toMatchObject({ largest_wal: "big.db", wal_mb: 2.5, wal_growth_mb: 2.5 });
    // Few GiB free fails even with a fair share of a small disk free
    h.measures.disk = { freeBytes: 0.5 * GIB, totalBytes: 2 * GIB };
    await round(h);
    expect(server(h, "disk_free")).toMatchObject({ status: "failing", values: { free_percent: 25, free_gib: 0.5 } });

    // What can't be measured is unknown, never ok; old requests and timeouts leave their windows
    h.measures.delay = null;
    h.measures.files = { open: 120, limit: null, source: "dev-fd" };
    h.measures.disk = null;
    await round(h, 16 * MIN);
    expect(server(h, "event_loop_lag")?.status).toBe("unknown");
    expect(server(h, "open_files")).toMatchObject({ status: "unknown", values: { open: 120, limit: null } });
    expect(server(h, "disk_free")?.status).toBe("unknown");
    expect(server(h, "request_latency")).toMatchObject({ status: "ok", values: { requests: 0 } });
    expect(server(h, "request_latency")?.explanation).toContain("too few to judge");
    expect(server(h, "command_timeouts")).toMatchObject({ status: "ok", values: { timeouts: 0 } });
    h.measures.files = null;
    await round(h);
    expect(server(h, "open_files")?.status).toBe("unknown");

    // The diagnostics count them
    expect(h.supervisor.diagnostics().counts.unknown).toBeGreaterThanOrEqual(3);
  });

  it("refuses thresholds in the wrong order, naming the key", () => {
    const h = harness();
    expect(h.supervisor.validate(projectConfig(h.root, { supervisor: { checks: { open_files: { warning_percent: 95, failing_percent: 90 } } } }))).toEqual([
      "supervisor.checks.open_files: the warning threshold (95) is above the failing one (90)",
    ]);
    expect(h.supervisor.validate(projectConfig(h.root, { supervisor: { checks: { bogus: 1 } } }))[0]).toContain("supervisor.checks");
    expect(h.supervisor.validate(projectConfig(h.root, { supervisor: { checks: { disabled: ["nope"] } } }))[0]).toContain("supervisor.checks.disabled.0");
    expect(h.supervisor.validate(projectConfig(h.root))).toEqual([]);
  });
});

/** The command runner placement probes machines with: probe-<id> answers 0 when the machine is up. */
class ProbeRunner implements CommandRunner {
  down = new Set<string>();
  async run(argv: string[]): Promise<CommandOutput> {
    const machine = argv[0].replace(/^probe-/, "");
    return this.down.has(machine) ? { code: 255, stdout: "", stderr: "ssh: connect to host build.example port 22: refused" } : { code: 0, stdout: "ok", stderr: "" };
  }
}

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: "run-1",
    project: "demo",
    task: "feat-x",
    agent: "kiro-A",
    prompt: "do the task",
    chainId: over.id ?? "run-1",
    attempt: 1,
    profileIndex: 0,
    profile: { adapter: "kiro", provider: "kiro" },
    sessionId: "s-1",
    sessionMode: "new",
    sameSessionRestarts: 0,
    freshSessions: 0,
    startRetries: 0,
    launchFailures: 0,
    state: "failed",
    detail: "crashed: exit code 1",
    requestedAt: T0,
    notBefore: T0,
    logOffset: 0,
    ...over,
  };
}

async function raiseHold(inbox: DecisionInbox, task: string, key: string) {
  return inbox.raise({
    project: "demo",
    kind: "escalation",
    title: `kiro-A is paused on ${task}`,
    context: "Attempts: 3",
    options: [
      { id: "fresh", label: "Start it again", consequences: "A fresh session." },
      { id: "release", label: "Leave the task unclaimed", consequences: "Nothing more starts." },
    ],
    recommended: { optionId: "release", reasoning: "Recoveries are used up." },
    source: { module: "agents", ref: key },
    key,
    blocks: [`agents:demo:task:${task}`],
  });
}

describe("a project's checks", () => {
  it("grade the modules, the watcher, holds, machines, the gate queue and the watched folders", async () => {
    const fake = new FakeClock();
    const root = tempDir("lair-supervisor-project-");
    const agentsDir = join(root, "agents");
    const queueDir = join(root, "gates", "queue");
    mkdirSync(agentsDir);
    mkdirSync(queueDir, { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(join(agentsDir, `kiro-${i}.log`), "x\n");
    const request = join(queueDir, "heavy.5.gate-a1.req");
    writeFileSync(request, "npm test\n");
    utimesSync(request, (T0 - 120 * MIN) / 1000, (T0 - 120 * MIN) / 1000);

    const config = projectConfig(root, {
      watchdog: { enabled: true, not_a_key: 1 },
      agents: { enabled: true },
      placement: {
        enabled: true,
        machines: { mac: { probe: ["probe-mac"], min_up_seconds: 0 }, builder: { probe: ["probe-builder"], min_up_seconds: 0 } },
        lanes: { heavy: { machine: "mac" }, remote: { machine: "builder" } },
      },
      supervisor: { checks: { retention: { warning_entries: 5, failing_entries: 10 }, infra_holds: { warning: 1, failing: 2 } } },
    });

    // The real modules the checks read
    const watchdogs = new WatchdogManager({ dbPath: ":memory:" });
    watchdogs.load([{ name: "demo", config }]);
    const runner = new ProbeRunner();
    runner.down.add("builder");
    const placements = new PlacementManager({ dbPath: ":memory:", probes: { runner, clock: fake, files: new NodeQueueFiles() } });
    placements.load([{ name: "demo", config }]);
    await placements.get("demo")!.tick();
    const agentsStore = new AgentsStore(":memory:");
    const decisionStore = new DecisionStore(":memory:");
    const inbox = new DecisionInbox({ store: decisionStore, secrets: new MemorySecretStore(), clock: fake });
    const watcher = new FileWatcherService(null as unknown as LairWebSocketServer, config);
    watcher.start();
    cleanups.push(async () => {
      await watcher.stop();
      await watchdogs.stop();
      await placements.stop();
      agentsStore.close();
      decisionStore.close();
    });

    // A hold whose run ended while Lair restarted, and one that failed for a reason of its own
    agentsStore.insertRun(run({ id: "run-1", task: "feat-x", detail: "exit unknown: Lair restarted while it ran" }));
    await raiseHold(inbox, "feat-x", "escalation:run-1:3");
    agentsStore.insertRun(run({ id: "run-2", task: "feat-y", detail: "crashed: exit code 1" }));
    await raiseHold(inbox, "feat-y", "escalation:run-2:3");

    const h = harness({
      supervisor: config.supervisor as Record<string, unknown>,
      sources: {
        watchers: () => watcher.watched(),
        modules: (project) => moduleReports({ watchdogs, placements }, project, config),
        agentsStore: () => agentsStore,
        agentsOn: () => true,
        agentDecisions: (project) => inbox.openOf(project, "agents"),
        placement: (project) => placements.status(project),
      },
    });
    h.configs.demo = config;
    h.fake.t = fake.t;
    const advance = async (ms: number) => {
      fake.t += ms;
      h.fake.t = fake.t;
      await h.supervisor.runNow();
    };

    await advance(11_000);
    expect(inProject(h, "module_errors")).toMatchObject({ status: "failing", values: { failed: "watchdog" } });
    expect(inProject(h, "module_errors")?.explanation).toBe("watchdog did not start: its config has errors.");
    // results/ doesn't exist yet: it is polled
    expect(inProject(h, "watcher_mode")).toMatchObject({ status: "warning", values: { polling: 1, polled: "results" } });
    expect(inProject(h, "infra_holds")).toMatchObject({ status: "warning", values: { holds: 2, infra: 1, restart: 1, transient: 0 } });
    expect(inProject(h, "infra_holds")?.explanation).toContain("a restart of Lair (1)");
    expect(inProject(h, "machines")).toMatchObject({ status: "warning", values: { machines: 2, down: 1, down_ids: "builder" } });
    expect(inProject(h, "gate_queue_age")).toMatchObject({ status: "warning", values: { queued: 1, oldest_minutes: 120, oldest_lane: "heavy" } });
    expect(inProject(h, "retention")).toMatchObject({ status: "warning", values: { largest_folder: "agents_dir", largest_entries: 6 } });
    // Nothing of a command's or a log's output is in a result
    expect(JSON.stringify(h.supervisor.diagnostics())).not.toContain("ssh: connect");
    // The watcher is done with (it would tell the dashboard about the files written below)
    await watcher.stop();

    // Worse: a second hold from a transient provider error, a machine down for long, an older request, a fuller folder
    agentsStore.insertRun(run({ id: "run-3", task: "feat-z", detail: "failed: provider error" }));
    agentsStore.addEvent({ project: "demo", kind: "transient", agent: "kiro-A", task: "feat-z", runId: "run-3", summary: "transient", evidence: [], data: {}, at: T0 });
    await raiseHold(inbox, "feat-z", "escalation:run-3:2");
    for (let i = 6; i < 12; i++) writeFileSync(join(agentsDir, `kiro-${i}.log`), "x\n");
    utimesSync(request, (T0 - 240 * MIN) / 1000, (T0 - 240 * MIN) / 1000);
    await advance(11 * MIN);
    expect(inProject(h, "infra_holds")).toMatchObject({ status: "failing", values: { infra: 2, transient: 1, restart: 1 } });
    expect(inProject(h, "machines")).toMatchObject({ status: "failing", values: { longest_down_minutes: 11 } });
    expect(inProject(h, "gate_queue_age")?.status).toBe("failing");
    expect(inProject(h, "retention")).toMatchObject({ status: "failing", values: { largest_entries: 12 } });

    // Fixed: the watchdog's config, the machine back, the queue taken
    await watchdogs.reloadProject({ name: "demo", config: { ...config, watchdog: { enabled: false } } });
    runner.down.delete("builder");
    await placements.get("demo")!.tick();
    rmSync(request);
    await advance(11_000);
    expect(inProject(h, "module_errors")).toMatchObject({ status: "ok", values: { failed: null } });
    expect(inProject(h, "machines")?.status).toBe("ok");
    expect(inProject(h, "gate_queue_age")).toMatchObject({ status: "ok", values: { queued: 0 } });
  });

  it("leave out a check that doesn't apply, and run nothing for a project whose checks are off", async () => {
    const root = tempDir("lair-supervisor-plain-");
    const h = harness({
      others: {
        plain: projectConfig(root, { gates_dir: join(root, "no-gates") }),
        quiet: projectConfig(root, { supervisor: { checks: { enabled: false } } }),
      },
    });
    await h.supervisor.runNow();
    const ids = h.supervisor
      .diagnostics("plain")
      .projects[0].checks.map((c) => c.id)
      .sort();
    // No modules or watcher source, no agents, no placement, no gate queue folder: only the folders it can count
    expect(ids).toEqual([]);
    mkdirSync(join(root, "agents"));
    await round(h);
    expect(h.supervisor.diagnostics("plain").projects[0].checks.map((c) => c.id)).toEqual(["retention"]);
    expect(h.supervisor.diagnostics("quiet").projects[0]).toMatchObject({ enabled: false, checks: [], lastRunAt: null });
  });
});

describe("a slow or failing measure", () => {
  it("is timed out, kept from the others, not started again while it runs, and measured again once it settles", async () => {
    const h = harness({ supervisor: { checks: { timeout_seconds: 1, disabled: ["store_size"] } } });
    let release: (files: OpenFiles) => void = () => undefined;
    h.measures.files = new Promise<OpenFiles>((resolve) => {
      release = resolve;
    });
    h.measures.delayThrows = true;

    const started = Date.now();
    await h.supervisor.runNow();
    // The round waited for the timeout, no longer
    expect(Date.now() - started).toBeLessThan(5000);
    expect(server(h, "open_files")).toMatchObject({ status: "unknown" });
    expect(server(h, "open_files")?.explanation).toContain("took longer than 1 s");
    expect(server(h, "event_loop_lag")?.status).toBe("unknown");
    expect(server(h, "event_loop_lag")?.explanation).toBe("Its measure failed (Error); it is tried again on the next round.");
    // The error's own words never reach the result
    expect(JSON.stringify(h.supervisor.diagnostics())).not.toContain("abc123secret");
    // The other checks answered
    expect(server(h, "disk_free")?.status).toBe("ok");
    expect(server(h, "command_timeouts")?.status).toBe("ok");

    // Still running: not started again
    await round(h);
    expect(server(h, "open_files")?.explanation).toContain("still running");

    // Settled: measured again
    release({ open: 10, limit: 100, source: "proc" });
    await new Promise((resolve) => setImmediate(resolve));
    h.measures.files = { open: 95, limit: 100, source: "proc" };
    h.measures.delayThrows = false;
    await round(h);
    expect(server(h, "open_files")).toMatchObject({ status: "failing", values: { open: 95 } });
    expect(server(h, "event_loop_lag")?.status).toBe("ok");
  });
});

describe("the schedule", () => {
  it("runs the checks every interval_seconds after a first delay, never on a read, and stops", async () => {
    vi.useFakeTimers({ now: T0 });
    const h = harness({ clock: { now: () => Date.now() }, supervisor: { checks: { interval_seconds: 30, disabled: ["store_size"] } } });
    expect(h.supervisor.start()).toEqual(["server", "demo"]);

    await vi.advanceTimersByTimeAsync(FIRST_ROUND_MS - TICK_MS);
    expect(h.measures.delayCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.measures.delayCalls).toBe(1);
    expect(server(h, "event_loop_lag")?.status).toBe("ok");

    // Reading the results runs nothing
    h.supervisor.diagnostics();
    expect(h.measures.delayCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.measures.delayCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.measures.delayCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.measures.delayCalls).toBe(3);

    await h.supervisor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.measures.delayCalls).toBe(3);
  });
});

describe("a failing check becomes a notice", () => {
  it("raised once after notice_minutes, withdrawn on recovery, not raised again within the cool-down or after Noted, kept across a restart", async () => {
    const h = harness({ inbox: true, supervisor: { checks: { notice_minutes: 5, notice_cooldown_minutes: 60, disabled: ["store_size"] } } });
    const inbox = h.inbox!;
    const at = async (minutes: number, s: Supervisor = h.supervisor) => {
      h.fake.t = T0 + minutes * MIN;
      await s.runNow();
    };
    const notices = () => inbox.list({ project: "demo", status: "all" }).filter((d) => d.source.module === "supervisor");
    const open = () => notices().filter((d) => d.status === "open");
    const bad = { p99Ms: 5000, maxMs: 6000, meanMs: 900 };
    const good = { p99Ms: 5, maxMs: 9, meanMs: 2 };

    h.measures.delay = bad;
    await at(0);
    expect(server(h, "event_loop_lag")).toMatchObject({ status: "failing", failingSince: new Date(T0).toISOString(), noticeId: null });
    await at(3);
    expect(notices()).toHaveLength(0);

    await at(5);
    expect(open()).toHaveLength(1);
    const first = open()[0];
    expect(first).toMatchObject({
      kind: "other",
      attention: "notice",
      key: "check:server:event_loop_lag",
      source: { module: "supervisor", ref: "server:event_loop_lag" },
      title: `Lair's self-check "Event-loop lag" is failing for Lair`,
    });
    expect(first.context).toContain("What to do:");
    expect(server(h, "event_loop_lag")?.noticeId).toBe(first.id);
    // For information: never counted, so never notified
    expect(inbox.counts("demo")).toMatchObject({ action: 0, notices: 1 });

    await at(6);
    expect(notices()).toHaveLength(1);

    // Recovered: withdrawn
    h.measures.delay = good;
    await at(7);
    expect(notices().map((d) => d.status)).toEqual(["withdrawn"]);
    expect(server(h, "event_loop_lag")).toMatchObject({ status: "ok", failingSince: null, noticeId: null });

    // Failing again within the cool-down: none
    h.measures.delay = bad;
    await at(8);
    await at(14);
    expect(open()).toHaveLength(0);
    // Past it, and failing for long enough: one again
    await at(68);
    expect(open()).toHaveLength(1);
    expect(notices()).toHaveLength(2);

    // Noted by the owner: not raised again until it recovers and fails again
    await inbox.answer(open()[0].id, { optionId: "noted" });
    await at(75);
    expect(open()).toHaveLength(0);
    h.measures.delay = good;
    await at(76);
    h.measures.delay = bad;
    await at(77);
    await at(82);
    expect(open()).toHaveLength(1);
    expect(notices()).toHaveLength(3);

    // A restart: the open notice is kept, not raised twice, and withdrawn once the check recovers
    const again = h.make();
    await at(83, again);
    expect(open()).toHaveLength(1);
    expect(server(h, "event_loop_lag", again)?.noticeId).toBe(open()[0].id);
    h.measures.delay = good;
    await at(84, again);
    expect(open()).toHaveLength(0);

    // Over HTTP nobody raises a notice in the supervisor's name
    await expect(
      inbox.raiseFromHttp({
        project: "demo",
        kind: "other",
        attention: "notice",
        title: "A notice in the supervisor's name",
        context: "From some script",
        options: [{ id: "noted", label: "Noted", consequences: "Nothing" }],
        recommended: { optionId: "noted", reasoning: "Nothing to choose" },
        source: { module: "supervisor", ref: "x" },
        key: "check:server:event_loop_lag",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("withdraws the notices of checks turned off", async () => {
    const h = harness({ inbox: true, supervisor: { checks: { notice_minutes: 1, disabled: ["store_size"] } } });
    h.measures.delay = { p99Ms: 5000, maxMs: 6000, meanMs: 900 };
    await h.supervisor.runNow();
    h.fake.t += 2 * MIN;
    await h.supervisor.runNow();
    expect(h.inbox!.openOf("demo", "supervisor")).toHaveLength(1);
    await h.supervisor.reloadProject({ name: "demo", config: projectConfig(h.root, { supervisor: { checks: { enabled: false } } }) });
    expect(h.inbox!.openOf("demo", "supervisor")).toHaveLength(0);
    expect(h.supervisor.diagnostics()).toMatchObject({ enabled: false, server: [] });
  });
});

describe("the OS measures", () => {
  it("read the open-files limit of /proc and the descriptors of lsof", () => {
    const limits = [
      "Limit                     Soft Limit           Hard Limit           Units",
      "Max processes             63421                63421                processes",
      "Max open files            1024                 524288               files",
    ].join("\n");
    expect(parseProcLimits(limits)).toBe(1024);
    expect(parseProcLimits("Max open files            unlimited            unlimited            files")).toBeNull();
    expect(parseProcLimits("")).toBeNull();
    const lsof = [
      "COMMAND PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    101 me    cwd    DIR    1,4      640    2 /work",
      "node    101 me    txt    REG    1,4        1    3 /usr/bin/node",
      "node    101 me      0u   CHR   16,1      0t0    4 /dev/ttys001",
      "node    101 me     12r   REG    1,4        9    5 /work/a.log",
      "node    101 me     13u  IPv4    0x1      0t0  TCP *:4777 (LISTEN)",
    ].join("\n");
    expect(countLsofDescriptors(lsof)).toBe(3);
  });

  it("measure this process: its open files, its event loop's delay, a disk's free space", async () => {
    const m = new SystemMeasures();
    cleanups.push(() => m.dispose());
    if (process.platform === "linux" || process.platform === "darwin") {
      const files = await m.openFiles();
      expect(files?.open).toBeGreaterThan(0);
    }
    expect(m.eventLoopDelay()).not.toBeNull();
    expect((await m.diskSpace(tmpdir()))?.totalBytes).toBeGreaterThan(0);
  });
});

describe("commands that time out", () => {
  it("are counted by the runners that time them out, and only those", async () => {
    const before = Date.now();
    const hang = [process.execPath, "-e", "setTimeout(() => {}, 5000)"];
    const probe = await new ExecFileRunner(200).run(hang);
    expect(probe.code).toBe(-1);
    const tool = await new SpawnToolRunner().run(hang, { timeoutMs: 200, maxBytes: 4096, env: { PATH: process.env.PATH ?? "" } });
    expect(tool.failure).toBe("timeout");
    // A command that ends by itself, or that prints too much, is no timeout
    await new ExecFileRunner(5000).run([process.execPath, "-e", "process.exit(3)"]);
    await new ExecFileRunner(5000).run([process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"], { maxBufferBytes: 16 });
    const noted = commandTimeouts()
      .since(before)
      .map((e) => [e.kind, e.program]);
    expect(noted).toEqual([
      ["probe", basename(process.execPath)],
      ["tool", basename(process.execPath)],
    ]);
  });
});
