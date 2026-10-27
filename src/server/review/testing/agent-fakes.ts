/**
 * The system boundary of the agents module, for the reviews-by-agents tests:
 * a clock both modules read, the process table, and a process spawner that
 * records each spawn (argv, the environment it was given, the log path) and
 * keeps the process "running" until the test ends it. Everything else (the
 * agents service, its store, the review service, routes) is production code.
 * Not part of the build (tsconfig.server.json excludes testing/).
 */
import { appendFileSync, utimesSync } from "fs";
import type { ProcessOwner, ProcessSpawner, SpawnOptions } from "../../agents/probes.js";
import type { Clock as WatchdogClock, CommandOutput, CommandRunner, ProcessInfo, ProcessTable } from "../../watchdog/probes.js";

export class SharedClock implements WatchdogClock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeProcessTable implements ProcessTable {
  private procs = new Map<number, { startedAt: number; command: string }>();
  constructor(private clock: SharedClock) {}
  add(pid: number, command: string, startedAt: number = this.clock.now()): void {
    this.procs.set(pid, { startedAt, command });
  }
  remove(pid: number): void {
    this.procs.delete(pid);
  }
  async list(): Promise<ProcessInfo[]> {
    return [...this.procs.entries()].map(([pid, p]) => ({
      pid,
      ppid: 1,
      elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - p.startedAt) / 1000)),
      argv: p.command.split(" "),
      command: p.command,
    }));
  }
}

export interface SpawnCall {
  argv: string[];
  env: Record<string, string>;
  logPath: string;
  pid: number;
}

export class FakeSpawner implements ProcessSpawner {
  calls: SpawnCall[] = [];
  private exits = new Map<number, number | null>();
  private started = new Set<number>();
  nextPid = 7001;

  constructor(
    private procs: FakeProcessTable,
    private clock: SharedClock,
  ) {}

  async spawn(argv: string[], options: SpawnOptions): Promise<ProcessOwner> {
    const pid = this.nextPid++;
    this.calls.push({ argv: [...argv], env: { ...options.env }, logPath: options.logPath, pid });
    appendFileSync(options.logPath, "reviewing\n");
    const t = new Date(this.clock.now());
    utimesSync(options.logPath, t, t);
    this.started.add(pid);
    this.procs.add(pid, argv.join(" "), this.clock.now());
    return { pid, startedAt: this.clock.now() };
  }

  exitCode(pid: number): number | null | undefined {
    return this.exits.has(pid) ? this.exits.get(pid) : undefined;
  }

  knows(pid: number): boolean {
    return this.started.has(pid);
  }

  /** Signals sent, in order; a signalled process ends at once */
  kills: { pid: number; signal: string }[] = [];

  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    this.kills.push({ pid, signal });
    this.exit(pid, null);
    return true;
  }

  forget(pid: number): void {
    this.exits.delete(pid);
    this.started.delete(pid);
  }

  /** The process ends with this exit code */
  exit(pid: number, code: number | null): void {
    this.procs.remove(pid);
    this.exits.set(pid, code);
  }
}

export class NoCommands implements CommandRunner {
  async run(): Promise<CommandOutput> {
    return { code: 0, stdout: "", stderr: "" };
  }
}
