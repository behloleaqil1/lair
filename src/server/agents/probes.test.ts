/**
 * The real spawner, with real processes (the Node binary running a one-line
 * script), and the pid-plus-start-time liveness rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { agentEnvironment, ChildProcessSpawner, NodeSystemInfo, ProcessSnapshot, type SystemInfoDeps } from "./probes.js";
import type { CommandOutput, CommandRunner, RunOptions } from "../watchdog/probes.js";
import { AgentsManager } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-spawn-"));
  dirs.push(dir);
  return join(dir, "logs", "worker-a.log");
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

describe("ChildProcessSpawner", () => {
  it("starts a process without a shell, appends its output to the log, and reports its exit code", async () => {
    const spawner = new ChildProcessSpawner();
    const log = logPath();
    const owner = await spawner.spawn(
      [process.execPath, "-e", "console.log('hello ' + process.env.LAIR_TASK); console.error('$HOME stays literal'); process.exit(3)"],
      { env: { LAIR_TASK: "feat-login" }, logPath: log },
    );
    expect(owner.pid).toBeGreaterThan(0);
    expect(Math.abs(owner.startedAt - Date.now())).toBeLessThan(5000);

    await until(() => spawner.exitCode(owner.pid) !== undefined);
    expect(spawner.exitCode(owner.pid)).toBe(3);
    await until(() => readFileSync(log, "utf-8").includes("literal"));
    expect(readFileSync(log, "utf-8")).toContain("hello feat-login\n");
    expect(readFileSync(log, "utf-8")).toContain("$HOME stays literal\n");
    expect(spawner.knows(owner.pid)).toBe(true);
    spawner.forget(owner.pid);
    expect(spawner.exitCode(owner.pid)).toBeUndefined();
    expect(spawner.knows(owner.pid)).toBe(false);
  });

  it("rejects a command that can't start", async () => {
    const spawner = new ChildProcessSpawner();
    await expect(spawner.spawn([join(tmpdir(), "no-such-agent-cli")], { env: {}, logPath: logPath() })).rejects.toThrow(
      /ENOENT/,
    );
    await expect(spawner.spawn([], { env: {}, logPath: logPath() })).rejects.toThrow("empty command");
  });

  it("stops a process with a signal (its exit code is then null)", async () => {
    const spawner = new ChildProcessSpawner();
    const owner = await spawner.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      env: {},
      logPath: logPath(),
    });
    expect(spawner.exitCode(owner.pid)).toBeUndefined();
    expect(spawner.kill(owner.pid, "SIGTERM")).toBe(true);
    await until(() => spawner.exitCode(owner.pid) !== undefined);
    expect(spawner.exitCode(owner.pid)).toBeNull();
  });
});

describe("ProcessSnapshot", () => {
  const now = Date.parse("2026-03-02T12:00:00.000Z");
  const self = { pid: 100, startedAt: now - 3_600_000 };
  const proc = (pid: number, elapsedSeconds: number) => ({ pid, ppid: 1, elapsedSeconds, argv: ["x"], command: "x" });

  it("an owner is alive only while its pid runs with the same start time", () => {
    const snap = new ProcessSnapshot([proc(4242, 600)], now, self, 5);
    expect(snap.isAlive(4242, now - 600_000)).toBe(true);
    expect(snap.isAlive(4242, now - 603_000)).toBe(true); // within the tolerance
    expect(snap.isAlive(4242, now - 3_600_000)).toBe(false); // the pid was reused
    expect(snap.describe(4242, now - 3_600_000)).toContain("is a different process now");
    expect(snap.isAlive(4343)).toBe(false);
    expect(snap.isAlive(self.pid, self.startedAt)).toBe(true); // this server, also when ps doesn't list it
    snap.addSpawned({ pid: 5001, startedAt: now });
    expect(snap.isAlive(5001, now)).toBe(true);
  });

  it("counts start times back from when the reading was taken, and allows for the time ps took", () => {
    // Taken 20 s ago, when 4242 had run 600 s: it started 620 s ago
    const old = new ProcessSnapshot([proc(4242, 600)], now - 20_000, self, 5);
    expect(old.startedAt(4242)).toBe(now - 620_000);
    expect(old.isAlive(4242, now - 620_000)).toBe(true);
    expect(old.isAlive(4242, now - 600_000)).toBe(false); // 20 s later: not that process
    // ps took 10 s: the elapsed times were read up to 10 s before it answered, so the start may be that much earlier
    const slow = new ProcessSnapshot([proc(4242, 600)], now, self, 5, 10_000);
    expect(slow.isAlive(4242, now - 610_000)).toBe(true);
    expect(slow.isAlive(4242, now - 618_000)).toBe(false);
    expect(slow.isAlive(4242, now - 590_000)).toBe(false); // never later than the reading allows
  });
});

describe("an agent's environment", () => {
  it("copies only the base names and env_passthrough from the server's, never a LAIR_* one", () => {
    const env = agentEnvironment(
      { PATH: "/usr/bin", HOME: "/home/user", LAIR_NODE_TOKEN: "t", LAIR_PROJECT: "p", lair_node_token: "t", SECRET: "s", KEY: "k" },
      ["KEY", "LAIR_PROJECT", "lair_node_token", "Lair_Node_Token"],
      { LAIR_RUN_ID: "r" },
    );
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user", KEY: "k", LAIR_RUN_ID: "r" });
  });

  it("is built, not inherited: a real agent never sees the server's secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-env-"));
    dirs.push(dir);
    const planted: Record<string, string> = {
      LAIR_NODE_TOKEN: "node-token-planted-for-this-test",
      EXAMPLE_SERVER_SECRET: "server-secret-planted-for-this-test",
      EXAMPLE_PROVIDER_KEY: "provider-key-planted-for-this-test",
    };
    const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(dir, "queue.md"), "# Queue\n");
    const config = {
      name: "Demo",
      repo: dir,
      github: "example/demo",
      queue_file: join(dir, "queue.md"),
      agents_dir: agentsDir,
      gates_dir: join(dir, "gates"),
      machines: {},
      prompts_dir: join(dir, "prompts"),
      dragons: { "worker-a": { name: "A", model: "model-a", machine: "local", instructions: "", adapter: "env-cli" } },
      agent_adapters: {
        "env-cli": {
          id: "env-cli",
          name: "Env CLI",
          // The agent prints the names of its environment variables
          start_cmd: `"${process.execPath}" -e "console.log(JSON.stringify(Object.keys(process.env).sort()))"`,
          stop_cmd: "kill -TERM {pid}",
          status_method: "file",
          log_dir: "logs",
          session_id_env: "ENV_CLI_SESSION",
        },
      },
      agents: { enabled: true, env_passthrough: ["EXAMPLE_PROVIDER_KEY"] },
    } as ProjectConfig;
    // The real probes: ps, the real spawner, the system clock
    const manager = new AgentsManager({ dbPath: join(dir, "agents.db") });
    try {
      manager.load([{ name: "demo", config }]);
      const service = manager.get("demo");
      if (!service) throw new Error(manager.status("demo").errors.join("; "));
      await service.requestRun({ agent: "worker-a", task: "env-check", prompt: "print the environment" });
      await service.tick();
      const log = service.runs()[0].logPath ?? "";
      await until(() => existsSync(log) && readFileSync(log, "utf-8").includes("]"));

      const keys = JSON.parse(readFileSync(log, "utf-8").trim().split("\n").pop() ?? "[]") as string[];
      expect(keys).not.toContain("LAIR_NODE_TOKEN");
      expect(keys).not.toContain("EXAMPLE_SERVER_SECRET");
      expect(keys).toContain("EXAMPLE_PROVIDER_KEY");
      expect(keys).toContain("PATH");
      expect(keys).toContain("ENV_CLI_SESSION");
      expect(keys.filter((name) => name.startsWith("LAIR_"))).toEqual([
        "LAIR_AGENT",
        "LAIR_RUN_ID",
        "LAIR_SESSION_ID",
        "LAIR_SESSION_MODE",
        "LAIR_TASK",
      ]);
    } finally {
      await manager.stop();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             5000.
Pages inactive:                           3000.
Pages speculative:                         200.
Pages purgeable:                           800.
`;

/** Answers argv[0] from a table; counts calls and keeps the options. */
class TableRunner implements CommandRunner {
  calls: Array<{ argv: string[]; options?: RunOptions }> = [];
  constructor(private answers: Record<string, CommandOutput | Error>) {}
  async run(argv: string[], options?: RunOptions): Promise<CommandOutput> {
    this.calls.push({ argv, options });
    const answer = this.answers[argv[0]] ?? { code: 127, stdout: "", stderr: "" };
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function machine(platform: NodeJS.Platform, runner: CommandRunner, files: Record<string, string> = {}): NodeSystemInfo {
  const deps: SystemInfoDeps = {
    platform,
    runner,
    readText: async (path) => {
      if (path in files) return files[path];
      throw new Error(`ENOENT ${path}`);
    },
    freemem: () => 123,
  };
  return new NodeSystemInfo(deps);
}

describe("NodeSystemInfo available memory and pressure", () => {
  it("on macOS counts free, inactive, speculative and purgeable pages from vm_stat, not os.freemem()", async () => {
    const runner = new TableRunner({ vm_stat: { code: 0, stdout: VM_STAT, stderr: "" } });
    const reading = await machine("darwin", runner).memory({ pressure: false, timeoutMs: 1234 });
    expect(reading.available).toBe((1000 + 3000 + 200 + 800) * 16384);
    expect(reading.pressurePct).toBeUndefined();
    // No shell, bounded by the timeout, and sysctl is not run when pressure is not wanted
    expect(runner.calls).toEqual([{ argv: ["vm_stat"], options: { timeoutMs: 1234 } }]);
  });

  it("on macOS reads pressure as 100 minus kern.memorystatus_level", async () => {
    const runner = new TableRunner({
      vm_stat: { code: 0, stdout: VM_STAT, stderr: "" },
      sysctl: { code: 0, stdout: "72\n", stderr: "" },
    });
    const reading = await machine("darwin", runner).memory({ pressure: true, timeoutMs: 1000 });
    expect(reading.pressurePct).toBe(28);
    expect(runner.calls.map((c) => c.argv)).toEqual([["vm_stat"], ["sysctl", "-n", "kern.memorystatus_level"]]);
  });

  it("on macOS a failed, throwing or unparsable read is NaN, never a number", async () => {
    const failed = await machine("darwin", new TableRunner({ vm_stat: { code: 1, stdout: VM_STAT, stderr: "" } })).memory({ pressure: false, timeoutMs: 10 });
    expect(failed.available).toBeNaN();
    const threw = await machine("darwin", new TableRunner({ vm_stat: new Error("timed out") })).memory({ pressure: false, timeoutMs: 10 });
    expect(threw.available).toBeNaN();
    const junk = await machine(
      "darwin",
      new TableRunner({ vm_stat: { code: 0, stdout: "nonsense", stderr: "" }, sysctl: { code: 0, stdout: "lots", stderr: "" } }),
    ).memory({ pressure: true, timeoutMs: 10 });
    expect(junk.available).toBeNaN();
    expect(junk.pressurePct).toBeNaN();
  });

  it("on Linux uses os.freemem() (MemAvailable) and reads pressure from /proc/pressure/memory without a command", async () => {
    const runner = new TableRunner({});
    const info = machine("linux", runner, {
      "/proc/pressure/memory": "some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=9\n",
    });
    expect(await info.memory({ pressure: true, timeoutMs: 10 })).toEqual({ available: 123, pressurePct: 12.5 });
    expect(await info.memory({ pressure: false, timeoutMs: 10 })).toEqual({ available: 123 });
    expect(runner.calls).toEqual([]);
  });

  it("on Linux an unreadable pressure file is NaN", async () => {
    const reading = await machine("linux", new TableRunner({})).memory({ pressure: true, timeoutMs: 10 });
    expect(reading.available).toBe(123);
    expect(reading.pressurePct).toBeNaN();
  });
});
