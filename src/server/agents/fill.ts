/**
 * Fill (agents.fill, docs/configuration.md#fill): Lair starts agent runs
 * itself from a task list, so a project needs no launcher loop of its own.
 *
 * Every fill.interval_seconds each tasks_file line
 * (`<agent>|<name>|<task>|<description>`) is looked at in file order. It is:
 * - not_allowlisted when its agent isn't in fill.agents (another launcher may
 *   still run that agent): fill never starts it;
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
  FillWaitingView,
} from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { parseGateFilename } from "../parsers/gates.js";
import { getPromptsDir } from "../routes/controls.js";
import {
  backoffMs,
  doneLineMatches,
  fillPatternFor,
  getAgentClass,
  matchesByAgent,
  taskLineMatch,
  WAKE_VALUE,
  type FillPattern,
  type FillSettings,
} from "./config.js";
import { escalationDecisionKey, type DecisionRequest } from "./decisions.js";
import {
  computeIdleStates,
  findReadyWork,
  idleExplanation,
  idleStateView,
  shouldNotice,
  type IdleState,
} from "./idle.js";
import type { AgentProbes, MemoryReading } from "./probes.js";
import { MAX_PROMPT_FILE_BYTES } from "./prompts.js";
import { lastLines, readTail } from "./sessions.js";
import type { AgentsStore } from "./store.js";
import { isActive, isValidTaskId, type AgentRun, type QueueMark } from "./types.js";
import type { ProcessInfo } from "../watchdog/probes.js";

export const MAX_TASKS_FILE_BYTES = 256 * 1024;
export const MAX_TASK_LINES = 200;
export const MAX_TASK_LINE_CHARS = 2000;
const CAPACITY_PROBE_TIMEOUT_MS = 5_000;

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
const isPlainWake = (value: string) => WAKE_VALUE.test(value) && !value.includes("..");

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

/**
 * The queue file's lines at one check (its last 4 MB), trimmed, each with
 * the offset it starts at. Fill and the planner (checkDone) read it.
 */
export class QueueLines {
  private lines: { start: number; text: string }[] = [];
  private size = 0;
  private usableMarks = new Map<string, boolean>();

  constructor(private path: string) {
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
          this.lines.push({ start: begin + pos, text });
        }
        pos = end + 1;
      }
    } catch {
      this.lines = [];
    } finally {
      closeSync(opened.fd);
    }
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

  /** The first line in the pattern's window that reports what it looks for (taskLineMatch). */
  find(pattern: FillPattern, mark: QueueMark | undefined, until?: QueueMark): string | null {
    const window = this.window(pattern, mark, until);
    if (window === null) return null;
    for (const line of this.lines) {
      if (line.start >= window.from && line.start < window.to && doneLineMatches(pattern, line.text)) return line.text;
    }
    return null;
  }

  /**
   * The last line in the patterns' windows that one of them matches
   * (taskLineMatch; a line takes the first pattern that matches it): the
   * latest such line wins.
   */
  lastOf<K extends string>(
    patterns: { kind: K; pattern: FillPattern }[],
    mark: QueueMark | undefined,
    until?: QueueMark,
  ): { kind: K; line: string; match: RegExpExecArray } | null {
    const windows = patterns.map(({ pattern }) => this.window(pattern, mark, until));
    let last: { kind: K; line: string; match: RegExpExecArray } | null = null;
    for (const line of this.lines) {
      for (let i = 0; i < patterns.length; i++) {
        const window = windows[i];
        if (window === null || line.start < window.from || line.start >= window.to) continue;
        const match = taskLineMatch(patterns[i].pattern, line.text);
        if (match) {
          last = { kind: patterns[i].kind, line: line.text, match };
          break;
        }
      }
    }
    return last;
  }

  /**
   * The last line written after `mark` that reports the task waiting or
   * blocked: the latest such line wins. A waiting line's (?<wake>...) is
   * what it waits on.
   */
  lastStatus(waiting: FillPattern, blocked: FillPattern, mark: QueueMark | undefined, until?: QueueMark): RunStatus | null {
    const last = this.lastOf<"waiting" | "blocked">(
      [
        { kind: "waiting", pattern: waiting },
        { kind: "blocked", pattern: blocked },
      ],
      mark,
      until,
    );
    if (!last) return null;
    return { kind: last.kind, line: last.line, wake: last.kind === "waiting" ? last.match.groups?.wake?.trim() || null : null };
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
}

// ============ THE TASKS FILE ============

export type TasksFileEntry =
  | { kind: "task"; line: number; agent: string | null; name: string; task: string; description: string }
  | { kind: "malformed"; line: number; text: string; reason: string };

/**
 * tasks_file lines: `<agent>|<name>|<task>|<description>` (the description
 * may be empty and may hold "|"). `#` comments and blank lines are skipped.
 * A line that doesn't parse, names an invalid agent or task id, repeats a
 * task, or comes after the 200th task is malformed: reported, not fatal.
 * With `onePerAgent` (patterns that match by agent), so is a second line
 * for an agent: its queue lines couldn't say which of its tasks they're about.
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
    // Empty agent means unassigned task (ready work); non-empty must be valid
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
    const agentLine = agentLines.get(agent.toLowerCase());
    if (onePerAgent && agentLine !== undefined) {
      bad(`${agent} already has a task on line ${agentLine}: with patterns that match by agent, one line per agent`);
      continue;
    }
    if (taskLines.size >= MAX_TASK_LINES) {
      bad(`past the limit of ${MAX_TASK_LINES} tasks`);
      continue;
    }
    taskLines.set(task, line);
    // Only track agent lines for non-empty agents (unassigned tasks don't conflict)
    if (agent !== "") {
      agentLines.set(agent.toLowerCase(), line);
    }
    entries.push({ kind: "task", line, agent: agent || null, name: name || (agent || "unassigned"), task, description });
  }
  return entries;
}

/** A tasks_file line as written (its fields trimmed): a done task stays done while it is unchanged. */
function lineHash(entry: { agent: string | null; name: string; task: string; description: string }): string {
  return sha256(Buffer.from([entry.agent ?? "", entry.name, entry.task, entry.description].join("\u0000"), "utf-8")).slice(0, 16);
}

/** The fields of a tasks_file line with an assigned agent (for done checks, queue windows). */
export type TaskLineFields = { agent: string; name: string; task: string; description: string };

/** The key of the fill_done event that keeps a task done for its latest run and this line as written. */
function fillDoneKey(task: string, latestRunId: string | null, entry: TaskLineFields): string {
  return `fill_done:${task}:${latestRunId ?? "none"}:${lineHash(entry)}`;
}

/** A task fill judges done: from its kept record, or from a queue line. null: not done. */
export type DoneCheck = { kind: "kept"; line: string; at: number } | { kind: "queue"; line: string } | null;

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
  let line: string | null;
  if (donePattern.task !== null) {
    // A line that names the task: done is done, whatever came after it
    line = queue.find(donePattern, latest?.queueMark, until);
  } else {
    // A line by the agent only says where it is now: its last DONE, WAITING or BLOCKED line decides
    // ("- DONE row 1 by kiro-A", then "- WAITING <gate> by kiro-A" is waiting, not done)
    const last = queue.lastOf<"done" | "waiting" | "blocked">(
      [
        { kind: "done", pattern: donePattern },
        { kind: "waiting", pattern: fillPatternFor(settings.waitingPattern, entry.task, entry.agent) },
        { kind: "blocked", pattern: fillPatternFor(settings.blockedPattern, entry.task, entry.agent) },
      ],
      latest?.queueMark,
      until,
    );
    line = last?.kind === "done" ? last.line : null;
  }
  return line === null ? null : { kind: "queue", line };
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
  if (done.task !== null) {
    const line = queue.find(done, run.queueMark, until);
    if (line !== null) return { kind: "done", line };
    const status = queue.lastStatus(waiting, blocked, run.queueMark, until);
    return status ? { kind: status.kind, line: status.line } : null;
  }
  const last = queue.lastOf<ReportedOutcome["kind"]>(
    [
      { kind: "done", pattern: done },
      { kind: "waiting", pattern: waiting },
      { kind: "blocked", pattern: blocked },
    ],
    run.queueMark,
    until,
  );
  return last ? { kind: last.kind, line: last.line } : null;
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
}

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
  /** When fill last looked for a waiting run's wake file and didn't find it (task|run -> time) */
  private polled = new Map<string, number>();
  /** The waiting runs seen in the check in progress (to forget the others' polls) */
  private waitingSeen = new Set<string>();
  /** Open decisions whose line is gone from the tasks file: in how many checks in a row (key -> checks) */
  private lineGone = new Map<string, number>();
  /** When fill last saw a waiting run's gate in the gate queue (task|run -> time); the store keeps the first and last sightings */
  private lastQueued = new Map<string, number>();
  /** Idle states for all allowlisted agents (computed after each check) */
  private idleStates = new Map<string, IdleState>();
  /** Agents for which we've raised an idle notice (one per incident) */
  private idleNoticed = new Set<string>();
  /** Last capacity check state for the view */
  private lastCapacity: FillCapacityView | null = null;

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
    // Convert idle states to views
    const idle = Array.from(this.idleStates.values()).map(idleStateView);
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
      idle: idle.length > 0 ? idle : undefined,
      capacity: this.lastCapacity ?? undefined,
    };
  }

  /** The task's line at the last check, if there is one. */
  lineFor(task: string): FillLineView | null {
    return this.lines.find((line) => line.task === task) ?? null;
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

  /** Check soon, then every fill.interval_seconds, until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    await this.checking;
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
      // Compute idle states for all allowlisted agents
      await this.computeAndNotifyIdleStates(now);
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
   * Compute idle states for all allowlisted agents and raise notices as needed.
   * Called after each check to update the idle tracking.
   */
  private async computeAndNotifyIdleStates(now: number): Promise<void> {
    const { settings } = this.options;
    const { idle: idleSettings } = settings;

    // Find ready work from configured sources
    const readyWork = findReadyWork(idleSettings.readySources, this.lines);

    // Check if capacity_cmd refused (any held line with hold = "capacity")
    const capacityRefused = this.lines.some((l) => l.state === "held" && l.hold === "capacity");

    // Compute idle states for all agents
    const newStates = computeIdleStates(
      settings.agents,
      this.lines,
      this.activeCount(),
      settings.maxActive,
      capacityRefused,
      readyWork,
      now,
      this.idleStates,
    );

    // Update tracked states
    this.idleStates.clear();
    for (const state of newStates) {
      this.idleStates.set(state.agent, state);

      // Raise notice once per incident (when an agent is idle with ready work)
      if (shouldNotice(state, idleSettings) && !this.idleNoticed.has(state.agent)) {
        this.idleNoticed.add(state.agent);
        const durationMin = Math.round(state.duration / 60_000);
        await this.options.record(
          "fill_idle_notice",
          {
            agent: state.agent,
            summary: `${state.agent} idle for ${durationMin} min while ready work exists`,
            evidence: [idleExplanation(state)],
            data: { reason: state.reason, durationMinutes: durationMin },
          },
          now,
        );
      }

      // Clear the notice flag when the agent is no longer in the ready_work state
      if (state.reason !== "ready_work" && this.idleNoticed.has(state.agent)) {
        this.idleNoticed.delete(state.agent);
      }
    }
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

  private async evaluate(signal: AbortSignal, now: number): Promise<FillLineView[]> {
    const { project, settings, store, config, probes } = this.options;
    const path = this.tasksPath;
    if (!path) throw new Error("agents.fill.tasks_file is not set");
    const read = readBounded(path, MAX_TASKS_FILE_BYTES, false);
    if (!read.ok) throw new Error(`tasks_file ${path} ${read.reason}`);
    const byAgent = matchesByAgent(settings);
    const entries = parseTasksFile(read.text, byAgent);
    const allowed = new Set(settings.agents);
    const queue = new QueueLines(config.queue_file);
    // The gate queue, read at most once per check, and only when a waiting line names a gate
    let gateRequests: Map<string, QueuedRequest> | null = null;
    const gateQueue = () => (gateRequests ??= readGateQueue(config.gates_dir));
    const promptsDir = getPromptsDir(config);
    let active = this.activeCount();
    let noCapacity: string | null = null;
    const capacityState: CapacityState = {};
    this.waitingSeen.clear();
    const views: FillLineView[] = [];
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
      // This line's hold stands on the decision with this key: keep it, and show it on the line
      const standOn = (decisionKey: string) => {
        wanted.add(decisionKey);
        const decision = this.options.findDecision(decisionKey);
        const view = views[views.length - 1];
        if (view && view.task === task) view.decisionId = decision?.status === "open" ? decision.id : null;
      };

      // Unassigned task (no agent in tasks file): ready work, but fill can't start it
      if (agent === null) {
        show("unassigned", "no agent assigned: ready work for any agent");
        continue;
      }
      // After this point, agent is guaranteed to be a string (non-null)
      // Create variables with proper non-null types for use in closures and functions
      const agentId: string = agent;
      const assignedEntry: TaskLineFields = { agent: agentId, name, task, description };
      
      // Define closures that use the narrowed agentId
      const holdTask = async (kind: FillHold, reason: string, runId: string | null = null, waiting: FillWaitingView | null = null) => {
        show("held", reason, runId, kind, waiting);
        if (this.holds.get(key) === kind) return;
        this.holds.set(key, kind);
        await this.options.record(
          "fill_held",
          { agent: agentId, task, summary: `fill holds ${agentId} on ${task}: ${reason}`, evidence: [reason], data: { line, hold: kind, reason } },
          probes.clock.now(),
        );
      };
      // One decision per hold that needs the owner: raised once, kept while the hold lasts
      const askOwner = async (run: AgentRun | null, decisionKey: string, question: HoldQuestion) => {
        await this.raiseHold(run, agentId, task, decisionKey, question);
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
      const until = queueWindowEnd(store, project, settings, assignedEntry, latest);

      // The owner's last release of the task, and their pause (the owner's own hold) when it is newer
      const release = store.listEvents(project, { kinds: ["fill_released"], task, limit: 1 })[0];
      const paused = this.pausedBy(task, latest);
      // A refusal needs the owner: one decision per refusal and release ("Start it again" that is refused again asks again)
      const refused = async (reason: string, question: string, context: string[]) => {
        if (paused) {
          await holdTask("paused", paused, latest?.id ?? null);
          return;
        }
        await holdTask("refused", reason);
        await askOwner(latest, fillRefusedKey(task, release?.id ?? "0", latest?.id ?? null), {
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
        check = checkDone(store, project, queue, settings, assignedEntry, latest, until);
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
      if (check?.kind === "queue") {
        const done = check.line;
        await this.options.record(
          "fill_done",
          {
            agent,
            task,
            runId: latest?.id,
            summary: `fill: ${task} is done: ${oneLine(done)}`,
            evidence: [done],
            data: { line: done, runId: latest?.id ?? null, lineHash: lineHash(assignedEntry) },
            dedupeKey: fillDoneKey(task, latest?.id ?? null, assignedEntry),
          },
          probes.clock.now(),
        );
        show("done", `done: ${oneLine(done)}`, latest?.id ?? null);
        continue;
      }

      // The owner chose to leave it: nothing waits for them, and nothing starts until they release it
      if (paused) {
        await holdTask("paused", paused, latest?.id ?? null);
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
          await holdTask("owner", reason, latest.id);
          await askOwner(latest, fillDecisionKey(task, latest.id), {
            code: "repeated_failure",
            question: `${agent} is paused on ${task}: its run lost its claim to the task, and you did not release it`,
            context: runs,
          });
          continue;
        }
        await holdTask(
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
        await askOwner(latest, fillDecisionKey(task, latest.id), {
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
        await holdTask("blocked", reason, latest.id);
        await askOwner(latest, fillDecisionKey(task, latest.id, "blocked"), {
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
        await holdTask(
          "no_done",
          `its last ${count} run(s) exited 0 without progress (no done line, or waiting on nothing that came; agents.fill.max_completions_without_done is ${settings.maxCompletionsWithoutDone}): fill leaves the task to you`,
          run.id,
        );
        await askOwner(run, fillDecisionKey(task, run.id), {
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
          await holdTask(
            "waited_too_long",
            `${what}; its runs have been waiting since ${iso(streakStart)}, over ${over}: fill leaves the task to you`,
            latest.id,
            view,
          );
          await askOwner(latest, waitingKey, {
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
          await holdTask("waiting", detail, latest.id, { ...wait.view, queued: queuedView });
          continue;
        } else {
          // Waiting on nothing that came: a run without progress, counted and backed off
          const count = completions.length;
          const at = Math.max(wait.fallbackAt ?? 0, since + backoffMs(Math.max(count, 1), settings.backoffSeconds, settings.maxBackoffSeconds));
          if (now < at) {
            await holdTask(
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
            await holdTask(
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
        await holdTask("busy", `${agent} is busy: run ${short(busy.id)} on ${busy.task} is ${busy.state}`);
        continue;
      }
      if (this.options.readOnly()) {
        await holdTask("read_only", "the project is read_only: Lair starts no agents");
        continue;
      }
      if (active >= settings.maxActive) {
        await holdTask("max_active", `max_active: ${active} run(s) fill started are active (max_active ${settings.maxActive})`);
        continue;
      }
      // Native capacity checks (per-agent and per-task, based on class and heavy work)
      const nativeCapacity = await this.checkNativeCapacity(agent, task, capacityState);
      if (nativeCapacity !== null) {
        await holdTask(nativeCapacity.hold, nativeCapacity.reason);
        continue;
      }
      // Legacy capacity_cmd check (same for all agents)
      if (noCapacity !== null) {
        await holdTask("capacity", noCapacity);
        continue;
      }
      const prompt = buildPrompt(settings.promptFiles, promptsDir, { agent, task });
      if (!prompt.ok) {
        await holdTask("prompt", prompt.reason);
        continue;
      }
      if (settings.capacityCmd) {
        const reason = await this.capacity(settings.capacityCmd, signal);
        if (signal.aborted) break;
        if (reason !== null) {
          noCapacity = reason;
          await holdTask("capacity", reason);
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
        await holdTask("conflict", reason);
        continue;
      }

      let run: AgentRunView;
      try {
        run = await this.options.requestRun({ agent, task, prompt: prompt.text });
      } catch (e) {
        const why = message(e);
        if (why.startsWith("Over budget")) {
          // The hard limit's own spend decision asks the owner, and the refusal ends with the budget period
          await holdTask("refused", `the run request was refused: ${why}`);
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
    return views;
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
          data: { line: seen.line, wake: seen.wake },
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
