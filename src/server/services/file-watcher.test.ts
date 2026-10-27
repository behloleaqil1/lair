import { afterEach, describe, it, expect } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { DragonUpdateData, GateUpdateData, LairWebSocketServer } from "../websocket.js";
import { FileWatcherService, dragonIdFromLogFile } from "./file-watcher.js";

describe("dragonIdFromLogFile", () => {
  it("reads kiro IDs with and without a timestamp", () => {
    expect(dragonIdFromLogFile("kiro-A-20261025T123456Z.log")).toBe("kiro-A");
    expect(dragonIdFromLogFile("kiro-A.log")).toBe("kiro-A");
  });

  it("reads generic agent IDs", () => {
    expect(dragonIdFromLogFile("aider-1-20260101T000000Z.log")).toBe("aider-1");
    expect(dragonIdFromLogFile("worker_b.log")).toBe("worker_b");
  });

  it("ignores files that aren't dragon logs", () => {
    expect(dragonIdFromLogFile("dragons.txt")).toBeNull();
    expect(dragonIdFromLogFile(".hidden.log")).toBeNull();
    expect(dragonIdFromLogFile("1-run.log")).toBeNull();
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** The process's descriptors: /proc/self/fd on Linux, /dev/fd on macOS (null elsewhere) */
const FD_DIR =
  ["/proc/self/fd", "/dev/fd"].find((dir) => {
    try {
      readdirSync(dir);
      return true;
    } catch {
      return false;
    }
  }) ?? null;

function descriptorCount(): number | null {
  return FD_DIR ? readdirSync(FD_DIR).length : null;
}

/** Linux: the descriptors open on a path under `root` ([] where they can't be listed) */
function descriptorsUnder(root: string): string[] {
  if (FD_DIR !== "/proc/self/fd") return [];
  const real = realpathSync(root);
  const open: string[] = [];
  for (const fd of readdirSync(FD_DIR)) {
    try {
      const target = readlinkSync(join(FD_DIR, fd));
      if (target.startsWith(real)) open.push(target);
    } catch {
      // Closed meanwhile
    }
  }
  return open;
}

/** Linux: the process's inotify watches (one per watched path), or null elsewhere */
function inotifyWatches(): number | null {
  if (FD_DIR !== "/proc/self/fd" || !existsSync("/proc/self/fdinfo")) return null;
  let watches = 0;
  for (const fd of readdirSync(FD_DIR)) {
    try {
      if (readlinkSync(join(FD_DIR, fd)) !== "anon_inode:inotify") continue;
      const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf-8");
      watches += info.split("\n").filter((line) => line.startsWith("inotify wd:")).length;
    } catch {
      // Closed meanwhile
    }
  }
  return watches;
}

function fakeWs() {
  const dragons: DragonUpdateData[] = [];
  const gates: GateUpdateData[] = [];
  const lines: string[] = [];
  const ticks: unknown[] = [];
  const server = {
    broadcastDragonUpdate: (data: DragonUpdateData) => dragons.push(data),
    broadcastGateUpdate: (data: GateUpdateData) => gates.push(data),
    broadcastLogLine: (_id: string, line: string) => lines.push(line),
    broadcastOrchestratorTick: (data: unknown) => ticks.push(data),
  } as unknown as LairWebSocketServer;
  return { server, dragons, gates, lines, ticks };
}

function projectConfig(root: string): ProjectConfig {
  return {
    name: "Big",
    queue_file: join(root, "queue.md"),
    agents_dir: join(root, "agents"),
    gates_dir: join(root, "gates"),
  } as unknown as ProjectConfig;
}

/**
 * A project of 5000 files, as a long-running Lair's grow to: session logs,
 * prompts and sessions in agents_dir, gate results and their archive, the
 * gate queue's logs, and the queue file.
 */
function bigProject(): { root: string; config: ProjectConfig } {
  const root = mkdtempSync(join(tmpdir(), "lair-watch-"));
  const config = projectConfig(root);
  const results = join(config.gates_dir, "results");
  const queue = join(config.gates_dir, "queue");
  for (const dir of ["prompts", "lair-sessions"]) mkdirSync(join(config.agents_dir, dir), { recursive: true });
  mkdirSync(join(results, "archive"), { recursive: true });
  mkdirSync(queue, { recursive: true });
  let files = 0;
  const write = (path: string, text: string) => {
    writeFileSync(path, text);
    files++;
  };
  for (let i = 0; i < 2000; i++) write(join(config.agents_dir, `agent${i}-20261027T000000Z.log`), `agent${i} started\n`);
  for (let i = 0; i < 300; i++) write(join(config.agents_dir, "prompts", `p${i}.txt`), "prompt\n");
  for (let i = 0; i < 200; i++) write(join(config.agents_dir, "lair-sessions", `s${i}.json`), "{}\n");
  for (let i = 0; i < 500; i++) {
    write(join(results, `g${i}.rc`), "0\n");
    write(join(results, `g${i}.log`), "ok\n");
  }
  for (let i = 0; i < 1000; i++) write(join(results, "archive", `old${i}.rc`), "1\n");
  for (let i = 0; i < 499; i++) write(join(queue, `fast.1.q${i}.log`), "step\n");
  write(config.queue_file, "# queue\n");
  expect(files).toBe(5000);
  return { root, config };
}

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("FileWatcherService on large folders", () => {
  it("holds a bounded number of descriptors and watches for 5000 files, and still reports changes", async () => {
    const { root, config } = bigProject();
    const ws = fakeWs();
    const descriptorsBefore = descriptorCount();
    const watchesBefore = inotifyWatches();
    const watcher = new FileWatcherService(ws.server, config);
    cleanup = async () => {
      await watcher.stop();
      rmSync(root, { recursive: true, force: true });
    };
    watcher.start();
    // Time for a watcher that sets up asynchronously to finish
    await sleep(1500);

    // A watch or a descriptor per file would be thousands here
    const watches = inotifyWatches();
    if (watches !== null && watchesBefore !== null) expect(watches - watchesBefore).toBeLessThan(100);
    const descriptors = descriptorCount();
    if (descriptors !== null && descriptorsBefore !== null) expect(descriptors - descriptorsBefore).toBeLessThan(100);
    expect(descriptorsUnder(root)).toEqual([]);

    // New and changed files of the watched folders are still reported
    appendFileSync(join(config.agents_dir, "agent7-20261027T000000Z.log"), "step 2\n");
    writeFileSync(join(config.agents_dir, "kiro-new.log"), "hello\n");
    writeFileSync(join(config.gates_dir, "results", "g-new.rc"), "3\n");
    writeFileSync(join(config.gates_dir, "queue", "fast.1.g-next.req"), "");
    writeFileSync(config.queue_file, "# queue\n- one\n");
    await waitFor("the appended log line", () => ws.dragons.some((d) => d.id === "agent7" && d.lastLogLine === "step 2"));
    await waitFor("the new log", () => ws.lines.includes("hello"));
    await waitFor("the gate result", () =>
      ws.gates.some((g) => g.id === "g-new" && g.event === "completed" && g.rc === 3),
    );
    await waitFor("the queued gate", () => ws.gates.some((g) => g.id === "g-next" && g.event === "queued"));
    await waitFor("the queue change", () => ws.ticks.length > 0);

    // A file in a subfolder (an archive) is not the dashboard's
    writeFileSync(join(config.gates_dir, "results", "archive", "old-new.rc"), "1\n");
    await sleep(500);
    expect(ws.gates.some((g) => g.id === "old-new")).toBe(false);

    expect(descriptorsUnder(root)).toEqual([]);
    const after = descriptorCount();
    if (after !== null && descriptorsBefore !== null) expect(after - descriptorsBefore).toBeLessThan(100);
  }, 60_000);

  it("reports a burst of writes to one log once (debounced)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lair-watch-burst-"));
    const config = projectConfig(root);
    mkdirSync(config.agents_dir, { recursive: true });
    mkdirSync(join(config.gates_dir, "results"), { recursive: true });
    mkdirSync(join(config.gates_dir, "queue"), { recursive: true });
    const log = join(config.agents_dir, "kiro-A-20261027T000000Z.log");
    writeFileSync(log, "started\n");
    writeFileSync(config.queue_file, "# queue\n");
    const ws = fakeWs();
    const watcher = new FileWatcherService(ws.server, config);
    cleanup = async () => {
      await watcher.stop();
      rmSync(root, { recursive: true, force: true });
    };
    watcher.start();
    await sleep(500);

    appendFileSync(log, "a\n");
    appendFileSync(log, "b\n");
    appendFileSync(log, "c\n");
    await waitFor("the log lines", () => ws.lines.includes("c"));
    await sleep(500);
    const updates = ws.dragons.filter((d) => d.id === "kiro-A" && d.event === "log_line");
    expect(updates).toHaveLength(1);
    expect(updates[0].lastLogLine).toBe("c");
    expect(ws.lines.filter((line) => line === "b")).toHaveLength(1);
  }, 30_000);
});
