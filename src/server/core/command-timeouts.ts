/**
 * A count of the commands Lair gave up on because they took too long, for
 * the supervisor's command_timeouts check (src/server/supervisor/). The
 * runners that time commands out note each one here: the modules' command
 * runner (watchdog/probes.ts ExecFileRunner: probes and git), the
 * dashboard's status commands (services/data.ts) and the AI tools' checks
 * (ai/runner.ts). Only the kind, the program's name and the time are kept,
 * never an argument or output, in a bounded ring.
 */

export type CommandKind = "status" | "probe" | "git" | "tool";

export interface CommandTimeout {
  kind: CommandKind;
  /** The program's base name, at most 40 characters */
  program: string;
  at: number;
}

const MAX_KEPT = 500;

export class CommandTimeoutLog {
  private entries: CommandTimeout[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  note(kind: CommandKind, program: string): void {
    const base = (program.split(/[\\/]/).pop() ?? "").slice(0, 40) || "?";
    this.entries.push({ kind, program: base, at: this.now() });
    if (this.entries.length > MAX_KEPT) this.entries.splice(0, this.entries.length - MAX_KEPT);
  }

  /** The timeouts noted at or after `since` (ms), oldest first. */
  since(since: number): CommandTimeout[] {
    return this.entries.filter((e) => e.at >= since);
  }

  clear(): void {
    this.entries = [];
  }
}

let global: CommandTimeoutLog | null = null;

/** The server's log (one per process). */
export function commandTimeouts(): CommandTimeoutLog {
  global ??= new CommandTimeoutLog();
  return global;
}

/** Note a command that timed out: `kind` and its program (argv[0]). */
export function noteCommandTimeout(kind: CommandKind, program: string): void {
  commandTimeouts().note(kind, program);
}

/** git is git; any other command a module runs to look at something is a probe. */
export function kindOfProgram(program: string): CommandKind {
  const base = program.split(/[\\/]/).pop() ?? "";
  return base === "git" ? "git" : "probe";
}
