import { afterEach, describe, expect, it } from "vitest";
import { ProcessCache, initProcessCache, getProcessCache, disposeProcessCache } from "./process-cache.js";

describe("ProcessCache", () => {
  afterEach(() => {
    disposeProcessCache();
  });

  it("returns process list on first get", async () => {
    const cache = new ProcessCache({
      psTimeoutMs: 10_000,
      maxAgeMs: 30_000,
    });

    const entry = await cache.get();
    expect(Array.isArray(entry.processes)).toBe(true);
    // We should see at least this test process
    expect(entry.processes.length).toBeGreaterThan(0);
    expect(entry.stale).toBe(false);
    expect(entry.ageMs).toBeLessThan(1000);
  });

  it("caches the snapshot and returns same list", async () => {
    const cache = new ProcessCache({
      maxAgeMs: 30_000,
    });

    const first = await cache.get();
    const second = await cache.get();

    // Should be the exact same array reference (cached)
    expect(first.processes).toBe(second.processes);
    expect(first.takenAt).toBe(second.takenAt);
  });

  it("peek returns undefined before any refresh", () => {
    const cache = new ProcessCache();
    expect(cache.peek()).toBeUndefined();
  });

  it("peek returns cached value after refresh", async () => {
    const cache = new ProcessCache();
    await cache.get();

    const peeked = cache.peek();
    expect(peeked).toBeDefined();
    expect(Array.isArray(peeked!.processes)).toBe(true);
  });

  it("start() triggers background refresh", async () => {
    const cache = new ProcessCache({
      refreshIntervalMs: 100,
    });

    cache.start();

    // Wait for the initial refresh
    await new Promise((r) => setTimeout(r, 50));

    const peeked = cache.peek();
    expect(peeked).toBeDefined();
    expect(peeked!.processes.length).toBeGreaterThan(0);

    cache.stop();
  });

  it("stop() stops background refresh", async () => {
    const cache = new ProcessCache({
      refreshIntervalMs: 50,
      maxAgeMs: 10_000,
    });

    cache.start();
    await new Promise((r) => setTimeout(r, 100));
    
    cache.stop();
    const first = cache.peek()!;
    
    await new Promise((r) => setTimeout(r, 200));
    const second = cache.peek()!;

    // After stop, no new refresh should have happened
    // Use >= comparison since stop() might have been called mid-refresh
    expect(second.takenAt).toBeGreaterThanOrEqual(first.takenAt);
    // The key assertion: the takenAt should NOT have changed significantly
    // (if refreshes were still happening, they'd be 50ms apart)
    expect(second.takenAt - first.takenAt).toBeLessThan(100);
  });

  it("shared cache is a singleton", () => {
    const cache1 = getProcessCache();
    const cache2 = getProcessCache();
    expect(cache1).toBe(cache2);
  });

  it("initProcessCache creates a new cache with options", async () => {
    const first = getProcessCache();
    const created = initProcessCache({ maxAgeMs: 5000 });
    const second = getProcessCache();

    expect(created).toBe(second);
    expect(first).not.toBe(second);
  });

  it("triggerRefresh is a no-op when already refreshing", async () => {
    const cache = new ProcessCache({
      psTimeoutMs: 500,
    });

    // Start a refresh
    cache.triggerRefresh();
    expect(cache.refreshing).toBe(true);

    // Trigger again - should be no-op
    cache.triggerRefresh();
    expect(cache.refreshing).toBe(true);

    // Wait for it to complete
    await new Promise((r) => setTimeout(r, 600));
    expect(cache.refreshing).toBe(false);
  });

  it("handles ps output with many processes", async () => {
    // This tests the real ps command, which should work
    const cache = new ProcessCache({
      psTimeoutMs: 15_000,
      psMaxBytes: 64 * 1024 * 1024,
    });

    const entry = await cache.get();
    // Should have parsed at least some processes
    expect(entry.processes.length).toBeGreaterThan(0);
    // Each process should have the required fields
    for (const proc of entry.processes.slice(0, 5)) {
      expect(typeof proc.pid).toBe("number");
      expect(typeof proc.ppid).toBe("number");
      expect(typeof proc.elapsedSeconds).toBe("number");
      expect(typeof proc.command).toBe("string");
      expect(Array.isArray(proc.argv)).toBe(true);
    }
  });
});
