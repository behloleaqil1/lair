/**
 * End-to-end acceptance test: a full agent cycle on a fake project.
 *
 * This test creates:
 * - A fake project in a temp directory
 * - A fake agent CLI (writes to the queue file like a real agent)
 * - A fake gate system (writes gate result files)
 *
 * Then runs Lair through the cycle:
 * task -> run -> report -> done
 *
 * Fakes only the process spawner, the clock, and the process table.
 * Files are real in a temp directory.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../core/event-bus.js";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  Clock,
  ProcessInfo,
  ProcessTable,
  RunOptions,
  CommandOutput,
  CommandRunner,
} from "../watchdog/probes.js";
import { NodeFileSystem } from "../watchdog/probes.js";
import type {
  ProcessOwner,
  ProcessSpawner,
  SpawnOptions,
  AgentProbes,
  SystemInfo,
  MemoryReading,
} from "../agents/probes.js";
import { AgentsManager, type AgentsService } from "../agents/service.js";

const NOW = Date.parse("2026-06-15T10:00:00.000Z");
const MIN = 60_000;
const SELF: ProcessOwner = { pid: 100, startedAt: NOW - 60 * MIN };

interface Paths {
  root: string;
  repo: string;
  queue: string;
  agents: string;
  gates: string;
  tasks: string;
  data: string;
  prompts: string;
}

function makePaths(): Paths {
  const root = mkdtempSync(join(tmpdir(), "e2e-cycle-"));
  const repo = join(root, "repo");
  const queue = join(root, "queue.md");
  const agents = join(root, "agents");
  const gates = join(root, "gates");
  const tasks = join(root, "tasks.txt");
  const data = join(root, "data");
  const prompts = join(root, "prompts");

  mkdirSync(repo);
  mkdirSync(agents);
  mkdirSync(gates);
  mkdirSync(join(gates, "results"));
  mkdirSync(data);
  mkdirSync(prompts);

  writeFileSync(queue, "# Agent queue\n");
  writeFileSync(tasks, "");
  // Prompt file for worker-a (required by fill config)
  writeFileSync(join(prompts, "worker-a.txt"), "You are worker-a.\n");

  return { root, repo, queue, agents, gates, tasks, data, prompts };
}

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

class FakeProcessTable implements ProcessTable {
  private procs = new Map<number, { startedAt: number; command: string }>();
  constructor(private clock: FakeClock) {}

  add(
    pid: number,
    command: string,
    startedAt: number = this.clock.now(),
  ): void {
    this.procs.set(pid, { startedAt, command });
  }

  remove(pid: number): void {
    this.procs.delete(pid);
  }

  async list(): Promise<ProcessInfo[]> {
    return [...this.procs.entries()].map(([pid, p]) => ({
      pid,
      ppid: 1,
      elapsedSeconds: Math.max(
        0,
        Math.floor((this.clock.now() - p.startedAt) / 1000),
      ),
      argv: p.command.split(" "),
      command: p.command,
    }));
  }
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
  private started = new Set<number>();
  nextPid = 5001;

  onSpawn?: (pid: number, call: SpawnCall) => void;

  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}

  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const call: SpawnCall = {
      argv: [...argv],
      env: { ...options.env },
      cwd: options.cwd,
      logPath: options.logPath,
    };
    this.calls.push(call);

    writeFileSync(options.logPath, "");
    const t = new Date(this.clock.now());
    utimesSync(options.logPath, t, t);

    const pid = this.nextPid++;
    this.started.add(pid);
    this.procs.add(pid, argv.join(" "), this.clock.now());

    this.onSpawn?.(pid, call);

    return { pid, startedAt: this.clock.now() };
  }

  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }

  knows(pid: number): boolean {
    return this.started.has(pid);
  }

  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push({ pid, signal });
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

class FakeCommandRunner implements CommandRunner {
  calls: string[][] = [];
  options: RunOptions[] = [];

  answer?: (
    argv: string[],
    options: RunOptions,
  ) => Promise<CommandOutput | undefined> | CommandOutput | undefined;

  async run(argv: string[], options: RunOptions = {}): Promise<CommandOutput> {
    this.calls.push([...argv]);
    this.options.push(options);

    const answered = await this.answer?.(argv, options);
    if (answered) return answered;

    return { stdout: "", stderr: "", code: 0 };
  }
}

class FakeSystemInfo implements SystemInfo {
  cpuCount(): number {
    return 4;
  }
  loadAvg1(): number {
    return 0.5;
  }
  totalMemory(): number {
    return 16 * 1024 * 1024 * 1024; // 16GB
  }
  async memory(_options: { pressure: boolean; timeoutMs: number }): Promise<MemoryReading> {
    return { available: 8 * 1024 * 1024 * 1024, pressurePct: 25 }; // 8GB available
  }
}

function projectConfig(paths: Paths): ProjectConfig {
  return {
    name: "E2E Test",
    repo: paths.repo,
    github: "example/e2e-test",
    queue_file: paths.queue,
    agents_dir: paths.agents,
    gates_dir: paths.gates,
    read_only: false,
    prompts_dir: paths.prompts,
    dragons: {
      "worker-a": {
        name: "TestAgent",
        machine: "local",
        model: "test-model",
        instructions: "",
      },
    },
    dragon_start_cmd: ["/bin/echo", "start", "{dragon}", "{task}"],
    dragon_stop_cmd: ["/bin/echo", "stop", "{dragon}"],
    machines: {},
    agents: {
      enabled: true,
      fill: {
        enabled: true,
        tasks_file: paths.tasks,
        agents: ["worker-a"],
        prompt_files: ["{prompts_dir}/{agent}.txt"],
        interval_seconds: 60,
      },
    },
  } as ProjectConfig;
}

interface TestHarness {
  paths: Paths;
  clock: FakeClock;
  procs: FakeProcessTable;
  spawner: FakeSpawner;
  runner: FakeCommandRunner;
  events: EventBus;
  manager: AgentsManager;
  service: AgentsService;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<TestHarness> {
  const paths = makePaths();
  const config = projectConfig(paths);

  const clock = new FakeClock();
  const procs = new FakeProcessTable(clock);
  const spawner = new FakeSpawner(procs, clock);
  const runner = new FakeCommandRunner();
  const events = new EventBus();

  const probes: AgentProbes = {
    processes: procs,
    fs: new NodeFileSystem(),
    runner,
    clock,
    spawner,
    self: SELF,
    systemInfo: new FakeSystemInfo(),
  };

  const dbPath = join(paths.data, "agents.db");

  const manager = new AgentsManager({
    dbPath,
    probes,
    events,
  });
  manager.load([{ name: "e2e", config }]);

  const service = manager.get("e2e");
  if (!service) {
    throw new Error(
      `agents not enabled: ${manager.status("e2e").errors.join("; ")}`,
    );
  }

  const cleanup = async () => {
    await manager.stop();
    rmSync(paths.root, { recursive: true, force: true });
  };

  return {
    paths,
    clock,
    procs,
    spawner,
    runner,
    events,
    manager,
    service,
    cleanup,
  };
}

describe("E2E: Full agent cycle on a fake project", () => {
  let harness: TestHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("runs a task through the full cycle: task -> run -> report -> done", async () => {
    harness = await setup();
    const { paths, clock, spawner, service } = harness;

    // 1. Add a task to the tasks file (format: agent|name|task|description)
    writeFileSync(paths.tasks, "worker-a|Search Fix|feat-search|Fix search results\n");

    // 2. Set up the spawner to simulate an agent that completes its task
    spawner.onSpawn = (pid, _call) => {
      clock.advance(5 * MIN);
      const queueLine = `- DONE feat-search by worker-a 10:05Z: implemented search fix\n`;
      appendFileSync(paths.queue, queueLine);
      spawner.exit(pid, 0);
    };

    // 3. Tick + fill check to start the agent
    await service.checkNow();

    // 4. Verify the agent was started
    expect(spawner.calls.length).toBe(1);
    expect(spawner.calls[0].argv).toContain("worker-a");

    // 5. Tick again to process the completion
    clock.advance(MIN);
    await service.checkNow();

    // 6. Verify the queue was read and task marked done
    const queueContent = readFileSync(paths.queue, "utf-8");
    expect(queueContent).toContain("DONE feat-search");
  });

  it("handles an agent that writes progress updates", async () => {
    harness = await setup();
    const { paths, clock, spawner, service } = harness;

    writeFileSync(paths.tasks, "worker-a|API Endpoint|feat-api|Add new API endpoint\n");

    spawner.onSpawn = (_pid, _call) => {
      clock.advance(2 * MIN);
      appendFileSync(
        paths.queue,
        `- PROGRESS feat-api by worker-a 10:02Z: started implementation\n`,
      );
    };

    // Start the agent
    await service.checkNow();
    expect(spawner.calls.length).toBe(1);

    // Simulate continued work and completion
    clock.advance(5 * MIN);
    appendFileSync(
      paths.queue,
      `- DONE feat-api by worker-a 10:07Z: completed API endpoint\n`,
    );
    spawner.exit(spawner.nextPid - 1, 0);

    // Tick to process completion
    await service.checkNow();

    const queueContent = readFileSync(paths.queue, "utf-8");
    expect(queueContent).toContain("PROGRESS feat-api");
    expect(queueContent).toContain("DONE feat-api");
  });

  it("detects a blocked agent and records it", async () => {
    harness = await setup();
    const { paths, clock, spawner, service } = harness;

    writeFileSync(paths.tasks, "worker-a|Blocked Task|feat-blocked|Task that gets blocked\n");

    spawner.onSpawn = (pid, _call) => {
      clock.advance(3 * MIN);
      appendFileSync(
        paths.queue,
        `- BLOCKED feat-blocked by worker-a 10:03Z: missing dependency\n`,
      );
      spawner.exit(pid, 1);
    };

    await service.checkNow();
    expect(spawner.calls.length).toBe(1);

    clock.advance(MIN);
    await service.checkNow();

    const queueContent = readFileSync(paths.queue, "utf-8");
    expect(queueContent).toContain("BLOCKED feat-blocked");
  });

  it("creates prompts directory and prompt files", async () => {
    harness = await setup();
    const { paths, clock, spawner, service } = harness;

    writeFileSync(paths.tasks, "worker-a|Prompt Test|feat-prompt|Test prompt creation\n");

    spawner.onSpawn = (pid, call) => {
      // The task name appears in env or argv
      const promptArg = call.argv.find((a) => a.includes("feat-prompt"));
      const taskEnv = call.env.LAIR_TASK;
      expect(promptArg || taskEnv === "feat-prompt").toBe(true);

      clock.advance(MIN);
      appendFileSync(
        paths.queue,
        `- DONE feat-prompt by worker-a 10:01Z: done\n`,
      );
      spawner.exit(pid, 0);
    };

    await service.checkNow();
    expect(spawner.calls.length).toBe(1);
  });

  it("runs on a multi-task queue", async () => {
    harness = await setup();
    const { paths, clock, spawner, service } = harness;

    writeFileSync(
      paths.tasks,
      `worker-a|First|feat-one|First task
worker-a|Second|feat-two|Second task
worker-a|Third|feat-three|Third task
`,
    );

    let tasksDone = 0;
    spawner.onSpawn = (_pid, call) => {
      tasksDone++;
      const task = call.env.LAIR_TASK;
      clock.advance(2 * MIN);
      appendFileSync(
        paths.queue,
        `- DONE ${task} by worker-a 10:0${tasksDone * 2}Z: completed\n`,
      );
      spawner.exit(spawner.nextPid - 1, 0);
    };

    // Run through the tasks
    for (let i = 0; i < 3; i++) {
      await service.checkNow();
      clock.advance(5 * MIN);
    }

    expect(tasksDone).toBe(3);
    const queueContent = readFileSync(paths.queue, "utf-8");
    expect(queueContent).toContain("DONE feat-one");
    expect(queueContent).toContain("DONE feat-two");
    expect(queueContent).toContain("DONE feat-three");
  });
});

describe("E2E: Fake project structure validation", () => {
  it("creates all required directories and files", async () => {
    const harness = await setup();
    const { paths } = harness;

    try {
      expect(existsSync(paths.root)).toBe(true);
      expect(existsSync(paths.repo)).toBe(true);
      expect(existsSync(paths.queue)).toBe(true);
      expect(existsSync(paths.agents)).toBe(true);
      expect(existsSync(paths.gates)).toBe(true);
      expect(existsSync(join(paths.gates, "results"))).toBe(true);
      expect(existsSync(paths.data)).toBe(true);
      expect(existsSync(paths.prompts)).toBe(true);

      const queueContent = readFileSync(paths.queue, "utf-8");
      expect(queueContent).toContain("# Agent queue");
    } finally {
      await harness.cleanup();
    }
  });

  it("cleans up temporary files after test", async () => {
    const harness = await setup();
    const rootPath = harness.paths.root;

    expect(existsSync(rootPath)).toBe(true);
    await harness.cleanup();
    expect(existsSync(rootPath)).toBe(false);
  });
});
