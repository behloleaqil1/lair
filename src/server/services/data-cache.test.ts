/**
 * Data cache tests: verify the async, cached behavior.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDataCache, DataCacheManager } from "./data-cache.js";
import type { ProjectConfig } from "../../shared/types.js";

const mockConfig: ProjectConfig = {
  name: "test",
  repo: "/tmp/test-repo",
  agents_dir: "/tmp/test-agents",
  gates_dir: "/tmp/test-gates",
  queue_file: "/tmp/test-queue.md",
  github: "example/test-repo",
  machines: {},
};

describe("ProjectDataCache", () => {
  it("returns cached value on subsequent calls", async () => {
    const cache = new ProjectDataCache(mockConfig, {
      prMaxAgeMs: 60_000,
      ghTimeoutMs: 100, // Fast timeout for testing
    });

    // First call - will likely fail due to no gh command or repo
    // but should not throw
    const first = await cache.getPullRequests();
    expect(Array.isArray(first.value)).toBe(true);
    expect(typeof first.ageMs).toBe("number");
    expect(typeof first.stale).toBe("boolean");

    // Second call should be from cache
    const second = await cache.getPullRequests();
    expect(second.refreshedAt).toBe(first.refreshedAt);
  });

  it("peek returns undefined before first refresh", () => {
    const cache = new ProjectDataCache(mockConfig);
    expect(cache.peekPullRequests()).toBeUndefined();
    expect(cache.peekMergedPrs()).toBeUndefined();
    expect(cache.peekGitInfo()).toBeUndefined();
  });

  it("peek returns cached value after refresh", async () => {
    const cache = new ProjectDataCache(mockConfig, {
      ghTimeoutMs: 100,
      gitTimeoutMs: 100,
    });

    await cache.getPullRequests();
    const peeked = cache.peekPullRequests();
    expect(peeked).toBeDefined();
    expect(Array.isArray(peeked!.value)).toBe(true);
  });

  it("start triggers background refresh", async () => {
    const cache = new ProjectDataCache(mockConfig, {
      ghTimeoutMs: 100,
      gitTimeoutMs: 100,
    });

    cache.start(100);

    // Wait for initial refresh
    await new Promise((r) => setTimeout(r, 200));

    const peeked = cache.peekPullRequests();
    expect(peeked).toBeDefined();

    cache.stop();
  });

  it("stop prevents further refreshes", async () => {
    const cache = new ProjectDataCache(mockConfig, {
      ghTimeoutMs: 100,
      gitTimeoutMs: 100,
    });

    cache.start(100);
    // Wait for initial refresh to complete (not just start)
    await new Promise((r) => setTimeout(r, 200));
    
    // Capture timestamp after refreshes have settled
    const first = cache.peekPullRequests()?.refreshedAt;

    cache.stop();
    
    // Wait longer than the refresh interval to verify no new refreshes
    await new Promise((r) => setTimeout(r, 300));

    // Should be same as before stop
    const after = cache.peekPullRequests()?.refreshedAt;
    expect(after).toBe(first);
  });
});

describe("DataCacheManager", () => {
  let manager: DataCacheManager;

  afterEach(() => {
    manager?.stopAll();
  });

  it("creates cache on first access", () => {
    manager = new DataCacheManager();
    const cache1 = manager.getCache(mockConfig);
    expect(cache1).toBeDefined();
  });

  it("returns same cache for same project", () => {
    manager = new DataCacheManager();
    const cache1 = manager.getCache(mockConfig);
    const cache2 = manager.getCache(mockConfig);
    expect(cache1).toBe(cache2);
  });

  it("removeCache stops and removes the cache", async () => {
    manager = new DataCacheManager();
    const cache = manager.getCache(mockConfig);
    cache.start(50);

    manager.removeCache(mockConfig.name);

    // Getting again should create a new cache
    const newCache = manager.getCache(mockConfig);
    expect(newCache).not.toBe(cache);
  });

  it("stopAll stops all caches", () => {
    manager = new DataCacheManager();
    manager.getCache(mockConfig);
    manager.getCache({ ...mockConfig, name: "test2" });

    // Should not throw
    manager.stopAll();
  });
});

describe("cached data format", () => {
  it("includes all required fields", async () => {
    const cache = new ProjectDataCache(mockConfig, {
      ghTimeoutMs: 100,
    });

    const data = await cache.getPullRequests();

    expect(data).toHaveProperty("value");
    expect(data).toHaveProperty("refreshedAt");
    expect(data).toHaveProperty("ageMs");
    expect(data).toHaveProperty("stale");
    // error is optional
    expect(typeof data.refreshedAt).toBe("string");
    expect(typeof data.ageMs).toBe("number");
    expect(typeof data.stale).toBe("boolean");
  });
});
