/**
 * The tasks the tracker follows: agents.fill's tasks file, the one the
 * planner keeps (lines `<agent>|<name>|<task>|<description>`, done lines
 * behind the planner's done marker). Read asynchronously (never a
 * synchronous read on the event loop), bounded, and parsed as the planner
 * parses it. The work store, once tasks live there, is another TaskSource.
 */
import { open } from "fs/promises";
import { MAX_TASKS_FILE_BYTES } from "../agents/fill.js";
import { isValidTaskId } from "../agents/types.js";
import { parseTasksDoc } from "../planner/tasks-file.js";

export interface TaskInfo {
  task: string;
  /** null: an unassigned line (any agent may take it): no agent rule matches it, and it is linked by its task id alone */
  agent: string | null;
  name: string;
  description: string;
}

export interface TasksSnapshot {
  open: TaskInfo[];
  done: Set<string>;
  /**
   * Every word that could be a task id on a line fill refuses (malformed,
   * too long, past its cap): a task on such a line is still in the file,
   * never removed from it.
   */
  mentioned: Set<string>;
}

export interface TaskSource {
  /** The open and done tasks now; null when there is no tasks file (or it can't be read) */
  read(): Promise<TasksSnapshot | null>;
}

/** The words of a line (split at "|" and whitespace) that are valid task ids */
export function taskIdsIn(line: string): string[] {
  return line.split(/[|\s]+/).filter((word) => word.length > 0 && isValidTaskId(word));
}

export function fileTaskSource(path: string | null, doneMarker: string): TaskSource {
  return {
    async read() {
      if (!path) return null;
      let handle;
      try {
        handle = await open(path, "r");
      } catch {
        return null;
      }
      try {
        const { size } = await handle.stat();
        if (size > MAX_TASKS_FILE_BYTES) throw new Error(`the tasks file is ${size} bytes, over fill's limit of ${MAX_TASKS_FILE_BYTES}`);
        const text = await handle.readFile("utf-8");
        const doc = parseTasksDoc(text, doneMarker);
        const mentioned = new Set<string>();
        for (const bad of doc.malformed) for (const id of taskIdsIn(doc.rows[bad.line - 1] ?? bad.text)) mentioned.add(id);
        return {
          open: doc.tasks.map((t) => ({ task: t.task, agent: t.agent, name: t.name, description: t.description })),
          done: new Set(doc.done.keys()),
          mentioned,
        };
      } finally {
        await handle.close();
      }
    },
  };
}
