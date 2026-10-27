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
 *     wake.max_wait_minutes (counted from the store, across restarts):
 *     held, with one decision;
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
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  AgentEventKind,
  AgentRunView,
  FillHold,
  FillLineState,
  FillLineView,
  FillStatusView,
  FillWaitingView,
} from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getPromptsDir } from "../routes/controls.js";
import {
  backoffMs,
  doneLineMatches,
  fillPatternFor,
  matchesByAgent,
  taskLineMatch,
  WAKE_VALUE,
  type FillPattern,
  type FillSettings,
} from "./config.js";
import type { DecisionRequest } from "./decisions.js";
import type { AgentProbes } from "./probes.js";
import { MAX_PROMPT_FILE_BYTES } from "./prompts.js";
import { lastLines, readTail } from "./sessions.js";
import type { AgentsStore } from "./store.js";
import { isActive, isValidTaskId, type AgentRun, type QueueMark } from "./types.js";

export const MAX_TASKS_FILE_BYTES = 256 * 1024;
export const MAX_TASK_LINES = 200;
export const MAX_TASK_LINE_CHARS = 2000;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const QUEUE_LINE_CHARS = 1000;
const MARK_TAIL_BYTES = 256;

/** The decision options fill offers for a task it holds for the owner */
export const DECISION_FILL_START = "start_again";
export const DECISION_FILL_KEEP = "keep_held";
/** Holds the owner lifts (POST /api/agents/fill/release, or the decision); a waiting one also ends by itself */
export const OWNER_HOLDS: readonly FillHold[] = ["owner", "no_done", "blocked", "waiting", "waited_too_long"];

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

/** Agent-written text for a decision's context: one line, bounded, in a code block (data, never markdown). */
function asData(text: string, max = 300): string[] {
  return ["```text", oneLine(text, max).replace(/`/g, "'"), "```"];
}

// ============ FILES ============

type Opened = { fd: number; size: number } | { error: string };

/**
 * Open a regular file for reading. O_NONBLOCK, so a FIFO put in its place
 * doesn't block the server (it is refused as not a regular file);
 * `noFollow` refuses a symlink as the last component.
 */
function openRegular(path: string, noFollow: boolean): Opened {
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

function readAt(fd: number, position: number, length: number): Buffer {
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
function readBounded(path: string, maxBytes: number, noFollow: boolean): { ok: true; text: string } | { ok: false; reason: string } {
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
  | { kind: "pending"; named: string | null; view: FillWaitingView; detail: string }
  | { kind: "woken"; named: string | null; file: string }
  | { kind: "weak"; named: string | null; view: FillWaitingView; detail: string; fallbackAt: number | null };

/** How many of a task's newest chains the no-done count and the wait streak look at */
const MAX_CHAINS_LOOKED_AT = 50;

/** The queue file's lines at one check (its last 4 MB), trimmed, each with the offset it starts at. */
class QueueLines {
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
   */
  private window(pattern: FillPattern, mark: QueueMark | undefined, until: QueueMark | undefined): { from: number; to: number } | null {
    const from = this.from(pattern, mark);
    if (from === null) return null;
    const to = pattern.task === null && until && this.usable(until) ? until.offset : Number.POSITIVE_INFINITY;
    return { from, to };
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
  | { kind: "task"; line: number; agent: string; name: string; task: string; description: string }
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
    if (!isValidDragonId(agent)) {
      bad(`${agent || "(empty)"} is not a valid agent id`);
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
    agentLines.set(agent.toLowerCase(), line);
    entries.push({ kind: "task", line, agent, name: name || agent, task, description });
  }
  return entries;
}

/** A tasks_file line as written (its fields trimmed): a done task stays done while it is unchanged. */
function lineHash(entry: { agent: string; name: string; task: string; description: string }): string {
  return sha256(Buffer.from([entry.agent, entry.name, entry.task, entry.description].join("\u0000"), "utf-8")).slice(0, 16);
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

export interface AgentsFillOptions {
  project: string;
  config: ProjectConfig;
  settings: FillSettings;
  /** agents.command_timeout_seconds: capacity_cmd's timeout */
  commandTimeoutSeconds: number;
  store: AgentsStore;
  probes: AgentProbes;
  readOnly: () => boolean;
  /** AgentsService.requestRun as fill: the module's in-process path */
  requestRun: (input: { agent: string; task: string; prompt: string }) => Promise<AgentRunView>;
  /** Record an event in the store, and on the bus */
  record: (kind: AgentEventKind, input: FillEventInput, at: number) => Promise<boolean>;
  /** Raise a decision in the Decision Inbox, once per key (AgentsService's) */
  raise: (request: FillDecision, run: AgentRun) => Promise<boolean>;
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
    const abort = new AbortController();
    this.abort = abort;
    const now = this.options.probes.clock.now();
    try {
      this.lines = await this.evaluate(abort.signal, now);
      this.lastError = abort.signal.aborted ? "the check was interrupted: the module stopped" : null;
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
    const promptsDir = getPromptsDir(config);
    let active = this.activeCount();
    let noCapacity: string | null = null;
    this.waitingSeen.clear();
    const views: FillLineView[] = [];
    const seen = new Set<string>();

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
        });
      };
      const hold = async (kind: FillHold, reason: string, runId: string | null = null, waiting: FillWaitingView | null = null) => {
        show("held", reason, runId, kind, waiting);
        if (this.holds.get(key) === kind) return;
        this.holds.set(key, kind);
        await this.options.record(
          "fill_held",
          { agent, task, summary: `fill holds ${agent} on ${task}: ${reason}`, evidence: [reason], data: { line, hold: kind, reason } },
          probes.clock.now(),
        );
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
      const until = byAgent && latest ? store.firstRunForAgentAfter(project, agent, task, latest)?.queueMark : undefined;

      // Done: kept once seen (for this latest run and this line as written), else from the queue file
      const doneKey = `fill_done:${task}:${latest?.id ?? "none"}:${lineHash(entry)}`;
      const kept = store.getEventByKey(project, doneKey);
      if (kept) {
        show("done", `done: ${oneLine(String(kept.data.line ?? ""))} (seen ${iso(kept.at)})`, latest?.id ?? null);
        continue;
      }
      let done: string | null;
      try {
        const donePattern = fillPatternFor(settings.donePattern, task, agent);
        if (donePattern.task !== null) {
          // A line that names the task: done is done, whatever came after it
          done = queue.find(donePattern, latest?.queueMark, until);
        } else {
          // A line by the agent only says where it is now: its last DONE, WAITING or BLOCKED line decides
          // ("- DONE row 1 by kiro-A", then "- WAITING <gate> by kiro-A" is waiting, not done)
          const last = queue.lastOf<"done" | "waiting" | "blocked">(
            [
              { kind: "done", pattern: donePattern },
              { kind: "waiting", pattern: fillPatternFor(settings.waitingPattern, task, agent) },
              { kind: "blocked", pattern: fillPatternFor(settings.blockedPattern, task, agent) },
            ],
            latest?.queueMark,
            until,
          );
          done = last?.kind === "done" ? last.line : null;
        }
      } catch (e) {
        await hold("refused", `done_pattern: ${message(e)}`);
        continue;
      }
      if (done !== null) {
        await this.options.record(
          "fill_done",
          {
            agent,
            task,
            runId: latest?.id,
            summary: `fill: ${task} is done: ${oneLine(done)}`,
            evidence: [done],
            data: { line: done, runId: latest?.id ?? null, lineHash: lineHash(entry) },
            dedupeKey: doneKey,
          },
          probes.clock.now(),
        );
        show("done", `done: ${oneLine(done)}`, latest?.id ?? null);
        continue;
      }

      // The owner's: a run that ended other than completed, or completions without done
      const release = store.listEvents(project, { kinds: ["fill_released"], task, limit: 1 })[0];
      const releasedRun = typeof release?.data.runId === "string" ? release.data.runId : null;
      const releasedChain = typeof release?.data.chainId === "string" ? release.data.chainId : null;
      // A superseded run never ran (another live claim held the task when it tried to start): it starts with no
      // backoff once that claim is gone, as a first start does; the claimed check above holds it until then
      if (latest && latest.state !== "completed" && latest.state !== "superseded" && latest.id !== releasedRun) {
        if (latest.state === "lost_claim" && !this.claimReleasedByOwner(latest)) {
          const reason = `its run ${short(latest.id)} lost its claim (${oneLine(latest.detail)}), not released by you: fill leaves the task to you`;
          await hold("owner", reason, latest.id);
          await this.raiseHold(latest, agent, task, {
            question: `Fill holds task ${task}: run ${short(latest.id)} of ${agent} lost its claim, and you did not release it`,
            context: ["Runs:", `- Run ${short(latest.id)}: ${latest.state}: ${oneLine(latest.detail)}`],
          });
        } else {
          await hold(
            "owner",
            `its last run ${short(latest.id)} ended ${latest.state} (${oneLine(latest.detail)}): fill leaves the task to you (answer its decision, start a run, or release the hold)`,
            latest.id,
          );
        }
        continue;
      }
      // A run that ended on a WAITING or BLOCKED line (the latest such line wins; a done line won above)
      const status =
        latest && latest.state === "completed" && latest.id !== releasedRun ? await this.runStatus(latest, agent, task, queue, until) : null;
      if (latest && status?.kind === "blocked") {
        const reason = `blocked: ${oneLine(status.line)}: fill leaves the task to you (release the hold once it is unblocked)`;
        await hold("blocked", reason, latest.id);
        await this.raiseHold(latest, agent, task, {
          kind: "blocked",
          question: `Fill holds task ${task}: ${agent} reported it blocked`,
          context: [`Run ${short(latest.id)} ended ${iso(latest.endedAt ?? latest.requestedAt)} on this line:`, "", ...asData(status.line)],
          startLabel: "Start it again",
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
        await this.raiseHold(run, agent, task, {
          question: `Fill holds task ${task}: ${agent}'s last ${count} run(s) exited 0 without reporting it done`,
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
        // A wait budget across restarts: from the first run of this streak of waiting runs
        const streakStart = this.waitStreakStart(task, releasedChain) ?? since;
        if (now - streakStart >= settings.wake.maxWaitMinutes * 60000) {
          const on = wait.named ?? "its WAITING line";
          const view = wait.kind === "woken" ? null : wait.view;
          const what = wait.kind === "woken" ? `waiting: ${on} since ${iso(since)}` : wait.detail;
          await hold(
            "waited_too_long",
            `${what}; its runs have been waiting since ${iso(streakStart)}, over agents.fill.wake.max_wait_minutes (${settings.wake.maxWaitMinutes}): fill leaves the task to you`,
            latest.id,
            view,
          );
          await this.raiseHold(latest, agent, task, {
            kind: "waiting",
            question: `Fill: ${agent} is waiting too long on ${on} (task ${task}, since ${iso(streakStart)})`,
            context: [
              `Run ${short(latest.id)} ended ${iso(since)} on this line:`,
              "",
              ...asData(status.line),
              "",
              `Its runs have been waiting since ${iso(streakStart)}; fill holds the task until you answer.`,
            ],
            startLabel: "Start it again now",
            startConsequences: `Fill starts ${task} for ${agent} again on its next check, and the wait counts from zero.`,
            why: "A gate or a review usually finishes on its own; a wait this long may mean it never will.",
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
          await hold("waiting", wait.detail, latest.id, wait.view);
          continue;
        } else {
          // Waiting on nothing that came: a run without progress, counted and backed off
          const count = completions.length;
          const at = Math.max(wait.fallbackAt ?? 0, since + backoffMs(Math.max(count, 1), settings.backoffSeconds, settings.maxBackoffSeconds));
          if (now < at) {
            await hold(
              "waiting",
              `${wait.detail}; counted as a run without progress (${count} of ${settings.maxCompletionsWithoutDone}): starting it again at ${iso(at)}`,
              latest.id,
              { ...wait.view, fallbackAt: iso(at) },
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

      let run: AgentRunView;
      try {
        run = await this.options.requestRun({ agent, task, prompt: prompt.text });
      } catch (e) {
        await hold("refused", `the run request was refused: ${message(e)}`);
        continue;
      }
      active++;
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
    return views;
  }

  /**
   * One decision per hold (per task, latest run and kind of hold): start it
   * again (the release), or keep it held. The last run's output is added
   * unless `withOutput` is false; agent-written text goes in as data.
   */
  private async raiseHold(
    latest: AgentRun,
    agent: string,
    task: string,
    ask: {
      kind?: "blocked" | "waiting";
      question: string;
      context: string[];
      startLabel?: string;
      startConsequences?: string;
      keepLabel?: string;
      keepConsequences?: string;
      why?: string;
      withOutput?: boolean;
    },
  ): Promise<void> {
    const output = ask.withOutput === false ? [] : lastOutput(latest);
    await this.options.raise(
      {
        kind: "escalation",
        key: fillDecisionKey(task, latest.id, ask.kind),
        ref: `fill:${task}`,
        blocks: [`agents:${this.options.project}:task:${task}`],
        question: ask.question,
        context: [...ask.context, ...(output.length > 0 ? ["", "Last output:", ...output.map((l) => `- ${l}`)] : [])].join("\n"),
        options: [
          {
            id: DECISION_FILL_START,
            label: ask.startLabel ?? "Let fill start it again",
            consequences: ask.startConsequences ?? `Fill starts ${task} for ${agent} again on its next check, counting from zero.`,
          },
          {
            id: DECISION_FILL_KEEP,
            label: ask.keepLabel ?? "Keep it held",
            consequences:
              ask.keepConsequences ?? `Fill leaves ${task} alone until you start a run of it, or release the hold in the Agents view.`,
          },
        ],
        recommended: DECISION_FILL_KEEP,
        why:
          ask.why ??
          "A run that stops the same way again and again usually needs a change a restart won't make (a usage limit, a missing done line, a prompt).",
        reversible: true,
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
   *   the run's start (the gate the run queued finished, however soon). It
   *   starts again at once, and the run counts neither for nor against the
   *   no-done count;
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
      }
      if (found.state !== "present") {
        return { kind: "pending", named, view: view(null), detail: `waiting: ${shown} since ${iso(since)}; starts again once ${file} exists` };
      }
      // It came: fill saw it absent before (whatever its mtime says: a copy may keep an old one), or it is newer than the run
      if (seen.has("fill_wake_absent") || found.mtimeMs > (latest.spawnedAt ?? latest.requestedAt)) {
        return { kind: "woken", file, named };
      }
      await note("fill_weak", `fill: ${file} was there before run ${short(latest.id)} started: waiting on it was no wait`);
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
   * When the task's current streak of waiting runs began: the end of the
   * first of the runs in a row, newest first, that ended waiting (since the
   * owner last released it, and up to a chain the owner started), from the
   * store, so it holds across restarts of Lair and of the task.
   */
  private waitStreakStart(task: string, releasedChain: string | null): number | null {
    const { store, project } = this.options;
    let start: number | null = null;
    for (const head of store.chainHeadsForTask(project, task, MAX_CHAINS_LOOKED_AT)) {
      if (head.chainId === releasedChain) break;
      const last = store.chainRuns(head.chainId).at(-1);
      if (!last || last.state !== "completed") break;
      if (store.listEvents(project, { kinds: ["fill_waiting"], task, runId: last.id, limit: 1 }).length === 0) break;
      start = last.endedAt ?? last.requestedAt;
      if (head.origin !== "fill") break;
    }
    return start;
  }

  /** The wake file for a waiting line's capture: a plain name, inside wake.root. */
  private wakePath(value: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (!WAKE_VALUE.test(value) || value.includes("..")) {
      return { ok: false, reason: "not a plain name (letters, digits, '.', '_' and '-', no '..', '/' or leading '-')" };
    }
    const { config, settings } = this.options;
    const vars: Record<string, string> = { wake: value, gates_dir: config.gates_dir, agents_dir: config.agents_dir, repo: config.repo };
    const fill = (template: string) => template.replace(/\{(wake|gates_dir|agents_dir|repo)\}/g, (match, name: string) => vars[name] ?? match);
    const absolute = (path: string) => (isAbsolute(path) ? resolve(path) : resolve(config.repo, path));
    const root = absolute(fill(settings.wake.root));
    const path = absolute(fill(settings.wake.file ?? ""));
    if (!within(root, path)) return { ok: false, reason: `${path} is outside wake.root (${root})` };
    return { ok: true, path };
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
