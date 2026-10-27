/**
 * The planner's sources (docs/design/planner.md#sources): plan and backlog
 * files with checkbox tasks (or list items, or table rows), the owner's
 * messages, and the queue lines the agents report with. Every read is
 * bounded and stays inside the configured roots (files.ts); lines are cut
 * before any regular expression sees them; parsing is one pass, line by
 * line.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { createHash } from "crypto";
import { dirname } from "path";
import type { QueueLineType } from "../../shared/types.js";
import type { SourceFileView, SourceStatusView } from "../../shared/planner-types.js";
import { parseQueueLine } from "../parsers/queue.js";
import { parseInboxLine, parseOutboxLine } from "../parsers/inbox.js";
import { isValidTaskId, type QueueMark } from "../agents/types.js";
import type { OwnerSourceSettings, PlanSourceSettings, QueueSourceSettings } from "./config.js";
import { checkedPath, clean, readInside, sha256 } from "./files.js";

/** Lines are cut to this many characters before any pattern sees them */
export const LINE_CHARS = 2000;
const DETAIL_LINES = 12;
const DETAIL_CHARS = 300;
const TEXT_CHARS = 500;
/** The queue's last bytes read each cycle, and the line cut (fill's) */
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const QUEUE_LINE_CHARS = 1000;
const MARK_TAIL_BYTES = 256;

export interface PlanTask {
  source: string;
  file: string;
  line: number;
  id: string | null;
  text: string;
  done: boolean;
  section: string | null;
  phase: string | null;
  dependsOn: string[];
  details: string[];
}

export interface ParsedFile {
  tasks: PlanTask[];
  lines: number;
  truncated: boolean;
}

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,4}[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^\*\*([^*]{1,200})\*\*:?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}/g;

function idFrom(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const id = (match.groups?.id ?? match[1] ?? "").trim();
  return isValidTaskId(id) ? id : null;
}

/** "depends on A, B and C" -> [A, B, C] (ids only, at most 20). */
function dependsFrom(pattern: RegExp | null, text: string): string[] {
  if (!pattern) return [];
  const ids: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = pattern.exec(text)) !== null && guard++ < 20) {
    const list = match.groups?.ids ?? match[1] ?? "";
    for (const raw of list.match(ID_TOKEN) ?? []) {
      // "depends on S-1." or "S-1:": the punctuation ends the sentence, not the id
      const token = raw.replace(/[.:/#-]+$/, "");
      if (token.toLowerCase() === "and" || !isValidTaskId(token)) continue;
      if (!ids.includes(token)) ids.push(token);
      if (ids.length >= 20) return ids;
    }
    if (match[0].length === 0) pattern.lastIndex++;
  }
  pattern.lastIndex = 0;
  return ids;
}

/**
 * Plan tasks in markdown: checkbox lines (`- [ ] ...`, `* [x] ...`), with
 * their headings (the section path) and phase (phase_pattern on a heading),
 * the lines indented under them as details, and depends_pattern ids. A line
 * that is only bold text (`**Data model**`) is a subsection. Fenced code
 * blocks are skipped. The id comes from id_pattern; a task without one keeps
 * id null.
 */
export function parseMarkdownTasks(text: string, settings: PlanSourceSettings, file: string, checkboxesOnly = true): ParsedFile {
  const raw = text.split("\n");
  const truncated = raw.length > settings.maxLines;
  const lines = truncated ? raw.slice(0, settings.maxLines) : raw;
  const tasks: PlanTask[] = [];
  const headings: string[] = [];
  let bold: string | null = null;
  let phase: string | null = null;
  let inFence = false;
  let current: { task: PlanTask; indent: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").slice(0, LINE_CHARS);
    if (FENCE.test(line)) {
      inFence = !inFence;
      current = null;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = clean(heading[2], 200);
      bold = null;
      const p = settings.phasePattern?.exec(heading[2]);
      if (p) phase = clean(p.groups?.phase ?? p[1] ?? heading[2], 40);
      else if (level <= 2) phase = null;
      current = null;
      continue;
    }
    const boldLine = BOLD_LINE.exec(line.trim());
    if (boldLine) {
      bold = clean(boldLine[1], 200);
      current = null;
      continue;
    }
    const box = CHECKBOX.exec(line);
    const item = box ? null : checkboxesOnly ? null : LIST_ITEM.exec(line);
    if (box || item) {
      const indent = (box ? box[1] : item![1]).replace(/\t/g, "    ").length;
      // An item indented under a task is one of its details
      if (current && indent > current.indent) {
        if (current.task.details.length < DETAIL_LINES) current.task.details.push(clean(line, DETAIL_CHARS));
        continue;
      }
      const body = box ? box[3] : item![2];
      const done = box ? box[2] !== " " : settings.donePattern?.test(body) === true;
      const section = [...headings.filter((h) => h), ...(bold ? [bold] : [])].join(" > ") || null;
      const task: PlanTask = {
        source: settings.name,
        file,
        line: i + 1,
        id: idFrom(settings.idPattern, body),
        text: clean(body, TEXT_CHARS),
        done,
        section,
        phase,
        dependsOn: dependsFrom(settings.dependsPattern, body),
        details: [],
      };
      tasks.push(task);
      current = { task, indent };
      continue;
    }
    if (current && line.trim().length > 0 && /^\s/.test(line)) {
      if (current.task.details.length < DETAIL_LINES) current.task.details.push(clean(line, DETAIL_CHARS));
      for (const id of dependsFrom(settings.dependsPattern, line)) {
        if (!current.task.dependsOn.includes(id) && current.task.dependsOn.length < 20) current.task.dependsOn.push(id);
      }
      continue;
    }
    if (line.trim().length > 0) current = null;
  }
  return { tasks, lines: lines.length, truncated };
}

/** Backlog rows in a markdown table: every row after a header and its separator; the id from id_column. */
export function parseTableTasks(text: string, settings: PlanSourceSettings, file: string): ParsedFile {
  const raw = text.split("\n");
  const truncated = raw.length > settings.maxLines;
  const lines = truncated ? raw.slice(0, settings.maxLines) : raw;
  const tasks: PlanTask[] = [];
  const headings: string[] = [];
  let header = false;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").slice(0, LINE_CHARS);
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = clean(heading[2], 200);
      inTable = false;
      continue;
    }
    const row = TABLE_ROW.exec(line);
    if (!row) {
      inTable = false;
      continue;
    }
    if (TABLE_SEPARATOR.test(line)) {
      header = false;
      continue;
    }
    if (!inTable) {
      // The first row of a table is its header
      inTable = true;
      header = true;
      continue;
    }
    if (header) continue;
    const cells = row[1].split("|").map((cell) => cell.trim());
    const idCell = cells[settings.idColumn - 1] ?? "";
    const body = cells.join(" | ");
    tasks.push({
      source: settings.name,
      file,
      line: i + 1,
      id: idFrom(settings.idPattern, idCell),
      text: clean(body, TEXT_CHARS),
      done: settings.donePattern?.test(body) === true,
      section: headings.filter((h) => h).join(" > ") || null,
      phase: null,
      dependsOn: dependsFrom(settings.dependsPattern, body),
      details: [],
    });
  }
  return { tasks, lines: lines.length, truncated };
}

function emptyStatus(name: string, kind: SourceStatusView["kind"]): SourceStatusView {
  return { name, kind, ok: true, files: [], tasks: 0, open: 0, done: 0, withoutId: 0, duplicates: 0, items: 0 };
}

export interface PlanSourceRead {
  status: SourceStatusView;
  tasks: PlanTask[];
  /** One hash of every file's content (or error), to notice a change */
  hash: string;
}

/** Read and parse a markdown_plan or backlog_file source. */
export function readPlanSource(settings: PlanSourceSettings, roots: string[]): PlanSourceRead {
  const status = emptyStatus(settings.name, settings.kind);
  const tasks: PlanTask[] = [];
  const digest = createHash("sha256");
  const seen = new Set<string>();
  for (const path of settings.paths) {
    const view: SourceFileView = { path, ok: true, error: null, bytes: 0, lines: 0, truncated: false };
    status.files.push(view);
    const read = readInside(path, roots, settings.maxBytes, "whole");
    if (!read.ok) {
      view.ok = false;
      view.error = read.reason;
      status.ok = false;
      digest.update(`error:${path}\n`);
      continue;
    }
    digest.update(`${path}\n${sha256(read.text)}\n`);
    view.bytes = read.bytes;
    const parsed =
      settings.format === "table"
        ? parseTableTasks(read.text, settings, path)
        : parseMarkdownTasks(read.text, settings, path, settings.format !== "list");
    view.lines = parsed.lines;
    view.truncated = parsed.truncated;
    for (const task of parsed.tasks) {
      if (task.id !== null) {
        if (seen.has(task.id)) {
          status.duplicates++;
          task.id = null;
        } else {
          seen.add(task.id);
        }
      }
      tasks.push(task);
    }
  }
  status.tasks = tasks.length;
  status.done = tasks.filter((t) => t.done).length;
  status.open = status.tasks - status.done;
  status.withoutId = tasks.filter((t) => t.id === null).length;
  return { status, tasks, hash: digest.digest("hex") };
}

// ============ OWNER MESSAGES ============

export interface OwnerMessage {
  id: string;
  at: string;
  text: string;
}

export interface OwnerMessagesRead {
  status: SourceStatusView;
  /** Unanswered messages, oldest first, at most max_messages (the newest) */
  messages: OwnerMessage[];
}

function projectRoots(path: string, projectFile: boolean, roots: string[]): string[] {
  // A file the project config names itself is checked against its own directory
  return projectFile ? [dirname(path)] : roots;
}

/** `- OWNER <time> [<id>]: <text>` lines without a `- REPLY <id> ...` line (parsers/inbox.ts). */
export function readOwnerMessages(settings: OwnerSourceSettings, roots: string[]): OwnerMessagesRead {
  const status = emptyStatus(settings.name, "owner_messages");
  const view: SourceFileView = { path: settings.path, ok: true, error: null, bytes: 0, lines: 0, truncated: false };
  status.files.push(view);
  const allowed = projectRoots(settings.path, settings.projectFile, roots);
  const read = readInside(settings.path, allowed, settings.maxBytes, "tail");
  if (!read.ok) {
    // No message file yet is no messages
    if (!read.reason.endsWith("does not exist")) {
      view.ok = false;
      view.error = read.reason;
      status.ok = false;
    }
    return { status, messages: [] };
  }
  view.bytes = read.bytes;
  view.truncated = read.bytes > settings.maxBytes;
  const answered = new Set<string>();
  if (settings.repliesPath) {
    const replyView: SourceFileView = { path: settings.repliesPath, ok: true, error: null, bytes: 0, lines: 0, truncated: false };
    status.files.push(replyView);
    const replies = readInside(settings.repliesPath, settings.projectFile ? [dirname(settings.repliesPath)] : roots, settings.maxBytes, "tail");
    if (replies.ok) {
      replyView.bytes = replies.bytes;
      for (const line of replies.text.split("\n")) {
        const reply = parseOutboxLine(line.slice(0, LINE_CHARS));
        if (reply) answered.add(reply.id);
      }
      replyView.lines = replies.text.split("\n").length;
    } else if (!replies.reason.endsWith("does not exist")) {
      replyView.ok = false;
      replyView.error = replies.reason;
    }
  }
  const lines = read.text.split("\n");
  view.lines = lines.length;
  const messages: OwnerMessage[] = [];
  for (const line of lines) {
    const item = parseInboxLine(line.slice(0, LINE_CHARS));
    if (!item || answered.has(item.id)) continue;
    messages.push({ id: clean(item.id, 64), at: clean(item.timestamp, 40), text: clean(item.text, TEXT_CHARS) });
  }
  const kept = messages.slice(-settings.maxMessages);
  status.items = kept.length;
  return { status, messages: kept };
}

// ============ QUEUE EVENTS ============

export interface QueueEvent {
  /** Where the line starts in the queue file */
  offset: number;
  type: QueueLineType;
  agent: string | null;
  /** The task as the line names it (parseQueueLine), not necessarily a task id */
  task: string | null;
  text: string;
}

export interface QueueEventsRead {
  status: SourceStatusView;
  /** Lines written since `cursor`, oldest first, at most max_events (the newest) */
  events: QueueEvent[];
  /** Where this read ended: the next cursor */
  cursor: QueueMark;
  /** The file no longer has the bytes before the cursor (rewritten, truncated): no events, a new baseline */
  reset: boolean;
}

const markHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function readRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

/**
 * The queue lines written since `cursor` (fill's QueueMark: an offset, and a
 * hash of the bytes before it). No cursor: a baseline, no events. A file
 * that no longer matches the cursor gives a new baseline too, so old lines
 * are never taken for new ones. At most the last 4 MB are read; lines are
 * cut at 1,000 characters.
 */
export function readQueueEvents(settings: QueueSourceSettings, roots: string[], cursor: QueueMark | null): QueueEventsRead {
  const status = emptyStatus(settings.name, "queue_events");
  const view: SourceFileView = { path: settings.path, ok: true, error: null, bytes: 0, lines: 0, truncated: false };
  status.files.push(view);
  const empty = (reason: string | null, reset: boolean): QueueEventsRead => {
    if (reason) {
      view.ok = false;
      view.error = reason;
      status.ok = false;
    }
    return { status, events: [], cursor: cursor ?? { offset: 0, tail: markHash(Buffer.alloc(0)) }, reset };
  };
  const checked = checkedPath(settings.path, projectRoots(settings.path, settings.projectFile, roots));
  if (!checked.ok) return empty(checked.reason.endsWith("does not exist") ? null : checked.reason, false);
  let fd: number;
  try {
    fd = openSync(checked.real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    return empty(`${settings.path} cannot be read (${(e as NodeJS.ErrnoException).code ?? String(e)})`, false);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return empty(`${settings.path} is not a regular file`, false);
    const size = st.size;
    view.bytes = size;
    const tailLength = Math.min(size, MARK_TAIL_BYTES);
    const next: QueueMark = { offset: size, tail: markHash(readRange(fd, size - tailLength, tailLength)) };
    if (!cursor) return { status, events: [], cursor: next, reset: true };
    const usable =
      cursor.offset <= size &&
      markHash(readRange(fd, cursor.offset - Math.min(cursor.offset, MARK_TAIL_BYTES), Math.min(cursor.offset, MARK_TAIL_BYTES))) === cursor.tail;
    if (!usable) return { status, events: [], cursor: next, reset: true };
    const begin = Math.max(cursor.offset, size - QUEUE_MAX_BYTES);
    view.truncated = begin > cursor.offset;
    const bytes = readRange(fd, begin, size - begin);
    const events: QueueEvent[] = [];
    let pos = 0;
    let lines = 0;
    while (pos < bytes.length) {
      const newline = bytes.indexOf(0x0a, pos);
      // A line still being written (no newline yet) waits for the next cycle
      if (newline < 0) {
        next.offset = begin + pos;
        const t = Math.min(next.offset, MARK_TAIL_BYTES);
        next.tail = markHash(readRange(fd, next.offset - t, t));
        break;
      }
      // A window that starts inside a line (the 4 MB cut) skips that line
      if (begin === cursor.offset || pos > 0) {
        const text = bytes
          .subarray(pos, Math.min(newline, pos + QUEUE_LINE_CHARS * 4))
          .toString("utf-8")
          .slice(0, QUEUE_LINE_CHARS)
          .trim();
        lines++;
        const parsed = text.length > 0 ? parseQueueLine(text) : null;
        if (parsed) {
          events.push({
            offset: begin + pos,
            type: parsed.type,
            agent: parsed.agent ?? null,
            task: parsed.task ?? null,
            text: clean(text, QUEUE_LINE_CHARS),
          });
        }
      }
      pos = newline + 1;
    }
    view.lines = lines;
    const kept = events.slice(-settings.maxEvents);
    status.items = kept.length;
    return { status, events: kept, cursor: next, reset: false };
  } catch (e) {
    return empty(`${settings.path} cannot be read (${e instanceof Error ? e.message : String(e)})`, false);
  } finally {
    closeSync(fd);
  }
}

/** The reason in a queue line: what follows the first ": " (the whole line without one). */
export function reasonOf(text: string): string {
  const i = text.indexOf(": ");
  return clean(i >= 0 ? text.slice(i + 2) : text, TEXT_CHARS);
}

/** Whether a queue line names `task` as a whole token (task ids hold '/', ':', '#', '-' and '.'). */
export function namesTask(text: string, task: string): boolean {
  let from = 0;
  for (let guard = 0; guard < 50; guard++) {
    const i = text.indexOf(task, from);
    if (i < 0) return false;
    const before = i === 0 ? " " : text[i - 1];
    const after = i + task.length >= text.length ? " " : text[i + task.length];
    if (/[\s([{"'`]/.test(before) && /[\s)\]},:;"'`]/.test(after)) return true;
    from = i + 1;
  }
  return false;
}
