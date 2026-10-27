/**
 * A config reload of the agents module, through the production code: the
 * reloader as src/server/index.ts wires it, the real AgentsManager and
 * store, a real project file. Only the process table, the spawner and the
 * clock are fake. An agent running when its project's `agents:` block
 * changes keeps running: the new service re-adopts it by pid, as after a
 * restart, with no recovery and no second process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import { loadProjectConfig } from "../config.js";
import { AgentsManager, RECOVERY_KINDS } from "../agents/service.js";
import type { ProcessOwner, ProcessSpawner, SpawnOptions } from "../agents/probes.js";
import { NodeFileSystem, type Clock, type CommandOutput, type ProcessInfo, type ProcessTable } from "../watchdog/probes.js";
import { ConfigReloader, serverModules } from "./index.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const quiet = { log: () => undefined, warn: () => undefined };

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

/** Starts "agents" that keep running until killed. */
class FakeSpawner implements ProcessSpawner {
  spawned: { pid: number; argv: string[] }[] = [];
  kills: { pid: number; signal: string }[] = [];
  private started = new Set<number>();
  private nextPid = 5001;
  constructor(
    private procs: FakeProcessTable,
    private clock: FakeClock,
  ) {}
  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    appendFileSync(options.logPath, "working\n");
    const t = new Date(this.clock.now());
    utimesSync(options.logPath, t, t);
    this.started.add(pid);
    this.procs.procs.set(pid, { startedAt: this.clock.now(), command: argv.join(" ") });
    this.spawned.push({ pid, argv: [...argv] });
    return { pid, startedAt: this.clock.now() };
  }
  exitCode(): number | null | undefined {
    return undefined;
  }
  knows(pid: number): boolean {
    return this.started.has(pid);
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push({ pid, signal });
    this.procs.procs.delete(pid);
    return true;
  }
  forget(pid: number): void {
    this.started.delete(pid);
  }
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function waitFor(what: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("reloading the agents module", () => {
  it("re-adopts the running agent by pid: same process, no recovery, no second spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lair-agents-reload-"));
    const projects = join(root, "projects");
    mkdirSync(projects, { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "gates", "results"), { recursive: true });
    writeFileSync(join(root, "queue.md"), "# Queue\n");
    const file = join(projects, "demo.yaml");
    const write = (hungMinutes: number) =>
      writeFileSync(
        file,
        stringify({
          name: "Demo",
          repo: root,
          github: "example/demo",
          queue_file: join(root, "queue.md"),
          agents_dir: join(root, "agents"),
          gates_dir: join(root, "gates"),
          inbox_file: join(root, "inbox.md"),
          prompts_dir: join(root, "prompts"),
          machines: {},
          dragons: { "worker-a": { name: "A", model: "model-a", machine: "local", instructions: "", adapter: "test-cli" } },
          agent_adapters: {
            "test-cli": {
              id: "test-cli",
              name: "Test CLI",
              start_cmd: "agent-cli run --agent {agent_id} --model {model} --prompt {prompt_file}",
              stop_cmd: "kill -TERM {pid}",
              status_method: "file",
              log_dir: "logs",
            },
          },
          agents: { enabled: true, interval_seconds: 3600, hung_minutes: hungMinutes, stop_grace_seconds: 30 },
        }),
      );
    write(45);

    const clock = new FakeClock();
    const procs = new FakeProcessTable(clock);
    const spawner = new FakeSpawner(procs, clock);
    const manager = new AgentsManager({
      dbPath: join(root, "data", "agents.db"),
      probes: {
        processes: procs,
        fs: new NodeFileSystem(),
        runner: { run: async (): Promise<CommandOutput> => ({ code: 0, stdout: "", stderr: "" }) },
        clock,
        spawner,
        self: { pid: 100, startedAt: NOW - 3600_000 },
      },
    });
    const initial = [{ name: "demo", config: loadProjectConfig("demo", projects) }];
    manager.load(initial);
    manager.start();
    const reloader = new ConfigReloader({
      modules: serverModules({ agents: manager }),
      initial,
      projectsDir: projects,
      debounceMs: 150,
      cwd: root,
      log: quiet,
    });
    reloader.start();
    await reloader.ready();
    cleanup = async () => {
      await reloader.stop();
      await manager.stop();
      rmSync(root, { recursive: true, force: true });
    };

    const old = manager.get("demo")!;
    const run = await old.requestRun({ agent: "worker-a", task: "feat-login", prompt: "Build the login form" });
    await old.tick();
    const store = manager.getStore()!;
    expect(store.getRun(run.id)).toMatchObject({ state: "running", pid: 5001 });
    expect(spawner.spawned).toHaveLength(1);

    write(50);
    await waitFor("the agents reload", () => manager.get("demo") !== old);
    await reloader.settled();

    const next = manager.get("demo")!;
    expect(next.settings.hungMinutes).toBe(50);
    expect(next.running).toBe(true);
    expect(old.running).toBe(false);
    await next.tick();
    clock.t += 60_000;
    await next.tick();

    // The same process, still running and still owning its claim; nothing restarted or killed it
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.kills).toEqual([]);
    expect(procs.procs.has(5001)).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ state: "running", pid: 5001 });
    expect(store.listRuns("demo")).toHaveLength(1);
    expect(store.getClaim("demo", "feat-login")).toMatchObject({ runId: run.id, ownerPid: 5001 });
    expect(store.listEvents("demo", { kinds: RECOVERY_KINDS, limit: 50 })).toEqual([]);
    expect(manager.status("demo")).toMatchObject({ enabled: true, running: true, errors: [] });
  });
});
