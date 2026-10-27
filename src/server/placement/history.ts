/**
 * What the project's files say about finished runs, for learning durations:
 *
 * - a result is `gates_dir/results/<id>.rc`; its mtime is when the run
 *   ended (as the Gates view reads it);
 * - the result's log `results/<id>.log` often prints the run's seconds
 *   (`history.duration_pattern`, by default `time=<N>s`): the last match in
 *   its tail counts;
 * - a runner log (`history.runner_log`, optional) has one tab-separated line
 *   per finished run with its id, exit code, command and lane, in the order
 *   `history.columns` names them. It gives the command and lane of runs
 *   that ended before Lair watched them.
 *
 * All reads are bounded: tails only, lines cut before any pattern runs.
 */
import { isAbsolute, join } from "path";
import { isSafeGateId } from "../services/data.js";
import type { HistoryColumn } from "./config.js";
import type { QueueFiles } from "./probes.js";

const RC_BYTES = 64;
const LOG_TAIL_BYTES = 16 * 1024;
const MAX_LINE = 1000;
/** The runner log's tail that is read, and at most this many lines of it */
const RUNNER_LOG_TAIL_BYTES = 1024 * 1024;
const RUNNER_LOG_LINES = 2000;
const MAX_RUNNER_LINE = 8192;
const SAFE_LANE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface ResultInfo {
  rc: number;
  /** The .rc file's mtime */
  finishedAtMs: number;
  /** The seconds the result's log prints, when it prints them */
  logSeconds: number | null;
}

/** A result for `id`, or null when it has none (yet). */
export function readResult(
  files: QueueFiles,
  gatesDir: string,
  id: string,
  durationPattern: RegExp,
): ResultInfo | null {
  if (!isSafeGateId(id)) return null;
  const resultsDir = join(gatesDir, "results");
  const rcPath = join(resultsDir, `${id}.rc`);
  const st = files.stat(rcPath);
  if (!st || !st.isFile) return null;
  const rc = Number.parseInt((files.head(rcPath, RC_BYTES) ?? "").trim(), 10);
  if (!Number.isFinite(rc)) return null;
  return { rc, finishedAtMs: st.mtimeMs, logSeconds: logSeconds(files, join(resultsDir, `${id}.log`), durationPattern) };
}

/** The last duration the log's tail prints, in seconds, or null. */
export function logSeconds(files: QueueFiles, path: string, pattern: RegExp): number | null {
  const text = files.tail(path, LOG_TAIL_BYTES);
  if (!text) return null;
  const global = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
  let seconds: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.slice(0, MAX_LINE);
    global.lastIndex = 0;
    for (const match of line.matchAll(global)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0) seconds = value;
    }
  }
  return seconds;
}

export interface RunnerLogLine {
  id: string;
  rc: number;
  command: string;
  lane: string;
  /** The time column, when there is one and it parses */
  atMs: number | null;
}

/** The runner log's path: relative paths are under gates_dir. */
export function runnerLogPath(gatesDir: string, path: string): string {
  return isAbsolute(path) ? path : join(gatesDir, path);
}

/**
 * The finished runs in the runner log's tail, oldest first: lines whose rc
 * column is an integer and whose id and lane are safe names. Other lines
 * (starts, waits, notes) are skipped.
 */
export function readRunnerLog(files: QueueFiles, path: string, columns: readonly HistoryColumn[]): RunnerLogLine[] {
  const text = files.tail(path, RUNNER_LOG_TAIL_BYTES);
  if (!text) return [];
  const lines = text.split("\n");
  // The first line of a tail may be cut: skip it unless the whole file was read
  const start = text.length >= RUNNER_LOG_TAIL_BYTES ? 1 : 0;
  const out: RunnerLogLine[] = [];
  for (const raw of lines.slice(Math.max(start, lines.length - RUNNER_LOG_LINES))) {
    const fields = raw.slice(0, MAX_RUNNER_LINE).replace(/\r$/, "").split("\t");
    if (fields.length < columns.length - 1) continue;
    const get = (name: HistoryColumn) => {
      const i = columns.indexOf(name);
      return i >= 0 && i < fields.length ? fields[i] : undefined;
    };
    const id = get("id")?.trim();
    const rcText = get("rc")?.trim();
    const lane = get("lane")?.trim();
    const command = get("command") ?? "";
    if (!id || !isSafeGateId(id) || !lane || !SAFE_LANE.test(lane)) continue;
    if (!rcText || !/^-?\d{1,4}$/.test(rcText)) continue;
    const time = get("time");
    const atMs = time ? Date.parse(time.trim()) : NaN;
    out.push({ id, rc: Number(rcText), command, lane, atMs: Number.isFinite(atMs) ? atMs : null });
  }
  return out;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One learned run, as the index needs it. */
export interface IndexedSample {
  class: string;
  machine: string;
  seconds: number;
  /** The load factor while it ran, when measured */
  factor: number | null;
  /** Its exit code; null for a sample learned before rc was kept */
  rc: number | null;
}

export interface DurationRow {
  class: string;
  machine: string;
  medianSeconds: number;
  samples: number;
}

/**
 * The newest `n` samples per class and machine (and per class, per machine),
 * passed runs (rc 0) apart from all runs: durations come from passed runs
 * when there are any, so a failed run's time counts only while nothing
 * better is known.
 */
export class SampleIndex {
  private passed = new Map<string, number[]>();
  private passedClass = new Map<string, number[]>();
  private all = new Map<string, number[]>();
  private allClass = new Map<string, number[]>();
  private allMachine = new Map<string, number[]>();
  private factors = new Map<string, number[]>();

  constructor(private n: number) {}

  private static key(cls: string, machine: string): string {
    return `${cls}\u0000${machine}`;
  }

  private put(map: Map<string, number[]>, key: string, value: number, newest: boolean): void {
    const list = map.get(key) ?? [];
    if (newest) {
      list.unshift(value);
      if (list.length > this.n) list.length = this.n;
    } else if (list.length < this.n) {
      list.push(value);
    }
    map.set(key, list);
  }

  private insert(s: IndexedSample, newest: boolean): void {
    const key = SampleIndex.key(s.class, s.machine);
    if (s.rc === 0) {
      this.put(this.passed, key, s.seconds, newest);
      this.put(this.passedClass, s.class, s.seconds, newest);
    }
    this.put(this.all, key, s.seconds, newest);
    this.put(this.allClass, s.class, s.seconds, newest);
    this.put(this.allMachine, s.machine, s.seconds, newest);
    if (s.factor !== null) this.put(this.factors, s.machine, s.factor, newest);
  }

  /** Add samples newest first (as the store lists them). */
  add(s: IndexedSample): void {
    this.insert(s, false);
  }

  /** Add one just learned: newer than all the others. */
  addNewest(s: IndexedSample): void {
    this.insert(s, true);
  }

  /** What a run of the class usually takes on the machine: passed runs there, else on any machine. */
  reference(cls: string, machine: string): number | null {
    return median(this.passed.get(SampleIndex.key(cls, machine)) ?? []) ?? median(this.passedClass.get(cls) ?? []);
  }

  /** The expected duration before load, or null when nothing is learned. */
  base(cls: string, machine: string): number | null {
    const key = SampleIndex.key(cls, machine);
    return (
      median(this.passed.get(key) ?? []) ??
      median(this.passedClass.get(cls) ?? []) ??
      median(this.all.get(key) ?? []) ??
      median(this.allClass.get(cls) ?? []) ??
      median(this.allMachine.get(machine) ?? [])
    );
  }

  /** The machine's usual load factor while running gates (at least 1). */
  usualFactor(machine: string): number {
    return Math.max(1, median(this.factors.get(machine) ?? []) ?? 1);
  }

  /** Per class and machine: the median used (passed runs when there are any) and how many runs it is of. */
  table(): DurationRow[] {
    const rows = [...this.all.entries()].map(([key, values]) => {
      const [cls, machine] = key.split("\u0000");
      const used = this.passed.get(key) ?? values;
      return { class: cls, machine, medianSeconds: Math.round(median(used) ?? 0), samples: used.length };
    });
    return rows.sort((a, b) => a.class.localeCompare(b.class) || a.machine.localeCompare(b.machine));
  }
}
