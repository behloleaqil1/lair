/**
 * The tasks file as the planner edits it: fill's parser and bounds
 * (agents/fill.ts), every other line (comments, blank lines) kept as it is.
 * An edit is applied to the lines and the result parsed again; an edit that
 * would add a malformed line, a duplicate, a task past fill's cap or a file
 * past its size limit is refused.
 */
import { MAX_TASK_LINES, MAX_TASK_LINE_CHARS, MAX_TASKS_FILE_BYTES, parseTasksFile } from "../agents/fill.js";
import { isValidTaskId } from "../agents/types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { clean, sha256 } from "./files.js";

export const MAX_DESCRIPTION_CHARS = 500;
const MAX_NAME_CHARS = 64;

export interface TaskLine {
  line: number;
  agent: string;
  name: string;
  task: string;
  description: string;
}

export interface TasksDoc {
  text: string;
  hash: string;
  rows: string[];
  /** Open tasks: fill's task lines */
  tasks: TaskLine[];
  /** Done tasks: lines marked with done_marker (task -> line) */
  done: Map<string, number>;
  malformed: { line: number; reason: string; text: string }[];
  /** Parsed as fill parses it when its patterns match by agent: a second line for an agent is malformed */
  onePerAgent: boolean;
}

export type TaskEdit =
  | { op: "mark_done"; task: string }
  | { op: "drop"; task: string }
  | { op: "add"; agent: string; name: string; task: string; description: string }
  | { op: "reassign"; task: string; agent: string; name: string }
  | { op: "reword"; task: string; description: string };

export type EditResult =
  | { ok: true; doc: TasksDoc; line: number; before: string | null; after: string | null }
  | { ok: false; reason: string };

export function parseTasksDoc(text: string, doneMarker: string, onePerAgent = false): TasksDoc {
  const rows = text.split("\n");
  const tasks: TaskLine[] = [];
  const malformed: TasksDoc["malformed"] = [];
  for (const entry of parseTasksFile(text, onePerAgent)) {
    if (entry.kind === "task") {
      // Only include tasks with an assigned agent (non-null)
      if (entry.agent !== null) {
        tasks.push({ line: entry.line, agent: entry.agent, name: entry.name, task: entry.task, description: entry.description });
      }
    } else {
      malformed.push({ line: entry.line, reason: entry.reason, text: entry.text });
    }
  }
  const done = new Map<string, number>();
  const marker = doneMarker.trimEnd();
  rows.forEach((row, i) => {
    const trimmed = row.replace(/\r$/, "").trim();
    if (!trimmed.startsWith(marker)) return;
    const rest = trimmed.slice(marker.length);
    // "#done worker-a|..." (the marker, then whitespace), never "#donework..."
    if (!/^\s/.test(rest)) return;
    const [entry] = parseTasksFile(rest.trim());
    if (entry && entry.kind === "task" && !done.has(entry.task)) done.set(entry.task, i + 1);
  });
  return { text, hash: sha256(text), rows, tasks, done, malformed, onePerAgent };
}

/** A line's fields as fill reads them: no "|" in the first three, the description one line. */
export function renderLine(agent: string, name: string, task: string, description: string): string {
  const safeName = clean(name, MAX_NAME_CHARS).replace(/\|/g, "/") || agent;
  return `${agent}|${safeName}|${task}|${clean(description, MAX_DESCRIPTION_CHARS)}`;
}

export function findTask(doc: TasksDoc, task: string): TaskLine | null {
  return doc.tasks.find((t) => t.task === task) ?? null;
}

function withRows(rows: string[], doneMarker: string, onePerAgent: boolean): TasksDoc {
  return parseTasksDoc(rows.join("\n"), doneMarker, onePerAgent);
}

/** Apply one edit; the result must be a valid tasks file with no new malformed line. */
export function applyEdit(doc: TasksDoc, edit: TaskEdit, doneMarker: string): EditResult {
  const rows = [...doc.rows];
  let line = 0;
  let before: string | null = null;
  let after: string | null = null;

  if (edit.op === "add") {
    if (!isValidDragonId(edit.agent)) return { ok: false, reason: `${edit.agent} is not a valid agent id` };
    if (!isValidTaskId(edit.task)) return { ok: false, reason: `${edit.task} is not a valid task id` };
    if (findTask(doc, edit.task)) return { ok: false, reason: `task ${edit.task} is already in the tasks file` };
    if (doc.done.has(edit.task)) return { ok: false, reason: `task ${edit.task} is done (line ${doc.done.get(edit.task)}): task ids are not reused` };
    if (doc.tasks.length >= MAX_TASK_LINES) return { ok: false, reason: `the tasks file has ${MAX_TASK_LINES} tasks, fill's limit` };
    after = renderLine(edit.agent, edit.name, edit.task, edit.description);
    // Append after the last non-empty row, keeping a trailing newline
    let at = rows.length;
    while (at > 0 && rows[at - 1].trim() === "") at--;
    rows.splice(at, 0, after);
    line = at + 1;
  } else {
    const found = findTask(doc, edit.task);
    if (!found) return { ok: false, reason: `task ${edit.task} has no open line in the tasks file` };
    line = found.line;
    before = rows[found.line - 1];
    switch (edit.op) {
      case "mark_done":
        after = `${doneMarker.trimEnd()} ${before.replace(/\r$/, "").trim()}`;
        rows[found.line - 1] = after;
        break;
      case "drop":
        rows.splice(found.line - 1, 1);
        break;
      case "reassign":
        if (!isValidDragonId(edit.agent)) return { ok: false, reason: `${edit.agent} is not a valid agent id` };
        after = renderLine(edit.agent, edit.name, found.task, found.description);
        rows[found.line - 1] = after;
        break;
      case "reword":
        after = renderLine(found.agent, found.name, found.task, edit.description);
        rows[found.line - 1] = after;
        break;
    }
  }
  if (after !== null && after.length > MAX_TASK_LINE_CHARS) {
    return { ok: false, reason: `the line would be longer than ${MAX_TASK_LINE_CHARS} characters` };
  }
  const next = withRows(rows, doneMarker, doc.onePerAgent);
  if (Buffer.byteLength(next.text, "utf-8") > MAX_TASKS_FILE_BYTES) {
    return { ok: false, reason: `the tasks file would be larger than ${MAX_TASKS_FILE_BYTES} bytes` };
  }
  if (next.malformed.length > doc.malformed.length) {
    const added = next.malformed.find((m) => !doc.malformed.some((o) => o.text === m.text && o.reason === m.reason));
    return { ok: false, reason: `the edit would make a line malformed${added ? ` (${added.reason})` : ""}` };
  }
  return { ok: true, doc: next, line, before, after };
}

/** One change's diff lines: "-<line> <old>" and "+<line> <new>". */
export function diffOf(line: number, before: string | null, after: string | null): string[] {
  return [...(before !== null ? [`-${line} ${clean(before, 2000)}`] : []), ...(after !== null ? [`+${line} ${clean(after, 2000)}`] : [])];
}

/**
 * A diff of two versions of the file, for an edit Lair didn't make: the rows
 * between the common start and the common end (at most 200 lines).
 */
export function diffTexts(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  for (let i = start; i < endA && out.length < 100; i++) out.push(`-${i + 1} ${clean(a[i], 2000)}`);
  for (let i = start; i < endB && out.length < 200; i++) out.push(`+${i + 1} ${clean(b[i], 2000)}`);
  return out;
}
