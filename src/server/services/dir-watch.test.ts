/**
 * Folder watching: one watch per folder, whatever number of files it holds,
 * with polling where a folder can't be watched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { stat } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { ConfigReloader } from "../reload/index.js";
import {
  DirWatch,
  MIN_HEALTH_CHECK_MS,
  defaultWatch,
  type DirEntryEvent,
  type DirWatchOptions,
  type StatDirFn,
  type WatchFn,
} from "./dir-watch.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A test that waits on several real file events in turn. Each wait is bounded
 * by waitFor (10 s, failing with the event it waited for); FSEvents on a macOS
 * runner can take a second or more per event, so five in a row outlast
 * vitest's 5 s default, which would fail the test without naming the event.
 */
const EVENTS_TIMEOUT_MS = 60_000;

async function waitFor(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const quiet = { log: () => undefined, warn: () => undefined };

const roots: string[] = [];
const watches: DirWatch[] = [];

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lair-dir-watch-"));
  roots.push(root);
  return root;
}

interface Seen {
  event: DirEntryEvent;
  name: string;
}

function watchDir(dir: string, options: Partial<DirWatchOptions> = {}) {
  const seen: Seen[] = [];
  const errors: string[] = [];
  const watch = new DirWatch(dir, {
    // Everything but names starting with "skip"
    accept: (name) => !name.startsWith("skip"),
    onEvent: (event, _path, name) => seen.push({ event, name }),
    debounceMs: 50,
    pollMs: 100,
    onError: (text) => errors.push(text),
    ...options,
  });
  watches.push(watch);
  watch.start();
  const saw = (event: DirEntryEvent, name: string) => seen.some((s) => s.event === event && s.name === name);
  return { watch, seen, errors, saw };
}

/** Add, change, remove a file and a folder; nothing for skipped names or a subfolder's files. */
async function exercise(dir: string, h: ReturnType<typeof watchDir>): Promise<void> {
  writeFileSync(join(dir, "b.log"), "new\n");
  await waitFor("add b.log", () => h.saw("add", "b.log"));
  appendFileSync(join(dir, "a.log"), "more\n");
  await waitFor("change a.log", () => h.saw("change", "a.log"));
  rmSync(join(dir, "b.log"));
  await waitFor("unlink b.log", () => h.saw("unlink", "b.log"));
  mkdirSync(join(dir, "kiro-A.running"));
  await waitFor("addDir kiro-A.running", () => h.saw("addDir", "kiro-A.running"));
  rmSync(join(dir, "kiro-A.running"), { recursive: true });
  await waitFor("unlinkDir kiro-A.running", () => h.saw("unlinkDir", "kiro-A.running"));

  writeFileSync(join(dir, "skip-me.log"), "x\n");
  writeFileSync(join(dir, "sub", "inner-new.log"), "x\n");
  await sleep(400);
  expect(h.seen.filter((s) => s.name.startsWith("skip") || s.name.startsWith("inner"))).toEqual([]);
}

function folderWithFiles(root: string): string {
  const dir = join(root, "watched");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.log"), "first\n");
  writeFileSync(join(dir, "sub", "inner.log"), "x\n");
  return dir;
}

describe("DirWatch", () => {
  it("reports the folder's entries through one watch of the folder", async () => {
    const dir = folderWithFiles(tempRoot());
    const watched: string[] = [];
    const watch: WatchFn = (path, listener) => {
      watched.push(path);
      return defaultWatch(path, listener);
    };
    const h = watchDir(dir, { watch });
    expect(h.watch.state).toBe("watching");
    await exercise(dir, h);
    // Entries that were there before the watch are not reported as new
    expect(h.saw("add", "a.log")).toBe(false);
    expect(watched).toEqual([dir]);
    expect(h.errors).toEqual([]);
  }, EVENTS_TIMEOUT_MS);

  it("reports a burst of writes to one file once", async () => {
    const dir = folderWithFiles(tempRoot());
    const h = watchDir(dir);
    for (let i = 0; i < 5; i++) appendFileSync(join(dir, "a.log"), `line ${i}\n`);
    await waitFor("change a.log", () => h.saw("change", "a.log"));
    await sleep(300);
    expect(h.seen.filter((s) => s.name === "a.log")).toHaveLength(1);
  }, EVENTS_TIMEOUT_MS);

  it("polls instead when asked to, with the same events", async () => {
    const dir = folderWithFiles(tempRoot());
    const watched: string[] = [];
    const h = watchDir(dir, {
      mode: "poll",
      watch: (path, listener) => {
        watched.push(path);
        return defaultWatch(path, listener);
      },
    });
    expect(h.watch.state).toBe("polling");
    await exercise(dir, h);
    expect(watched).toEqual([]);
  }, EVENTS_TIMEOUT_MS);

  it("polls a folder that doesn't exist yet, and watches it once it does", async () => {
    const dir = join(tempRoot(), "later");
    const h = watchDir(dir);
    expect(h.watch.state).toBe("polling");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.log"), "x\n");
    await waitFor("add x.log", () => h.saw("add", "x.log"));
    await waitFor("the watch", () => h.watch.state === "watching");
    writeFileSync(join(dir, "y.log"), "y\n");
    await waitFor("add y.log", () => h.saw("add", "y.log"));
    // A missing folder is not an error
    expect(h.errors).toEqual([]);
  }, EVENTS_TIMEOUT_MS);

  it("polls a folder whose watch can't be made, and says so once", async () => {
    const dir = folderWithFiles(tempRoot());
    const h = watchDir(dir, {
      watch: () => {
        throw Object.assign(new Error("no inotify watches left"), { code: "ENOSPC" });
      },
    });
    expect(h.watch.state).toBe("polling");
    writeFileSync(join(dir, "z.log"), "z\n");
    await waitFor("add z.log", () => h.saw("add", "z.log"));
    // Every poll tries the watch again; the failure is said once
    await sleep(400);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("ENOSPC");
  }, EVENTS_TIMEOUT_MS);

  it("watches a folder again after it was removed and made again", async () => {
    const dir = folderWithFiles(tempRoot());
    const h = watchDir(dir);
    rmSync(dir, { recursive: true, force: true });
    // inotify reports the removal of the folder's files as it happens
    if (process.platform === "linux") await waitFor("unlink a.log", () => h.saw("unlink", "a.log"));
    // The folder's own removal: its rename (inotify), or the health check (macOS, where FSEvents may say nothing)
    await waitFor("polling", () => h.watch.state === "polling");
    mkdirSync(dir);
    writeFileSync(join(dir, "n.log"), "n\n");
    await waitFor("add n.log", () => h.saw("add", "n.log"));
    await waitFor("the watch", () => h.watch.state === "watching");
    // Wherever the events went, the removed file is reported by the time the folder is watched again
    expect(h.saw("unlink", "a.log")).toBe(true);
    writeFileSync(join(dir, "m.log"), "m\n");
    await waitFor("add m.log", () => h.saw("add", "m.log"));
  }, 30_000);

  /** A watch that reports nothing, as FSEvents may for the watched folder's own removal */
  const silent: WatchFn = (path) => defaultWatch(path, () => undefined);

  it("the health check notices a removed folder the watch said nothing about, then the folder is watched again", async () => {
    const dir = folderWithFiles(tempRoot());
    const h = watchDir(dir, { watch: silent, healthCheck: true, healthCheckMs: MIN_HEALTH_CHECK_MS });
    expect(h.watch.state).toBe("watching");
    rmSync(dir, { recursive: true, force: true });
    await waitFor("polling", () => h.watch.state === "polling", 5_000);
    // Said by the health check: the silent watch never asked for a folder check
    expect(h.errors).toEqual([`${dir} was removed or replaced; polling it every 0.1 s`]);
    mkdirSync(dir);
    writeFileSync(join(dir, "n.log"), "n\n");
    await waitFor("add n.log", () => h.saw("add", "n.log"));
    await waitFor("the watch", () => h.watch.state === "watching");
    expect(h.saw("unlink", "a.log")).toBe(true);
  }, 30_000);

  it("the health check is off unless asked for (on by default on macOS only), and never runs more than once a second", async () => {
    const dir = folderWithFiles(tempRoot());
    const plain = { accept: () => true, onEvent: () => undefined };
    expect(new DirWatch(dir, plain).healthCheck).toBe(process.platform === "darwin");
    const intervals = [
      new DirWatch(dir, plain).healthCheckMs,
      new DirWatch(dir, { ...plain, pollMs: 0 }).healthCheckMs,
      new DirWatch(dir, { ...plain, pollMs: 2000 }).healthCheckMs,
      new DirWatch(dir, { ...plain, healthCheckMs: 1 }).healthCheckMs,
    ];
    expect(intervals).toEqual([5000, MIN_HEALTH_CHECK_MS, 2000, MIN_HEALTH_CHECK_MS]);

    // Off: a silent watch on a removed folder is left as it is, and nothing is looked at on a timer
    let stats = 0;
    const counted: StatDirFn = (path) => {
      stats++;
      return stat(path);
    };
    const h = watchDir(dir, { watch: silent, healthCheck: false, statDir: counted });
    rmSync(dir, { recursive: true, force: true });
    await sleep(MIN_HEALTH_CHECK_MS + 500);
    expect(h.watch.state).toBe("watching");
    expect(stats).toBe(0);
  }, 30_000);

  it("the health check's stat is async and one at a time: a slow one is never doubled, and a check asked for meanwhile runs right after it", async () => {
    const dir = folderWithFiles(tempRoot());
    let calls = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: StatDirFn = async (path) => {
      calls++;
      if (calls === 1) await held;
      return stat(path);
    };
    const h = watchDir(dir, { watch: silent, healthCheck: true, healthCheckMs: MIN_HEALTH_CHECK_MS, statDir: slow });
    // Three ticks while the first stat hangs: still one stat, and the event loop keeps running
    await sleep(3 * MIN_HEALTH_CHECK_MS + 300);
    expect(calls).toBe(1);
    // It answers (the folder is still there): the check the later ticks asked for runs at once, not on the next tick
    release();
    await waitFor("the check asked for meanwhile", () => calls === 2, 500);
    expect(h.watch.state).toBe("watching");
    // The ticks go on: a removed folder is noticed on the next one
    rmSync(dir, { recursive: true, force: true });
    await waitFor("polling", () => h.watch.state === "polling", 3_000);
    expect(h.errors).toEqual([`${dir} was removed or replaced; polling it every 0.1 s`]);
  }, 30_000);

  it("does nothing after stop()", async () => {
    const dir = folderWithFiles(tempRoot());
    const h = watchDir(dir);
    h.watch.stop();
    expect(h.watch.state).toBe("stopped");
    writeFileSync(join(dir, "late.log"), "x\n");
    await sleep(300);
    expect(h.seen).toEqual([]);
  });
});

describe("folder watches of the server", () => {
  it("the config reloader watches projects/ and projects/local/, not their files", async () => {
    const root = tempRoot();
    const projects = join(root, "projects");
    mkdirSync(join(projects, "local"), { recursive: true });
    // Backups pile up next to a project file
    for (let i = 0; i < 300; i++) writeFileSync(join(projects, "local", `shop.yaml.bak-${i}`), "name: Shop\n");
    for (let i = 0; i < 100; i++) writeFileSync(join(projects, `notes-${i}.txt`), "x\n");
    const watched: string[] = [];
    const watch: WatchFn = (path, listener) => {
      watched.push(path);
      return defaultWatch(path, listener);
    };
    const reloader = new ConfigReloader({ modules: [], initial: [], projectsDir: projects, cwd: root, log: quiet, watch });
    try {
      reloader.start();
      await reloader.ready();
      expect(watched).toEqual([projects, join(projects, "local")]);
      expect(reloader.status().watching).toBe(true);
    } finally {
      await reloader.stop();
    }
    expect(reloader.status().watching).toBe(false);
  });

  it("nothing in src watches files another way (chokidar, fs.watchFile, fs.watch outside dir-watch.ts)", () => {
    const src = fileURLToPath(new URL("../../", import.meta.url));
    const own = join("server", "services", "dir-watch.ts");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const text = readFileSync(path, "utf-8");
        const file = relative(src, path);
        if (/from\s+["']chokidar["']|require\(\s*["']chokidar["']\s*\)/.test(text)) offenders.push(`${file}: chokidar`);
        if (/\bwatchFile\(/.test(text)) offenders.push(`${file}: fs.watchFile`);
        const watchImport = /import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/;
        if (file !== own && (watchImport.test(text) || /\bfs\.watch\(/.test(text))) offenders.push(`${file}: fs.watch`);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
