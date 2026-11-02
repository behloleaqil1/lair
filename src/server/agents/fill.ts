/**
 * Fill (agents.fill, docs/configuration.md#fill): Lair starts agent runs
 * itself from a task list, so a project needs no launcher loop of its own.
 *
 * Every fill.interval_seconds each tasks_file line
 * (`<agent>|<name>|<task>|<description>`) is looked at in file order. It is:
 * - not_allowlisted when its agent isn't in fill.agents (another launcher may
 *   still run that agent): fill never starts it;
 * - unassigned when it names no agent (`|<name>|<task>|<description>`):
 *   fill never starts it. It is ready work for any allowlisted agent while
 *   it is open (no active run or claim on its task, no done line in the
 *   queue, its last run not waiting or blocked; see unassignedLine), and an
 *   agent idle while ready work exists raises one notice (fill.idle, idle.ts);
 * - started when a run of its agent on its task is active;
 * - claimed when another agent's run, or any other claim, holds the task;
 * - done when done_pattern matches a queue line written since the task's
 *   last chain was requested (the whole file for a task with no run, when
 *   the pattern names the task; one that names only the agent counts only
 *   that agent's own lines, only since a start, and only when its last DONE,
 *   WAITING or BLOCKED line is the DONE one). Once
 *   seen, done is kept in the store (a fill_done event for the task's latest
 *   run and the line as written), so a rotated or truncated queue file never
 *   restarts a finished task. An edited line drops that record, but the queue
 *   scan finds the DONE line again while it is in the window; only a new run
 *   of the task (the owner requests one: a new run id and queue mark) makes
 *   the lines written before it not count;
 * - held, with the reason, when:
 *   - owner: its last run ended other than completed (escalated, stopped by
 *     the owner, its claim lost). The owner's to resume; a claim lost without
 *     the owner releasing it raises a decision (an escalated chain already
 *     raised its own);
 *   - blocked: its last run exited 0 on a BLOCKED line for the task (the
 *     latest of its WAITING and BLOCKED lines): held at once, with one
 *     decision carrying the line (as data, never in a prompt);
 *   - waiting: its last run exited 0 on a WAITING line. With a (?<wake>...)
 *     capture and fill.wake.file (a plain name, inside wake.root) it starts
 *     again once that file appears (a gate's result, say), with no backoff
 *     and nothing counted. A wait on nothing that came (no capture, a refused
 *     one, or a file already there when the run ended) counts as a run
 *     without progress: it starts again after wake.fallback_seconds and the
 *     backoff, and toward the no_done hold;
 *   - waited_too_long: its runs have been waiting, in a row, longer than
 *     wake.max_wait_minutes (counted from the store, across restarts),
 *     not counting the time the gate the latest one waits on was still in
 *     the gate queue (<lane>.<pri>.<id>.req or .req.run, under its id or one
 *     wake.requeue_marker names it re-queued as): such a live wait is held
 *     only past wake.max_queue_wait_minutes. Held, with one decision, until
 *     the owner answers. A wake fill finds there ends the wait instead: a
 *     woken task is never newly held, only one already held stays so;
 *   - no_done / backoff: its runs exited 0 without reporting it done. It is
 *     started again after a backoff (fill.backoff_seconds, doubling), and
 *     after fill.max_completions_without_done of them in a row it is held and
 *     one decision is raised, with the last output;
 *   - busy, read_only, max_active, capacity (capacity_cmd), prompt (a
 *     refused prompt file) or refused (the run request);
 *   the owner releases an owner, no_done, blocked or waiting hold from the
 *   Agents view, or by answering the decision;
 * - otherwise started: the prompt is built from prompt_files and the run is
 *   requested through AgentsService.requestRun, the module's in-process path,
 *   so claims, locks, never-started retries, recovery, failover and budgets
 *   apply to it as to any run.
 * Input is bounded: the tasks file (256 KB, 200 tasks, 2000 characters a
 * line), each prompt file (200 KB, a regular file inside prompts_dir with no
 * symlink out of it) and the queue file (its last 4 MB, lines cut at 1000
 * characters and trimmed before done_pattern sees them).
 */
import { createHash } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, type Dir } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type { Decision } from "../../shared/decision-types.js";
import type {
  AgentEventKind,
  AgentRunView,
  FillCapacityView,
  FillHold,
  FillLineState,
  FillLineView,
  FillQueuedGateView,
  FillStatusView,
  FillUnmatchedReportView,
  FillWaitingView,
} from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { parseGateFilename } from "../parsers/gates.js";
import { attributedAgent } from "../parsers/queue.js";
import { getPromptsDir } from "../routes/controls.js";
import {
  anyAgentPatternFor,
  backoffMs,
  fillPatternFor,
  getAgentClass,
  matchesByAgent,
  reportPatternFor,
  REPORTED_TASK_GROUP,
  taskLineMatch,
  isPlainName,
  type FillPattern,
  type FillSettings,
} from "./config.js";
import { escalationDecisionKey, type DecisionRequest } from "./decisions.js";
import { computeIdleStates, findReadyWork, idleExplanation, idleStateView, shouldNotice, type IdleInput, type IdleState } from "./idle.js";
import type { AgentProbes, MemoryReading } from "./probes.js";
import { MAX_PROMPT_FILE_BYTES } from "./prompts.js";
import { lastLines, readTail } from "./sessions.js";
import type { AgentsStore } from "./store.js";
import { isActive, isValidTaskId, type AgentRun, type QueueMark } from "./types.js";
import type { ProcessInfo } from "../watchdog/probes.js";
import { evaluateReady, isPrWork, parseReadyReport, refuseReport, unverifiable, type ParsedReport, type ReadyFactsSource, type ReadyVerdict } from "../ready-guard/guard.js";
import { extractBusId, mirroredReport, type BusLineSource, type StructuredReport } from "../bus/consumers.js";

export const MAX_TASKS_FILE_BYTES = 256 * 1024;
export const MAX_TASK_LINES = 200;
export const MAX_TASK_LINE_CHARS = 2000;
const CAPACITY_PROBE_TIMEOUT_MS = 5_000;
/** After the git host failed or timed out, the ready guard leaves it alone this long */
const HOST_BACKOFF_MS = 60_000;

/** What one fill check reads of the machine and of the heavy work, once */
interface CapacityState {
  machine?: Promise<{ cpus: number; load: number; total: number; memory?: MemoryReading }>;
  heavy?: number;
}
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const QUEUE_LINE_CHARS = 1000;
const MARK_TAIL_BYTES = 256;
/** Checks in a row a held line must be gone from the tasks file before its decision is withdrawn */
export const LINE_GONE_CHECKS = 3;

/** Where a hold's decision stands (AgentsFill.holdDecision) */
export type HoldDecisionState =
  | { status: "unknown" }
  | { status: "none" }
  | { status: "open"; id: string }
  | { status: "withdrawn"; id: string }
  | { status: "answered"; id: string; optionId: string | null };

/**
 * The decision options fill offers for a task it holds for the owner:
 * "Start it again" releases the hold, "Keep it paused" turns it into the
 * owner's own pause (a `paused` hold, which waits for nobody).
 */
export const DECISION_FILL_START = "start_again";
export const DECISION_FILL_KEEP = "keep_held";
/** Holds the owner lifts (POST /api/agents/fill/release, or the decision); a waiting one also ends by itself */
export const OWNER_HOLDS: readonly FillHold[] = ["owner", "no_done", "blocked", "waiting", "waited_too_long", "paused"];

const short = (id: string) => id.slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The key of a fill decision about `task` while `runId` is its latest run,
 * per kind of hold (the task id may hold ':'; a run id doesn't, so it is last).
 */
export const fillDecisionKey = (task: string, runId: string, kind?: "blocked" | "waiting") =>
  `fill:${task}:${kind ? `${kind}:` : ""}${runId}`;

/**
 * The key of the decision about a refused task: per release (`since`, the
 * owner's last release of the task, or "0"), so a refusal that comes back
 * after "Start it again" asks again; the latest run (or "none") is last.
 */
export const fillRefusedKey = (task: string, since: string, runId: string | null) =>
  `fill:${task}:refused:${since}:${runId ?? "none"}`;

/** The one option of an idle notice (fill.idle): it asks nothing */
export const IDLE_NOTICE_NOTED = "noted";
/** The key of an agent's idle notice: one per episode (`since`, when it began idling while ready work existed, in ms). */
export const idleNoticeKey = (agent: string, since: number) => `fill-idle:${agent}:${since}`;
/** The agent and episode of an idle notice's key, or null for any other key. */
export function parseIdleNoticeKey(key: string): { agent: string; since: number } | null {
  const match = /^fill-idle:([A-Za-z][A-Za-z0-9_-]{0,63}):(\d{1,15})$/.exec(key);
  return match ? { agent: match[1], since: Number(match[2]) } : null;
}

/** How a run that ended other than completed ended, in plain words (never its log). */
function howItEnded(run: AgentRun): string {
  const detail = run.detail.toLowerCase();
  if (detail.startsWith("exit unknown")) return "its last run failed while Lair was restarting";
  if (detail.startsWith("stopped by the owner") || detail.includes("stopped by you")) return "you stopped its last run";
  if (detail.startsWith("crashed")) return "its last run crashed";
  if (detail.startsWith("dead on start")) return "its last run died as it started";
  if (detail.startsWith("hung")) return "its last run hung and was stopped";
  if (run.state === "never_started" || detail.startsWith("never started")) return "its last run never started";
  if (run.failover) return "its last run hit provider errors or rate limits";
  if (run.state === "lost_claim") return "you released its claim on the task";
  return `its last run ended ${run.state.replace(/_/g, " ")}`;
}

/** Agent-written text for a decision's context: one line, bounded, in a code block (data, never markdown). */
function asData(text: string, max = 300): string[] {
  return ["```text", oneLine(text, max).replace(/`/g, "'"), "```"];
}

// ============ FILES ============

export type Opened = { fd: number; size: number } | { error: string };

/**
 * Open a regular file for reading. O_NONBLOCK, so a FIFO put in its place
 * doesn't block the server (it is refused as not a regular file);
 * `noFollow` refuses a symlink as the last component. Shared with the
 * planner's source reads (src/server/planner/files.ts).
 */
export function openRegular(path: string, noFollow: boolean): Opened {
  let fd: number;
  try {
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
    fd = openSync(path, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      error: code === "ENOENT" ? "does not exist" : code === "ELOOP" ? "is a symlink" : `cannot be read (${code ?? message(e)})`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return { error: "is not a regular file" };
    }
    return { fd, size: st.size };
  } catch (e) {
    closeSync(fd);
    return { error: `cannot be read (${message(e)})` };
  }
}

export function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

/** A whole regular file of at most `maxBytes`, as text. */
export function readBounded(path: string, maxBytes: number, noFollow: boolean): { ok: true; text: string } | { ok: false; reason: string } {
  const opened = openRegular(path, noFollow);
  if ("error" in opened) return { ok: false, reason: opened.error };
  try {
    if (opened.size > maxBytes) return { ok: false, reason: `is larger than ${maxBytes} bytes (${opened.size})` };
    return { ok: true, text: readAt(opened.fd, 0, opened.size).toString("utf-8") };
  } catch (e) {
    return { ok: false, reason: `cannot be read (${message(e)})` };
  } finally {
    closeSync(opened.fd);
  }
}

// ============ THE QUEUE FILE ============

const EMPTY_TAIL = sha256(Buffer.alloc(0));

/** Where the queue file stands now (see QueueMark); offset 0 when it can't be read. */
export function queueMark(path: string): QueueMark {
  const opened = openRegular(path, false);
  if ("error" in opened) return { offset: 0, tail: EMPTY_TAIL };
  try {
    const length = Math.min(opened.size, MARK_TAIL_BYTES);
    return { offset: opened.size, tail: sha256(readAt(opened.fd, opened.size - length, length)) };
  } catch {
    return { offset: 0, tail: EMPTY_TAIL };
  } finally {
    closeSync(opened.fd);
  }
}

/** How a run that exited 0 without the done line ended: on a WAITING or a BLOCKED line for its task. */
interface RunStatus {
  kind: "waiting" | "blocked";
  /** The line as the agent wrote it (cut at 1000 characters): data, never a prompt */
  line: string;
  /** What a waiting line names to wait on ((?<wake>...)), not yet checked */
  wake: string | null;
  /** bus.consume on: the id of the bus report the line was read from (its gate id is the wake), else null */
  busId: number | null;
}

/** What a waiting run waits on (see AgentsFill.classifyWait); `named` is a wake that resolved to a file, else null. */
type WaitState =
  | { kind: "pending"; named: string | null; view: FillWaitingView; detail: string; file: string }
  | { kind: "woken"; named: string | null; file: string }
  | { kind: "weak"; named: string | null; view: FillWaitingView; detail: string; fallbackAt: number | null };

/** How many of a task's newest chains the no-done count and the wait streak look at */
const MAX_CHAINS_LOOKED_AT = 50;

// ============ THE GATE QUEUE ============

/** At most this many entries of gates_dir/queue are looked at per check */
const GATE_QUEUE_MAX_ENTRIES = 20_000;
/** A re-queue marker's first line is read from at most this many bytes */
const MARKER_MAX_BYTES = 512;
/** At most this many ids are followed from a waiting line's gate through re-queue markers */
export const MAX_REQUEUE_IDS = 10;
/** {n} in wake.requeue_marker takes 1 to this */
const MAX_MARKER_N = 9;

/** A gate request in gates_dir/queue: queued (<lane>.<pri>.<id>.req) or running (.req.run). */
export interface QueuedRequest {
  lane: string;
  status: "queued" | "running";
  path: string;
}

/**
 * The gate queue's queued and running requests by gate id, read with the
 * gates parser (any other status, such as .req.stuck, is not in the queue).
 * Bounded: the first GATE_QUEUE_MAX_ENTRIES entries; a directory or a
 * symlink is never a request. A running request wins over a queued one.
 */
export function readGateQueue(gatesDir: string): Map<string, QueuedRequest> {
  const requests = new Map<string, QueuedRequest>();
  const dir = join(gatesDir, "queue");
  let handle: Dir;
  try {
    handle = opendirSync(dir);
  } catch {
    return requests;
  }
  try {
    for (let i = 0; i < GATE_QUEUE_MAX_ENTRIES; i++) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entry.isDirectory() || entry.isSymbolicLink()) continue;
      const gate = parseGateFilename(entry.name);
      if (!gate || (gate.status !== "queued" && gate.status !== "running")) continue;
      if (requests.get(gate.id)?.status === "running") continue;
      requests.set(gate.id, { lane: gate.lane, status: gate.status === "running" ? "running" : "queued", path: join(dir, entry.name) });
    }
  } catch {
    // What was read before the error stands
  } finally {
    handle.closeSync();
  }
  return requests;
}

/** A waiting run's gate that is still in the gate queue: the wait is alive. */
interface QueuedGate {
  gate: string;
  /** The id the waiting line named, when `gate` is what a re-queue marker says it became */
  requeuedFrom: string | null;
  lane: string;
  status: "queued" | "running";
  path: string;
  /** The request file's mtime: when it was written */
  since: number;
}

const queuedGateView = (q: QueuedGate): FillQueuedGateView => ({
  gate: q.gate,
  requeuedFrom: q.requeuedFrom,
  lane: q.lane,
  status: q.status,
  since: iso(q.since),
});

/** "<gate> still queued in <lane> since <time>" */
const queuedText = (q: QueuedGate) =>
  `${q.gate}${q.requeuedFrom ? ` (re-queued from ${q.requeuedFrom})` : ""} still ${q.status} in ${q.lane} since ${iso(q.since)}`;

/** What a waiting line may name and fill may look up: one plain name (WAKE_VALUE), no ".." */
const isPlainWake = isPlainName;

/** The first line of a small regular file (no symlink as its last part), trimmed; null when it can't be read. */
function firstLineOf(path: string, maxBytes: number): string | null {
  const opened = openRegular(path, true);
  if ("error" in opened) return null;
  try {
    const text = readAt(opened.fd, 0, Math.min(opened.size, maxBytes)).toString("utf-8");
    return text.split("\n")[0].replace(/\r$/, "").trim();
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/** What a queue line reports, as fill's patterns look for it. */
export type LineKind = "done" | "waiting" | "blocked";

/** The bus report kind of each line kind */
const REPORT_KIND: Record<LineKind, StructuredReport["kind"]> = { done: "DONE", waiting: "WAITING", blocked: "BLOCKED" };

/** One pattern of a query, with the kind of line it looks for. */
export interface LineQuery<K extends LineKind = LineKind> {
  kind: K;
  pattern: FillPattern;
}

/**
 * Whom a query is about. A bus report (bus.consume on) is matched by these
 * ids, never by the patterns: its task must be `task`, and its agent `agent`
 * when the pattern names the agent or `own` is set.
 */
export interface LineSubject {
  task: string;
  agent: string;
  /** Only the agent's own lines count, whatever the pattern names (reportedOutcome) */
  own?: boolean;
}

/** A line a query matched: its text, what a waiting line waits on, and the bus report it was read from (on mode). */
export interface LineMatch<K extends LineKind = LineKind> {
  kind: K;
  line: string;
  wake: string | null;
  report: StructuredReport | null;
}

interface QueueLine {
  start: number;
  text: string;
  /** The line's newline is in the file (the last line may still be being written) */
  ended: boolean;
  /** The bus report this line mirrors (its marker, verified against the bus store), or null */
  report: StructuredReport | null;
  /** A second line with the same report's marker: in on mode it is not read again */
  repeat: boolean;
}

/**
 * The queue file's lines at one check (its last 4 MB), trimmed, each with
 * the offset it starts at. Fill and the planner (checkDone) read it.
 *
 * With the project's bus (bus.consume observe or on), a line that ends with
 * a bus marker is looked up in the bus store: when it is that report's
 * mirrored line, the report is kept with it. In on mode such a line is read
 * by the report's fields only; a marker that names no report, or a line
 * that isn't the report's mirror, is read as a hand-written line.
 */
export class QueueLines {
  private lines: QueueLine[] = [];
  /** Line indexes by author (lowercase), built on first use (agentLines) */
  private byAuthor: Map<string, number[]> | null = null;
  private size = 0;
  private usableMarks = new Map<string, boolean>();
  private readonly structured: boolean;

  constructor(
    private path: string,
    bus: BusLineSource | null = null,
  ) {
    this.structured = bus?.mode === "on";
    const opened = openRegular(path, false);
    if ("error" in opened) return;
    try {
      this.size = opened.size;
      const begin = Math.max(0, opened.size - QUEUE_MAX_BYTES);
      const bytes = readAt(opened.fd, begin, opened.size - begin);
      let pos = 0;
      while (pos < bytes.length) {
        const newline = bytes.indexOf(0x0a, pos);
        const end = newline < 0 ? bytes.length : newline;
        // A window that starts inside the file may start inside a line: skip that one
        if (begin === 0 || pos > 0) {
          const text = bytes
            .subarray(pos, Math.min(end, pos + QUEUE_LINE_CHARS * 4))
            .toString("utf-8")
            .slice(0, QUEUE_LINE_CHARS)
            .trim();
          this.lines.push({ start: begin + pos, text, ended: newline >= 0, report: null, repeat: false });
        }
        pos = end + 1;
      }
    } catch {
      this.lines = [];
    } finally {
      closeSync(opened.fd);
    }
    if (bus) this.attachReports(bus);
  }

  /** Keep each mirrored line's bus report with it (one store read for all of them). */
  private attachReports(bus: BusLineSource): void {
    const marked = this.lines.map((line) => ({ line, id: extractBusId(line.text) })).filter((m): m is { line: QueueLine; id: number } => m.id !== null);
    if (marked.length === 0) return;
    const reports = bus.reports([...new Set(marked.map((m) => m.id))]);
    const seen = new Set<number>();
    for (const { line, id } of marked) {
      const report = mirroredReport(bus, line.text, id, reports);
      if (!report) continue;
      if (seen.has(id)) {
        line.repeat = true;
        continue;
      }
      seen.add(id);
      line.report = report;
    }
  }

  /** The lines that mirror a bus report, oldest first, with the report. */
  mirrored(): { line: string; report: StructuredReport }[] {
    return this.lines.flatMap((l) => (l.report ? [{ line: l.text, report: l.report }] : []));
  }

  /**
   * Whether a line matches one query for `subject`. In on mode a mirrored
   * line matches by its report only (kind, task, agent; a WAITING report's
   * gate id is its wake), and a repeated one never; every other line by the
   * pattern (taskLineMatch; a waiting line's (?<wake>...) is its wake).
   */
  private match<K extends LineKind>(line: QueueLine, query: LineQuery<K>, subject: LineSubject): LineMatch<K> | null {
    if (this.structured && (line.report !== null || line.repeat)) {
      const report = line.report;
      if (report === null || report.kind !== REPORT_KIND[query.kind] || report.task !== subject.task) return null;
      if ((subject.own || query.pattern.agent !== null) && report.agent.toLowerCase() !== subject.agent.toLowerCase()) return null;
      return { kind: query.kind, line: line.text, wake: query.kind === "waiting" ? report.gateId : null, report };
    }
    const match = taskLineMatch(query.pattern, line.text);
    if (match === null) return null;
    return { kind: query.kind, line: line.text, wake: query.kind === "waiting" ? match.groups?.wake?.trim() || null : null, report: null };
  }

  /**
   * Where the lines a pattern may look at start: after `mark`. Without a
   * usable mark (no run of the task yet, or a rewritten file) a pattern that
   * names the task looks at the whole window; one that names only the agent
   * looks at nothing, since a line by the agent from before the task's start
   * can be about anything it did before.
   */
  private from(pattern: FillPattern, mark: QueueMark | undefined): number | null {
    if (mark && this.usable(mark)) return mark.offset;
    return pattern.task !== null ? 0 : null;
  }

  /**
   * The lines a pattern looks at: [from, to). A pattern that names only the
   * agent also stops where the agent's next run on another task began
   * (`until`, that run's mark): its lines after that are about that task.
   * When that mark no longer describes the file (it was rewritten since),
   * where that run's lines begin is unknown, so such a pattern reads
   * nothing: what fill saw before is kept in the store.
   */
  private window(pattern: FillPattern, mark: QueueMark | undefined, until: QueueMark | undefined): { from: number; to: number } | null {
    const from = this.from(pattern, mark);
    if (from === null) return null;
    if (pattern.task !== null || !until) return { from, to: Number.POSITIVE_INFINITY };
    return this.usable(until) ? { from, to: until.offset } : null;
  }

  /** The first line in the query's window that reports what it looks for (see match). */
  find<K extends LineKind>(query: LineQuery<K>, subject: LineSubject, mark: QueueMark | undefined, until?: QueueMark): LineMatch<K> | null {
    const window = this.window(query.pattern, mark, until);
    if (window === null) return null;
    for (const line of this.lines) {
      if (line.start < window.from || line.start >= window.to) continue;
      const found = this.match(line, query, subject);
      if (found) return found;
    }
    return null;
  }

  /**
   * The last line in the queries' windows that one of them matches (a line
   * takes the first query that matches it): the latest such line wins.
   */
  lastOf<K extends LineKind>(queries: LineQuery<K>[], subject: LineSubject, mark: QueueMark | undefined, until?: QueueMark): LineMatch<K> | null {
    const windows = queries.map(({ pattern }) => this.window(pattern, mark, until));
    let last: LineMatch<K> | null = null;
    for (const line of this.lines) {
      for (let i = 0; i < queries.length; i++) {
        const window = windows[i];
        if (window === null || line.start < window.from || line.start >= window.to) continue;
        const found = this.match(line, queries[i], subject);
        if (found) {
          last = found;
          break;
        }
      }
    }
    return last;
  }

  /**
   * The last line written after `mark` that reports the task waiting or
   * blocked: the latest such line wins. A waiting line's (?<wake>...), or a
   * WAITING report's gate id, is what it waits on.
   */
  lastStatus(waiting: FillPattern, blocked: FillPattern, subject: LineSubject, mark: QueueMark | undefined, until?: QueueMark): RunStatus | null {
    const last = this.lastOf<"waiting" | "blocked">(
      [
        { kind: "waiting", pattern: waiting },
        { kind: "blocked", pattern: blocked },
      ],
      subject,
      mark,
      until,
    );
    if (!last) return null;
    return { kind: last.kind, line: last.line, wake: last.wake, busId: last.report?.id ?? null };
  }

  /** A mark still describes this file: it isn't past its end and the bytes before it are unchanged. */
  private usable(mark: QueueMark): boolean {
    const key = `${mark.offset}:${mark.tail}`;
    const known = this.usableMarks.get(key);
    if (known !== undefined) return known;
    let ok = false;
    if (mark.offset <= this.size) {
      const opened = openRegular(this.path, false);
      if (!("error" in opened)) {
        try {
          const length = Math.min(mark.offset, MARK_TAIL_BYTES);
          ok = sha256(readAt(opened.fd, mark.offset - length, length)) === mark.tail;
        } catch {
          ok = false;
        } finally {
          closeSync(opened.fd);
        }
      }
    }
    this.usableMarks.set(key, ok);
    return ok;
  }

  /**
   * The whole lines `agent` wrote, by their attribution (attributedAgent, in
   * any case), after `mark` and before `until` (a run's own lines: `until`
   * is where its agent's next run on another task began), oldest first.
   * Nothing without a usable `mark` (a line from before the run can be about
   * anything the agent did before), or when `until` no longer describes the
   * file. A last line without its newline is still being written: it is left
   * for a later check. Lines are indexed by author once per QueueLines (one
   * pass for the check), so each task costs only its agent's lines.
   */
  agentLines(agent: string, mark: QueueMark | undefined, until: QueueMark | undefined): string[] {
    if (!mark || !this.usable(mark)) return [];
    if (until && !this.usable(until)) return [];
    if (this.byAuthor === null) {
      const byAuthor = new Map<string, number[]>();
      this.lines.forEach((line, i) => {
        const author = line.ended ? attributedAgent(line.text)?.toLowerCase() : undefined;
        if (author === undefined) return;
        const own = byAuthor.get(author);
        if (own) own.push(i);
        else byAuthor.set(author, [i]);
      });
      this.byAuthor = byAuthor;
    }
    const to = until ? until.offset : Number.POSITIVE_INFINITY;
    return (this.byAuthor.get(agent.toLowerCase()) ?? [])
      .map((i) => this.lines[i])
      // In on mode a mirrored line is its bus report, always about the task its run held: never an unmatched one
      .filter((line) => line.start >= mark.offset && line.start < to && !(this.structured && (line.report !== null || line.repeat)))
      .map((line) => line.text);
  }
}

// ============ THE TASKS FILE ============

export type TasksFileEntry =
  /** agent null: an unassigned line (an empty agent field), ready work for any agent while it is open */
  | { kind: "task"; line: number; agent: string | null; name: string; task: string; description: string }
  | { kind: "malformed"; line: number; text: string; reason: string };

/**
 * tasks_file lines: `<agent>|<name>|<task>|<description>` (the description
 * may be empty and may hold "|"). `#` comments and blank lines are skipped.
 * An empty agent field (`|<name>|<task>|<description>`) makes the line
 * unassigned (agent null): fill starts nothing for it. A line that doesn't
 * parse, names an invalid agent or task id, repeats a task (unassigned lines
 * included), or comes after the 200th task is malformed: reported, not
 * fatal. With `onePerAgent` (patterns that match by agent), so is a second
 * line for an agent: its queue lines couldn't say which of its tasks they're
 * about (unassigned lines have no agent, so they never count as one).
 */
export function parseTasksFile(content: string, onePerAgent = false): TasksFileEntry[] {
  const entries: TasksFileEntry[] = [];
  const taskLines = new Map<string, number>();
  const agentLines = new Map<string, number>();
  const raw = content.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].replace(/\r$/, "").trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const line = i + 1;
    const bad = (reason: string) => entries.push({ kind: "malformed", line, text: oneLine(text), reason });
    if (text.length > MAX_TASK_LINE_CHARS) {
      bad(`longer than ${MAX_TASK_LINE_CHARS} characters`);
      continue;
    }
    const fields = text.split("|");
    if (fields.length < 4) {
      bad("expected <agent>|<name>|<task>|<description>");
      continue;
    }
    const [agent, name, task] = fields.slice(0, 3).map((field) => field.trim());
    const description = fields.slice(3).join("|").trim();
    if (agent !== "" && !isValidDragonId(agent)) {
      bad(`${agent} is not a valid agent id`);
      continue;
    }
    if (!isValidTaskId(task)) {
      bad(`${task || "(empty)"} is not a valid task id`);
      continue;
    }
    const first = taskLines.get(task);
    if (first !== undefined) {
      bad(`task ${task} is already on line ${first}`);
      continue;
    }
    const agentLine = agent === "" ? undefined : agentLines.get(agent.toLowerCase());
    if (onePerAgent && agentLine !== undefined) {
      bad(`${agent} already has a task on line ${agentLine}: with patterns that match by agent, one line per agent`);
      continue;
    }
    if (taskLines.size >= MAX_TASK_LINES) {
      bad(`past the limit of ${MAX_TASK_LINES} tasks`);
      continue;
    }
    taskLines.set(task, line);
    if (agent === "") {
      entries.push({ kind: "task", line, agent: null, name, task, description });
      continue;
    }
    agentLines.set(agent.toLowerCase(), line);
    entries.push({ kind: "task", line, agent, name: name || agent, task, description });
  }
  return entries;
}

/** A tasks_file line as written (its fields trimmed): a done task stays done while it is unchanged. */
function lineHash(entry: { agent: string; name: string; task: string; description: string }): string {
  return sha256(Buffer.from([entry.agent, entry.name, entry.task, entry.description].join("\u0000"), "utf-8")).slice(0, 16);
}

/** The fields of a tasks_file line. */
export type TaskLineFields = { agent: string; name: string; task: string; description: string };

/** The key of the fill_done event that keeps a task done for its latest run and this line as written. */
function fillDoneKey(task: string, latestRunId: string | null, entry: TaskLineFields): string {
  return `fill_done:${task}:${latestRunId ?? "none"}:${lineHash(entry)}`;
}

/**
 * A task fill judges done: from its kept record, or from a queue line (with
 * the bus report it was read from, in on mode). null: not done.
 */
export type DoneCheck = { kind: "kept"; line: string; at: number } | { kind: "queue"; line: string; report: StructuredReport | null } | null;

/**
 * Where a line's queue window ends: with patterns that match by agent, the
 * agent's next run on another task (its lines after that are about that
 * task); otherwise nowhere. Fill and the planner both use it.
 */
export function queueWindowEnd(
  store: Pick<AgentsStore, "firstRunForAgentAfter">,
  project: string,
  settings: Pick<FillSettings, "donePattern" | "waitingPattern" | "blockedPattern">,
  entry: Pick<TaskLineFields, "agent" | "task">,
  latest: AgentRun | null,
): QueueMark | undefined {
  return matchesByAgent(settings) && latest ? store.firstRunForAgentAfter(project, entry.agent, entry.task, latest)?.queueMark : undefined;
}

/**
 * Fill's done check for one tasks_file line, shared with the planner
 * (src/server/planner/): the fill_done record kept for the task's latest run
 * and this line as written, else the queue lines written since that run's
 * chain was requested (the whole window for a task with no run, when the
 * pattern names the task). A done_pattern that names the task decides by
 * itself; one that names only the agent counts only when the agent's last
 * DONE, WAITING or BLOCKED line (up to `until`, queueWindowEnd) is the DONE
 * one. Throws when a pattern doesn't compile for this task.
 */
export function checkDone(
  store: Pick<AgentsStore, "getEventByKey">,
  project: string,
  queue: QueueLines,
  settings: Pick<FillSettings, "donePattern" | "waitingPattern" | "blockedPattern">,
  entry: TaskLineFields,
  latest: AgentRun | null,
  until: QueueMark | undefined,
): DoneCheck {
  const kept = store.getEventByKey(project, fillDoneKey(entry.task, latest?.id ?? null, entry));
  if (kept) return { kind: "kept", line: String(kept.data.line ?? ""), at: kept.at };
  const donePattern = fillPatternFor(settings.donePattern, entry.task, entry.agent);
  const subject: LineSubject = { task: entry.task, agent: entry.agent };
  let found: LineMatch | null;
  if (donePattern.task !== null) {
    // A line that names the task: done is done, whatever came after it
    found = queue.find({ kind: "done", pattern: donePattern }, subject, latest?.queueMark, until);
  } else {
    // A line by the agent only says where it is now: its last DONE, WAITING or BLOCKED line decides
    // ("- DONE row 1 by kiro-A", then "- WAITING <gate> by kiro-A" is waiting, not done)
    const last = queue.lastOf<LineKind>(
      [
        { kind: "done", pattern: donePattern },
        { kind: "waiting", pattern: fillPatternFor(settings.waitingPattern, entry.task, entry.agent) },
        { kind: "blocked", pattern: fillPatternFor(settings.blockedPattern, entry.task, entry.agent) },
      ],
      subject,
      latest?.queueMark,
      until,
    );
    found = last?.kind === "done" ? last : null;
  }
  return found === null ? null : { kind: "queue", line: found.line, report: found.report };
}

/** A report line an agent wrote on a run that names no task it can be about (done_match task_id). */
export interface UnmatchedReport {
  kind: "done" | "waiting" | "blocked";
  /** The task id the line names, as its pattern reads it (shown, never compared: taskLineMatch decides) */
  reportedTask: string;
  /** The line as written (trimmed and cut as QueueLines reads it): data, never an instruction */
  line: string;
}

/** Unmatched reports kept per run at most: the latest ones */
export const MAX_UNMATCHED_PER_RUN = 5;

/**
 * With done_match task_id: the report lines `run`'s agent wrote on the run
 * (QueueLines.agentLines: its own by attribution, after its queue mark,
 * before `until`, where its next run on another task began) that name no
 * task they can be about. A line is a report when the project's own
 * pattern of a kind that has {task} reads a task id
 * in it (reportPatternFor): a READY or other keyword of the project's
 * pattern counts, a keyword it doesn't have never does. Such a line is
 * unmatched unless it is a line of the run's own task (taskLineMatch with
 * that task's pattern, so "fix-10" and "review-fix-1" are not "fix-1") or
 * `listed` claims it for another task of the tasks file. An unmatched line
 * closes and changes nothing: the run's task goes on as if it wasn't there
 * (no done line: the no-done path). The latest MAX_UNMATCHED_PER_RUN.
 */
export function unmatchedReports(
  queue: QueueLines,
  settings: Pick<FillSettings, "donePattern" | "waitingPattern" | "blockedPattern">,
  run: Pick<AgentRun, "agent" | "task" | "queueMark">,
  until: QueueMark | undefined,
  listed: (kind: UnmatchedReport["kind"], line: string) => boolean,
): UnmatchedReport[] {
  const templates: [UnmatchedReport["kind"], string][] = [
    ["done", settings.donePattern],
    ["waiting", settings.waitingPattern],
    ["blocked", settings.blockedPattern],
  ];
  const kinds = templates.flatMap(([kind, template]) => {
    const report = reportPatternFor(template, run.agent);
    return report ? [{ kind, report, own: fillPatternFor(template, run.task, run.agent) }] : [];
  });
  if (kinds.length === 0) return [];
  const found: UnmatchedReport[] = [];
  for (const line of queue.agentLines(run.agent, run.queueMark, until)) {
    for (const { kind, report, own } of kinds) {
      const match = report.exec(line);
      if (!match) continue;
      // The run's own task's line, or another listed task's: it counts for that task (or for nothing), never here
      if (taskLineMatch(own, line) === null && !listed(kind, line)) {
        found.push({ kind, reportedTask: match.groups?.[REPORTED_TASK_GROUP] ?? "", line });
      }
      break;
    }
  }
  return found.slice(-MAX_UNMATCHED_PER_RUN);
}

/** How a run ended by its own queue line: DONE, WAITING or BLOCKED, and the line as written (data, never a prompt). */
export interface ReportedOutcome {
  kind: "done" | "waiting" | "blocked";
  line: string;
}

/**
 * How a run ended, by its agent's own queue lines for its task written since
 * its chain was requested (its queue mark): read with fill's patterns as
 * checkDone and runStatus read them (a done line that names the task wins,
 * else the latest WAITING or BLOCKED line; with a done_pattern that names
 * only the agent, its last DONE, WAITING or BLOCKED line decides), and only
 * lines the agent wrote by their attribution ("by <agent>", attributedAgent)
 * count, whatever the patterns name. For a run whose exit status is lost
 * (it ended while Lair was restarting). null: it wrote no such line.
 */
export function reportedOutcome(
  queue: QueueLines,
  settings: Pick<FillSettings, "donePattern" | "waitingPattern" | "blockedPattern">,
  run: Pick<AgentRun, "agent" | "task" | "queueMark">,
  until: QueueMark | undefined,
): ReportedOutcome | null {
  // Its agent's lines only: a pattern that names the task alone would count another agent's line about it
  const own = (template: string): FillPattern => ({ ...fillPatternFor(template, run.task, run.agent), agent: run.agent });
  const done = own(settings.donePattern);
  const waiting = own(settings.waitingPattern);
  const blocked = own(settings.blockedPattern);
  const subject: LineSubject = { task: run.task, agent: run.agent, own: true };
  if (done.task !== null) {
    const found = queue.find({ kind: "done", pattern: done }, subject, run.queueMark, until);
    if (found !== null) return { kind: "done", line: found.line };
    const status = queue.lastStatus(waiting, blocked, subject, run.queueMark, until);
    return status ? { kind: status.kind, line: status.line } : null;
  }
  const last = queue.lastOf<ReportedOutcome["kind"]>(
    [
      { kind: "done", pattern: done },
      { kind: "waiting", pattern: waiting },
      { kind: "blocked", pattern: blocked },
    ],
    subject,
    run.queueMark,
    until,
  );
  return last ? { kind: last.kind, line: last.line } : null;
}

/** What fill makes of an unassigned line: its state, why, and whether it is ready work (fill.idle). */
export interface UnassignedLine {
  state: Extract<FillLineState, "done" | "claimed" | "unassigned">;
  detail: string;
  runId: string | null;
  ready: boolean;
}

/**
 * An unassigned tasks_file line (no agent): fill starts nothing for it, and
 * it is ready work for any allowlisted agent only while it is open. It is
 * claimed while a run of its task is active or a claim holds it (someone
 * took it: a run you requested, say); done when a queue line matching
 * done_pattern names it, written since its latest run was requested (the
 * whole window when it never ran; `{agent}` then matches any agent, since the
 * line names none), or when its latest run's own last line is the DONE one;
 * and not ready while that run's own last line is WAITING or BLOCKED (its
 * agent still has it). A done line here only keeps the line from counting as
 * ready work: nothing is recorded, and nothing goes to review. With a
 * done_pattern that names only the agent, no queue line can name a task
 * nobody ran: it stays open until it is assigned or taken out of the file.
 * Throws when a pattern doesn't compile for this task.
 */
export function unassignedLine(
  store: Pick<AgentsStore, "latestRunForTask" | "getClaim" | "firstRunForAgentAfter">,
  project: string,
  queue: QueueLines,
  settings: Pick<FillSettings, "donePattern" | "waitingPattern" | "blockedPattern">,
  task: string,
): UnassignedLine {
  const latest = store.latestRunForTask(project, task);
  if (latest && isActive(latest.state)) {
    return { state: "claimed", detail: `run ${short(latest.id)} of agent ${latest.agent} is ${latest.state}: not ready work`, runId: latest.id, ready: false };
  }
  const claim = store.getClaim(project, task);
  if (claim) {
    return { state: "claimed", detail: `claimed by run ${short(claim.runId)} (agent ${claim.agent}): not ready work`, runId: claim.runId, ready: false };
  }
  const donePattern = anyAgentPatternFor(settings.donePattern, task);
  // An unassigned line has no agent: a done line (or bus report, in on mode) for the task by any agent
  const doneLine = donePattern ? queue.find({ kind: "done", pattern: donePattern }, { task, agent: "" }, latest?.queueMark) : null;
  if (doneLine !== null) return { state: "done", detail: `done: ${oneLine(doneLine.line)}`, runId: latest?.id ?? null, ready: false };
  if (latest) {
    const until = queueWindowEnd(store, project, settings, { agent: latest.agent, task }, latest);
    const outcome = reportedOutcome(queue, settings, latest, until);
    if (outcome?.kind === "done") return { state: "done", detail: `done: ${oneLine(outcome.line)}`, runId: latest.id, ready: false };
    if (outcome) {
      return {
        state: "unassigned",
        detail: `no agent assigned, and not ready work: its last run ${short(latest.id)} (agent ${latest.agent}) ended on a ${outcome.kind.toUpperCase()} line: ${oneLine(outcome.line)}`,
        runId: latest.id,
        ready: false,
      };
    }
  }
  return { state: "unassigned", detail: "no agent assigned: ready work for any agent in agents.fill.agents", runId: null, ready: true };
}

// ============ PROMPTS ============

export type PromptResult = { ok: true; text: string; files: string[] } | { ok: false; reason: string };

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * A run's prompt: the prompt_files' contents, in order, joined by a blank
 * line. {prompts_dir}, {agent} and {task} are replaced in each path; a
 * relative path is relative to prompts_dir. Every path must stay inside
 * prompts_dir: a ".." segment, a path outside it, a symlink that leads out
 * of it, anything but a regular file, or a file over 200 KB is refused.
 */
export function buildPrompt(templates: string[], promptsDir: string, vars: { agent: string; task: string }): PromptResult {
  const root = resolve(promptsDir);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: `prompts_dir ${root} does not exist` };
  }
  const refuse = (path: string, why: string): PromptResult => ({ ok: false, reason: `prompt file ${path} refused: ${why}` });
  const parts: string[] = [];
  const files: string[] = [];
  for (const template of templates) {
    const filled = template.replace(/\{(prompts_dir|agent|task)\}/g, (_match, name: string) =>
      name === "prompts_dir" ? root : name === "agent" ? vars.agent : vars.task,
    );
    if (filled.split(/[\\/]/).includes("..")) return refuse(filled, "a '..' segment");
    const path = isAbsolute(filled) ? resolve(filled) : resolve(root, filled);
    if (!within(root, path)) return refuse(path, `it is outside prompts_dir (${root})`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return { ok: false, reason: `prompt file ${path} does not exist` };
    }
    if (!within(realRoot, real)) return refuse(path, `a symlink out of prompts_dir (to ${real})`);
    const read = readBounded(real, MAX_PROMPT_FILE_BYTES, true);
    if (!read.ok) return refuse(path, `it ${read.reason}`);
    files.push(path);
    const text = read.text.trim();
    if (text.length > 0) parts.push(text);
  }
  return { ok: true, text: parts.join("\n\n"), files };
}

// ============ THE FILL LOOP ============

/** An event, as AgentsService records it. */
export interface FillEventInput {
  agent?: string;
  task?: string;
  runId?: string;
  summary: string;
  evidence?: string[];
  data?: Record<string, unknown>;
  dedupeKey?: string;
}

export type FillDecision = Omit<DecisionRequest, "project" | "requestedBy">;

/** What a hold's decision says: a plain sentence, the evidence, and the options' wording when it differs. */
interface HoldQuestion {
  question: string;
  context: string[];
  startLabel?: string;
  startConsequences?: string;
  keepConsequences?: string;
  why?: string;
  withOutput?: boolean;
  /** The evidence code: why the task is held (agents.gave_up, or agents.cannot_start for probe_failed and fill_waiting) */
  code: "probe_failed" | "fill_waiting" | "repeated_failure" | "exit0_no_report" | "blocked_reported";
}

export interface AgentsFillOptions {
  project: string;
  config: ProjectConfig;
  settings: FillSettings;
  /** agents.command_timeout_seconds: capacity_cmd's timeout */
  commandTimeoutSeconds: number;
  store: AgentsStore;
  probes: AgentProbes;
  readOnly: () => boolean;
  /** False until AgentsService has reconciled the runs the store says are active (after start()): no check runs */
  ready: () => boolean;
  /** A live process running a run of the task that no active run owns (AgentsService's), or null */
  taskProcess: (task: string) => Promise<ProcessInfo | null>;
  /** AgentsService.requestRun as fill: the module's in-process path */
  requestRun: (input: { agent: string; task: string; prompt: string }) => Promise<AgentRunView>;
  /** Record an event in the store, and on the bus */
  record: (kind: AgentEventKind, input: FillEventInput, at: number) => Promise<boolean>;
  /** Raise a decision in the Decision Inbox, once per key while it is open or answered (AgentsService's) */
  raise: (request: FillDecision, run: AgentRun | null) => Promise<boolean>;
  /** The agents module's open Decision Inbox items in the project ([] without the inbox) */
  openDecisions: () => Decision[];
  /** The latest decision raised with this key; null when there is none, undefined without a Decision Inbox to ask */
  findDecision: (key: string) => Decision | null | undefined;
  /** Withdraw a decision whose hold lifted (never throws) */
  withdraw: (decision: Decision, reason: string) => Promise<void>;
  /** The ready guard's source for this project's PRs (used when settings.readyGuard is on); undefined: none, nothing is refused */
  readyFacts?: () => ReadyFactsSource | undefined;
  /** The project's bus at this check (bus.consume observe or on), or null: queue lines only, as without the bus */
  bus?: () => BusLineSource | null;
}

/** How a report or a line reads, for observe mode's comparison: its kind, and the gate a waiting one waits on */
function reading(kind: LineKind | "PROGRESS" | "TICK" | null, wake: string | null): string {
  if (kind === null || kind === "PROGRESS" || kind === "TICK") return "nothing (no done, waiting or blocked line)";
  return kind === "waiting" ? `waiting on ${wake ?? "(nothing named)"}` : kind;
}

/** observe: how many of the latest mirrored lines each check compares */
const MAX_OBSERVED_LINES = 200;

const LINE_KIND: Record<StructuredReport["kind"], LineKind | "PROGRESS" | "TICK"> = {
  DONE: "done",
  WAITING: "waiting",
  BLOCKED: "blocked",
  PROGRESS: "PROGRESS",
  TICK: "TICK",
};

function firstLine(text: string): string | null {
  const line = text
    .slice(0, 4096)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? oneLine(line) : null;
}

/** The last lines of a run's log, for a decision's context (text the agent wrote: cut, one line each). */
function lastOutput(run: AgentRun): string[] {
  return run.logPath ? lastLines(readTail(run.logPath, 8192), 10).map((line) => oneLine(line)) : [];
}

export class AgentsFill {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private checking: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private lines: FillLineView[] = [];
  private lastCheck: number | null = null;
  private lastError: string | null = null;
  /** The hold each held line is in (agent|task -> hold): fill_held is recorded when it changes */
  private holds = new Map<string, FillHold>();
  /** The git host failed or timed out: the ready guard asks it nothing until then (clock ms) */
  private guardDownUntil = 0;
  /** When fill last looked for a waiting run's wake file and didn't find it (task|run -> time) */
  private polled = new Map<string, number>();
  /** The waiting runs seen in the check in progress (to forget the others' polls) */
  private waitingSeen = new Set<string>();
  /** Open decisions whose line is gone from the tasks file: in how many checks in a row (key -> checks) */
  private lineGone = new Map<string, number>();
  /** When fill last saw a waiting run's gate in the gate queue (task|run -> time); the store keeps the first and last sightings */
  private lastQueued = new Map<string, number>();
  /** The unmatched reports of the lines' last runs at the last complete check (rebuilt from the queue each check) */
  private unmatchedReports: FillUnmatchedReportView[] = [];
  /** Last capacity check state for the view */
  private lastCapacity: FillCapacityView | null = null;
  /** checkSoon's check after the one in progress */
  private again: Promise<void> | null = null;
  /** stop() ran: events start no check */
  private ended = false;
  /** Every allowlisted agent's idle state at the last whole check (fill.idle) */
  private idleStates = new Map<string, IdleState>();
  /** Each agent's open idle notice: its episode's start (ms), null for none; read from the store once per agent */
  private idleNotices = new Map<string, number | null>();

  constructor(private options: AgentsFillOptions) {}

  get running(): boolean {
    return !this.stopped;
  }

  get tasksPath(): string | null {
    const file = this.options.settings.tasksFile;
    if (!file) return null;
    return isAbsolute(file) ? file : resolve(this.options.config.repo, file);
  }

  view(): FillStatusView {
    const { settings } = this.options;
    return {
      enabled: settings.enabled,
      running: this.running,
      tasksFile: this.tasksPath,
      agents: settings.agents,
      maxActive: settings.maxActive,
      active: this.activeCount(),
      intervalSeconds: settings.intervalSeconds,
      lastCheck: this.lastCheck === null ? null : iso(this.lastCheck),
      lastError: this.lastError,
      lines: this.lines,
      idle: this.idleStates.size > 0 ? [...this.idleStates.values()].map(idleStateView) : undefined,
      unmatchedReports: this.unmatchedReports,
      warnings: settings.warnings,
      capacity: this.lastCapacity ?? undefined,
    };
  }

  /** The task's line at the last check, if there is one. */
  lineFor(task: string): FillLineView | null {
    return this.lines.find((line) => line.task === task) ?? null;
  }

  /**
   * Why fill won't read a bus report (bus.consume on or observe), or null
   * when it will: its task has no line in the tasks file at the last check,
   * that line's agent isn't allowlisted, or fill's pattern for the report's
   * kind names the agent and another agent reported it. Null until a check
   * has read the tasks file.
   */
  busReportProblem(report: Pick<StructuredReport, "task" | "agent" | "kind">): string | null {
    if (this.lastCheck === null || this.lastError !== null) return null;
    const line = this.lineFor(report.task);
    if (!line) return `task ${report.task} is not in agents.fill.tasks_file: fill ignores the report`;
    if (line.state === "not_allowlisted") return `${line.agent ?? "its agent"} is not in agents.fill.agents: fill ignores the report`;
    const kind = LINE_KIND[report.kind];
    const { settings } = this.options;
    const template = kind === "done" ? settings.donePattern : kind === "waiting" ? settings.waitingPattern : kind === "blocked" ? settings.blockedPattern : null;
    if (template !== null && template.includes("{agent}") && line.agent?.toLowerCase() !== report.agent.toLowerCase()) {
      return `${report.agent} reported it, but the task's line is ${line.agent ?? "another agent"}'s and fill's pattern names the agent: fill ignores the report`;
    }
    return null;
  }

  /**
   * With patterns that match by agent, the agent's open fill task other than
   * `task`, if it has one: its line at the last check, whose task has run for
   * this agent and isn't done (it waits, backs off, is held or runs). A run
   * of the agent on another task meanwhile would write lines fill can't tell
   * from that task's, so AgentsService.requestRun refuses it.
   */
  openTaskFor(agent: string, task: string): FillLineView | null {
    if (!matchesByAgent(this.options.settings)) return null;
    const lower = agent.toLowerCase();
    for (const line of this.lines) {
      if (line.agent?.toLowerCase() !== lower || line.task === null || line.task === task) continue;
      if (line.state === "done" || line.state === "malformed" || line.state === "not_allowlisted") continue;
      if (this.options.store.latestRunForTask(this.options.project, line.task)?.agent.toLowerCase() === lower) return line;
    }
    return null;
  }

  /** Active runs (any attempt) of the chains fill started. */
  private activeCount(): number {
    return this.options.store.activeRuns(this.options.project).filter((run) => run.origin === "fill").length;
  }

  /** Run one check. Concurrent calls share the one in progress; it never rejects. */
  check(): Promise<void> {
    if (!this.checking) {
      this.checking = this.runCheck().finally(() => {
        this.checking = null;
      });
    }
    return this.checking;
  }

  /**
   * A check now, for an event (bus.consume on: an accepted bus report, or a
   * run that ended), instead of at the next interval. One in progress may
   * have read the queue before the event's line was written, so one more
   * runs right after it (calls meanwhile share that one). Nothing once
   * stop() has run. It never rejects.
   */
  checkSoon(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (!this.checking) return this.check();
    this.again ??= this.checking.then(() => {
      this.again = null;
      return this.ended ? undefined : this.check();
    });
    return this.again;
  }

  /** Check soon, then every fill.interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.ended = false;
    const interval = this.options.settings.intervalSeconds * 1000;
    const loop = async () => {
      if (this.stopped) return;
      await this.check();
      if (this.stopped) return;
      this.timer = setTimeout(loop, interval);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, Math.min(1000, interval));
    this.timer.unref();
  }

  /** Stop the loop. A check in progress is interrupted (its capacity_cmd killed) and awaited. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ended = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    await this.checking;
    await this.again;
  }

  private async runCheck(): Promise<void> {
    const now = this.options.probes.clock.now();
    if (!this.options.ready()) {
      // A restart: a task whose run the previous server started must not look free before that run is adopted
      this.lastError = "waiting for the agents module to reconcile the runs it found active: fill starts nothing until then";
      this.lastCheck = now;
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    try {
      this.lines = await this.evaluate(abort.signal, now);
      this.lastError = abort.signal.aborted ? "the check was interrupted: the module stopped" : null;
      // A check cut short saw only some lines: the idle states and notices wait for a whole one
      if (!abort.signal.aborted) await this.updateIdle(this.lines, now);
    } catch (e) {
      const error = message(e);
      if (error !== this.lastError) console.warn(`[agents] ${this.options.project}: fill check failed: ${error}`);
      this.lines = [];
      this.lastError = error;
    } finally {
      this.lastCheck = now;
      if (this.abort === abort) this.abort = null;
    }
  }

  /**
   * After a whole check: every allowlisted agent's idle state (idle.ts), and
   * its notice (fill.idle). An agent idle while ready work exists for
   * fill.idle.notice_minutes raises one fill_idle_notice (on the bus too) and,
   * with the Decision Inbox, one notice there, once per episode. The episode
   * ends when the agent's state changes (it works, waits or is held, or the
   * ready work is gone), when notices are turned off, or when it leaves
   * fill.agents: fill_idle_resolved is recorded and the notice withdrawn. The
   * store says which notice is open, so a restart neither repeats it nor
   * leaves it open; how long an agent idles before its notice is counted in
   * memory, so a restart starts that count again. Reads only the store and
   * the inbox; never throws (the next check tries again).
   */
  private async updateIdle(lines: FillLineView[], now: number): Promise<void> {
    const { store, project, settings } = this.options;
    const { idle } = settings;
    try {
      const active = store.activeRuns(project);
      const input: IdleInput = {
        lines,
        busy: new Set(active.map((run) => run.agent.toLowerCase())),
        activeCount: active.filter((run) => run.origin === "fill").length,
        maxActive: settings.maxActive,
        capacityRefused: lines.some((l) => l.state === "held" && l.hold === "capacity"),
        readOnly: this.options.readOnly(),
      };
      // After a restart an open notice's episode goes on: its start is kept, so it isn't raised again
      const previous = new Map<string, Pick<IdleState, "reason" | "since">>(this.idleStates);
      for (const agent of settings.agents) {
        const open = this.openIdleNotice(agent);
        if (open !== null && !previous.has(agent)) previous.set(agent, { reason: "ready_work", since: open });
      }
      const ready = findReadyWork(idle.readySources, lines);
      const states = computeIdleStates(settings.agents, input, ready, now, previous);
      this.idleStates = new Map(states.map((state) => [state.agent, state]));
      for (const state of states) {
        const open = this.openIdleNotice(state.agent);
        if (open === null) {
          if (shouldNotice(state, idle)) await this.raiseIdleNotice(state, ready.length, now);
        } else if (idle.noticeMinutes <= 0) {
          await this.resolveIdleNotice(state.agent, open, "fill.idle.notice_minutes is 0: idle notices are off", now);
        } else if (state.reason !== "ready_work") {
          await this.resolveIdleNotice(state.agent, open, idleExplanation(state), now);
        }
      }
      // Notices that no episode stands on: an agent out of fill.agents, or an episode that ended without its withdrawal
      for (const decision of this.options.openDecisions()) {
        const notice = parseIdleNoticeKey(decision.key);
        if (!notice) continue;
        if (!settings.agents.includes(notice.agent)) {
          await this.resolveIdleNotice(notice.agent, notice.since, `${notice.agent} is no longer in agents.fill.agents`, now);
        } else if (this.openIdleNotice(notice.agent) !== notice.since) {
          await this.options.withdraw(decision, "The idle episode it was about has ended.");
        }
      }
    } catch (e) {
      console.warn(`[agents] ${project}: fill's idle check failed: ${message(e)}`);
    }
  }

  /** The start (ms) of the agent's open idle notice, or null: the latest of its fill_idle_notice and fill_idle_resolved. */
  private openIdleNotice(agent: string): number | null {
    let since = this.idleNotices.get(agent);
    if (since === undefined) {
      const last = this.options.store.listEvents(this.options.project, { kinds: ["fill_idle_notice", "fill_idle_resolved"], agent, limit: 1 })[0];
      since = last?.kind === "fill_idle_notice" && typeof last.data.since === "number" ? last.data.since : null;
      this.idleNotices.set(agent, since);
    }
    return since;
  }

  /** One notice for an agent idle while ready work exists: the event (and bus), and a notice in the Decision Inbox. */
  private async raiseIdleNotice(state: IdleState, readyCount: number, now: number): Promise<void> {
    const { agent, since } = state;
    const minutes = Math.floor(state.duration / 60_000);
    const tasks = state.readyTasks ?? [];
    const explanation = idleExplanation(state);
    const key = idleNoticeKey(agent, since);
    await this.options.record(
      "fill_idle_notice",
      {
        agent,
        summary: `fill: ${agent} has been idle for ${minutes} min while ready work exists (${readyCount} unassigned task(s))`,
        evidence: [explanation],
        data: { since, cause: state.cause ?? null, minutes, readyCount, readyTasks: tasks, key },
        dedupeKey: `fill_idle_notice:${agent}:${since}`,
      },
      now,
    );
    this.idleNotices.set(agent, since);
    // Without a Decision Inbox the event is the notice: the inbox file is for questions, and this asks none
    if (this.options.findDecision(key) === undefined) return;
    const more = readyCount > tasks.length ? ` (and ${readyCount - tasks.length} more)` : "";
    await this.options.raise(
      {
        kind: "other",
        attention: "notice",
        question: `${agent} has been idle for ${minutes} min while ready work exists`,
        context: [
          `${explanation}.`,
          "",
          `Ready work: ${readyCount} unassigned line(s) in the tasks file: ${tasks.join(", ")}${more}.`,
          "",
          `Since ${iso(since)}. Assign one of them to ${agent} (its id in the line's agent field), or let the planner do it. ` +
            `This notice is withdrawn once ${agent} is no longer idle while ready work exists.`,
        ].join("\n"),
        options: [
          {
            id: IDLE_NOTICE_NOTED,
            label: "Noted",
            consequences: `The notice closes. Fill raises none again until ${agent} stops idling and then idles while ready work exists again.`,
            effect: "reversible",
          },
        ],
        recommended: IDLE_NOTICE_NOTED,
        why: "Nothing is decided here: assigning the work is yours (or the planner's), and the notice goes by itself once the agent is no longer idle.",
        reversible: true,
        key,
        ref: `fill-idle:${agent}`,
        structure: {
          class: "agents.fill_idle",
          evidence: {
            code: "idle_with_ready_work",
            facts: { agent, idle_minutes: minutes, ready_count: readyCount, cause: state.cause ?? null },
            cause_cleared: false,
            linked_issue: null,
          },
        },
      },
      null,
    );
  }

  /** The end of an agent's idle episode: fill_idle_resolved (on the bus too), and its notice withdrawn. */
  private async resolveIdleNotice(agent: string, since: number, why: string, now: number): Promise<void> {
    const key = idleNoticeKey(agent, since);
    await this.options.record(
      "fill_idle_resolved",
      {
        agent,
        summary: `fill: ${agent}'s idle notice is resolved: ${why}`,
        evidence: [why],
        data: { since, key },
        dedupeKey: `fill_idle_resolved:${agent}:${since}`,
      },
      now,
    );
    this.idleNotices.set(agent, null);
    const decision = this.options.findDecision(key);
    if (decision?.status === "open") await this.options.withdraw(decision, `The idle episode ended: ${why}.`);
  }

  /** Whether the owner released the claim of this run (POST /api/agents/claims/release). */
  private claimReleasedByOwner(run: AgentRun): boolean {
    return this.options.store
      .listEvents(this.options.project, { kinds: ["claim_released"], runId: run.id, limit: 20 })
      .some((event) => event.data.by === "request");
  }

  /**
   * The task's runs in a row, newest first, that completed (exit 0) without
   * progress: no done line, or a WAITING line on nothing that came (no wake,
   * a refused one, or a result already there when the run ended). A run
   * whose wake really came (fill_woken) neither counts nor ends the row; a
   * blocked one ends it (only the owner's release starts it again). The row
   * starts after the owner's last release, and a chain the owner started is
   * its first (a new start counts afresh).
   */
  private completionsWithoutDone(task: string, releasedChain: string | null): AgentRun[] {
    const { store, project, settings } = this.options;
    const counted: AgentRun[] = [];
    for (const head of store.chainHeadsForTask(project, task, MAX_CHAINS_LOOKED_AT)) {
      if (head.chainId === releasedChain) break;
      const last = store.chainRuns(head.chainId).at(-1);
      if (!last || last.state !== "completed") break;
      const kinds = new Set(
        store.listEvents(project, { kinds: ["fill_blocked", "fill_woken"], task, runId: last.id, limit: 10 }).map((e) => e.kind),
      );
      if (kinds.has("fill_blocked")) break;
      if (!kinds.has("fill_woken")) counted.push(last);
      if (head.origin !== "fill" || counted.length >= settings.maxCompletionsWithoutDone) break;
    }
    return counted;
  }

  /**
   * bus.consume observe: for the latest mirrored lines, what the bus report
   * would have been read as next to what fill's patterns read the same line
   * as, for the tasks_file line of the task the report names. Kept in memory
   * by the bus consumers (Home → Health); nothing is written, nothing acts.
   */
  private observe(bus: BusLineSource, queue: QueueLines, entries: TasksFileEntry[]): void {
    const { settings } = this.options;
    const byTask = new Map<string, TaskLineFields>();
    // An unassigned line (no agent) reads no report: fill starts nothing for it
    for (const entry of entries) if (entry.kind === "task" && entry.agent !== null) byTask.set(entry.task, { ...entry, agent: entry.agent });
    for (const { line, report } of queue.mirrored().slice(-MAX_OBSERVED_LINES)) {
      const entry = byTask.get(report.task);
      if (!entry) continue;
      const queries: LineQuery[] = [
        { kind: "done", pattern: fillPatternFor(settings.donePattern, entry.task, entry.agent) },
        { kind: "waiting", pattern: fillPatternFor(settings.waitingPattern, entry.task, entry.agent) },
        { kind: "blocked", pattern: fillPatternFor(settings.blockedPattern, entry.task, entry.agent) },
      ];
      let file = reading(null, null);
      for (const { kind, pattern } of queries) {
        const match = taskLineMatch(pattern, line);
        if (match === null) continue;
        file = reading(kind, kind === "waiting" ? match.groups?.wake?.trim() || null : null);
        break;
      }
      // As on mode reads it (QueueLines.match): a pattern that names the agent needs the report to be that agent's
      const kind = LINE_KIND[report.kind];
      const query = queries.find((q) => q.kind === kind);
      const otherAgent = query !== undefined && query.pattern.agent !== null && report.agent.toLowerCase() !== entry.agent.toLowerCase();
      const wouldRead = otherAgent ? reading(null, null) : reading(kind, report.gateId);
      bus.observed({ consumer: "fill", busId: report.id, task: report.task, agent: report.agent, report: wouldRead, file });
    }
  }

  private async evaluate(signal: AbortSignal, now: number): Promise<FillLineView[]> {
    const { project, settings, store, config, probes } = this.options;
    const path = this.tasksPath;
    if (!path) throw new Error("agents.fill.tasks_file is not set");
    const read = readBounded(path, MAX_TASKS_FILE_BYTES, false);
    if (!read.ok) throw new Error(`tasks_file ${path} ${read.reason}`);
    const byAgent = matchesByAgent(settings);
    const entries = parseTasksFile(read.text, byAgent);
    const allowed = new Set(settings.agents);
    // bus.consume on: mirrored lines are read by their bus report; observe: compared, nothing else changes
    const bus = this.options.bus?.() ?? null;
    const queue = new QueueLines(config.queue_file, bus);
    if (bus?.mode === "observe") this.observe(bus, queue, entries);
    // The gate queue, read at most once per check, and only when a waiting line names a gate
    let gateRequests: Map<string, QueuedRequest> | null = null;
    const gateQueue = () => (gateRequests ??= readGateQueue(config.gates_dir));
    const promptsDir = getPromptsDir(config);
    let active = this.activeCount();
    let noCapacity: string | null = null;
    const capacityState: CapacityState = {};
    this.waitingSeen.clear();
    const views: FillLineView[] = [];
    const unmatchedThisCheck: FillUnmatchedReportView[] = [];
    const listedTasks = entries.flatMap((e) => (e.kind === "task" ? [e] : []));
    const templates = { done: settings.donePattern, waiting: settings.waitingPattern, blocked: settings.blockedPattern };
    // A report line another task of the file counts as its own (it names that task, written as that task's pattern
    // wants) is that task's: it is not unmatched, unless that task is done by another line (a stale report about it)
    const reportsListedTask = (kind: UnmatchedReport["kind"], line: string): boolean =>
      listedTasks.some((other) => {
        if (!line.includes(other.task)) return false;
        const { agent } = other;
        try {
          // An unassigned task's line may be anyone's (it has no agent): it is that task's, never unmatched
          const pattern = agent === null ? anyAgentPatternFor(templates[kind], other.task) : fillPatternFor(templates[kind], other.task, agent);
          if (pattern === null || taskLineMatch(pattern, line) === null) return false;
        } catch {
          return false;
        }
        if (agent === null) return true;
        const kept = store.getEventByKey(project, fillDoneKey(other.task, store.latestRunForTask(project, other.task)?.id ?? null, { ...other, agent }));
        return kept === null || kept.data.line === line;
      });
    const seen = new Set<string>();
    /** The keys of the decisions that the holds of this check stand on (fill's own, or a run's escalation) */
    const wanted = new Set<string>();

    for (const entry of entries) {
      if (signal.aborted) break;
      if (entry.kind === "malformed") {
        views.push({
          line: entry.line,
          agent: null,
          name: null,
          task: null,
          description: null,
          state: "malformed",
          detail: `${entry.reason}: ${entry.text}`,
          hold: null,
          releasable: false,
          waiting: null,
          runId: null,
          decisionId: null,
        });
        continue;
      }
      const { line, agent, name, task, description } = entry;
      if (agent === null) {
        // Unassigned: fill starts nothing for it; it is ready work for any allowlisted agent while it is open
        let found: UnassignedLine;
        try {
          found = unassignedLine(store, project, queue, settings, task);
        } catch (e) {
          found = { state: "unassigned", detail: `no agent assigned, and not ready work: done_pattern can't be checked for it: ${message(e)}`, runId: null, ready: false };
        }
        const { state, detail, runId, ready } = found;
        views.push({ line, agent, name, task, description, state, detail, hold: null, releasable: false, waiting: null, runId, decisionId: null, ready });
        continue;
      }
      const fields: TaskLineFields = { agent, name, task, description };
      const key = `${agent}|${task}`;
      seen.add(key);
      const show = (
        state: FillLineState,
        detail: string,
        runId: string | null = null,
        hold: FillHold | null = null,
        waiting: FillWaitingView | null = null,
      ) => {
        if (state !== "held") this.holds.delete(key);
        views.push({
          line,
          agent,
          name,
          task,
          description,
          state,
          detail,
          hold,
          releasable: hold !== null && OWNER_HOLDS.includes(hold),
          waiting,
          runId,
          decisionId: null,
        });
      };
      // `busId`: the bus report the hold stands on (bus.consume on). Its fill_held is recorded once for that report
      // and run, also across restarts (held kinds are in memory only, so a hold from a queue line is recorded again
      // after a restart, as before)
      const hold = async (
        kind: FillHold,
        reason: string,
        runId: string | null = null,
        waiting: FillWaitingView | null = null,
        busId: number | null = null,
      ) => {
        show("held", reason, runId, kind, waiting);
        if (this.holds.get(key) === kind) return;
        this.holds.set(key, kind);
        await this.options.record(
          "fill_held",
          {
            agent,
            task,
            summary: `fill holds ${agent} on ${task}: ${reason}`,
            evidence: [reason],
            data: busId === null ? { line, hold: kind, reason } : { line, hold: kind, reason, busId },
            dedupeKey: busId === null ? undefined : `fill_held:${task}:${runId ?? "none"}:${kind}:bus:${busId}`,
          },
          probes.clock.now(),
        );
      };
      // This line's hold stands on the decision with this key: keep it, and show it on the line
      const standOn = (decisionKey: string) => {
        wanted.add(decisionKey);
        const decision = this.options.findDecision(decisionKey);
        const view = views[views.length - 1];
        if (view && view.task === task) view.decisionId = decision?.status === "open" ? decision.id : null;
      };
      // One decision per hold that needs the owner: raised once, kept while the hold lasts
      const ask = async (run: AgentRun | null, decisionKey: string, question: HoldQuestion) => {
        await this.raiseHold(run, agent, task, decisionKey, question);
        standOn(decisionKey);
      };

      if (!allowed.has(agent)) {
        show("not_allowlisted", `${agent} is not in agents.fill.agents: fill never starts it`);
        continue;
      }
      const latest = store.latestRunForTask(project, task);
      if (latest && isActive(latest.state)) {
        if (latest.agent === agent) {
          show("started", `run ${short(latest.id)} is ${latest.state}: ${oneLine(latest.detail)}`, latest.id);
        } else {
          show("claimed", `run ${short(latest.id)} of agent ${latest.agent} is ${latest.state}`, latest.id);
        }
        continue;
      }
      const claim = store.getClaim(project, task);
      if (claim) {
        show("claimed", `claimed by run ${short(claim.runId)} (agent ${claim.agent})`, claim.runId);
        continue;
      }

      // Lines that name only the agent end where its next run on another task began (an owner's run, say)
      const until = queueWindowEnd(store, project, settings, fields, latest);

      // The owner's last release of the task, and their pause (the owner's own hold) when it is newer
      const release = store.listEvents(project, { kinds: ["fill_released"], task, limit: 1 })[0];
      const paused = this.pausedBy(task, latest);
      // A refusal needs the owner: one decision per refusal and release ("Start it again" that is refused again asks again)
      const refused = async (reason: string, question: string, context: string[]) => {
        if (paused) {
          await hold("paused", paused, latest?.id ?? null);
          return;
        }
        await hold("refused", reason);
        await ask(latest, fillRefusedKey(task, release?.id ?? "0", latest?.id ?? null), {
          code: "probe_failed",
          question,
          context,
          startLabel: "Start it again",
          startConsequences: `Fill tries to start ${task} for ${agent} again on its next check: choose this once you fixed what refused it.`,
          keepConsequences: `Fill stops trying ${task} until you release it in Work.`,
          why: "Fill tries again on every check, and it is refused the same way until the cause is fixed.",
          withOutput: false,
        });
      };

      // Done: kept once seen (for this latest run and this line as written), else from the queue file
      let check: DoneCheck;
      try {
        check = checkDone(store, project, queue, settings, fields, latest, until);
      } catch (e) {
        await refused(
          `done_pattern: ${message(e)}`,
          `${agent} can't start ${task}: fill can't tell whether the task is done`,
          ["Fill checks agents.fill.done_pattern against the queue file before it starts a task, and that check failed:", "", ...asData(message(e))],
        );
        continue;
      }
      if (check?.kind === "kept") {
        show("done", `done: ${oneLine(check.line)} (seen ${iso(check.at)})`, latest?.id ?? null);
        continue;
      }
      // A DONE line that names a PR counts only when the PR is ready to review (settings.readyGuard)
      const refusal = check?.kind === "queue" ? await this.guardReport(agent, task, check.line, latest, description, check.report) : null;
      if (refusal?.retry && refusal.expired && !(release && release.at >= refusal.since)) {
        // Waited long enough: one decision for the owner, the report stays refused
        await refused(
          `done line still not verifiable after ${Math.round((probes.clock.now() - refusal.since) / 60000)} min: ${refusal.problems.map((p) => oneLine(p, 160)).join("; ")}`,
          `${agent}'s done report for ${task} could not be verified`,
          ["Fill held the report and checked it again, and it still could not be accepted:", "", ...asData(refusal.problems.join("; "))],
        );
        continue;
      }
      if (refusal?.retry && !refusal.expired) {
        // Only time can fix it (CI running): not done, no new run, checked again on the next check
        await hold(
          "report_refused",
          `done line not accepted yet: ${refusal.problems.map((p) => oneLine(p, 160)).join("; ")}; checked again on the next check`,
          latest?.id ?? null,
          null,
          check?.kind === "queue" ? (check.report?.id ?? null) : null,
        );
        continue;
      }
      if (check?.kind === "queue" && !refusal) {
        const done = check.line;
        const data: Record<string, unknown> = { line: done, runId: latest?.id ?? null, lineHash: lineHash(fields) };
        // Read from a bus report (bus.consume on): which one
        if (check.report) data.busId = check.report.id;
        await this.options.record(
          "fill_done",
          {
            agent,
            task,
            runId: latest?.id,
            summary: `fill: ${task} is done: ${oneLine(done)}`,
            evidence: [done],
            data,
            dedupeKey: fillDoneKey(task, latest?.id ?? null, fields),
          },
          probes.clock.now(),
        );
        show("done", `done: ${oneLine(done)}`, latest?.id ?? null);
        continue;
      }

      // task_id: the last run's own report lines that name no task they can be about. Each is recorded once and
      // shown; it closes and changes nothing, so a run with only such lines goes on below as one without a done line
      if (settings.doneMatch === "task_id" && latest) {
        const after = store.firstRunForAgentAfter(project, latest.agent, task, latest)?.queueMark;
        const reports = unmatchedReports(queue, settings, latest, after, reportsListedTask);
        if (reports.length > 0) unmatchedThisCheck.push(await this.recordUnmatched(latest, reports));
      }

      // The owner chose to leave it: nothing waits for them, and nothing starts until they release it
      if (paused) {
        await hold("paused", paused, latest?.id ?? null);
        continue;
      }

      // The owner's: a run that ended other than completed, or completions without done
      const releasedRun = typeof release?.data.runId === "string" ? release.data.runId : null;
      const releasedChain = typeof release?.data.chainId === "string" ? release.data.chainId : null;
      // A superseded run never ran (another live claim held the task when it tried to start): it starts with no
      // backoff once that claim is gone, as a first start does; the claimed check above holds it until then
      if (latest && latest.state !== "completed" && latest.state !== "superseded" && latest.id !== releasedRun) {
        const runs = ["Runs:", `- Run ${short(latest.id)}: ${latest.state}: ${oneLine(latest.detail)}`];
        if (latest.state === "lost_claim" && !this.claimReleasedByOwner(latest)) {
          const reason = `its run ${short(latest.id)} lost its claim (${oneLine(latest.detail)}), not released by you: fill leaves the task to you`;
          await hold("owner", reason, latest.id);
          await ask(latest, fillDecisionKey(task, latest.id), {
            code: "repeated_failure",
            question: `${agent} is paused on ${task}: its run lost its claim to the task, and you did not release it`,
            context: runs,
          });
          continue;
        }
        await hold(
          "owner",
          `its last run ${short(latest.id)} ended ${latest.state} (${oneLine(latest.detail)}): fill leaves the task to you (answer its decision, start a run, or release the hold)`,
          latest.id,
        );
        // An escalated run's own decision is this hold's while it is open; without it, fill asks
        const escalated = store.listEvents(project, { kinds: ["escalated"], runId: latest.id, limit: 1 }).length > 0;
        const escalationKey = escalationDecisionKey(latest.chainId, store.chainRuns(latest.chainId).length);
        const escalation = escalated ? this.options.findDecision(escalationKey) : null;
        if (escalated && escalation === undefined) continue; // no Decision Inbox: the escalation went to the inbox file
        if (escalation?.status === "open") {
          standOn(escalationKey);
          continue;
        }
        await ask(latest, fillDecisionKey(task, latest.id), {
          code: "repeated_failure",
          question: `${agent} is paused on ${task}: ${howItEnded(latest)}`,
          context: [
            ...runs,
            "",
            escalated
              ? "Its escalation was answered, and the task is still held: start it again, or keep it paused."
              : "Fill doesn't start a task again after a run that ended this way: that is your call.",
          ],
        });
        continue;
      }
      // A run that ended on a WAITING or BLOCKED line (the latest such line wins; a done line won above)
      const status =
        latest && latest.state === "completed" && latest.id !== releasedRun ? await this.runStatus(latest, agent, task, queue, until) : null;
      if (latest && status?.kind === "blocked") {
        const reason = `blocked: ${oneLine(status.line)}: fill leaves the task to you (release the hold once it is unblocked)`;
        await hold("blocked", reason, latest.id, null, status.busId);
        await ask(latest, fillDecisionKey(task, latest.id, "blocked"), {
          code: "blocked_reported",
          question: `${agent} is paused on ${task}: it reported the task blocked`,
          context: [`Run ${short(latest.id)} ended ${iso(latest.endedAt ?? latest.requestedAt)} on this line:`, "", ...asData(status.line)],
          startConsequences: `Fill starts ${task} for ${agent} again on its next check: choose this once what blocked it is cleared.`,
          why: "A blocked task needs someone else first; starting it again before that only repeats the run.",
        });
        continue;
      }
      // N runs in a row without progress: held, and one decision with them and the last output
      const holdNoDone = async (run: AgentRun, completions: AgentRun[]) => {
        const count = completions.length;
        await hold(
          "no_done",
          `its last ${count} run(s) exited 0 without progress (no done line, or waiting on nothing that came; agents.fill.max_completions_without_done is ${settings.maxCompletionsWithoutDone}): fill leaves the task to you`,
          run.id,
        );
        await ask(run, fillDecisionKey(task, run.id), {
          code: "exit0_no_report",
          question: `${agent} is paused on ${task}: its last ${count} run(s) ended without reporting it done`,
          context: [
            "Runs:",
            ...completions.map(
              (r) => `- Run ${short(r.id)} (${r.origin === "fill" ? "fill" : "requested"}): ended ${iso(r.endedAt ?? r.requestedAt)}: ${oneLine(r.detail)}`,
            ),
          ],
        });
      };
      if (latest && status?.kind === "waiting") {
        const since = latest.endedAt ?? latest.requestedAt;
        const wait = await this.classifyWait(latest, agent, task, status, now);
        // Waiting on nothing that came is a run without progress: N of them hold the task (and that hold stays)
        const completions = wait.kind === "weak" ? this.completionsWithoutDone(task, releasedChain) : [];
        if (completions.length >= settings.maxCompletionsWithoutDone) {
          await holdNoDone(latest, completions);
          continue;
        }
        // The gate it waits on is still in the gate queue (under its id, or one it was re-queued as): a live wait
        const pollKey = `${task}|${latest.id}`;
        this.waitingSeen.add(pollKey);
        const queued = wait.kind === "woken" ? null : this.queuedGate(status.wake, gateQueue);
        await this.noteQueued(latest, agent, task, pollKey, queued, now);
        const queuedView = queued ? queuedGateView(queued) : null;
        // A wait budget across restarts: from the first run of this streak of waiting runs
        const streak = this.waitStreak(task, releasedChain);
        const streakStart = streak?.start ?? since;
        const maxWait = settings.wake.maxWaitMinutes;
        const maxQueueWait = Math.max(settings.wake.maxQueueWaitMinutes, maxWait);
        // Once held for waiting too long, it stays held while its decision is open or was answered "Keep it paused"
        // (holdDecision). A withdrawn one doesn't hold: it is asked again once the wait is over its budget again.
        // Without a Decision Inbox to ask, while the decision was raised (the inbox file can't say more)
        const waitingKey = fillDecisionKey(task, latest.id, "waiting");
        const decided = this.holdDecision(waitingKey);
        const heldBefore =
          decided.status === "open" ||
          (decided.status === "answered" && decided.optionId === DECISION_FILL_KEEP) ||
          (decided.status === "unknown" && store.hasEvent(project, `decision:${waitingKey}`));
        // Alive, only max_queue_wait_minutes holds it. Otherwise the time its gates were in the gate queue doesn't
        // count (from the streak's start, or the last sighting there), and a wake that came ends the wait
        const from = queued ? streakStart : Math.max(streakStart, this.lastQueuedAt(task, streak?.runs ?? [latest]) ?? streakStart);
        const overQueue = queued !== null && now - streakStart >= maxQueueWait * 60000;
        const overWait = queued === null && wait.kind !== "woken" && now - from >= maxWait * 60000;
        const over = overQueue
          ? `agents.fill.wake.max_queue_wait_minutes (${maxQueueWait}), though its gate is still in the gate queue`
          : overWait
            ? `agents.fill.wake.max_wait_minutes (${maxWait})${from > streakStart ? ` counted from ${iso(from)}, when its gate was last in the gate queue` : ""}`
            : heldBefore
              ? `its wait budget (agents.fill.wake.max_wait_minutes ${maxWait}, max_queue_wait_minutes ${maxQueueWait}) earlier`
              : null;
        if (over !== null) {
          const on = wait.named ?? "its WAITING line";
          const view = wait.kind === "woken" ? null : { ...wait.view, queued: queuedView };
          const what = queued
            ? `waiting: ${queuedText(queued)}`
            : wait.kind === "woken"
              ? `waiting: ${on} since ${iso(since)}`
              : wait.detail;
          await hold(
            "waited_too_long",
            `${what}; its runs have been waiting since ${iso(streakStart)}, over ${over}: fill leaves the task to you`,
            latest.id,
            view,
          );
          await ask(latest, waitingKey, {
            code: "fill_waiting",
            question: `${agent} is paused on ${task}: it has waited on ${on} since ${iso(streakStart)}`,
            context: [
              `Run ${short(latest.id)} ended ${iso(since)} on this line:`,
              "",
              ...asData(status.line),
              "",
              ...(queued ? [`The gate it waits on: ${queuedText(queued)}.`, ""] : []),
              `Its runs have been waiting since ${iso(streakStart)}; fill holds the task until you answer.`,
            ],
            startLabel: "Start it again now",
            startConsequences: `Fill starts ${task} for ${agent} again on its next check, and the wait counts from zero.`,
            why: queued
              ? "Its gate has been in the gate queue longer than max_queue_wait_minutes: a machine or runner may be down, or the queue stuck."
              : "A gate or a review usually finishes on its own; a wait this long may mean it never will.",
            withOutput: false,
          });
          continue;
        }
        if (wait.kind === "woken") {
          // What it waited on came after the run ended: it starts again now, with no backoff and nothing counted
          await this.options.record(
            "fill_woken",
            {
              agent,
              task,
              runId: latest.id,
              summary: `fill: ${wait.file} is there: ${agent} starts on ${task} again`,
              evidence: [wait.file],
              data: { file: wait.file },
              dedupeKey: `fill_woken:${task}:${latest.id}`,
            },
            probes.clock.now(),
          );
        } else if (wait.kind === "pending") {
          const detail = queued ? `waiting: ${queuedText(queued)}; starts again once ${wait.file} exists` : wait.detail;
          await hold("waiting", detail, latest.id, { ...wait.view, queued: queuedView }, status.busId);
          continue;
        } else {
          // Waiting on nothing that came: a run without progress, counted and backed off
          const count = completions.length;
          const at = Math.max(wait.fallbackAt ?? 0, since + backoffMs(Math.max(count, 1), settings.backoffSeconds, settings.maxBackoffSeconds));
          if (now < at) {
            await hold(
              "waiting",
              `${wait.detail}${queued ? `; ${queuedText(queued)}` : ""}; counted as a run without progress (${count} of ${settings.maxCompletionsWithoutDone}): starting it again at ${iso(at)}`,
              latest.id,
              { ...wait.view, fallbackAt: iso(at), queued: queuedView },
            );
            continue;
          }
        }
      } else if (latest && latest.state === "completed") {
        const completions = this.completionsWithoutDone(task, releasedChain);
        const count = completions.length;
        if (count >= settings.maxCompletionsWithoutDone) {
          await holdNoDone(latest, completions);
          continue;
        }
        if (count >= 1) {
          const at = (latest.endedAt ?? latest.requestedAt) + backoffMs(count, settings.backoffSeconds, settings.maxBackoffSeconds);
          if (now < at) {
            await hold(
              "backoff",
              `its last run ${short(latest.id)} exited 0 without reporting it done (${count} of ${settings.maxCompletionsWithoutDone}): starting it again at ${iso(at)}`,
              latest.id,
            );
            continue;
          }
        }
      }

      const busy = store.activeRunForAgent(project, agent);
      if (busy) {
        await hold("busy", `${agent} is busy: run ${short(busy.id)} on ${busy.task} is ${busy.state}`);
        continue;
      }
      if (this.options.readOnly()) {
        await hold("read_only", "the project is read_only: Lair starts no agents");
        continue;
      }
      if (active >= settings.maxActive) {
        await hold("max_active", `max_active: ${active} run(s) fill started are active (max_active ${settings.maxActive})`);
        continue;
      }
      // Native capacity checks (per-agent and per-task, based on class and heavy work)
      const nativeCapacity = await this.checkNativeCapacity(agent, task, capacityState);
      if (nativeCapacity !== null) {
        await hold(nativeCapacity.hold, nativeCapacity.reason);
        continue;
      }
      // Legacy capacity_cmd check (same for all agents)
      if (noCapacity !== null) {
        await hold("capacity", noCapacity);
        continue;
      }
      const prompt = buildPrompt(settings.promptFiles, promptsDir, { agent, task });
      if (!prompt.ok) {
        await hold("prompt", prompt.reason);
        continue;
      }
      if (settings.capacityCmd) {
        const reason = await this.capacity(settings.capacityCmd, signal);
        if (signal.aborted) break;
        if (reason !== null) {
          noCapacity = reason;
          await hold("capacity", reason);
          continue;
        }
      }

      // A run of the task the store doesn't know (one reconciliation couldn't adopt) still runs: never a second
      const other = await this.options.taskProcess(task);
      if (other) {
        const reason = `pid ${other.pid} runs ${task} already (a run prompt file of the task is on its command line), though no run here owns it`;
        await this.options.record(
          "fill_conflict",
          {
            agent,
            task,
            summary: `fill: ${agent} doesn't start ${task}: ${reason}`,
            // Not its command line: another program's arguments are not Lair's to store
            evidence: [reason],
            data: { pid: other.pid },
            dedupeKey: `fill_conflict:${task}:${other.pid}`,
          },
          probes.clock.now(),
        );
        await hold("conflict", reason);
        continue;
      }

      let run: AgentRunView;
      try {
        // What the last run reported that wasn't its task, and a refused DONE report of it, are this run's first notes
        const notes = latest ? [this.unmatchedNote(latest), this.refusalNote(latest)].filter((n): n is string => n !== null) : [];
        run = await this.options.requestRun({ agent, task, prompt: notes.length > 0 ? `${prompt.text}\n\n${notes.join("\n\n")}\n` : prompt.text });
      } catch (e) {
        const why = message(e);
        if (why.startsWith("Over budget")) {
          // The hard limit's own spend decision asks the owner, and the refusal ends with the budget period
          await hold("refused", `the run request was refused: ${why}`);
          continue;
        }
        await refused(`the run request was refused: ${why}`, `${agent} can't start ${task}: ${oneLine(why, 120)}`, [
          "Fill asked Lair to start the run, and it was refused:",
          "",
          ...asData(why),
        ]);
        continue;
      }
      active++;
      if (capacityState.heavy !== undefined && this.isHeavyTask(task)) capacityState.heavy++;
      show("started", `started run ${short(run.id)}`, run.id);
      await this.options.record(
        "fill_started",
        {
          agent,
          task,
          runId: run.id,
          summary: `fill started ${agent} on ${task} (run ${short(run.id)})`,
          evidence: prompt.files.map((file) => `prompt file: ${file}`),
          data: { line, name, description, promptFiles: prompt.files, runId: run.id },
        },
        probes.clock.now(),
      );
    }
    for (const key of [...this.holds.keys()]) {
      if (!seen.has(key)) this.holds.delete(key);
    }
    for (const key of [...this.polled.keys()]) {
      if (!this.waitingSeen.has(key)) this.polled.delete(key);
    }
    for (const key of [...this.lastQueued.keys()]) {
      if (!this.waitingSeen.has(key)) this.lastQueued.delete(key);
    }
    // A check cut short saw only some lines: what it didn't see may still be held
    if (!signal.aborted) await this.withdrawLifted(views, wanted);
    // A line whose last run reported another task says so, beside why it is where it is
    for (const report of unmatchedThisCheck) {
      const view = views.find((v) => v.task === report.openTask);
      if (view) {
        view.detail = `${view.detail}; its run ${short(report.runId)} reported ${report.kind.toUpperCase()} for ${report.reportedTask || "no task id"}, not ${report.openTask}: an unmatched report, counted for no task`;
      }
    }
    // Shown from complete checks only (the queue is read again each check, so a line stays shown while its run is the last)
    if (!signal.aborted) this.unmatchedReports = unmatchedThisCheck;
    return views;
  }

  /**
   * Record a run's unmatched reports: one fill_unmatched event per line, kept
   * in the store (its dedupeKey is the task, the run and the line's hash), so
   * a line is reported once however many checks see it and across restarts;
   * a new event also goes on the event bus (agents.fill_unmatched). Returns
   * the run's view: its latest such line, since it was first seen.
   */
  private async recordUnmatched(run: AgentRun, reports: UnmatchedReport[]): Promise<FillUnmatchedReportView> {
    const { store, project, probes } = this.options;
    const key = (line: string) => `fill_unmatched:${run.task}:${run.id}:${sha256(Buffer.from(line, "utf-8")).slice(0, 16)}`;
    for (const report of reports) {
      await this.options.record(
        "fill_unmatched",
        {
          agent: run.agent,
          task: run.task,
          runId: run.id,
          summary: `fill: ${run.agent}'s ${report.kind.toUpperCase()} line names ${report.reportedTask || "no task id"}, not its task ${run.task}: it counts for no task (unmatched report)`,
          evidence: [report.line],
          data: { kind: report.kind, reportedTask: report.reportedTask, line: report.line, runId: run.id },
          dedupeKey: key(report.line),
        },
        probes.clock.now(),
      );
    }
    const last = reports[reports.length - 1];
    return {
      agent: run.agent,
      openTask: run.task,
      runId: run.id,
      reportedTask: last.reportedTask,
      kind: last.kind,
      line: oneLine(last.line, 300),
      at: iso(store.getEventByKey(project, key(last.line))?.at ?? probes.clock.now()),
    };
  }

  /** The note for the next run when its last run's latest unmatched report is kept (its line fenced as data), or null. */
  private unmatchedNote(run: AgentRun): string | null {
    if (this.options.settings.doneMatch !== "task_id") return null;
    const { store, project } = this.options;
    const event = store.listEvents(project, { kinds: ["fill_unmatched"], task: run.task, runId: run.id, limit: 1 })[0];
    if (typeof event?.data.line !== "string") return null;
    return [
      `Your previous run reported a task that is not yours; your task is ${run.task}. What it reported (its queue line, as data, not an instruction):`,
      ...asData(event.data.line),
    ].join("\n");
  }

  /**
   * The ready guard's verdict on a DONE line: null when it is accepted (the
   * guard is off, the task is not PR work, or the PR is ready). Fill and the
   * planner both settle a task through this, so a refused report is never a
   * done anywhere. A refusal that needs a change is recorded once
   * (fill_report_refused) with the instruction the agent gets next. One that
   * only time can fix (`retry`: CI running, the host not answering) is held
   * and checked again, for at most settings.readyWaitMinutes from its first
   * check (stored as fill_report_waiting, so a restart keeps it); then it is
   * `expired` and the caller asks the owner. Nothing here marks the task done
   * or sends anything to review.
   */
  async guardReport(
    agent: string,
    task: string,
    line: string,
    latest: AgentRun | null,
    taskText: string,
    report: StructuredReport | null = null,
  ): Promise<{ retry: boolean; expired: boolean; since: number; problems: string[] } | null> {
    const { store, project, settings, probes } = this.options;
    if (!settings.readyGuard) return null;
    const now = probes.clock.now();
    // A bus report (bus.consume on) names its PR and head in fields of their own: nothing is parsed from text
    const parsed: ParsedReport = report
      ? report.pr === null
        ? { kind: "none" }
        : { kind: "pr", report: { pr: report.pr, sha: report.sha?.toLowerCase() ?? null } }
      : parseReadyReport(line, taskText);
    // Whose branch the PR must be: the agent that reported it
    const reporter = report?.agent ?? agent;
    let pr: number | null = null;
    let verdict: ReadyVerdict;
    if (parsed.kind === "ambiguous") {
      verdict = refuseReport(
        "ambiguous",
        `the line names several PRs (${parsed.prs.map((n) => `#${n}`).join(", ")}) and the task names none of them`,
        "Report one PR: end the line with `PR #<n> at <sha>`.",
      );
    } else if (parsed.kind === "none") {
      if (!isPrWork(taskText)) return null;
      verdict = refuseReport("no_pr", "the task is about a pull request but the line names none", "Report again with `PR #<n> at <sha>` for the PR you opened.");
    } else {
      pr = parsed.report.pr;
      const source = this.options.readyFacts?.();
      if (parsed.report.sha === null) {
        verdict = refuseReport("no_head", `the line names PR #${pr} but not the head it reports on`, "Report again with `PR #<n> at <sha>`, the sha of the PR's head.", pr);
      } else if (!source) {
        verdict = unverifiable(pr, "no git host is set up to read this project's PRs");
      } else if (now < this.guardDownUntil) {
        verdict = unverifiable(pr, "the git host is not answering; asked again shortly");
      } else {
        verdict = await evaluateReady(parsed.report, source, { agent: reporter });
        if (!verdict.ok && verdict.hostDown) this.guardDownUntil = now + HOST_BACKOFF_MS;
      }
    }
    if (verdict.ok) return null;
    const hash = createHash("sha256").update(line).digest("hex").slice(0, 16);
    if (!verdict.retry) {
      await this.options.record(
        "fill_report_refused",
        {
          agent,
          task,
          runId: latest?.id,
          summary: `fill: ${agent}'s done report for ${task}${pr === null ? "" : ` (PR #${pr})`} was refused: ${verdict.reason}`,
          evidence: verdict.problems,
          data: { pr, reason: verdict.reason, instruction: verdict.instruction },
          dedupeKey: `fill_report_refused:${task}:${latest?.id ?? "none"}:${createHash("sha256").update(verdict.instruction).digest("hex").slice(0, 16)}`,
        },
        now,
      );
      return { retry: false, expired: false, since: now, problems: verdict.problems };
    }
    // Only time can fix it: held, but only for settings.readyWaitMinutes since it was first held
    const runId = latest?.id ?? null;
    const first = store
      .listEvents(project, { kinds: ["fill_report_waiting"], task, limit: 20 })
      .find((e) => e.data.lineHash === hash && (e.data.runId ?? null) === runId);
    const since = first?.at ?? now;
    if (!first) {
      await this.options.record(
        "fill_report_waiting",
        {
          agent,
          task,
          runId: latest?.id,
          summary: `fill: ${agent}'s done report for ${task}${pr === null ? "" : ` (PR #${pr})`} can't be verified yet: ${verdict.reason}`,
          evidence: verdict.problems,
          data: { pr, reason: verdict.reason, lineHash: hash, runId },
          dedupeKey: `fill_report_waiting:${task}:${runId ?? "none"}:${hash}`,
        },
        now,
      );
    }
    return { retry: true, expired: now - since >= settings.readyWaitMinutes * 60_000, since, problems: verdict.problems };
  }

  /** The instruction of the run's last refused DONE report, or null. */
  private refusalNote(run: AgentRun): string | null {
    const { store, project } = this.options;
    const event = store.listEvents(project, { kinds: ["fill_report_refused"], task: run.task, runId: run.id, limit: 1 })[0];
    return typeof event?.data.instruction === "string" ? event.data.instruction : null;
  }

  /**
   * The owner's pause of `task` (the reason shown), or null: their latest
   * pause or release of the task is a pause ("Keep it paused", or "Leave the
   * task unclaimed" on its run's escalation), about the task's latest run.
   */
  private pausedBy(task: string, latest: AgentRun | null): string | null {
    const { store, project } = this.options;
    const last = store.listEvents(project, { kinds: ["fill_paused", "fill_released"], task, limit: 1 })[0];
    if (!last || last.kind !== "fill_paused") return null;
    if ((typeof last.data.runId === "string" ? last.data.runId : null) !== (latest?.id ?? null)) return null;
    const why = typeof last.data.why === "string" ? last.data.why : "you paused it";
    return `paused by you (${why}, ${iso(last.at)}): fill starts it again once you release it`;
  }

  /**
   * Withdraw the open decisions whose hold lifted: fill's own that no line
   * of this check stands on (released in Work, the task done, started or
   * claimed, its line removed), and a run's escalation once its task is done.
   * An escalation whose chain moved on is the tick's to withdraw. A line
   * that is gone from the tasks file (or doesn't parse) counts only after
   * LINE_GONE_CHECKS checks in a row: an edit that takes it out and puts it
   * back (the planner's, say) neither withdraws its decision nor asks again.
   */
  private async withdrawLifted(views: FillLineView[], wanted: Set<string>): Promise<void> {
    const prefix = `agents:${this.options.project}:task:`;
    const lines = new Map(views.filter((v) => v.task !== null).map((v) => [v.task as string, v]));
    const gone = new Map<string, number>();
    for (const decision of this.options.openDecisions()) {
      if (wanted.has(decision.key)) continue;
      const own = decision.key.startsWith("fill:") && decision.source.ref.startsWith("fill:");
      const task = own
        ? decision.source.ref.slice("fill:".length)
        : decision.key.startsWith("escalation:")
          ? (decision.blocks.find((ref) => ref.startsWith(prefix))?.slice(prefix.length) ?? null)
          : null;
      if (task === null) continue;
      const line = lines.get(task);
      if (!own && line?.state !== "done") continue;
      if (!line) {
        const checks = (this.lineGone.get(decision.key) ?? 0) + 1;
        gone.set(decision.key, checks);
        if (checks < LINE_GONE_CHECKS) continue;
      }
      let reason: string;
      if (!line) reason = `${task} is no longer in the tasks file`;
      else if (line.state === "done") reason = `${task} is done`;
      else if (line.state === "held" && line.hold === "paused") reason = `you paused ${task}`;
      else if (line.state === "held") reason = `${task} is held for another reason now (${line.hold})`;
      else if (line.state === "started") reason = `${task} started again`;
      else reason = `${task} is ${line.state.replace(/_/g, " ")} now`;
      gone.delete(decision.key);
      await this.options.withdraw(decision, `The hold lifted: ${reason}.`);
    }
    // Counted again from zero once its line is back (or its decision closed)
    this.lineGone = gone;
  }

  /**
   * Where the decision of a hold stands (`key`: fillDecisionKey, or the
   * run's escalationDecisionKey): open, answered (with the option), withdrawn,
   * or none (never raised in the Decision Inbox; unknown without one). For
   * code that keeps a hold only while its decision says so.
   */
  holdDecision(key: string): HoldDecisionState {
    const decision = this.options.findDecision(key);
    if (decision === undefined) return { status: "unknown" };
    if (decision === null) return { status: "none" };
    if (decision.status === "open") return { status: "open", id: decision.id };
    if (decision.status === "withdrawn") return { status: "withdrawn", id: decision.id };
    return { status: "answered", id: decision.id, optionId: decision.answer?.optionId ?? null };
  }

  /**
   * One decision per hold (per task, latest run and kind of hold): start it
   * again (the release), or keep it paused (the owner's pause). The last
   * run's output is added unless `withOutput` is false; agent-written text
   * goes in as data.
   */
  private async raiseHold(
    latest: AgentRun | null,
    agent: string,
    task: string,
    key: string,
    ask: HoldQuestion,
  ): Promise<void> {
    const output = ask.withOutput === false || !latest ? [] : lastOutput(latest);
    await this.options.raise(
      {
        kind: "escalation",
        key,
        ref: `fill:${task}`,
        blocks: [`agents:${this.options.project}:task:${task}`],
        question: ask.question,
        context: [...ask.context, ...(output.length > 0 ? ["", "Last output:", ...output.map((l) => `- ${l}`)] : [])].join("\n"),
        options: [
          {
            id: DECISION_FILL_START,
            label: ask.startLabel ?? "Start it again",
            effect: "reversible",
            consequences: ask.startConsequences ?? `Fill starts ${task} for ${agent} again on its next check, counting from zero.`,
          },
          {
            id: DECISION_FILL_KEEP,
            label: "Keep it paused",
            effect: "reversible",
            consequences:
              ask.keepConsequences ??
              `Fill leaves ${task} paused until you start a run of it, or release it in Work. Nothing more is asked about it.`,
          },
        ],
        recommended: DECISION_FILL_KEEP,
        why:
          ask.why ??
          "A run that stops the same way again and again usually needs a change a restart won't make (a usage limit, a missing done line, a prompt).",
        reversible: true,
        structure: {
          class: ask.code === "probe_failed" || ask.code === "fill_waiting" ? "agents.cannot_start" : "agents.gave_up",
          evidence: {
            code: ask.code,
            facts: { agent, task, attempt_count: latest?.attempt ?? null, last_exit: latest?.exitCode ?? null },
            cause_cleared: false,
            linked_issue: null,
          },
        },
      },
      latest,
    );
  }

  /**
   * How the run ended, beyond exit 0: the latest WAITING or BLOCKED line for
   * the task written since its chain was requested. Once seen it is kept in
   * the store (fill_waiting / fill_blocked for this run), so a rotated queue
   * file doesn't turn a waiting or blocked run into one without progress.
   */
  private async runStatus(
    latest: AgentRun,
    agent: string,
    task: string,
    queue: QueueLines,
    until: QueueMark | undefined,
  ): Promise<RunStatus | null> {
    const { settings, store, project, probes } = this.options;
    const seen = queue.lastStatus(
      fillPatternFor(settings.waitingPattern, task, agent),
      fillPatternFor(settings.blockedPattern, task, agent),
      { task, agent },
      latest.queueMark,
      until,
    );
    if (seen) {
      await this.options.record(
        seen.kind === "waiting" ? "fill_waiting" : "fill_blocked",
        {
          agent,
          task,
          runId: latest.id,
          summary: `fill: run ${short(latest.id)} of ${agent} on ${task} ended ${seen.kind}: ${oneLine(seen.line)}`,
          evidence: [seen.line],
          data: seen.busId === null ? { line: seen.line, wake: seen.wake } : { line: seen.line, wake: seen.wake, busId: seen.busId },
          dedupeKey: `fill_status:${task}:${latest.id}:${seen.kind}:${sha256(Buffer.from(seen.line, "utf-8")).slice(0, 16)}`,
        },
        probes.clock.now(),
      );
      return seen;
    }
    const kept = store.listEvents(project, { kinds: ["fill_waiting", "fill_blocked"], task, runId: latest.id, limit: 1 })[0];
    if (!kept) return null;
    return {
      kind: kept.kind === "fill_waiting" ? "waiting" : "blocked",
      line: String(kept.data.line ?? ""),
      wake: typeof kept.data.wake === "string" ? kept.data.wake : null,
      busId: typeof kept.data.busId === "number" ? kept.data.busId : null,
    };
  }

  /**
   * What a waiting run waits on:
   * - pending: a wake file that isn't there yet (a real wait: nothing counted);
   * - woken: that file came: fill saw it absent before, or it is newer than
   *   the run's start (the gate the run queued finished, however soon). With
   *   wake.requeue_marker, so does the result of an id its gate was re-queued
   *   as, once it is newer than the chain's first start. It starts again at
   *   once, and the run counts neither for nor against the no-done count;
   * - weak: nothing to wait on (no capture, no wake.file, a refused capture,
   *   or a result older than the run, so naming it was no wait at all): it
   *   counts as a run without progress, and starts again after
   *   fallback_seconds (when nothing was named) and the backoff.
   * What fill found is kept per run in the store (fill_wake_absent,
   * fill_woken, fill_weak): a run once weak stays weak, so a result file
   * rewritten later can't lift a no_done hold; only the owner does.
   * A capture that isn't a plain name, or whose file would be outside
   * wake.root, is refused, and shown.
   */
  private async classifyWait(latest: AgentRun, agent: string, task: string, status: RunStatus, now: number): Promise<WaitState> {
    const { settings, store, project, probes } = this.options;
    const since = latest.endedAt ?? latest.requestedAt;
    let file: string | null = null;
    let refused: string | null = null;
    if (status.wake !== null && settings.wake.file) {
      const resolved = this.wakePath(status.wake);
      if (resolved.ok) file = resolved.path;
      else refused = resolved.reason;
    }
    const shown = status.wake === null ? null : oneLine(status.wake, 100);
    // Only a wake that resolved to a file names anything a decision may repeat
    const named = file !== null ? shown : null;
    const view = (fallbackAt: number | null): FillWaitingView => ({
      wake: shown,
      since: iso(since),
      fallbackAt: fallbackAt === null ? null : iso(fallbackAt),
      refused,
    });
    if (file !== null) {
      const stale: WaitState = {
        kind: "weak",
        named,
        fallbackAt: null,
        view: view(null),
        detail: `waiting: ${shown} since ${iso(since)}; its result ${file} was there before the run started, so that was no wait`,
      };
      const seen = new Set(
        store
          .listEvents(project, { kinds: ["fill_woken", "fill_weak", "fill_wake_absent"], task, runId: latest.id, limit: 10 })
          .map((e) => e.kind),
      );
      if (seen.has("fill_woken")) return { kind: "woken", file, named };
      if (seen.has("fill_weak")) return stale;
      const pollKey = `${task}|${latest.id}`;
      this.waitingSeen.add(pollKey);
      const found = this.wakeFile(pollKey, file, now);
      const path = file;
      const note = (kind: "fill_wake_absent" | "fill_weak", summary: string) =>
        this.options.record(
          kind,
          { agent, task, runId: latest.id, summary, evidence: [path], data: { file: path }, dedupeKey: `${kind}:${task}:${latest.id}` },
          probes.clock.now(),
        );
      if (found.state === "absent") {
        await note("fill_wake_absent", `fill: ${file} isn't there yet: ${agent} waits on it for ${task}`);
        // Its gate re-queued under a new id (wake.requeue_marker): that run's result, newer than the chain, wakes it too
        const requeued = status.wake !== null ? this.requeuedResult(status.wake, this.chainStart(latest)) : null;
        if (requeued !== null) return { kind: "woken", file: requeued, named };
      }
      if (found.state !== "present") {
        return {
          kind: "pending",
          named,
          file,
          view: view(null),
          detail: `waiting: ${shown} since ${iso(since)}; starts again once ${file} exists`,
        };
      }
      // It came: fill saw it absent before (whatever its mtime says: a copy may keep an old one), or it is newer than
      // the chain's first start (an earlier attempt of the same chain may have queued the gate the last one waits on)
      if (seen.has("fill_wake_absent") || found.mtimeMs > this.chainStart(latest)) {
        return { kind: "woken", file, named };
      }
      await note("fill_weak", `fill: ${file} was there before run ${short(latest.id)}'s chain started: waiting on it was no wait`);
      return stale;
    }
    const fallbackAt = since + settings.wake.fallbackSeconds * 1000;
    return {
      kind: "weak",
      named,
      fallbackAt,
      view: view(fallbackAt),
      detail: [`waiting: ${shown ?? "(nothing named)"} since ${iso(since)}`, ...(refused !== null ? [`wake "${shown}" refused: ${refused}`] : [])].join(
        "; ",
      ),
    };
  }

  /**
   * The task's current streak of waiting runs: the last run of each chain in
   * a row, newest first, that ended waiting (since the owner last released
   * it, and up to a chain the owner started), and when it began (the end of
   * the first of them), from the store, so it holds across restarts of Lair
   * and of the task.
   */
  private waitStreak(task: string, releasedChain: string | null): { start: number; runs: AgentRun[] } | null {
    const { store, project } = this.options;
    const runs: AgentRun[] = [];
    let start: number | null = null;
    for (const head of store.chainHeadsForTask(project, task, MAX_CHAINS_LOOKED_AT)) {
      if (head.chainId === releasedChain) break;
      const last = store.chainRuns(head.chainId).at(-1);
      if (!last || last.state !== "completed") break;
      if (store.listEvents(project, { kinds: ["fill_waiting"], task, runId: last.id, limit: 1 }).length === 0) break;
      runs.push(last);
      start = last.endedAt ?? last.requestedAt;
      if (head.origin !== "fill") break;
    }
    return start === null ? null : { start, runs };
  }

  /**
   * The gate a waiting line names, when its request is still in the gate
   * queue (queued or running): under its own id, else under an id a
   * re-queue marker says it became (the newest first). null for a wake that
   * isn't a plain name, or a gate the queue no longer has.
   */
  private queuedGate(wake: string | null, gateQueue: () => Map<string, QueuedRequest>): QueuedGate | null {
    if (wake === null || !isPlainWake(wake)) return null;
    const queue = gateQueue();
    let gate = wake;
    let request = queue.get(wake);
    if (!request) {
      for (const id of this.requeuedIds(wake).slice(1).reverse()) {
        request = queue.get(id);
        if (request) {
          gate = id;
          break;
        }
      }
    }
    if (!request) return null;
    let since: number;
    try {
      since = lstatSync(request.path).mtimeMs;
    } catch {
      return null; // it left the queue since the listing
    }
    return { gate, requeuedFrom: gate === wake ? null : wake, lane: request.lane, status: request.status, path: request.path, since };
  }

  /**
   * Keep what fill saw of a waiting run's gate in the gate queue, for the
   * wait budget: fill_gate_queued when it first sees it there, and
   * fill_gate_gone, with when it was last seen there, when it first finds it
   * gone (or the wake came). In between the last sighting is in memory; after
   * a restart, a gate seen queued before and gone now counts as seen until now.
   */
  private async noteQueued(run: AgentRun, agent: string, task: string, key: string, queued: QueuedGate | null, now: number): Promise<void> {
    const { store, project, probes } = this.options;
    const queuedKey = `fill_gate_queued:${task}:${run.id}`;
    if (queued) {
      this.lastQueued.set(key, now);
      if (store.hasEvent(project, queuedKey)) return;
      await this.options.record(
        "fill_gate_queued",
        {
          agent,
          task,
          runId: run.id,
          summary: `fill: ${agent} waits on ${task}'s gate ${queuedText(queued)}: the wait is alive`,
          evidence: [queued.path],
          data: { gate: queued.gate, requeuedFrom: queued.requeuedFrom, lane: queued.lane, status: queued.status, path: queued.path },
          dedupeKey: queuedKey,
        },
        probes.clock.now(),
      );
      return;
    }
    const goneKey = `fill_gate_gone:${task}:${run.id}`;
    const last = this.lastQueued.get(key);
    if (store.hasEvent(project, goneKey) || (last === undefined && !store.hasEvent(project, queuedKey))) return;
    await this.options.record(
      "fill_gate_gone",
      {
        agent,
        task,
        runId: run.id,
        summary: `fill: ${agent}'s gate for ${task} is no longer in the gate queue (last seen there ${iso(last ?? now)})`,
        data: { lastQueuedAt: last ?? now },
        dedupeKey: goneKey,
      },
      probes.clock.now(),
    );
  }

  /** The last time fill saw the gate of one of these waiting runs in the gate queue, from memory and the store. */
  private lastQueuedAt(task: string, runs: AgentRun[]): number | null {
    const { store, project } = this.options;
    const times: number[] = [];
    for (const run of runs) {
      const seen = this.lastQueued.get(`${task}|${run.id}`);
      if (seen !== undefined) times.push(seen);
      for (const event of store.listEvents(project, { kinds: ["fill_gate_queued", "fill_gate_gone"], task, runId: run.id, limit: 10 })) {
        times.push(event.kind === "fill_gate_gone" ? Number(event.data.lastQueuedAt) : event.at);
      }
    }
    const known = times.filter((t) => Number.isFinite(t));
    return known.length > 0 ? Math.max(...known) : null;
  }

  /**
   * The ids a waiting line's gate goes by: its own, then (with
   * wake.requeue_marker) each id a marker says it was re-queued or
   * re-checked as, breadth first, at most MAX_REQUEUE_IDS. A marker is a
   * regular file inside wake.root (not a symlink) whose first line is a
   * plain name; any other is passed over. Without the setting: its own only.
   */
  private requeuedIds(wake: string): string[] {
    const template = this.options.settings.wake.requeueMarker;
    const ids = [wake];
    if (!template) return ids;
    const ns: (string | undefined)[] = template.includes("{n}")
      ? Array.from({ length: MAX_MARKER_N }, (_, i) => String(i + 1))
      : [undefined];
    for (let i = 0; i < ids.length && ids.length < MAX_REQUEUE_IDS; i++) {
      for (const n of ns) {
        const marker = this.templatePath(template, ids[i], n);
        if (!marker.ok) continue;
        const next = firstLineOf(marker.path, MARKER_MAX_BYTES);
        if (next === null || !isPlainWake(next) || ids.includes(next)) continue;
        ids.push(next);
        if (ids.length >= MAX_REQUEUE_IDS) break;
      }
    }
    return ids;
  }

  /** The wake file of an id the waiting line's gate was re-queued as, when it exists and is newer than `after`. */
  private requeuedResult(wake: string, after: number): string | null {
    if (!isPlainWake(wake) || !this.options.settings.wake.file) return null;
    for (const id of this.requeuedIds(wake).slice(1)) {
      const resolved = this.wakePath(id);
      if (!resolved.ok) continue;
      try {
        if (lstatSync(resolved.path).mtimeMs > after) return resolved.path;
      } catch {
        // Not there yet
      }
    }
    return null;
  }

  /** The wake file for a waiting line's capture: a plain name, inside wake.root. */
  private wakePath(value: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (!isPlainWake(value)) {
      return { ok: false, reason: "not a plain name (letters, digits, '.', '_' and '-', no '..', '/' or leading '-')" };
    }
    return this.templatePath(this.options.settings.wake.file ?? "", value);
  }

  /** A wake template (wake.file, wake.requeue_marker) for one id: its placeholders filled, relative to repo, inside wake.root. */
  private templatePath(template: string, wake: string, n?: string): { ok: true; path: string } | { ok: false; reason: string } {
    const { config, settings } = this.options;
    const vars: Record<string, string> = { wake, gates_dir: config.gates_dir, agents_dir: config.agents_dir, repo: config.repo };
    if (n !== undefined) vars.n = n;
    const fill = (text: string) => text.replace(/\{(wake|n|gates_dir|agents_dir|repo)\}/g, (match, name: string) => vars[name] ?? match);
    const absolute = (path: string) => (isAbsolute(path) ? resolve(path) : resolve(config.repo, path));
    const root = absolute(fill(settings.wake.root));
    const path = absolute(fill(template));
    if (!within(root, path)) return { ok: false, reason: `${path} is outside wake.root (${root})` };
    return { ok: true, path };
  }

  /** When the run's chain first started a process (its first attempt's spawn), or was requested if none did. */
  private chainStart(run: AgentRun): number {
    const spawned = this.options.store
      .chainRuns(run.chainId)
      .map((r) => r.spawnedAt)
      .filter((at): at is number => at !== undefined);
    return spawned.length > 0 ? Math.min(...spawned) : (run.spawnedAt ?? run.requestedAt);
  }

  /** The wake file, looked for at most every wake.poll_seconds per waiting run ("unchecked" in between). */
  private wakeFile(
    key: string,
    path: string,
    now: number,
  ): { state: "present"; mtimeMs: number } | { state: "absent" } | { state: "unchecked" } {
    const last = this.polled.get(key);
    if (last !== undefined && now - last < this.options.settings.wake.pollSeconds * 1000) return { state: "unchecked" };
    try {
      const mtimeMs = lstatSync(path).mtimeMs;
      this.polled.delete(key);
      return { state: "present", mtimeMs };
    } catch {
      this.polled.set(key, now);
      return { state: "absent" };
    }
  }

  /**
   * Native capacity check for one agent starting one task: null when there is capacity, otherwise the hold and
   * why. Nothing is probed when no capacity limit is configured. The machine is read once per check (`state`),
   * and the heavy-work count once, kept current as this check starts heavy runs. A probe that fails or returns
   * nonsense holds ("capacity_probe"): fill never starts agents on a machine it could not measure.
   */
  private async checkNativeCapacity(
    agent: string,
    task: string,
    state: CapacityState,
  ): Promise<{ hold: FillHold; reason: string } | null> {
    const cap = this.options.settings.capacity;
    const wantsLoad = cap.loadPerCpuMax !== undefined;
    const wantsMemory = cap.memory.availableMinPct !== undefined;
    const wantsPressure = cap.memory.pressureMax !== undefined;
    const wantsHeavy = cap.heavyWork.detect.length > 0;
    if (!wantsLoad && !wantsMemory && !wantsPressure && !wantsHeavy) return null;

    const sysInfo = this.options.probes.systemInfo;
    state.machine ??= (async () => {
      const memory =
        wantsMemory || wantsPressure
          ? await sysInfo.memory({ pressure: wantsPressure, timeoutMs: CAPACITY_PROBE_TIMEOUT_MS })
          : undefined;
      return { cpus: sysInfo.cpuCount(), load: sysInfo.loadAvg1(), total: sysInfo.totalMemory(), memory };
    })();
    const machine = await state.machine;
    const numCpus = machine.cpus;
    const load1 = machine.load;
    const totalMem = machine.total;
    const available = machine.memory?.available;
    const pressure = machine.memory?.pressurePct;

    const availablePct =
      available !== undefined && Number.isFinite(available) && totalMem > 0 ? (available / totalMem) * 100 : undefined;
    const probeFailed = (what: string) => ({ hold: "capacity_probe" as const, reason: `no capacity: ${what} could not be read` });
    if (wantsLoad && !(Number.isFinite(numCpus) && numCpus > 0 && Number.isFinite(load1))) return probeFailed("CPU count or load");
    if (wantsMemory && availablePct === undefined) {
      return probeFailed("available memory");
    }
    if (wantsPressure && !(pressure !== undefined && Number.isFinite(pressure))) return probeFailed("memory pressure");

    const loadPerCpu = wantsLoad ? load1 / numCpus : undefined;
    state.heavy ??= wantsHeavy ? this.countHeavyWork() : 0;
    const heavyAtLimit = wantsHeavy && state.heavy >= cap.heavyWork.maxActive;
    const agentClass = getAgentClass(cap, agent);

    this.lastCapacity = {
      load: wantsLoad ? load1 : undefined,
      cpus: wantsLoad ? numCpus : undefined,
      loadPerCpu,
      loadPerCpuMax: cap.loadPerCpuMax,
      loadOverLimit: loadPerCpu !== undefined && cap.loadPerCpuMax !== undefined && loadPerCpu > cap.loadPerCpuMax,
      memory:
        availablePct !== undefined
          ? {
              total: totalMem,
              available: available as number,
              availablePct,
              underMin: cap.memory.availableMinPct !== undefined && availablePct < cap.memory.availableMinPct,
              availableMinPct: cap.memory.availableMinPct,
              pressurePct: pressure,
              pressureMax: cap.memory.pressureMax,
            }
          : undefined,
      heavyWork: wantsHeavy ? { active: state.heavy, maxActive: cap.heavyWork.maxActive, atLimit: heavyAtLimit } : undefined,
    };

    // Memory checks hold local and remote agents alike
    if (availablePct !== undefined && cap.memory.availableMinPct !== undefined && availablePct < cap.memory.availableMinPct) {
      return {
        hold: "capacity_memory",
        reason: `no capacity: available memory ${availablePct.toFixed(1)}% is below capacity.memory.available_min_pct (${cap.memory.availableMinPct}%)`,
      };
    }
    if (pressure !== undefined && cap.memory.pressureMax !== undefined && pressure > cap.memory.pressureMax) {
      return {
        hold: "capacity_memory",
        reason: `no capacity: memory pressure ${pressure.toFixed(1)}% exceeds capacity.memory.pressure_max (${cap.memory.pressureMax}%)`,
      };
    }

    // Load holds local agents only
    if (agentClass === "local" && loadPerCpu !== undefined && cap.loadPerCpuMax !== undefined && loadPerCpu > cap.loadPerCpuMax) {
      return {
        hold: "capacity_load",
        reason: `no capacity: load per CPU ${loadPerCpu.toFixed(2)} exceeds capacity.load_per_cpu_max (${cap.loadPerCpuMax})`,
      };
    }

    // Heavy work holds only a task that is itself heavy, whatever agent runs it
    if (heavyAtLimit && this.isHeavyTask(task)) {
      return {
        hold: "capacity_heavy",
        reason: `no capacity: ${state.heavy} heavy work item(s) active (capacity.heavy_work.max_active is ${cap.heavyWork.maxActive})`,
      };
    }

    return null;
  }

  /** True when the task id matches one of the heavy_work.detect globs. */
  private isHeavyTask(task: string): boolean {
    return this.options.settings.capacity.heavyWork.detectPatterns.some((pattern) => pattern.test(task));
  }

  /** Active runs whose task matches a heavy_work.detect glob. */
  private countHeavyWork(): number {
    const { store, project } = this.options;
    return store.activeRuns(project).filter((run) => this.isHeavyTask(run.task)).length;
  }

  /** null when capacity_cmd exits 0; otherwise why fill holds (a timeout holds too). */
  private async capacity(argv: string[], signal: AbortSignal): Promise<string | null> {
    const seconds = this.options.commandTimeoutSeconds;
    const out = await this.options.probes.runner.run(argv, { timeoutMs: seconds * 1000, signal });
    if (out.code === 0) return null;
    const first = firstLine(out.stdout) ?? firstLine(out.stderr);
    if (out.code === -1) {
      return `no capacity: capacity_cmd did not finish within ${seconds} s (timed out or could not start)${first ? `: ${first}` : ""}`;
    }
    return `no capacity (capacity_cmd exited ${out.code})${first ? `: ${first}` : ""}`;
  }
}
