/**
 * The operating-system measures the self-checks read: the event loop's
 * delay, this process's open file descriptors and their limit, and a
 * filesystem's free space. Tests replace this one boundary (with the clock
 * and the spawner); the checks read Lair's own files for real.
 *
 * Open files: Linux counts /proc/self/fd and reads the limit from
 * /proc/self/limits; macOS counts /dev/fd and reads the limit from the
 * process report; anywhere else, or when those fail, `lsof -p <pid>` is run
 * with a timeout. The limit is read once, the first time it is needed, and
 * kept for the process's life: it doesn't change while the process runs,
 * and the report blocks the event loop while it is gathered. A measure that
 * isn't available here is null: its check reports unknown.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";
import { readFile, readdir, statfs } from "fs/promises";
import { SpawnToolRunner, type ToolRunner } from "../ai/runner.js";

export interface LoopDelay {
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface OpenFiles {
  open: number;
  /** The soft limit; null when it isn't known */
  limit: number | null;
  /** How it was counted: proc, dev-fd or lsof */
  source: string;
}

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface OsMeasures {
  /** The event loop's delay since the last call (then the histogram starts over); null when it can't be measured */
  eventLoopDelay(): LoopDelay | null;
  /** Forget the delays measured so far (the server's own start-up, say) */
  resetEventLoopDelay?(): void;
  openFiles(): Promise<OpenFiles | null>;
  /** The free and total space of the filesystem that holds `path` */
  diskSpace(path: string): Promise<DiskSpace | null>;
}

/** How often the event loop is sampled (ms): Node's histogram records each whole interval, so this is taken off */
const LOOP_RESOLUTION_MS = 20;
const LSOF_TIMEOUT_MS = 5000;
const LSOF_MAX_BYTES = 8 * 1024 * 1024;

/** The soft "Max open files" of /proc/self/limits, or null. */
export function parseProcLimits(text: string): number | null {
  const line = text.split("\n").find((l) => l.startsWith("Max open files"));
  const soft = line?.slice("Max open files".length).trim().split(/\s+/)[0];
  if (!soft) return null;
  if (soft === "unlimited") return null;
  const n = Number(soft);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The open file descriptors in `lsof -n -P -p <pid>` output: rows whose FD column is a number (cwd, txt and mem rows are not). */
export function countLsofDescriptors(output: string): number {
  let n = 0;
  for (const line of output.split("\n").slice(1)) {
    const fd = line.slice(0, 500).trim().split(/\s+/)[3];
    if (fd !== undefined && /^\d+[a-zA-Z-]*$/.test(fd)) n++;
  }
  return n;
}

/**
 * Node's own process report (synchronous: it blocks the event loop while it
 * gathers), without its network section, so no DNS lookups.
 */
export function processReport(): unknown {
  const report = process.report as unknown as { excludeNetwork?: boolean; getReport(): unknown };
  const previous = report.excludeNetwork;
  try {
    report.excludeNetwork = true;
    return report.getReport();
  } finally {
    report.excludeNetwork = previous;
  }
}

/** The soft open-files limit in a process report (`userLimits.open_files.soft`), or null. */
function reportLimit(readReport: () => unknown): number | null {
  try {
    const data = readReport() as { userLimits?: { open_files?: { soft?: unknown } } } | null;
    const soft = data?.userLimits?.open_files?.soft;
    return typeof soft === "number" && Number.isSafeInteger(soft) && soft > 0 ? soft : null;
  } catch {
    return null;
  }
}

export class SystemMeasures implements OsMeasures {
  private histogram: IntervalHistogram | null = null;
  /** The soft limit, read once: a process's limit doesn't change while it runs (the server makes one SystemMeasures) */
  private limit: Promise<number | null> | null = null;

  constructor(
    private readonly runner: ToolRunner = new SpawnToolRunner(),
    private readonly platform: NodeJS.Platform = process.platform,
    /** Where the limit comes from without /proc (macOS): the process report, read once */
    private readonly readReport: () => unknown = processReport,
  ) {
    try {
      this.histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      this.histogram.enable();
    } catch {
      this.histogram = null;
    }
  }

  eventLoopDelay(): LoopDelay | null {
    const h = this.histogram;
    if (!h) return null;
    // Nanoseconds of a whole sampling interval: the delay is what goes past the interval
    const late = (ns: number) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS) : 0);
    const delay = h.count === 0 ? { p99Ms: 0, maxMs: 0, meanMs: 0 } : { p99Ms: late(h.percentile(99)), maxMs: late(h.max), meanMs: late(h.mean) };
    h.reset();
    return delay;
  }

  resetEventLoopDelay(): void {
    this.histogram?.reset();
  }

  async openFiles(): Promise<OpenFiles | null> {
    const dir = this.platform === "linux" ? "/proc/self/fd" : this.platform === "darwin" ? "/dev/fd" : null;
    if (dir) {
      try {
        // The listing opens one descriptor of its own
        const open = Math.max(0, (await readdir(dir)).length - 1);
        return { open, limit: await this.softLimit(), source: this.platform === "linux" ? "proc" : "dev-fd" };
      } catch {
        // lsof below
      }
    }
    const out = await this.runner.run(["lsof", "-n", "-P", "-p", String(process.pid)], {
      timeoutMs: LSOF_TIMEOUT_MS,
      maxBytes: LSOF_MAX_BYTES,
      env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/bin" },
    });
    if (out.code !== 0 || out.failure) return null;
    return { open: countLsofDescriptors(out.stdout), limit: await this.softLimit(), source: "lsof" };
  }

  private softLimit(): Promise<number | null> {
    this.limit ??= this.readLimit();
    return this.limit;
  }

  private async readLimit(): Promise<number | null> {
    if (this.platform === "linux") {
      try {
        const value = parseProcLimits((await readFile("/proc/self/limits", "utf-8")).slice(0, 8192));
        if (value !== null) return value;
      } catch {
        // The report below
      }
    }
    return reportLimit(this.readReport);
  }

  async diskSpace(path: string): Promise<DiskSpace | null> {
    try {
      const s = await statfs(path);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.histogram?.disable();
    this.histogram = null;
  }
}
