/**
 * Shared process snapshot: one ps call per interval for all modules.
 *
 * The watchdog, agents and health checks all need the process table. Before
 * this, each called ps itself, and under load those calls piled up. Now one
 * AsyncCache holds the snapshot; every module reads from it.
 *
 * A failed ps keeps the last good snapshot, marked stale. A ps that the
 * timeout (or the output cap) stopped failed, whatever it printed: its table
 * may stop part-way, and a process missing from it is not proof that it
 * ended. A table without this server's own pid (or without pid 1, once a
 * reading has shown it) is not complete either, and fails the same way.
 */
import { execFile } from "child_process";
import type { ProcessInfo, ProcessReading, ProcessTable } from "../watchdog/probes.js";
import { parsePsOutput, PS_ARGV } from "../watchdog/probes.js";
import { AsyncCache } from "./async-cache.js";

export interface ProcessSnapshotEntry {
  /** The process list */
  processes: ProcessInfo[];
  /** When the snapshot was taken (ms since epoch): when ps answered */
  takenAt: number;
  /** When the ps that took it was started (ms since epoch) */
  readStartedAt?: number;
  /** Whether the snapshot is stale (refresh failed or timed out) */
  stale: boolean;
  /** Age of the snapshot in milliseconds */
  ageMs: number;
  /** The error if the last refresh failed */
  error?: string;
}

/** What one `ps` run printed, and how it ended. */
export interface PsOutput {
  stdout: string;
  /** Exit code; null when a signal ended it */
  code: number | null;
  /** The timeout or the output cap stopped it: what it printed may stop part-way */
  killed: boolean;
  /** Why it failed, when it did */
  error?: string;
}

/** Runs `ps` (the boundary tests replace): never rejects, the output says how it ended. */
export type PsRunner = (argv: string[], options: { timeoutMs: number; maxBytes: number }) => Promise<PsOutput>;

export interface ProcessCacheOptions {
  /** How often to refresh the cache in the background (ms); default 5_000 */
  refreshIntervalMs?: number;
  /** Maximum age before the cache is considered stale (ms); default 10_000 */
  maxAgeMs?: number;
  /** Timeout for the ps command (ms); default 15_000 */
  psTimeoutMs?: number;
  /** Maximum output from ps (bytes); default 64 MiB */
  psMaxBytes?: number;
  /** A clock for testing */
  clock?: () => number;
  /** Runs ps; default execFile (tests replace it) */
  runPs?: PsRunner;
  /** This server's pid, which every complete table holds; default process.pid */
  selfPid?: number;
}

/**
 * Max output from ps: a busy machine can have many processes with long
 * argument lists (JVM classpaths, build commands). 64 MiB is generous.
 */
const DEFAULT_PS_MAX_BYTES = 64 * 1024 * 1024;

/** The real ps: execFile, its output as a buffer (a large table never throws a maxBuffer error mid-string). */
export const execPs: PsRunner = (argv, { timeoutMs, maxBytes }) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (!file) {
      resolve({ stdout: "", code: null, killed: false, error: "empty ps command" });
      return;
    }
    execFile(file, args, { timeout: timeoutMs, maxBuffer: maxBytes, encoding: "buffer" }, (error, stdout) => {
      const text = stdout ? stdout.toString("utf-8") : "";
      if (!error) {
        resolve({ stdout: text, code: 0, killed: false });
        return;
      }
      // execFile reports a child that exited 0 as success even when its timer fired late (a blocked event loop),
      // so an error here means ps really failed, or was stopped part-way
      const code = typeof error.code === "number" ? error.code : null;
      const killed = error.killed === true || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      resolve({ stdout: text, code, killed, error: error.message });
    });
  });

/**
 * Run ps and parse its table. Rejects when ps failed or was stopped part-way, and when the table can't be complete:
 * it lacks this server's own pid, or pid 1 while `expectInit` (a host that hides other users' processes never shows
 * pid 1, so it is expected once a reading has shown it).
 */
export async function readPsTable(
  run: PsRunner,
  options: { timeoutMs: number; maxBytes: number; selfPid: number; expectInit: boolean },
): Promise<ProcessInfo[]> {
  const out = await run(PS_ARGV, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
  if (out.killed) {
    throw new Error(
      `ps was stopped after ${options.timeoutMs} ms or ${options.maxBytes} bytes: its table may stop part-way, so it is not used`,
    );
  }
  if (out.code !== 0) throw new Error(`ps failed (${out.code ?? "signal"}): ${out.error ?? "no table"}`);
  const processes = parsePsOutput(out.stdout);
  const pids = new Set(processes.map((p) => p.pid));
  if (!pids.has(options.selfPid)) {
    throw new Error(`the ps table lacks this server's own pid ${options.selfPid}: it is not complete, so it is not used`);
  }
  if (options.expectInit && !pids.has(1)) throw new Error("the ps table lacks pid 1: it is not complete, so it is not used");
  return processes;
}

interface PsReading {
  processes: ProcessInfo[];
  startedAt: number;
  takenAt: number;
}

function toEntry(value: PsReading, entry: { stale: boolean; ageMs: number; error?: string }): ProcessSnapshotEntry {
  return {
    processes: value.processes,
    takenAt: value.takenAt,
    readStartedAt: value.startedAt,
    stale: entry.stale,
    ageMs: entry.ageMs,
    error: entry.error,
  };
}

/**
 * A shared process cache that all modules can read from.
 */
export class ProcessCache {
  private readonly cache: AsyncCache<PsReading>;
  private readonly refreshIntervalMs: number;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;
  /** A reading has shown pid 1: every complete one does from now on */
  private seenInit = false;

  constructor(options: ProcessCacheOptions = {}) {
    const psTimeoutMs = options.psTimeoutMs ?? 15_000;
    const maxBytes = options.psMaxBytes ?? DEFAULT_PS_MAX_BYTES;
    const runPs = options.runPs ?? execPs;
    const selfPid = options.selfPid ?? process.pid;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
    this.clock = options.clock ?? (() => Date.now());

    this.cache = new AsyncCache({
      refresh: async () => {
        const startedAt = this.clock();
        const processes = await readPsTable(runPs, { timeoutMs: psTimeoutMs, maxBytes, selfPid, expectInit: this.seenInit });
        if (processes.some((p) => p.pid === 1)) this.seenInit = true;
        return { processes, startedAt, takenAt: this.clock() };
      },
      maxAgeMs: options.maxAgeMs ?? 10_000,
      refreshTimeoutMs: psTimeoutMs + 1000, // A bit more than ps timeout
      clock: this.clock,
    });
  }

  /**
   * Start background refreshes at the configured interval.
   */
  start(): void {
    if (this.timer) return;
    // Trigger an initial refresh
    this.cache.triggerRefresh();
    this.timer = setInterval(() => {
      this.cache.triggerRefresh();
    }, this.refreshIntervalMs);
    // Don't block process exit
    this.timer.unref();
  }

  /**
   * Stop background refreshes.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get the process snapshot, refreshing if stale.
   */
  async get(): Promise<ProcessSnapshotEntry> {
    const entry = await this.cache.get();
    return toEntry(entry.value, entry);
  }

  /**
   * A snapshot taken by a ps started after this call, never one kept from before (a refresh in flight may have
   * started earlier: it is waited out first). Rejects when that ps fails: no stale snapshot stands in for it.
   */
  async getFresh(): Promise<ProcessSnapshotEntry> {
    const entry = await this.cache.fresh();
    return toEntry(entry.value, entry);
  }

  /**
   * Get the cached snapshot without triggering a refresh.
   * Returns undefined if no snapshot has been taken yet.
   */
  peek(): ProcessSnapshotEntry | undefined {
    const entry = this.cache.peek();
    if (!entry) return undefined;
    return toEntry(entry.value, entry);
  }

  /**
   * Trigger a background refresh without waiting.
   */
  triggerRefresh(): void {
    this.cache.triggerRefresh();
  }

  /**
   * Whether a refresh is currently in progress.
   */
  get refreshing(): boolean {
    return this.cache.refreshing;
  }

  /**
   * The age of the current snapshot in milliseconds, or null if none.
   */
  get ageMs(): number | null {
    return this.cache.ageMs;
  }
}

/** The singleton process cache, initialized by the server. */
let sharedCache: ProcessCache | null = null;

/**
 * Get the shared process cache. Creates one if it doesn't exist.
 * The server should call initProcessCache() at startup with options.
 */
export function getProcessCache(): ProcessCache {
  if (!sharedCache) {
    sharedCache = new ProcessCache();
  }
  return sharedCache;
}

/**
 * Initialize the shared process cache with options.
 * Should be called once at server startup.
 */
export function initProcessCache(options?: ProcessCacheOptions): ProcessCache {
  if (sharedCache) {
    sharedCache.stop();
  }
  sharedCache = new ProcessCache(options);
  return sharedCache;
}

/**
 * Dispose of the shared process cache.
 * Should be called at server shutdown.
 */
export function disposeProcessCache(): void {
  if (sharedCache) {
    sharedCache.stop();
    sharedCache = null;
  }
}

/**
 * A ProcessTable implementation that reads from the shared ProcessCache.
 * This adapter allows the agents and watchdog modules to use the cache
 * without changing their ProcessTable interface.
 */
export class CachedProcessTable implements ProcessTable {
  constructor(private cache: ProcessCache) {}

  async list(): Promise<ProcessInfo[]> {
    const entry = await this.cache.get();
    return entry.processes;
  }

  /** The snapshot with the time it was taken (it may be seconds old), or a fresh one. */
  async read(options: { fresh?: boolean } = {}): Promise<ProcessReading> {
    const entry = options.fresh ? await this.cache.getFresh() : await this.cache.get();
    return { processes: entry.processes, startedAt: entry.readStartedAt ?? entry.takenAt, takenAt: entry.takenAt };
  }
}
