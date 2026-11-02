/**
 * Tests for DirCache (issue #245: sync readdir stalls the event loop).
 *
 * Acceptance tests for the async directory cache that replaces synchronous
 * readdir calls on the tick path. Each test drives the real DirCache, faking
 * only the filesystem root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DirCache, fileExists, dirExists } from "./dir-cache.js";

/** Create a unique temp directory for a test. */
function createTempDir(): string {
  const dir = join(tmpdir(), `dir-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Clean up a temp directory after a test. */
function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

describe("DirCache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe("basic operations", () => {
    it("starts empty before start() is called", async () => {
      const cache = new DirCache(tempDir);
      expect(cache.state).toBe("idle");
      expect(cache.size).toBe(0);
      expect(cache.list()).toEqual([]);
    });

    it("loads existing entries on start()", async () => {
      // Create files before starting the cache
      writeFileSync(join(tempDir, "a.txt"), "content");
      writeFileSync(join(tempDir, "b.req"), "request");
      mkdirSync(join(tempDir, "subdir"));

      const cache = new DirCache(tempDir);
      await cache.start();

      expect(cache.state).toBe("ready");
      expect(cache.size).toBe(3);
      expect(cache.has("a.txt")).toBe(true);
      expect(cache.has("b.req")).toBe(true);
      expect(cache.has("subdir")).toBe(true);
      expect(cache.isFile("a.txt")).toBe(true);
      expect(cache.isDirectory("subdir")).toBe(true);
      expect(cache.isFile("subdir")).toBe(false);

      cache.stop();
    });

    it("filters entries with the accept function", async () => {
      writeFileSync(join(tempDir, "a.txt"), "content");
      writeFileSync(join(tempDir, "b.req"), "request");
      writeFileSync(join(tempDir, "c.req"), "request");

      const cache = new DirCache(tempDir, {
        accept: (name) => name.endsWith(".req"),
      });
      await cache.start();

      expect(cache.size).toBe(2);
      expect(cache.has("a.txt")).toBe(false);
      expect(cache.has("b.req")).toBe(true);
      expect(cache.has("c.req")).toBe(true);

      cache.stop();
    });

    it("returns files() and directories() separately", async () => {
      writeFileSync(join(tempDir, "file1.txt"), "content");
      writeFileSync(join(tempDir, "file2.txt"), "content");
      mkdirSync(join(tempDir, "dir1"));
      mkdirSync(join(tempDir, "dir2"));

      const cache = new DirCache(tempDir);
      await cache.start();

      const files = cache.files();
      const dirs = cache.directories();

      expect(files.sort()).toEqual(["file1.txt", "file2.txt"]);
      expect(dirs.sort()).toEqual(["dir1", "dir2"]);

      cache.stop();
    });

    it("handles missing directory gracefully", async () => {
      const cache = new DirCache(join(tempDir, "nonexistent"));
      await cache.start();

      expect(cache.state).toBe("ready");
      expect(cache.size).toBe(0);

      cache.stop();
    });

    it("stop() clears the cache", async () => {
      writeFileSync(join(tempDir, "a.txt"), "content");

      const cache = new DirCache(tempDir);
      await cache.start();

      expect(cache.size).toBe(1);

      cache.stop();

      expect(cache.state).toBe("stopped");
      expect(cache.size).toBe(0);
      expect(cache.list()).toEqual([]);
    });
  });

  describe("event-driven updates", () => {
    it("detects a new file added after start()", async () => {
      const cache = new DirCache(tempDir, {
        watchOptions: { debounceMs: 10 },
      });
      await cache.start();

      expect(cache.has("new.txt")).toBe(false);

      writeFileSync(join(tempDir, "new.txt"), "new content");

      // Wait for the debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.has("new.txt")).toBe(true);
      expect(cache.isFile("new.txt")).toBe(true);

      cache.stop();
    });

    it("detects a file removed after start()", async () => {
      const filePath = join(tempDir, "to-remove.txt");
      writeFileSync(filePath, "content");

      const cache = new DirCache(tempDir, {
        watchOptions: { debounceMs: 10 },
      });
      await cache.start();

      expect(cache.has("to-remove.txt")).toBe(true);

      unlinkSync(filePath);

      // Wait for the debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.has("to-remove.txt")).toBe(false);

      cache.stop();
    });

    it("detects a new subdirectory added after start()", async () => {
      const cache = new DirCache(tempDir, {
        watchOptions: { debounceMs: 10 },
      });
      await cache.start();

      expect(cache.has("newdir")).toBe(false);

      mkdirSync(join(tempDir, "newdir"));

      // Wait for the debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.has("newdir")).toBe(true);
      expect(cache.isDirectory("newdir")).toBe(true);

      cache.stop();
    });

    it("only tracks accepted entries from events", async () => {
      const cache = new DirCache(tempDir, {
        accept: (name) => name.endsWith(".req"),
        watchOptions: { debounceMs: 10 },
      });
      await cache.start();

      writeFileSync(join(tempDir, "ignored.txt"), "content");
      writeFileSync(join(tempDir, "tracked.req"), "request");

      // Wait for the debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.has("ignored.txt")).toBe(false);
      expect(cache.has("tracked.req")).toBe(true);

      cache.stop();
    });
  });

  describe("helper functions", () => {
    it("fileExists returns true for existing files", async () => {
      const filePath = join(tempDir, "exists.txt");
      writeFileSync(filePath, "content");

      expect(await fileExists(filePath)).toBe(true);
      expect(await fileExists(join(tempDir, "missing.txt"))).toBe(false);
      expect(await fileExists(tempDir)).toBe(false); // directory, not file
    });

    it("dirExists returns true for existing directories", async () => {
      const dirPath = join(tempDir, "subdir");
      mkdirSync(dirPath);

      expect(await dirExists(dirPath)).toBe(true);
      expect(await dirExists(join(tempDir, "missing"))).toBe(false);
      expect(await dirExists(join(tempDir, "nonexistent", "nested"))).toBe(false);
    });
  });
});

/**
 * Performance bench test (issue #245 acceptance).
 *
 * One fill tick with 5,000 files must stay under a time budget. This test
 * creates 5,000 files, loads them into a DirCache, and verifies that lookups
 * complete in microseconds (not the seconds that sync readdir took).
 */
describe("DirCache performance", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("loads 5000 files and completes lookups within budget", async () => {
    const FILE_COUNT = 5000;
    const INITIAL_LOAD_BUDGET_MS = 5000; // 5 seconds for initial async load
    const LOOKUP_BUDGET_MS = 50; // 50 ms for 5000 lookups (instant from memory; sync readdir takes seconds)

    // Create 5000 files (simulating a busy logs/prompts/results folder)
    const createStart = Date.now();
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(tempDir, `file-${i.toString().padStart(5, "0")}.req`), `content-${i}`);
    }
    const createTime = Date.now() - createStart;
    console.log(`Created ${FILE_COUNT} files in ${createTime} ms`);

    // Start the cache and measure initial load time
    const cache = new DirCache(tempDir, {
      accept: (name) => name.endsWith(".req"),
    });

    const loadStart = Date.now();
    await cache.start();
    const loadTime = Date.now() - loadStart;

    console.log(`DirCache loaded ${FILE_COUNT} files in ${loadTime} ms`);
    expect(loadTime).toBeLessThan(INITIAL_LOAD_BUDGET_MS);
    expect(cache.size).toBe(FILE_COUNT);

    // Measure lookup time for all entries (simulating a fill tick)
    const lookupStart = Date.now();
    const entries = cache.list();
    for (const entry of entries) {
      cache.has(entry.name);
      cache.isFile(entry.name);
    }
    const lookupTime = Date.now() - lookupStart;

    console.log(`${FILE_COUNT} lookups completed in ${lookupTime} ms`);
    expect(lookupTime).toBeLessThan(LOOKUP_BUDGET_MS);

    // Verify all files are present
    expect(entries.length).toBe(FILE_COUNT);
    expect(cache.has("file-00000.req")).toBe(true);
    expect(cache.has("file-04999.req")).toBe(true);

    cache.stop();
  }, 30_000); // 30 second timeout for this test
});

/**
 * Event loop lag test (issue #245 acceptance).
 *
 * The cache must not block the event loop during initial load. This test
 * verifies that other async operations can proceed while loading.
 */
describe("DirCache event loop", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("does not block the event loop during initial load", async () => {
    const FILE_COUNT = 2000;
    const MAX_LAG_MS = 100; // Event loop callbacks should fire within 100ms

    // Create files
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(tempDir, `file-${i}.txt`), `content-${i}`);
    }

    const lagReadings: number[] = [];
    let measuring = true;

    // Start measuring event loop lag
    const measureLag = () => {
      if (!measuring) return;
      const start = Date.now();
      setImmediate(() => {
        const lag = Date.now() - start;
        lagReadings.push(lag);
        if (measuring) {
          setTimeout(measureLag, 5);
        }
      });
    };
    measureLag();

    // Start the cache (this should not block)
    const cache = new DirCache(tempDir);
    await cache.start();

    // Stop measuring
    measuring = false;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that lag stayed reasonable
    const maxLag = Math.max(...lagReadings, 0);
    console.log(`Event loop lag readings: min=${Math.min(...lagReadings)}ms, max=${maxLag}ms, count=${lagReadings.length}`);

    expect(maxLag).toBeLessThan(MAX_LAG_MS);
    expect(cache.size).toBe(FILE_COUNT);

    cache.stop();
  }, 30_000);
});
