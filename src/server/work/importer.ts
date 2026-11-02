/**
 * The importer (docs/design/work-store.md §6.4): what the project's configured files say about its tasks, read with
 * fill's and the planner's own code, so there is no third parser and no new pattern setting.
 *
 * - Only the configured files: agents.fill.tasks_file (resolved against the repository, as fill resolves it) and
 *   queue_file; never a path from a request. Both are read asynchronously and bounded (fill's readBounded and
 *   QueueLines.read): nothing here blocks the event loop.
 * - The tasks file through the planner's parseTasksDoc (fill's parseTasksFile and bounds, plus done lines behind the
 *   planner's done_marker). A line fill refuses is a warning, and the task ids on it are kept, never dropped.
 * - Each open line's state through fill's checks with the project's patterns: checkDone (fill's kept record, then
 *   the queue lines since the latest run's mark), then reportedOutcome for that run (WAITING, BLOCKED), and
 *   unassignedLine for a line with no agent. With bus.consume on, a mirrored line is read by its bus report, as fill
 *   reads it; a DONE that fill's ready guard refuses does not make the task done.
 * - A task with an active run or a claim stays ready: the read model shows it assigned or running (§1.5).
 */
import { createHash } from "crypto";
import { isAbsolute, resolve } from "path";
import type { ProjectConfig } from "../../shared/types.js";
import { matchesByAgent, parseAgentsConfig } from "../agents/config.js";
import { checkDone, MAX_TASKS_FILE_BYTES, parseTasksFile, QueueLines, queueWindowEnd, readBounded, reportedOutcome, unassignedLine } from "../agents/fill.js";
import type { AgentsStore } from "../agents/store.js";
import { isActive } from "../agents/types.js";
import type { BusLineSource, StructuredReport } from "../bus/consumers.js";
import { parsePlannerConfig } from "../planner/config.js";
import { parseTasksDoc, type TaskLine } from "../planner/tasks-file.js";
import { taskIdsIn } from "../tracker/tasks.js";
import type { FileSnapshot, FileTask } from "./store.js";

/** The agents module's reads that fill's checks use (claims, runs, fill's kept records) */
export type RunsSource = Pick<AgentsStore, "getEventByKey" | "latestRunForTask" | "firstRunForAgentAfter" | "getClaim">;

/** Without the agents module: no run, no claim, no kept record (a pattern that names the task reads the whole window) */
const NO_RUNS: RunsSource = { getEventByKey: () => null, latestRunForTask: () => null, firstRunForAgentAfter: () => null, getClaim: () => null };

const DEFAULT_DONE_MARKER = "#done ";

/** Fill's ready guard on a DONE line (AgentsService.reportAccepted): false refuses it */
export type ReportAccepted = (agent: string, task: string, line: string, description: string, report: StructuredReport | null) => Promise<boolean>;

export interface ImportSources {
  project: string;
  config: ProjectConfig;
  runs: RunsSource | null;
  /** The project's bus (bus.consume observe or on), or null: a mirrored line is read by its report only in on mode */
  bus: BusLineSource | null;
  accepted?: ReportAccepted;
}

export type FilesRead = { ok: true; snapshot: FileSnapshot; tasksFile: string; warnings: string[] } | { ok: false; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The configured files' tasks with the state fill's checks read for each; an unreadable tasks file imports nothing. */
export async function readFiles(src: ImportSources): Promise<FilesRead> {
  const agents = parseAgentsConfig(src.config.agents, src.config);
  if (!agents.ok) return { ok: false, error: `the agents block is invalid: ${agents.errors.join("; ")}` };
  const fill = agents.settings.fill;
  if (!fill.tasksFile) return { ok: false, error: "agents.fill.tasks_file is not set: there is nothing to import" };
  const tasksFile = isAbsolute(fill.tasksFile) ? fill.tasksFile : resolve(src.config.repo, fill.tasksFile);
  const read = await readBounded(tasksFile, MAX_TASKS_FILE_BYTES, false);
  if (!read.ok) return { ok: false, error: `tasks_file ${tasksFile} ${read.reason}: nothing is imported or dropped` };
  const planner = parsePlannerConfig(src.config.planner, src.config);
  const marker = planner.ok ? planner.settings.doneMarker : DEFAULT_DONE_MARKER;
  const doc = parseTasksDoc(read.text, marker, matchesByAgent(fill));
  const warnings = doc.malformed.map((bad) => `line ${bad.line}: ${bad.reason}`);
  const kept = new Set(doc.malformed.flatMap((bad) => taskIdsIn(doc.rows[bad.line - 1] ?? bad.text)));
  const runs = src.runs ?? NO_RUNS;
  const queue = await QueueLines.read(src.config.queue_file, src.bus?.mode === "on" ? src.bus : null);

  /** What fill's checks read for one open line */
  const stateOf = async (line: TaskLine): Promise<Pick<FileTask, "state" | "reason">> => {
    const ready = { state: "ready", reason: null } as const;
    try {
      if (line.agent === null) {
        const seen = await unassignedLine(runs, src.project, queue, fill, line.task);
        return seen.state === "done" ? { state: "done", reason: seen.detail } : ready;
      }
      const latest = runs.latestRunForTask(src.project, line.task);
      // Held by a run or a claim: stored ready, shown assigned or running (§1.5)
      if ((latest && isActive(latest.state)) || runs.getClaim(src.project, line.task)) return ready;
      const fields = { agent: line.agent, name: line.name, task: line.task, description: line.description };
      const until = queueWindowEnd(runs, src.project, fill, fields, latest);
      const done = await checkDone(runs, src.project, queue, fill, fields, latest, until);
      if (done && (done.kind === "kept" || !src.accepted || (await src.accepted(line.agent, line.task, done.line, line.description, done.report)))) {
        return { state: "done", reason: done.line };
      }
      if (done) warnings.push(`${line.task}: fill's ready guard refuses its DONE line: imported as not done`);
      const outcome = latest ? await reportedOutcome(queue, fill, latest, until) : null;
      return outcome && outcome.kind !== "done" ? { state: outcome.kind, reason: outcome.line } : ready;
    } catch (e) {
      warnings.push(`${line.task}: ${message(e)}: imported as ready`);
      return ready;
    }
  };

  const tasks: FileTask[] = [];
  for (const line of doc.tasks) {
    tasks.push({ id: line.task, agent: line.agent, agentName: line.name || null, description: line.description, line: line.line, ...(await stateOf(line)) });
  }
  const open = new Set(doc.tasks.map((t) => t.task));
  for (const [task, lineNumber] of doc.done) {
    // An open line for the same task wins: it is back in the file
    if (open.has(task)) continue;
    const [entry] = parseTasksFile(doc.rows[lineNumber - 1].trim().slice(marker.trimEnd().length).trim());
    if (entry?.kind !== "task") continue;
    tasks.push({ id: task, agent: entry.agent, agentName: entry.name || null, description: entry.description, line: lineNumber, state: "done", reason: "a done line in the tasks file" });
  }
  tasks.sort((a, b) => a.line - b.line);
  const tasksFileHash = createHash("sha256").update(read.text).digest("hex");
  return { ok: true, tasksFile, warnings, snapshot: { tasks, kept, tasksFileHash, warnings: warnings.length } };
}
