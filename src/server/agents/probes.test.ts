/**
 * The real spawner, with real processes (the Node binary running a one-line
 * script), and the pid-plus-start-time liveness rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChildProcessSpawner, ProcessSnapshot } from "./probes.js";

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
    spawner.forget(owner.pid);
    expect(spawner.exitCode(owner.pid)).toBeUndefined();
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
