/**
 * Lock files on a real filesystem: the format Lair writes, legacy formats,
 * exclusive creation, hand-over, release and the race-safe removal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLock,
  formatLock,
  judgeLock,
  parseLockContent,
  readLock,
  releaseLock,
  removeLock,
  transferLock,
} from "./locks.js";
import { ProcessSnapshot } from "./probes.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const MIN = 60_000;
const SELF = { pid: 100, startedAt: NOW - 60 * MIN };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-locks-"));
  dirs.push(dir);
  return dir;
}

/** A process table reading at NOW: pid -> start time. */
function snapshot(procs: Record<number, number> = {}): ProcessSnapshot {
  const list = Object.entries(procs).map(([pid, startedAt]) => ({
    pid: Number(pid),
    ppid: 1,
    elapsedSeconds: Math.floor((NOW - startedAt) / 1000),
    argv: ["proc"],
    command: "proc",
  }));
  return new ProcessSnapshot(list, NOW, SELF, 5);
}

describe("lock files", () => {
  it("Lair's format names the pid, its start time and the owner, and round-trips", () => {
    const text = formatLock({ pid: 4242, startedAt: NOW, label: "lair run 1a2b3c4d\ntask x" });
    expect(text).toBe("pid=4242\nstarted=2026-03-02T12:00:00.000Z\nowner=lair run 1a2b3c4d task x\n");
    expect(parseLockContent(text)).toEqual({ format: "lair", pid: 4242, startedAt: NOW, owner: "lair run 1a2b3c4d task x" });
    expect(parseLockContent("4242\n")).toMatchObject({ format: "pid", pid: 4242, startedAt: null });
    expect(parseLockContent("pid: 77")).toMatchObject({ format: "pid", pid: 77 });
    expect(parseLockContent("")).toMatchObject({ format: "none", pid: null });
  });

  it("is created exclusively: a second creator is refused, also by a lock directory", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "a.lock");
    expect(createLock(path, { ...SELF, label: "first" })).toBe(true);
    expect(createLock(path, { pid: 200, startedAt: NOW, label: "second" })).toBe(false);
    expect(readLock(path)).toMatchObject({ format: "lair", pid: SELF.pid, owner: "first" });
    const lockDir = join(dir, "dir.lock");
    mkdirSync(lockDir);
    expect(createLock(lockDir, { ...SELF, label: "x" })).toBe(false);
  });

  it("is handed over and released only by its owner", () => {
    const path = join(tempDir(), "a.lock");
    createLock(path, { ...SELF, label: "server" });
    const agent = { pid: 5001, startedAt: NOW, label: "agent" };
    expect(transferLock(path, { pid: 999, startedAt: NOW }, agent)).toBe(false);
    expect(transferLock(path, SELF, agent)).toBe(true);
    expect(readLock(path)).toMatchObject({ pid: 5001, startedAt: NOW, owner: "agent" });
    expect(releaseLock(path, SELF)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(releaseLock(path, agent)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("removal leaves a lock that changed after it was read to its new holder", () => {
    const path = join(tempDir(), "a.lock");
    writeFileSync(path, "pid=4242\n");
    const read = readLock(path)!;
    writeFileSync(path, formatLock({ pid: 5001, startedAt: NOW, label: "a new holder" }));
    expect(removeLock(read)).toMatchObject({ removed: false });
    expect(readFileSync(path, "utf-8")).toContain("owner=a new holder");
    expect(removeLock(readLock(path)!)).toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
  });

  it("judges holders by pid and start time; legacy locks by pid, or by age", () => {
    const dir = tempDir();
    const lair = join(dir, "lair.lock");
    writeFileSync(lair, formatLock({ pid: 4242, startedAt: NOW - 30 * MIN, label: "x" }));
    expect(judgeLock(readLock(lair), snapshot({ 4242: NOW - 30 * MIN }), 30).state).toBe("held");
    expect(judgeLock(readLock(lair), snapshot({}), 30)).toMatchObject({ state: "stale", reason: "holder pid 4242 is not running" });
    const reused = judgeLock(readLock(lair), snapshot({ 4242: NOW - 2 * MIN }), 30);
    expect(reused.state).toBe("stale");
    if (reused.state === "stale") expect(reused.reason).toContain("is a different process now");

    const legacy = join(dir, "legacy.lock");
    writeFileSync(legacy, "4242\n");
    utimesSync(legacy, new Date(NOW - 20 * MIN), new Date(NOW - 20 * MIN));
    expect(judgeLock(readLock(legacy), snapshot({ 4242: NOW - 25 * MIN }), 30).state).toBe("held");
    expect(judgeLock(readLock(legacy), snapshot({ 4242: NOW - 5 * MIN }), 30).state).toBe("stale");
    expect(judgeLock(readLock(legacy), snapshot({}), 30).state).toBe("stale");

    const pidless = join(dir, "pidless.lock");
    mkdirSync(pidless);
    utimesSync(pidless, new Date(NOW - 20 * MIN), new Date(NOW - 20 * MIN));
    expect(judgeLock(readLock(pidless), snapshot(), 30)).toMatchObject({ state: "young", staleAt: NOW + 10 * MIN });
    expect(judgeLock(readLock(pidless), snapshot(), 15).state).toBe("stale");
    writeFileSync(join(pidless, "pid"), "pid=4242\n");
    utimesSync(pidless, new Date(NOW - 20 * MIN), new Date(NOW - 20 * MIN));
    expect(judgeLock(readLock(pidless), snapshot({ 4242: NOW - 25 * MIN }), 30).state).toBe("held");
    expect(judgeLock(null, snapshot(), 30).state).toBe("free");
  });
});
