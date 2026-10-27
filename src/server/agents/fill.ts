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
 *   last chain was requested (the whole file for a task with no run). Once
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
 *   - no_done / backoff: its runs exited 0 without reporting it done. It is
 *     started again after a backoff (fill.backoff_seconds, doubling), and
 *     after fill.max_completions_without_done of them in a row it is held and
 *     one decision is raised, with the last output;
 *   - busy, read_only, max_active, capacity (capacity_cmd), prompt (a
 *     refused prompt file) or refused (the run request);
 *   the owner releases an owner or no_done hold from the Agents view, or by
 *   answering the decision;
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
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import type {
  AgentEventKind,
  AgentRunView,
  FillHold,
  FillLineState,
  FillLineView,
  FillStatusView,
} from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getPromptsDir } from "../routes/controls.js";
import { backoffMs, doneLineMatches, donePatternFor, type FillSettings } from "./config.js";
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
/** Holds only the owner lifts (POST /api/agents/fill/release, or the decision) */
export const OWNER_HOLDS: readonly FillHold[] = ["owner", "no_done"];

const short = (id: string) => id.slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/** The key of a fill decision about `task` while `runId` is its latest run (the task id may hold ':'; a run id doesn't). */
export const fillDecisionKey = (task: string, runId: string) => `fill:${task}:${runId}`;

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
   * The first line written after `mark` (the whole window without a usable
   * mark) that reports the task done (doneLineMatches).
   */
  find(pattern: RegExp, task: string, mark: QueueMark | undefined): string | null {
    const from = mark && this.usable(mark) ? mark.offset : 0;
    for (const line of this.lines) {
      if (line.start < from || !line.text.includes(task)) continue;
      if (doneLineMatches(pattern, task, line.text)) return line.text;
    }
    return null;
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
 */
export function parseTasksFile(content: string): TasksFileEntry[] {
  const entries: TasksFileEntry[] = [];
  const taskLines = new Map<string, number>();
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
    if (taskLines.size >= MAX_TASK_LINES) {
      bad(`past the limit of ${MAX_TASK_LINES} tasks`);
      continue;
    }
    taskLines.set(task, line);
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
   * The task's chains in a row, newest first, whose last run completed (exit
   * 0) without reporting it done: since the owner last released it, and up
   * to and including a chain the owner started (a new start counts afresh).
   */
  private completionsWithoutDone(task: string, releasedChain: string | null): AgentRun[] {
    const { store, project, settings } = this.options;
    const counted: AgentRun[] = [];
    for (const head of store.chainHeadsForTask(project, task, settings.maxCompletionsWithoutDone + 1)) {
      if (head.chainId === releasedChain) break;
      const last = store.chainRuns(head.chainId).at(-1);
      if (!last || last.state !== "completed") break;
      counted.push(last);
      if (head.origin !== "fill") break;
    }
    return counted;
  }

  private async evaluate(signal: AbortSignal, now: number): Promise<FillLineView[]> {
    const { project, settings, store, config, probes } = this.options;
    const path = this.tasksPath;
    if (!path) throw new Error("agents.fill.tasks_file is not set");
    const read = readBounded(path, MAX_TASKS_FILE_BYTES, false);
    if (!read.ok) throw new Error(`tasks_file ${path} ${read.reason}`);
    const entries = parseTasksFile(read.text);
    const allowed = new Set(settings.agents);
    const queue = new QueueLines(config.queue_file);
    const promptsDir = getPromptsDir(config);
    let active = this.activeCount();
    let noCapacity: string | null = null;
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
          runId: null,
        });
        continue;
      }
      const { line, agent, name, task, description } = entry;
      const key = `${agent}|${task}`;
      seen.add(key);
      const show = (state: FillLineState, detail: string, runId: string | null = null, hold: FillHold | null = null) => {
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
          runId,
        });
      };
      const hold = async (kind: FillHold, reason: string, runId: string | null = null) => {
        show("held", reason, runId, kind);
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

      // Done: kept once seen (for this latest run and this line as written), else from the queue file
      const doneKey = `fill_done:${task}:${latest?.id ?? "none"}:${lineHash(entry)}`;
      const kept = store.getEventByKey(project, doneKey);
      if (kept) {
        show("done", `done: ${oneLine(String(kept.data.line ?? ""))} (seen ${iso(kept.at)})`, latest?.id ?? null);
        continue;
      }
      let done: string | null;
      try {
        done = queue.find(donePatternFor(settings.donePattern, task, agent), task, latest?.queueMark);
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
          await this.raiseHold(latest, agent, task, `Fill holds task ${task}: run ${short(latest.id)} of ${agent} lost its claim, and you did not release it`, [
            `Run ${short(latest.id)}: ${latest.state}: ${oneLine(latest.detail)}`,
          ]);
        } else {
          await hold(
            "owner",
            `its last run ${short(latest.id)} ended ${latest.state} (${oneLine(latest.detail)}): fill leaves the task to you (answer its decision, start a run, or release the hold)`,
            latest.id,
          );
        }
        continue;
      }
      if (latest && latest.state === "completed") {
        const completions = this.completionsWithoutDone(task, releasedChain);
        const count = completions.length;
        if (count >= settings.maxCompletionsWithoutDone) {
          const reason = `its last ${count} run(s) exited 0 without reporting it done (agents.fill.max_completions_without_done is ${settings.maxCompletionsWithoutDone}): fill leaves the task to you`;
          await hold("no_done", reason, latest.id);
          await this.raiseHold(
            latest,
            agent,
            task,
            `Fill holds task ${task}: ${agent}'s last ${count} run(s) exited 0 without reporting it done`,
            completions.map((run) => `Run ${short(run.id)} (${run.origin === "fill" ? "fill" : "requested"}): ended ${iso(run.endedAt ?? run.requestedAt)}: ${oneLine(run.detail)}`),
          );
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
    return views;
  }

  /** One decision per hold (per task and latest run): start it again, or keep it held. */
  private async raiseHold(latest: AgentRun, agent: string, task: string, question: string, runs: string[]): Promise<void> {
    const output = lastOutput(latest);
    await this.options.raise(
      {
        kind: "escalation",
        key: fillDecisionKey(task, latest.id),
        ref: `fill:${task}`,
        blocks: [`agents:${this.options.project}:task:${task}`],
        question,
        context: [
          "Runs:",
          ...runs.map((r) => `- ${r}`),
          ...(output.length > 0 ? ["", "Last output:", ...output.map((l) => `- ${l}`)] : []),
        ].join("\n"),
        options: [
          {
            id: DECISION_FILL_START,
            label: "Let fill start it again",
            consequences: `Fill starts ${task} for ${agent} again on its next check, counting from zero.`,
          },
          {
            id: DECISION_FILL_KEEP,
            label: "Keep it held",
            consequences: `Fill leaves ${task} alone until you start a run of it, or release the hold in the Agents view.`,
          },
        ],
        recommended: DECISION_FILL_KEEP,
        why: "A run that stops the same way again and again usually needs a change a restart won't make (a usage limit, a missing done line, a prompt).",
        reversible: true,
      },
      latest,
    );
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
