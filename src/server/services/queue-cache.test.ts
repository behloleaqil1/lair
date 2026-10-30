/**
 * The queue file is parsed once per change and served from memory (issue
 * #160). The tests use a real queue file in a temporary folder and a data
 * service as the dashboard handlers use it; the only fake is a counting
 * wrapper around the filesystem reader, to see how often the file is read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { monitorEventLoopDelay } from "perf_hooks";
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
  } as ProjectConfig;
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

    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const slowest: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      const dragons = service.getDragons();
      service.getQueueLinesByAgent(`worker-${i % AGENTS}`);
      service.getQueueLines();
      slowest.push(performance.now() - t);
      expect(dragons).toHaveLength(AGENTS);
      await new Promise((r) => setImmediate(r)); // let the loop run, as between requests
    }
    lag.disable();

    expect(reader.reads).toBe(1);
    expect(Math.max(...slowest)).toBeLessThan(200);
    expect(lag.max / 1e6).toBeLessThan(100);
    // The per-agent slice comes from the same memory
    expect(service.getQueueLinesByAgent("worker-3").every((l) => l.agent === "worker-3")).toBe(true);
    expect(service.getQueueLinesByAgent("worker-3").length).toBeGreaterThan(10);
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

  it("refuses what is not a regular file, and settles instead of holding requests", async () => {
    // A directory is not a regular file: the read is refused, and the queue stays as it was
    mkdirSync(QUEUE);
    const cache = await started();
    expect(cache.getLines()).toEqual([]);
    expect(cache.status().error).toBeDefined();
    expect(cache.settled).toBe(true);
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
