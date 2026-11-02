/**
 * Asynchronous, bounded reads (issue #245): the helpers' bounds, and the
 * event loop staying responsive while the disk is slow.
 *
 * The slow disk is simulated at the fs layer: every synchronous fs or
 * child_process call busy-waits (it blocks the event loop, as a call on a
 * saturated disk does) and every fs/promises call waits on a timer (the
 * thread pool is slow, the loop is free). The watchdog's tick (through its
 * Watchdog, with the node file system) and the data service's route reads
 * then run over folders of 5,000 files while a 5 ms timer keeps firing: the
 * longest gap between two firings must stay under the budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const slow = vi.hoisted(() => ({ on: false, syncMs: 2, asyncMs: 2, syncCalls: 0, asyncCalls: 0 }));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const block =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (slow.on) {
        slow.syncCalls++;
        const end = Date.now() + slow.syncMs;
        while (Date.now() < end) {
          // a synchronous call on a saturated disk: the event loop waits
        }
      }
      return fn(...args);
    };
  const mocked = {
    ...real,
    readdirSync: block(real.readdirSync),
    opendirSync: block(real.opendirSync),
    statSync: block(real.statSync),
    lstatSync: block(real.lstatSync),
    existsSync: block(real.existsSync),
    readFileSync: block(real.readFileSync),
    openSync: block(real.openSync),
    readSync: block(real.readSync),
    fstatSync: block(real.fstatSync),
    appendFileSync: block(real.appendFileSync),
  } as typeof real;
  return { ...mocked, default: mocked };
});

vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const block =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (slow.on) {
        slow.syncCalls++;
        const end = Date.now() + slow.syncMs;
        while (Date.now() < end) {
          // a command waited for in-line
        }
      }
      return fn(...args);
    };
  const mocked = {
    ...real,
    execSync: block(real.execSync),
    execFileSync: block(real.execFileSync),
    spawnSync: block(real.spawnSync),
  } as typeof real;
  return { ...mocked, default: mocked };
});

vi.mock("fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs/promises")>();
  const delayed =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (slow.on) {
        slow.asyncCalls++;
        await new Promise((resolve) => setTimeout(resolve, slow.asyncMs));
      }
      return fn(...args);
    };
  const mocked = {
    ...real,
    open: delayed(real.open),
    opendir: delayed(real.opendir),
    stat: delayed(real.stat),
    lstat: delayed(real.lstat),
    appendFile: delayed(real.appendFile),
  } as typeof real;
  return { ...mocked, default: mocked };
});

import type { ProjectConfig } from "../../shared/types.js";
import { createWatchdog } from "../watchdog/service.js";
import { WatchdogStore } from "../watchdog/store.js";
import { NodeFileSystem, type CommandOutput, type ProcessInfo } from "../watchdog/probes.js";
import { listDir, mapLimit, readSmallFile, readTail, SingleFlight } from "./async-fs.js";
import { DataService } from "./data.js";

const FILES = 5000;
/** The longest the event loop may go without running a due timer */
const LAG_BUDGET_MS = 250;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lair-async-fs-"));
  slow.on = false;
  slow.syncCalls = 0;
  slow.asyncCalls = 0;
});

afterEach(() => {
  slow.on = false;
  rmSync(dir, { recursive: true, force: true });
});

/** Run `work` with the slow disk on and a 5 ms timer firing; the longest gap between firings, and the result. */
async function withSlowDisk<T>(work: () => Promise<T>): Promise<{ result: T; maxGapMs: number; fired: number }> {
  let last = Date.now();
  let maxGapMs = 0;
  let fired = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    fired++;
  }, 5);
  slow.on = true;
  try {
    const result = await work();
    maxGapMs = Math.max(maxGapMs, Date.now() - last);
    return { result, maxGapMs, fired };
  } finally {
    slow.on = false;
    clearInterval(timer);
  }
}

/** A project with FILES agent logs, FILES gate results and their logs, all written an hour ago */
function bigProject(): ProjectConfig {
  const agents = join(dir, "agents");
  const results = join(dir, "gates", "results");
  mkdirSync(agents, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(join(dir, "gates", "queue"), { recursive: true });
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  writeFileSync(join(agents, "dragons.txt"), "worker-a|Worker A|task-1\n");
  for (let i = 0; i < FILES; i++) {
    const stamp = `20261101T${String(Math.floor(i / 3600) % 24).padStart(2, "0")}${String(Math.floor(i / 60) % 60).padStart(2, "0")}${String(i % 60).padStart(2, "0")}Z`;
    const log = join(agents, `worker-a-${stamp}-${i}.log`);
    writeFileSync(log, `line ${i}\n`);
    utimesSync(log, hourAgo, hourAgo);
    const id = `bt-20261101-${String(i).padStart(5, "0")}`;
    writeFileSync(join(results, `${id}.rc`), "0\n");
    writeFileSync(join(results, `${id}.log`), "ok\n");
    utimesSync(join(results, `${id}.rc`), hourAgo, hourAgo);
  }
  writeFileSync(join(dir, "queue.md"), "- TICK orchestrator all quiet\n");
  return {
    name: "demo",
    repo: dir,
    github: "",
    queue_file: join(dir, "queue.md"),
    agents_dir: agents,
    gates_dir: join(dir, "gates"),
    machines: { local: { name: "Local", type: "local" } },
    dragons: { "worker-a": { name: "A", model: "m", machine: "local", instructions: "" } },
    watchdog: { enabled: true, agent_command: "agent-cli --agent {agent}", hung_minutes: 30 },
  } as unknown as ProjectConfig;
}

describe("the event loop on a slow disk (issue #245)", () => {
  it("keeps a timer firing through a watchdog tick over 5,000 logs and results, and still finds the hung agent", async () => {
    const config = bigProject();
    const store = new WatchdogStore(":memory:");
    // worker-a runs for two hours; its newest log was written an hour ago: hung (limit 30 min)
    const proc: ProcessInfo = { pid: 4242, ppid: 1, elapsedSeconds: 7200, command: "agent-cli --agent worker-a", argv: ["agent-cli", "--agent", "worker-a"] };
    const wd = createWatchdog({
      project: "demo",
      config,
      store,
      probes: {
        processes: { list: async () => [proc] },
        fs: new NodeFileSystem(),
        runner: { run: async (): Promise<CommandOutput> => ({ code: 0, stdout: "", stderr: "" }) },
        clock: { now: () => Date.now(), sleep: async () => {} },
      },
    });
    try {
      const { result, maxGapMs, fired } = await withSlowDisk(() => wd.tick());
      expect(slow.syncCalls, "a synchronous fs or child_process call ran on the tick").toBe(0);
      expect(slow.asyncCalls).toBeGreaterThan(FILES);
      expect(maxGapMs).toBeLessThan(LAG_BUDGET_MS);
      expect(fired).toBeGreaterThan(10);
      expect(result.findings).toBe(1);
      expect(store.openBreaches("demo").map((b) => b.detector)).toEqual(["agent_hung"]);
    } finally {
      await wd.stop();
      store.close();
    }
  }, 120_000);

  it("keeps a timer firing through the overview, dragons and gate-results reads over 5,000 files, with the same answers", async () => {
    const config = bigProject();
    const service = new DataService(config);
    const { result, maxGapMs } = await withSlowDisk(async () => {
      const [overview, dragons, recent] = await Promise.all([service.getOverview(), service.getDragons(), service.getRecentGateResults(24)]);
      return { overview, dragons, recent };
    });
    expect(slow.syncCalls, "a synchronous fs or child_process call ran on a route read").toBe(0);
    expect(maxGapMs).toBeLessThan(LAG_BUDGET_MS);
    expect(result.dragons.map((d) => d.id)).toEqual(["worker-a"]);
    expect(result.dragons[0].lastLogLine).toBeDefined();
    expect(result.dragons[0].lastLogTime).toBeDefined();
    expect(result.recent).toHaveLength(100);
    expect(result.recent.every((r) => r.rc === 0)).toBe(true);
    expect(result.overview.agentCounts).toEqual({ running: 0, idle: 1 });
  }, 120_000);
});

describe("bounded async reads", () => {
  it("readTail reads only the last bytes of a regular file, and nothing of a folder or a missing path", async () => {
    const file = join(dir, "log.txt");
    writeFileSync(file, "a".repeat(1000) + "END");
    const read = await readTail(file, 3);
    expect(read).toMatchObject({ text: "END", size: 1003, partial: true });
    expect((await readTail(file, 10_000))?.partial).toBe(false);
    expect(await readTail(dir, 10)).toBeNull();
    expect(await readTail(join(dir, "missing"), 10)).toBeNull();
  });

  it("readSmallFile refuses a file over its cap instead of reading part of it", async () => {
    const file = join(dir, "pid");
    writeFileSync(file, "1234\n");
    expect(await readSmallFile(file, 5)).toBe("1234\n");
    expect(await readSmallFile(file, 4)).toBeNull();
  });

  it("listDir stops at its cap and answers [] for a missing folder", async () => {
    for (let i = 0; i < 1200; i++) writeFileSync(join(dir, `f${i}`), "");
    expect(await listDir(dir)).toHaveLength(1200);
    expect(await listDir(dir, 700)).toHaveLength(700);
    expect(await listDir(join(dir, "missing"))).toEqual([]);
  });

  it("SingleFlight shares a read in flight and starts a new one once it settled", async () => {
    const flight = new SingleFlight<number>();
    let reads = 0;
    const read = async () => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return reads;
    };
    const [a, b] = await Promise.all([flight.run("k", read), flight.run("k", read)]);
    expect([a, b, reads]).toEqual([1, 1, 1]);
    expect(await flight.run("k", read)).toBe(2);
  });

  it("mapLimit keeps the order and never runs more than its limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
