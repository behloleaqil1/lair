/**
 * The project's gate queue as placement sees it: the request files of the
 * configured lanes (src/server/parsers/gates.ts names them), each with its
 * command and class. Only a request with no status suffix is queued; `.run`
 * is running; every other suffix (superseded, stuck, ...) is neither.
 */
import { join } from "path";
import { parseGateFilename } from "../parsers/gates.js";
import type { ClassSettings, PlacementSettings } from "./config.js";
import type { QueueFiles } from "./probes.js";

/** At most this many queue directory entries are looked at */
export const MAX_QUEUE_ENTRIES = 5000;
/** The start of a request file that is read (its command) */
const MAX_REQUEST_BYTES = 16 * 1024;
/** Commands and ids are cut to this before any pattern runs */
export const MAX_MATCH_TEXT = 4096;

export interface QueueJob {
  id: string;
  lane: string;
  priority: number;
  status: "queued" | "running";
  /** The request file's name and path */
  name: string;
  path: string;
  command: string;
  class: string | null;
  /** A prefer_quiet pattern matches its id or command */
  quiet: boolean;
  /** The file's ctime: a running request's claim (rename) time */
  ctimeMs: number | null;
}

/** The request's command: the file from line `commandLine` on, without the trailing newline. */
export function requestCommand(content: string, commandLine: number): string {
  const lines = content.split("\n").slice(commandLine - 1);
  return lines.join("\n").replace(/\s+$/, "");
}

/** The first class (in the order written) with a pattern that matches the command. */
export function classify(command: string, classes: readonly ClassSettings[]): string | null {
  const text = command.slice(0, MAX_MATCH_TEXT);
  for (const cls of classes) {
    if (cls.patterns.some((p) => p.test(text))) return cls.name;
  }
  return null;
}

export function matchesAny(patterns: readonly RegExp[], ...texts: string[]): boolean {
  return texts.some((t) => {
    const text = t.slice(0, MAX_MATCH_TEXT);
    return patterns.some((p) => p.test(text));
  });
}

/** Lane order: priority digit first (lower first), then the id (its UTC stamp) as the runners sort. */
export function laneOrder(a: { priority: number; id: string }, b: { priority: number; id: string }): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The queued and running requests of the configured lanes, each lane in its own order. */
export function readQueue(files: QueueFiles, gatesDir: string, settings: PlacementSettings): QueueJob[] {
  const queueDir = join(gatesDir, "queue");
  const lanes = new Set(settings.lanes.map((l) => l.name));
  const jobs: QueueJob[] = [];
  for (const name of files.list(queueDir, MAX_QUEUE_ENTRIES)) {
    const gate = parseGateFilename(name);
    if (!gate || !lanes.has(gate.lane)) continue;
    if (gate.status !== "queued" && gate.status !== "running") continue;
    const path = join(queueDir, name);
    const content = files.head(path, MAX_REQUEST_BYTES);
    if (content === null) continue;
    const command = requestCommand(content, settings.commandLine);
    jobs.push({
      id: gate.id,
      lane: gate.lane,
      priority: gate.priority,
      status: gate.status,
      name,
      path,
      command,
      class: classify(command, settings.classes),
      quiet: settings.preferQuiet.length > 0 && matchesAny(settings.preferQuiet, gate.id, command),
      ctimeMs: files.stat(path)?.ctimeMs ?? null,
    });
  }
  return jobs.sort(laneOrder);
}
