/**
 * The infra monitor's system contact, against the real system: the runner
 * runs real programs, the queue is real files, liveness is real processes,
 * the ledger is a real file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { RequeueLedger } from "./ledger.js";
import { MAX_OUTPUT_CHARS, SpawnRunner, groupAlive, parsePid, pidAlive, readQueue, readRunnerPids } from "./probes.js";
import type { RequeueRecord } from "./types.js";

vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
const children: ChildProcess[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "infra-probes-"));
  dirs.push(dir);
  return dir;
}

function node(script: string): string[] {
  return [process.execPath, "-e", script];
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SpawnRunner", () => {
  const runner = new SpawnRunner();

  it("runs an argv without a shell and returns its exit code and output", async () => {
    const out = await runner.run(node("process.exit(3)"), { timeoutMs: 5000 });
    expect(out).toEqual({ code: 3, stdout: "", stderr: "", timedOut: false });
    const echo = await runner.run([process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(touch /tmp/x); `id`"], { timeoutMs: 5000 });
    expect(echo.stdout).toBe("$(touch /tmp/x); `id`");
  });

  it("a command that prints and then hangs is a failure at the deadline, not a success", async () => {
    const started = Date.now();
    const out = await runner.run(node("process.stdout.write('ok'); setInterval(() => {}, 1000)"), { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toMatchObject({ code: -1, timedOut: true, stdout: "ok" });
    expect(out.stderr).toContain("timed out after 500 ms");
  });

  it("the deadline kills the whole process group, and settles even when a grandchild keeps the pipe open", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "grandchild.pid");
    const script = `
      const { spawn } = require("child_process");
      const g = spawn("sleep", ["300"], { stdio: "inherit" });
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      process.exit(0);
    `;
    const started = Date.now();
    const out = await runner.run(node(script), { timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.timedOut).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    // Gone, or a zombie its new parent has not reaped yet: not running either way
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(grandchild)]).stdout.toString().trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("an abort kills the command at once; an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    const run = runner.run(["sleep", "300"], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    expect(await run).toMatchObject({ code: -1, stderr: "aborted", timedOut: false });
    expect(Date.now() - started).toBeLessThan(2000);
    const dir = tempDir();
    const marker = join(dir, "ran");
    expect(await runner.run(["touch", marker], { timeoutMs: 1000, signal: controller.signal })).toMatchObject({ code: -1, stderr: "aborted" });
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps at most MAX_OUTPUT_CHARS of output", async () => {
    const out = await runner.run(node("process.stdout.write('x'.repeat(300000))"), { timeoutMs: 5000 });
    expect(out.code).toBe(0);
    expect(out.stdout.length).toBe(MAX_OUTPUT_CHARS);
  });

  it("a program that does not exist answers -1, not a timeout", async () => {
    const out = await runner.run(["/nonexistent/probe"], { timeoutMs: 5000 });
    expect(out.code).toBe(-1);
    expect(out.timedOut).toBe(false);
    expect(out.stderr).toContain("ENOENT");
  });
});

describe("processes", () => {
  it("a live process and its group are alive; once it exits they are not", async () => {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    children.push(child);
    const pid = child.pid as number;
    expect(pidAlive(pid)).toBe(true);
    expect(groupAlive(pid)).toBe(true);
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(pidAlive(pid)).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  });

  it("never asks about pid or group 0 or 1, or a negative number", () => {
    for (const n of [0, 1, -1, Number.NaN]) {
      expect(pidAlive(n)).toBe(false);
      expect(groupAlive(n)).toBe(false);
    }
  });

  it("parsePid reads the first number of a pid file and refuses the rest", () => {
    expect(parsePid("4508\n")).toBe(4508);
    expect(parsePid(" 10059")).toBe(10059);
    expect(parsePid("0")).toBeNull();
    expect(parsePid("1")).toBeNull();
    expect(parsePid("login-fix-600")).toBeNull();
    expect(parsePid("600-track")).toBeNull();
    expect(parsePid(null)).toBeNull();
  });
});

describe("readQueue", () => {
  function gates(): { dir: string; queue: string } {
    const dir = tempDir();
    const queue = join(dir, "queue");
    mkdirSync(queue);
    return { dir, queue };
  }

  it("reads the queued and running requests of the given lanes, and each running one's process group", async () => {
    const { dir, queue } = gates();
    const id = "20261031T123256Z-login-fix-600-eafa931b-9040";
    writeFileSync(join(queue, `light.5.${id}.req.run`), "login-fix-600\neafa931b\nwork/bin/gate.sh backend {WT}\n");
    writeFileSync(join(queue, `light.5.${id}.pgid`), "10059\n");
    writeFileSync(join(queue, "light.5.20261031T124522Z-trial-4-de189d60-56587.req"), "x\n");
    writeFileSync(join(queue, "light.5.20261031T041530Z-trial-4-41b508ff-59267.req.cancelled"), "x\n");
    writeFileSync(join(queue, "heavy.1.20261031T041530Z-other-41b508ff-1.req"), "x\n");
    writeFileSync(join(queue, ".20261029T023210Z-other-track-7c0615ba-63311.tmp"), "x\n");
    writeFileSync(join(queue, "lane4.log"), "x\n");
    const jobs = await readQueue(dir, new Set(["light"]));
    expect(jobs.map((j) => [j.lane, j.id, j.status, j.pgid]).sort()).toEqual([
      ["light", id, "running", 10059],
      ["light", "20261031T124522Z-trial-4-de189d60-56587", "queued", null],
    ]);
    expect(jobs.every((j) => j.ctimeMs > 0 && j.mtimeMs > 0)).toBe(true);
  });

  it("never reads through a symbolic link, and a FIFO in place of a .pgid file can't hang it", async () => {
    const { dir, queue } = gates();
    const outside = join(dir, "outside");
    writeFileSync(outside, "4242\n");
    symlinkSync(outside, join(queue, "light.5.20261031T000000Z-a-abc-1.req.run"));
    writeFileSync(join(queue, "light.5.20261031T000000Z-b-abc-2.req.run"), "x\n");
    symlinkSync(outside, join(queue, "light.5.20261031T000000Z-b-abc-2.pgid"));
    writeFileSync(join(queue, "light.5.20261031T000000Z-c-abc-3.req.run"), "x\n");
    expect(spawnSync("mkfifo", [join(queue, "light.5.20261031T000000Z-c-abc-3.pgid")]).status).toBe(0);
    const jobs = await readQueue(dir, new Set(["light"]));
    expect(jobs.map((j) => [j.id, j.pgid]).sort()).toEqual([
      ["20261031T000000Z-b-abc-2", null],
      ["20261031T000000Z-c-abc-3", null],
    ]);
  });

  it("throws when the queue directory can't be listed (a queue it can't read is not a healthy one)", async () => {
    await expect(readQueue(join(tempDir(), "missing"), new Set(["light"]))).rejects.toThrow();
  });

  it("reads runner pid files from the gates directory", async () => {
    const { dir } = gates();
    writeFileSync(join(dir, "runner-remote.pid"), "4473\n");
    writeFileSync(join(dir, "runner-remote2.pid"), "garbage\n");
    expect(await readRunnerPids(dir, ["runner-remote.pid", "runner-remote2.pid", "runner-remote3.pid"])).toEqual([
      { file: "runner-remote.pid", pid: 4473 },
      { file: "runner-remote2.pid", pid: null },
      { file: "runner-remote3.pid", pid: null },
    ]);
  });
});

describe("the event loop (Lair #245)", () => {
  it("no source of the module calls a synchronous fs or child-process function", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toContain("service.ts");
    for (const file of sources) {
      const code = readFileSync(join(here, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/\b\w+Sync\s*\(/);
      expect(code, file).not.toMatch(/from "fs";|from "node:fs";/);
    }
  });
});

describe("RequeueLedger", () => {
  const record = (over: Partial<RequeueRecord> = {}): RequeueRecord => ({
    project: "demo",
    id: "g1",
    from: "remote",
    to: "heavy",
    attempts: 1,
    status: "moved",
    lastAttemptAt: Date.now(),
    nextAttemptAt: null,
    lastError: null,
    argv: ["requeue", "g1"],
    ...over,
  });

  it("keeps records across a restart; one started and never finished reads as a failed attempt", async () => {
    const path = join(tempDir(), "data", "ledger.json");
    const first = new RequeueLedger(path);
    await first.load();
    await first.put(record(), Date.now());
    await first.put(record({ id: "g2", status: "running", nextAttemptAt: Date.now() + 300_000 }), Date.now());
    const second = new RequeueLedger(path);
    await second.load();
    expect(second.error).toBeNull();
    expect(second.get("demo", "g1")).toMatchObject({ status: "moved" });
    expect(second.get("demo", "g2")).toMatchObject({ status: "failed", lastError: "interrupted by a restart", attempts: 1 });
    expect(second.get("other", "g1")).toBeNull();
  });

  it("a file it can't parse is an error and is never overwritten", async () => {
    const dir = tempDir();
    const path = join(dir, "ledger.json");
    writeFileSync(path, JSON.stringify({ format: 99, records: [] }));
    const ledger = new RequeueLedger(path);
    await ledger.load();
    expect(ledger.error).toContain("not valid");
    await expect(ledger.put(record(), Date.now())).rejects.toThrow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ format: 99, records: [] });
  });

  it("drops records older than 14 days on write", async () => {
    const path = join(tempDir(), "ledger.json");
    const ledger = new RequeueLedger(path);
    await ledger.load();
    const now = Date.now();
    await ledger.put(record({ id: "old", lastAttemptAt: now - 15 * 86_400_000 }), now);
    await ledger.put(record({ id: "new" }), now);
    expect(JSON.parse(readFileSync(path, "utf8")).records.map((r: RequeueRecord) => r.id)).toEqual(["new"]);
  });
});
