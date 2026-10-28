import { describe, expect, it, vi } from "vitest";
import { AsyncCache } from "./async-cache.js";

describe("AsyncCache", () => {
  it("refreshes on first get and returns the value", async () => {
    const cache = new AsyncCache({
      refresh: async () => "hello",
      maxAgeMs: 1000,
    });

    const entry = await cache.get();
    expect(entry.value).toBe("hello");
    expect(entry.stale).toBe(false);
    expect(entry.ageMs).toBeLessThan(100);
  });

  it("returns cached value without refreshing when fresh", async () => {
    let calls = 0;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        return `call-${calls}`;
      },
      maxAgeMs: 10_000,
    });

    const first = await cache.get();
    const second = await cache.get();
    expect(first.value).toBe("call-1");
    expect(second.value).toBe("call-1");
    expect(calls).toBe(1);
  });

  it("refreshes when cache is stale", async () => {
    let now = 0;
    let calls = 0;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        return `call-${calls}`;
      },
      maxAgeMs: 100,
      clock: () => now,
    });

    const first = await cache.get();
    expect(first.value).toBe("call-1");

    // Advance past max age
    now = 200;
    const second = await cache.get();
    expect(second.value).toBe("call-2");
    expect(calls).toBe(2);
  });

  it("single-flights concurrent refreshes", async () => {
    let calls = 0;
    let resolve: ((v: string) => void) | null = null;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
      maxAgeMs: 1000,
    });

    // Start multiple concurrent gets
    const p1 = cache.get();
    const p2 = cache.get();
    const p3 = cache.get();

    // Only one refresh should be in flight
    expect(calls).toBe(1);

    // Resolve the single refresh
    resolve!("shared-result");

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.value).toBe("shared-result");
    expect(r2.value).toBe("shared-result");
    expect(r3.value).toBe("shared-result");
    expect(calls).toBe(1);
  });

  it("returns stale value when refresh fails", async () => {
    let now = 0;
    let shouldFail = false;
    const cache = new AsyncCache({
      refresh: async () => {
        if (shouldFail) throw new Error("network error");
        return "good-value";
      },
      maxAgeMs: 100,
      clock: () => now,
    });

    // First get succeeds
    const first = await cache.get();
    expect(first.value).toBe("good-value");
    expect(first.stale).toBe(false);

    // Advance time and make refresh fail
    now = 200;
    shouldFail = true;

    // Should return stale value
    const second = await cache.get();
    expect(second.value).toBe("good-value");
    expect(second.stale).toBe(true);
    expect(second.error).toContain("network error");
  });

  it("throws when refresh fails with no cached value", async () => {
    const cache = new AsyncCache({
      refresh: async () => {
        throw new Error("cannot connect");
      },
      maxAgeMs: 1000,
    });

    await expect(cache.get()).rejects.toThrow("cannot connect");
  });

  it("peek returns undefined when no value cached", () => {
    const cache = new AsyncCache({
      refresh: async () => "value",
      maxAgeMs: 1000,
    });

    expect(cache.peek()).toBeUndefined();
  });

  it("peek returns cached value without triggering refresh", async () => {
    let calls = 0;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        return "value";
      },
      maxAgeMs: 1000,
    });

    // Populate cache
    await cache.get();
    expect(calls).toBe(1);

    // Peek should not trigger refresh
    const peeked = cache.peek();
    expect(peeked?.value).toBe("value");
    expect(calls).toBe(1);
  });

  it("triggerRefresh starts background refresh", async () => {
    let calls = 0;
    let resolve: (() => void) | null = null;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        await new Promise<void>((r) => {
          resolve = r;
        });
        return `call-${calls}`;
      },
      maxAgeMs: 1000,
    });

    // Trigger without waiting
    cache.triggerRefresh();
    expect(calls).toBe(1);
    expect(cache.refreshing).toBe(true);

    // Complete the refresh
    resolve!();
    await new Promise((r) => setTimeout(r, 10));

    expect(cache.refreshing).toBe(false);
    const entry = cache.peek();
    expect(entry?.value).toBe("call-1");
  });

  it("respects refresh timeout", async () => {
    const cache = new AsyncCache({
      refresh: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "late";
      },
      maxAgeMs: 1000,
      refreshTimeoutMs: 50,
    });

    await expect(cache.get()).rejects.toThrow("timed out");
  });

  it("clear forces next get to refresh", async () => {
    let calls = 0;
    const cache = new AsyncCache({
      refresh: async () => {
        calls++;
        return `call-${calls}`;
      },
      maxAgeMs: 10_000,
    });

    const first = await cache.get();
    expect(first.value).toBe("call-1");

    cache.clear();
    expect(cache.peek()).toBeUndefined();

    const second = await cache.get();
    expect(second.value).toBe("call-2");
    expect(calls).toBe(2);
  });

  it("ageMs returns null when no value, and the age otherwise", async () => {
    let now = 1000;
    const cache = new AsyncCache({
      refresh: async () => "value",
      maxAgeMs: 10_000,
      clock: () => now,
    });

    expect(cache.ageMs).toBeNull();

    await cache.get();
    expect(cache.ageMs).toBe(0);

    now = 1500;
    expect(cache.ageMs).toBe(500);
  });
});
