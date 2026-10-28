/**
 * A snapshot of one project's files and processes, read through the probes.
 * Each tick (and each diagnose/verify re-check) makes a fresh view; reads are
 * memoized within it so every detector sees the same data.
 *
 * File layout (the conventions the rest of Lair reads, see src/server/services/data.ts):
 * - queue_file: one status line per event ("- WAITING <task> <gate-id> by <agent> ...")
 * - agents_dir: dragons.txt, <id>.log or <id>-<UTC>.log, claims <id>.running
 * - gates_dir/queue: <lane>.<priority>.<gate-id>.req (queued), .req.run (running), <...>.log
 * - gates_dir/results: <gate-id>.rc, <gate-id>.log, optional <gate-id>.json
 * - gates_dir/runner-<lane>.pid: the lane's runner process
 */
import { join } from "path";
import type { Gate, ProjectConfig, QueueLine } from "../../shared/types.js";
import { parseQueueFile } from "../parsers/queue.js";
import { parseGateFilename, parseGateRc } from "../parsers/gates.js";
import { parseDragonsFile } from "../parsers/dragons.js";
import { isValidDragonId, parseDragonRegistry } from "../parsers/dragon-config.js";
import { isSafeGateId } from "../services/data.js";
import { agentMatcher, type WatchdogSettings } from "./config.js";
import type { ProcessInfo, Probes } from "./probes.js";
import type { WatchdogStore } from "./store.js";
import type { ContainerServices, SupervisedAgents } from "./types.js";

/** Everything a detector or executor needs for one project. */
export interface WatchdogContext {
  project: string;
  config: ProjectConfig;
  settings: WatchdogSettings;
  probes: Probes;
  store: WatchdogStore;
  /** Delivery's containers: their crash loops, and which ones are held */
  services?: ContainerServices;
  /** The agents module's supervised agents: agent_hung and orphan_claim leave them alone */
  agents?: SupervisedAgents;
  /** Aborted by Watchdog.stop(): waits end early and no further action starts */
  signal?: AbortSignal;
}

export interface AgentLog {
  name: string;
  path: string;
  mtimeMs: number;
}

export interface Claim {
  agent: string;
  name: string;
  path: string;
  mtimeMs: number;
}

export interface ClaimPid {
  pid: number;
  startedAt: number | null;
}

export interface GateRequest {
  name: string;
  path: string;
  /** The file name without .req / .req.run, e.g. heavy.1.<gate-id> */
  base: string;
  gate: Gate;
  mtimeMs: number;
}

export interface GateResultFile {
  id: string;
  rc: number;
  mtimeMs: number;
  logPath: string;
  jsonPath: string;
}

const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_FILE_BYTES = 64 * 1024;
const LANE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** A pid from a pid file or lock: "1234", or "pid=1234" / "pid: 1234" on any line. */
export function parsePid(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/\bpid\s*[=:]\s*(\d+)/i) ?? text.match(/^\s*(\d+)\s*$/m);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isSafeLane(lane: unknown): lane is string {
  return typeof lane === "string" && LANE.test(lane);
}

export class ProjectView {
  readonly now: number;
  private memo = new Map<string, unknown>();

  constructor(readonly ctx: WatchdogContext) {
    this.now = ctx.probes.clock.now();
  }

  private once<T>(key: string, compute: () => T): T {
    if (!this.memo.has(key)) {
      this.memo.set(key, compute());
    }
    return this.memo.get(key) as T;
  }

  get settings(): WatchdogSettings {
    return this.ctx.settings;
  }

  get config(): ProjectConfig {
    return this.ctx.config;
  }

  private get fs() {
    return this.ctx.probes.fs;
  }

  /** Minutes since a time, from this view's clock reading */
  minutesSince(ms: number): number {
    return (this.now - ms) / 60000;
  }

  // ============ PROCESSES ============

  processes(): Promise<ProcessInfo[]> {
    return this.once("processes", () => this.ctx.probes.processes.list());
  }

  async processByPid(): Promise<Map<number, ProcessInfo>> {
    const list = await this.processes();
    return this.once(
      "processByPid",
      () => new Map<number, ProcessInfo>(list.map((p) => [p.pid, p] as const)),
    );
  }

  async isAlive(pid: number): Promise<boolean> {
    return (await this.processByPid()).has(pid);
  }

  // ============ AGENTS ============

  /** Agent ids from the YAML dragons: map and agents_dir/dragons.txt. */
  agentIds(): string[] {
    return this.once("agentIds", () => {
      const ids = new Set(parseDragonRegistry(this.config).keys());
      const content = this.fs.read(join(this.config.agents_dir, "dragons.txt"), SMALL_FILE_BYTES);
      for (const dragon of parseDragonsFile(content ?? "")) {
        if (isValidDragonId(dragon.id)) ids.add(dragon.id);
      }
      return [...ids].sort();
    });
  }

  hasAgentPattern(): boolean {
    return this.settings.agentCommand !== undefined;
  }

  /**
   * The machine an agent runs on, and whether that is this machine (the only
   * one whose processes `ps` shows). The machine is the agent's
   * `dragons.<id>.machine`; unset means "local". It is local when
   * `machines.<id>.type` is "local", or when it is "local" and not listed in
   * machines:. Any other machine (ssh, or unknown) is remote: its agents'
   * processes are unknown here, never "dead".
   */
  agentMachine(agentId: string): { machine: string; local: boolean } {
    const raw = this.config.dragons?.[agentId]?.machine;
    const machine = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "local";
    const configured = this.config.machines?.[machine];
    if (configured) return { machine, local: configured.type === "local" };
    return { machine, local: machine === "local" };
  }

  isLocalAgent(agentId: string): boolean {
    return this.agentMachine(agentId).local;
  }

  /** Known agents that run on this machine. */
  localAgentIds(): string[] {
    return this.agentIds().filter((id) => this.isLocalAgent(id));
  }

  /**
   * The local processes attributed to an agent through
   * watchdog.agent_command, oldest first. A match whose ancestor is also a
   * match for the same agent (a wrapper and its child) counts once, as the
   * ancestor. Only meaningful for local agents (isLocalAgent): callers must
   * not read "no process" as "dead" for a remote one.
   */
  async agentProcesses(agentId: string): Promise<ProcessInfo[]> {
    const pattern = this.settings.agentCommand;
    if (!pattern || !isValidDragonId(agentId)) return [];
    const byPid = await this.processByPid();
    return this.once(`agentProcesses:${agentId}`, () => {
      const matcher = agentMatcher(pattern, agentId);
      const matches = [...byPid.values()].filter((p) => matcher.test(p.command));
      const matchPids = new Set(matches.map((p) => p.pid));
      const roots = matches.filter((p) => {
        let parent = byPid.get(p.ppid);
        for (let hops = 0; parent && hops < 32; hops++) {
          if (matchPids.has(parent.pid)) return false;
          if (parent.ppid === parent.pid) break;
          parent = byPid.get(parent.ppid);
        }
        return true;
      });
      return roots.sort((a, b) => b.elapsedSeconds - a.elapsedSeconds || a.pid - b.pid);
    });
  }

  /**
   * Agents counted as running: a local agent (known id or claim holder) with
   * a live process, or a remote agent with a claim (its process can't be
   * seen from here, so its claim is the signal).
   */
  async runningAgents(): Promise<string[]> {
    const claimed = new Set(this.claims().map((c) => c.agent));
    const ids = new Set([...this.agentIds(), ...claimed]);
    const running: string[] = [];
    for (const id of ids) {
      if (this.isLocalAgent(id)) {
        if ((await this.agentProcesses(id)).length > 0) running.push(id);
      } else if (claimed.has(id)) {
        running.push(id);
      }
    }
    return running.sort();
  }

  /** The newest <id>.log / <id>-<UTC>.log in agents_dir, by mtime. */
  newestLog(agentId: string): AgentLog | null {
    return this.once(`newestLog:${agentId}`, () => {
      const escaped = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const name = new RegExp(`^${escaped}(?:-\\d{8}T\\d{6}Z)?\\.log$`);
      let newest: AgentLog | null = null;
      for (const entry of this.fs.list(this.config.agents_dir)) {
        if (!name.test(entry)) continue;
        const path = join(this.config.agents_dir, entry);
        const st = this.fs.stat(path);
        if (st && !st.isDirectory && (!newest || st.mtimeMs > newest.mtimeMs)) {
          newest = { name: entry, path, mtimeMs: st.mtimeMs };
        }
      }
      return newest;
    });
  }

  /** Claims: agents_dir/<id>.running (a directory or a file). */
  claims(): Claim[] {
    return this.once("claims", () => {
      const claims: Claim[] = [];
      for (const entry of this.fs.list(this.config.agents_dir)) {
        if (!entry.endsWith(".running")) continue;
        const agent = entry.slice(0, -".running".length);
        if (!isValidDragonId(agent)) continue;
        const path = join(this.config.agents_dir, entry);
        const st = this.fs.stat(path);
        if (st) claims.push({ agent, name: entry, path, mtimeMs: st.mtimeMs });
      }
      return claims.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * The pid recorded in a claim file (a file or directory with a pid file).
   * Returns null when no pid is recorded. The claim format matches the lock
   * format: either `pid=1234\nstarted=...\n` or just a bare pid.
   */
  claimPid(claim: Claim): ClaimPid | null {
    const st = this.fs.stat(claim.path);
    if (!st) return null;
    const isDirectory = st.isDirectory;
    const pidFile = isDirectory ? join(claim.path, "pid") : claim.path;
    const content = this.fs.read(pidFile, SMALL_FILE_BYTES);
    if (!content) return null;
    const pid = parsePid(content);
    if (pid === null) return null;
    // Parse the started time if present (Lair's lock format)
    const started = content.match(/^\s*started\s*[=:]\s*(\S+)\s*$/im);
    const startedAt = started ? Date.parse(started[1]) : null;
    return { pid, startedAt: Number.isNaN(startedAt) ? null : startedAt };
  }

  // ============ QUEUE FILE ============

  queueLines(): QueueLine[] {
    return this.once("queueLines", () => {
      const content = this.fs.read(this.config.queue_file, QUEUE_MAX_BYTES);
      return content ? parseQueueFile(content) : [];
    });
  }

  /** The agent's latest line in the queue file (the file is appended in time order). */
  latestLineFor(agentId: string): QueueLine | undefined {
    const lower = agentId.toLowerCase();
    const lines = this.queueLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].agent?.toLowerCase() === lower) return lines[i];
    }
    return undefined;
  }

  /**
   * The gate an agent is WAITING on: its latest queue line is a WAITING line
   * naming a gate id, and that gate has no result (.rc) yet. Null otherwise.
   */
  waitingOn(agentId: string): string | null {
    const line = this.latestLineFor(agentId);
    if (!line || line.type !== "WAITING" || !line.gateId) return null;
    return this.gateResultExists(line.gateId) ? null : line.gateId;
  }

  /** Agents whose latest queue line is a WAITING line (on anything). */
  waitingAgents(): string[] {
    const agents = new Set<string>();
    for (const line of this.queueLines()) {
      if (line.agent) agents.add(line.agent);
    }
    return [...agents].filter((a) => this.latestLineFor(a)?.type === "WAITING").sort();
  }

  // ============ GATES ============

  private get gatesQueueDir(): string {
    return join(this.config.gates_dir, "queue");
  }

  private get gatesResultsDir(): string {
    return join(this.config.gates_dir, "results");
  }

  gateResultExists(gateId: string): boolean {
    return isSafeGateId(gateId) && this.fs.stat(join(this.gatesResultsDir, `${gateId}.rc`)) !== null;
  }

  /** Queued (.req) and running (.req.run) gate requests. */
  gateRequests(): GateRequest[] {
    return this.once("gateRequests", () => {
      const requests: GateRequest[] = [];
      for (const name of this.fs.list(this.gatesQueueDir)) {
        const gate = parseGateFilename(name);
        if (!gate || (gate.status !== "queued" && gate.status !== "running")) continue;
        const path = join(this.gatesQueueDir, name);
        const st = this.fs.stat(path);
        if (!st) continue;
        requests.push({
          name,
          path,
          base: name.replace(/\.req(\.run)?$/, ""),
          gate,
          mtimeMs: st.mtimeMs,
        });
      }
      return requests.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** The log of a running or finished gate request, newest of the queue and results copies. */
  gateLogMtime(request: GateRequest): number | null {
    const candidates = [
      join(this.gatesQueueDir, `${request.base}.log`),
      join(this.gatesResultsDir, `${request.gate.id}.log`),
    ];
    let newest: number | null = null;
    for (const path of candidates) {
      const st = this.fs.stat(path);
      if (st && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
    }
    return newest;
  }

  /** The pid recorded for a lane's runner: gates_dir/runner-<lane>.pid. */
  runnerPid(lane: string): number | null {
    if (!isSafeLane(lane)) return null;
    return parsePid(this.fs.read(join(this.config.gates_dir, `runner-${lane}.pid`), SMALL_FILE_BYTES));
  }

  /** Finished gates: gates_dir/results/<gate-id>.rc. */
  gateResults(): GateResultFile[] {
    return this.once("gateResults", () => {
      const results: GateResultFile[] = [];
      for (const name of this.fs.list(this.gatesResultsDir)) {
        if (!name.endsWith(".rc")) continue;
        const id = name.slice(0, -3);
        if (!isSafeGateId(id)) continue;
        const path = join(this.gatesResultsDir, name);
        const st = this.fs.stat(path);
        const rc = parseGateRc(this.fs.read(path, 64) ?? "");
        if (!st || rc === null) continue;
        results.push({
          id,
          rc,
          mtimeMs: st.mtimeMs,
          logPath: join(this.gatesResultsDir, `${id}.log`),
          jsonPath: join(this.gatesResultsDir, `${id}.json`),
        });
      }
      return results.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
    });
  }

  readSmall(path: string): string | null {
    return this.fs.read(path, SMALL_FILE_BYTES);
  }

  readTail(path: string, maxBytes: number): string | null {
    return this.fs.read(path, maxBytes);
  }

  stat(path: string) {
    return this.fs.stat(path);
  }

  // ============ READY WORK ============

  /**
   * Ready tasks from watchdog.ready_tasks_cmd: one id per stdout line (blank
   * and # lines skipped), or a JSON array. [] when it is not configured.
   */
  readyTasks(): Promise<string[]> {
    return this.once("readyTasks", async () => {
      const argv = this.settings.readyTasksCmd;
      if (!argv) return [];
      const out = await this.ctx.probes.runner.run(argv, {
        timeoutMs: this.settings.commandTimeoutSeconds * 1000,
      });
      if (out.code !== 0) {
        throw new Error(`ready_tasks_cmd exited ${out.code}: ${out.stderr.trim().slice(0, 200)}`);
      }
      const text = out.stdout.trim();
      if (text.startsWith("[")) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (Array.isArray(parsed)) return parsed.map((item) => String(typeof item === "object" ? JSON.stringify(item) : item));
        } catch {
          // fall through to line parsing
        }
      }
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    });
  }

  /** How long a condition has held, persisted in the store (see WatchdogStore.conditionSince). */
  conditionSince(key: string, holds: boolean): number | null {
    return this.ctx.store.conditionSince(this.ctx.project, key, holds, this.now);
  }
}
