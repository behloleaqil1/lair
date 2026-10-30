/**
 * The queue file is parsed once per change and served from memory (issue
 * #160). The tests use a real queue file in a temporary folder and a data
 * service as the dashboard handlers use it; the only fake is a counting
 * wrapper around the filesystem reader, to see how often the file is read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { DataService } from "./data.js";
import { QueueCache, QueueCacheManager, fsQueueFileReader, type QueueFileReader } from "./queue-cache.js";
import type { ProjectConfig } from "../../shared/types.js";

const TMP = join(process.cwd(), "data", "test-queue-cache");
const QUEUE = join(TMP, "queue.md");
const AGENTS = 40;

function makeConfig(): ProjectConfig {
  return {
    name: "test",
    repo: TMP,
    github: "",
    queue_file: QUEUE,
    agents_dir: TMP,
    gates_dir: join(TMP, "gates"),
    machines: { local: { name: "Local", type: "local" } },
  } as unknown as ProjectConfig;
}

const line = (agent: string, n: number) =>
  `- DONE task-${n} by ${agent} (Worker) 12:${String(n % 60).padStart(2, "0")}Z: finished step ${n} of the work, with a few more words so a line is a realistic length\n`;

/** About `bytes` of queue text spread over the agents, oldest first */
function queueText(bytes: number): string {
  let text = "# Queue\n";
  for (let n = 0; text.length < bytes; n++) text += line(`worker-${n % AGENTS}`, n);
  return text;
}

/** The real reader, counting its reads */
function counting(): QueueFileReader & { reads: number } {
  const reader = {
    reads: 0,
    read: (path: string, max: number) => {
      reader.reads++;
      return fsQueueFileReader.read(path, max);
    },
    stat: (path: string) => fsQueueFileReader.stat(path),
  };
  return reader;
}

let caches: QueueCache[] = [];
async function started(options: ConstructorParameters<typeof QueueCache>[1] = {}): Promise<QueueCache> {
  const cache = new QueueCache(QUEUE, options);
  caches.push(cache);
  await cache.start();
  return cache;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  mkdirSync(join(TMP, "gates", "results"), { recursive: true });
  mkdirSync(join(TMP, "gates", "queue"), { recursive: true });
  writeFileSync(
    join(TMP, "dragons.txt"),
    Array.from({ length: AGENTS }, (_, i) => `worker-${i}\tWorker ${i}\ttask\n`).join(""),
  );
});

afterEach(() => {
  for (const c of caches) c.stop();
  caches = [];
  rmSync(TMP, { recursive: true, force: true });
});

describe("a large queue file under dashboard polling", () => {
  it("reads the file once, however many requests come, and answers each fast without blocking the loop", async () => {
    writeFileSync(QUEUE, queueText(1024 * 1024));
    const reader = counting();
    const cache = await started({ reader });
    const service = new DataService(makeConfig(), { queue: () => cache.getLines() });
    expect(reader.reads).toBe(1);

    // The same rounds without the cache read and parse the file each time:
    // the control, so the cached rounds are judged against it, not a fixed time
    const control = new DataService(makeConfig());
    const round = (s: DataService, i: number) => {
      const t = performance.now();
      const dragons = s.getDragons();
      s.getQueueLinesByAgent(`worker-${i % AGENTS}`);
      s.getQueueLines();
      expect(dragons).toHaveLength(AGENTS);
      return performance.now() - t;
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const uncached: number[] = [];
    for (let i = 0; i < 9; i++) uncached.push(round(control, i));
    const cached: number[] = [];
    for (let i = 0; i < 9; i++) {
      cached.push(round(service, i));
      await new Promise((r) => setImmediate(r)); // let the loop run, as between requests
    }
    expect(reader.reads).toBe(1);
    expect(median(cached)).toBeLessThan(median(uncached));
    // The per-agent slice comes from the same memory
    expect(service.getQueueLinesByAgent("worker-3").every((l) => l.agent === "worker-3")).toBe(true);
    expect(service.getQueueLinesByAgent("worker-3").length).toBeGreaterThan(10);
  });

  it("serves the cached lines, not the file: a rewrite on disk is not seen until the cache reads it", async () => {
    writeFileSync(QUEUE, line("worker-1", 1) + line("worker-1", 2));
    // The watcher and the check are off, so nothing re-reads behind the test's back
    const cache = await started({ watch: false, checkMs: 3_600_000 });
    const service = new DataService(makeConfig(), { queue: () => cache.getLines() });
    const control = new DataService(makeConfig());
    expect(service.getQueueLines()).toHaveLength(2);

    writeFileSync(QUEUE, line("worker-1", 7) + line("worker-1", 8) + line("worker-2", 9));
    expect(service.getQueueLines()).toHaveLength(2);
    expect(service.getQueueLinesByAgent("worker-1").map((l) => l.task)).toEqual([
      expect.stringContaining("task-1"),
      expect.stringContaining("task-2"),
    ]);
    expect(service.getQueueLinesByAgent("worker-2")).toEqual([]);
    expect(service.getDragons().find((d) => d.id === "worker-2")?.stats?.doneCount ?? 0).toBe(0);
    expect(control.getDragons().find((d) => d.id === "worker-2")?.stats?.doneCount).toBe(1);
    // The control reads the file itself and sees the rewrite: it would fail this test if the service did too
    expect(control.getQueueLines()).toHaveLength(3);

    rmSync(QUEUE);
    expect(service.getQueueLines()).toHaveLength(2);
    await cache.refresh();
    expect(service.getQueueLines()).toEqual([]);
  });

  it("keeps the newest lines when the file is larger than the cap, and says so", async () => {
    writeFileSync(QUEUE, queueText(200 * 1024));
    const cache = await started({ maxBytes: 20 * 1024 });
    const lines = cache.getLines();
    expect(cache.status().truncated).toBe(true);
    expect(cache.status().size).toBe(statSync(QUEUE).size);
    // Every line is whole (the cut first line is dropped) and the last line of the file is kept
    expect(lines.every((l) => /^- DONE task-\d+ by worker-\d+ /.test(l.raw))).toBe(true);
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.length).toBeLessThan(200);
    const lastTask = /task-(\d+) by/.exec(lines[lines.length - 1].raw)?.[1];
    expect(Number(lastTask)).toBeGreaterThan(1000);
  });
});

describe("changes", () => {
  it("sees a line appended to the file and reads it once", async () => {
    writeFileSync(QUEUE, queueText(10 * 1024));
    const reader = counting();
    const cache = await started({ reader, debounceMs: 20, checkMs: 100 });
    const before = cache.getLines().length;
    appendFileSync(QUEUE, line("worker-1", 99999));
    await until(() => cache.getLines().length === before + 1);
    expect(cache.getByAgent("worker-1").some((l) => l.task?.startsWith("task-99999"))).toBe(true);
    // A burst of writes is one more read, not one per write
    const reads = reader.reads;
    for (let i = 0; i < 20; i++) appendFileSync(QUEUE, line("worker-2", 100000 + i));
    await until(() => cache.getLines().length === before + 21);
    expect(reader.reads - reads).toBeLessThanOrEqual(3);
  });

  it("sees the file appear, and treats a missing file as an empty queue", async () => {
    const cache = await started({ debounceMs: 20, checkMs: 100 });
    expect(cache.getLines()).toEqual([]);
    expect(cache.status().error).toBeUndefined();
    writeFileSync(QUEUE, line("worker-1", 1));
    await until(() => cache.getLines().length === 1);
  });

  it("runs one read at a time: calls during a read share it and ask for one more", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    let active = 0;
    let most = 0;
    let reads = 0;
    const reader: QueueFileReader = {
      stat: (p) => fsQueueFileReader.stat(p),
      read: async (p, max) => {
        reads++;
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 30));
        try {
          return await fsQueueFileReader.read(p, max);
        } finally {
          active--;
        }
      },
    };
    const cache = new QueueCache(QUEUE, { reader });
    caches.push(cache);
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(most).toBe(1);
    expect(reads).toBe(2);
  });

  it("keeps the last good lines and reports the error when a read fails", async () => {
    writeFileSync(QUEUE, line("worker-1", 1) + line("worker-1", 2));
    let fail = false;
    const reader: QueueFileReader = {
      stat: (p) => fsQueueFileReader.stat(p),
      read: (p, max) => (fail ? Promise.reject(new Error("EIO: input/output error")) : fsQueueFileReader.read(p, max)),
    };
    const cache = await started({ reader });
    expect(cache.getLines()).toHaveLength(2);
    fail = true;
    await cache.refresh();
    expect(cache.getLines()).toHaveLength(2);
    expect(cache.status().error).toMatch(/EIO/);
    fail = false;
    await cache.refresh();
    expect(cache.status().error).toBeUndefined();
  });

  it("sees a file replaced by an atomic rename (a temporary file renamed over the queue)", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    // The folder watch alone: the slow check is too slow to be what sees it
    const cache = await started({ debounceMs: 20, checkMs: 3_600_000 });
    writeFileSync(`${QUEUE}.tmp`, line("worker-1", 1) + line("worker-2", 2) + line("worker-2", 3));
    renameSync(`${QUEUE}.tmp`, QUEUE);
    await until(() => cache.getLines().length === 3);
  });

  it("sees a file cut down to a smaller one", async () => {
    writeFileSync(QUEUE, queueText(20 * 1024));
    const cache = await started({ debounceMs: 20, checkMs: 100 });
    expect(cache.getLines().length).toBeGreaterThan(20);
    truncateSync(QUEUE, 0);
    await until(() => cache.getLines().length === 0);
    writeFileSync(QUEUE, line("worker-1", 1));
    await until(() => cache.getLines().length === 1);
  });

  it("sees changes with the slow check alone when no watcher runs", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    const reader = counting();
    const cache = await started({ reader, watch: false, debounceMs: 20, checkMs: 50 });
    expect(cache.active).toBe(true);
    appendFileSync(QUEUE, line("worker-1", 2));
    await until(() => cache.getLines().length === 2);
    // Nothing changed since: the check reads no more
    const reads = reader.reads;
    await new Promise((r) => setTimeout(r, 200));
    expect(reader.reads).toBe(reads);
  });

  it("retries a failed read by itself, without a call to refresh()", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    let fail = false;
    const reader: QueueFileReader = {
      stat: (p) => fsQueueFileReader.stat(p),
      read: (p, max) => (fail ? Promise.reject(new Error("EIO: input/output error")) : fsQueueFileReader.read(p, max)),
    };
    const cache = await started({ reader, watch: false, debounceMs: 20, checkMs: 50 });
    fail = true;
    appendFileSync(QUEUE, line("worker-1", 2));
    await until(() => cache.status().error !== undefined);
    expect(cache.getLines()).toHaveLength(1);
    fail = false;
    await until(() => cache.getLines().length === 2);
    expect(cache.status().error).toBeUndefined();
  });

  it("stop() ends the watcher and the timers, and a later change is not read", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    const reader = counting();
    const cache = await started({ reader, debounceMs: 20, checkMs: 50 });
    expect(cache.active).toBe(true);
    appendFileSync(QUEUE, line("worker-1", 2)); // a debounce may be pending
    cache.stop();
    expect(cache.active).toBe(false);
    const reads = reader.reads;
    appendFileSync(QUEUE, line("worker-1", 3));
    await new Promise((r) => setTimeout(r, 300));
    expect(reader.reads).toBe(reads);
    expect(cache.getLines().length).toBeLessThan(3);
  });

  it("refuses what is not a regular file, and settles instead of holding requests", async () => {
    // A directory is not a regular file: the read is refused, and the queue stays as it was
    mkdirSync(QUEUE);
    const cache = await started();
    expect(cache.getLines()).toEqual([]);
    expect(cache.status().error).toBeDefined();
    expect(cache.settled).toBe(true);
  });
});

describe("the first read", () => {
  it("is waited for at most the given time when it hangs, then the cache serves what it has", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reader: QueueFileReader = {
      stat: (p) => fsQueueFileReader.stat(p),
      read: async (p, max) => {
        await gate; // a stalled mount: the first read does not come back
        return fsQueueFileReader.read(p, max);
      },
    };
    const cache = new QueueCache(QUEUE, { reader });
    caches.push(cache);
    void cache.start();

    const started = performance.now();
    expect(await cache.readyWithin(50)).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(cache.getLines()).toEqual([]); // empty, not blocked

    // The read carried on in the background and lands when the disk answers
    release();
    expect(await cache.readyWithin(5_000)).toBe(true);
    expect(cache.getLines()).toHaveLength(1);
  });

  it("returns true at once when the file is read in time", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    const cache = await started();
    expect(await cache.readyWithin(5_000)).toBe(true);
  });
});

describe("the cache manager", () => {
  it("gives a project one cache, and a new one when its queue file moves", async () => {
    writeFileSync(QUEUE, line("worker-1", 1));
    const manager = new QueueCacheManager({ debounceMs: 20, checkMs: 100 });
    const a = manager.get("demo", QUEUE);
    expect(manager.get("demo", QUEUE)).toBe(a);
    await a.ready();
    expect(a.getLines()).toHaveLength(1);
    const moved = join(TMP, "other.md");
    writeFileSync(moved, line("worker-2", 1) + line("worker-2", 2));
    const b = manager.get("demo", moved);
    expect(b).not.toBe(a);
    await b.ready();
    expect(b.getLines()).toHaveLength(2);
    manager.stopAll();
  });
});
