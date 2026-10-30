/**
 * Restart reconciliation (docs/design/autonomy.md §6): what a new server
 * makes of the runs its store says were active, so a restart never leaves
 * two runs of one task.
 *
 * A run the previous server started is:
 * - adopted when its pid runs and started when the run's pid started:
 *   supervised from here on as if this server had started it (its claim
 *   stays, fill counts it as active). The command is checked too, but a
 *   difference only goes in the evidence: a start script that execs the CLI,
 *   or a CLI that rewrites its process title, shows another command line,
 *   and pid and start time already identify the process;
 * - lost when its pid runs but started at another time: the pid was reused.
 *   That process is never signalled, and the run ends, its task free;
 * - gone when nothing runs under its pid: the first tick classifies its exit
 *   as for any re-adopted run that ended unseen (its queue line decides).
 *
 * The service never ends a run on one reading: lost and gone need a second,
 * fresh one to agree (AgentsService.reconcile).
 */
import { createHash } from "crypto";
import { join } from "path";
import type { ProcessInfo } from "../watchdog/probes.js";
import type { ProcessSnapshot } from "./probes.js";
import type { AgentRun } from "./types.js";

/** The command line as `ps` shows it (argv joined by spaces), hashed: kept on the run to tell a reused pid. */
export function commandFingerprint(argv: string[]): string {
  return hashCommand(argv.join(" "));
}

function hashCommand(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex").slice(0, 16);
}

/** Leading words `ps` may show before the command itself: an interpreter and its options for a script. */
const MAX_INTERPRETER_WORDS = 4;

/**
 * Whether a `ps` command line is the one fingerprinted: the whole line, or
 * the line after an interpreter (a script with `#!/bin/sh` shows as
 * `/bin/sh /path/start.sh ...`).
 */
export function commandMatches(fingerprint: string, command: string): boolean {
  const words = command.trim().split(" ");
  for (let skip = 0; skip <= Math.min(MAX_INTERPRETER_WORDS, words.length - 1); skip++) {
    if (hashCommand(words.slice(skip).join(" ")) === fingerprint) return true;
  }
  return false;
}

export type ReconcileVerdict =
  /** commandDiffers: pid and start time match, the command line shown now doesn't (noted, not held against it) */
  | { kind: "adopted"; evidence: string; commandDiffers: boolean }
  | { kind: "lost"; reason: string }
  | { kind: "gone"; reason: string };

/**
 * One run (running or stopping, so it has a pid) against a reading of the
 * process table. `startedHere`: this server process started the pid (a
 * config reload hands its runs over), which proves it the run's. A run
 * recorded before pgid and command fingerprints were kept is adopted on its
 * pid and start time alone, as servers did before.
 */
export function reconcileRun(run: AgentRun, snap: ProcessSnapshot, startedHere: boolean): ReconcileVerdict {
  const pid = run.pid;
  if (pid === undefined) return { kind: "gone", reason: "no pid was recorded" };
  if (snap.startedAt(pid) === null) return { kind: "gone", reason: `pid ${pid} is not running` };
  if (!snap.isAlive(pid, run.pidStartedAt)) return { kind: "lost", reason: snap.describe(pid, run.pidStartedAt) };
  const running = snap.describe(pid, run.pidStartedAt);
  if (startedHere) return { kind: "adopted", evidence: `${running}: this server process started it`, commandDiffers: false };
  if (run.commandFingerprint === undefined) {
    const proof = "its start time matches (the run was recorded without its process group and command)";
    return { kind: "adopted", evidence: `${running}: ${proof}`, commandDiffers: false };
  }
  const group = run.pgid !== undefined ? ` (process group ${run.pgid})` : "";
  const command = snap.get(pid)?.command;
  if (command !== undefined && commandMatches(run.commandFingerprint, command)) {
    return { kind: "adopted", evidence: `${running}: its start time and command match${group}`, commandDiffers: false };
  }
  return {
    kind: "adopted",
    evidence:
      `${running}: its start time matches${group}; its command line differs from the one it was started with ` +
      "(a start script that execs the agent, or a program that rewrites its title, shows another one)",
    commandDiffers: true,
  };
}

/** The file name of a run's prompt (in prompts_dir): the run's marker on its agent's command line. */
export function runPromptFileName(task: string, agent: string, runId: string): string {
  return `${taskSlug(task)}-${agent}-${runId.slice(0, 8)}.txt`;
}

function taskSlug(task: string): string {
  return task.replace(/[^A-Za-z0-9_-]/g, "-");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A live process that holds a run prompt file of `task` (any of `agents`)
 * on its command line, other than `ignore` (this server, the runs the store
 * knows): a run of the task the store doesn't know about. Null when none.
 */
export function findTaskProcess(
  processes: ProcessInfo[],
  promptsDir: string,
  task: string,
  agents: string[],
  ignore: Set<number>,
): ProcessInfo | null {
  if (agents.length === 0) return null;
  const names = agents.map(escapeRegExp).join("|");
  const marker = new RegExp(`${escapeRegExp(join(promptsDir, `${taskSlug(task)}-`))}(?:${names})-[0-9a-f]{8}\\.txt(?:\\s|$)`);
  return processes.find((proc) => !ignore.has(proc.pid) && marker.test(proc.command)) ?? null;
}
