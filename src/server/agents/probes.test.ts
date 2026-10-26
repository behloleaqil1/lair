/**
 * The real spawner, with real processes (the Node binary running a one-line
 * script), and the pid-plus-start-time liveness rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { agentEnvironment, ChildProcessSpawner, ProcessSnapshot } from "./probes.js";
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
});

describe("an agent's environment", () => {
  it("copies only the base names and env_passthrough from the server's, never a LAIR_* one", () => {
    const env = agentEnvironment(
      { PATH: "/usr/bin", HOME: "/home/user", LAIR_NODE_TOKEN: "t", LAIR_PROJECT: "p", SECRET: "s", KEY: "k" },
      ["KEY", "LAIR_PROJECT"],
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
