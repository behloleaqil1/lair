import { afterEach, describe, expect, it } from "vitest";
import {
  ProcessCache,
  initProcessCache,
  getProcessCache,
  disposeProcessCache,
  execPs,
  readPsTable,
  type PsOutput,
  type PsRunner,
} from "./process-cache.js";

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

describe("ProcessCache: only complete tables", () => {
  const SELF = 4321;
  const line = (pid: number, command: string) => `${String(pid).padStart(5)}     1       10:00 ${command}`;
  const table = (...pids: number[]) => `${pids.map((pid) => line(pid, pid === 1 ? "/sbin/init" : `proc-${pid}`)).join("\n")}\n`;
  /** A fake ps: answers with what `next` holds, and counts its runs */
  function fakePs(next: { out: PsOutput }) {
    const calls: number[] = [];
    const run: PsRunner = async () => {
      calls.push(calls.length + 1);
      return next.out;
    };
    return { run, calls };
  }

  it("never uses a table that the timeout stopped, whatever it printed", async () => {
    const next = { out: { stdout: `${table(1, SELF, 5001)}${line(5002, "proc-").slice(0, 9)}`, code: null, killed: true } as PsOutput };
    const cache = new ProcessCache({ runPs: fakePs(next).run, selfPid: SELF });
    await expect(cache.get()).rejects.toThrow("its table may stop part-way, so it is not used");
    expect(cache.peek()).toBeUndefined();

    // With a complete reading before it, the cut one leaves that one (stale), never itself
    let now = 1_000_000;
    const timed = new ProcessCache({ runPs: fakePs(next).run, selfPid: SELF, maxAgeMs: 10_000, clock: () => now });
    next.out = { stdout: table(1, SELF, 5001, 5002), code: 0, killed: false };
    expect((await timed.get()).processes.map((p) => p.pid)).toEqual([1, SELF, 5001, 5002]);
    now += 20_000;
    next.out = { stdout: table(1, SELF, 5001), code: null, killed: true };
    const entry = await timed.get();
    expect(entry).toMatchObject({ stale: true, takenAt: 1_000_000 });
    expect(entry.error).toContain("part-way");
    expect(entry.processes.map((p) => p.pid)).toEqual([1, SELF, 5001, 5002]);
  });

  it("rejects a whole table without this server's own pid, or without pid 1 once a reading has shown it", async () => {
    const next = { out: { stdout: table(1, 5001), code: 0, killed: false } as PsOutput };
    const cache = new ProcessCache({ runPs: fakePs(next).run, selfPid: SELF, maxAgeMs: 0 });
    await expect(cache.get()).rejects.toThrow(`the ps table lacks this server's own pid ${SELF}`);

    // A host that hides other users' processes never shows pid 1: tables without it are used there
    const hidden = new ProcessCache({ runPs: fakePs({ out: { stdout: table(SELF, 5001), code: 0, killed: false } }).run, selfPid: SELF });
    expect((await hidden.get()).processes.map((p) => p.pid)).toEqual([SELF, 5001]);

    // Once pid 1 has been seen, a table without it is cut short
    next.out = { stdout: table(1, SELF, 5001), code: 0, killed: false };
    expect((await cache.getFresh()).processes).toHaveLength(3);
    next.out = { stdout: table(SELF, 5001), code: 0, killed: false };
    await expect(cache.getFresh()).rejects.toThrow("the ps table lacks pid 1");
  });

  it("getFresh runs ps again even when the cached table is young, rejects when that fails, and says when it read", async () => {
    let now = 5_000;
    const next = { out: { stdout: table(1, SELF), code: 0, killed: false } as PsOutput };
    const ps = fakePs(next);
    const slow: PsRunner = async (argv, options) => {
      now += 2_000; // ps takes 2 s
      return ps.run(argv, options);
    };
    const cache = new ProcessCache({ runPs: slow, selfPid: SELF, maxAgeMs: 60_000, clock: () => now });
    expect(await cache.get()).toMatchObject({ readStartedAt: 5_000, takenAt: 7_000 });
    expect(await cache.get()).toMatchObject({ takenAt: 7_000 }); // cached
    expect(ps.calls).toHaveLength(1);
    expect(await cache.getFresh()).toMatchObject({ readStartedAt: 7_000, takenAt: 9_000, stale: false });
    expect(ps.calls).toHaveLength(2);
    next.out = { stdout: "", code: 1, killed: false, error: "ps: cannot read" };
    await expect(cache.getFresh()).rejects.toThrow("ps failed (1)");
    expect(await cache.get()).toMatchObject({ takenAt: 9_000 }); // the last good table stays for get()
  });

  it("the real runner reports a ps the timeout stopped as killed, with what it had printed", async () => {
    const out = await execPs(["sh", "-c", "echo '    1     0       10:00 /sbin/init'; exec sleep 5"], { timeoutMs: 300, maxBytes: 1024 });
    expect(out.killed).toBe(true);
    expect(out.code).not.toBe(0);
    expect(out.stdout).toContain("/sbin/init");
    await expect(readPsTable(async () => out, { timeoutMs: 300, maxBytes: 1024, selfPid: 1, expectInit: false })).rejects.toThrow(
      "part-way",
    );
  });
});
