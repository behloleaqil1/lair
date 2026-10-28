/**
 * The AI tools service (docs/design/ai-roles.md): for each tool a project
 * can use (the built-in presets and its agent_adapters), on each machine:
 * - installed: its program on PATH (this machine: a PATH lookup, nothing
 *   run; an SSH machine: `command -v` there);
 * - its version, when the preset has a version_cmd;
 * - its sign-in state, by the preset's auth_check_cmd: signed in, not signed
 *   in (with the exact command to run, the preset's login_hint) or unknown.
 *   Lair never signs in, and never reads a tool's token files: the tool's
 *   own command answers;
 * - its models: the preset's models_cmd, read by its parser, else its known
 *   `models` list.
 *
 * Every command is an argv (never a shell), run with a timeout and bounded
 * output, with the environment an agent of the project gets (agentEnvironment),
 * never the rest of this server's. Model lists are cached for an hour (a
 * refresh reads them again), statuses briefly; one command per key runs at a
 * time, and callers share its result.
 *
 * The agents module asks it before each start (ToolReadiness): a tool whose
 * check says it is signed out on this machine starts nothing here.
 */
import { accessSync, constants, statSync } from "fs";
import { delimiter, join } from "path";
import type { AgentAdapter, MachineConfig, ProjectConfig, SSHMachineConfig } from "../../shared/types.js";
import type {
  AiModelsView,
  AiToolsView,
  SignInState,
  ToolMachineStatus,
  ToolStatusView,
} from "../../shared/ai-types.js";
import { agentEnvironment } from "../agents/probes.js";
import { buildRemoteArgvCommand, buildRemoteLookupCommand, isSSHMachine } from "../machines/ssh.js";
import { BUILTIN_ADAPTERS, tokenizeTemplate } from "../services/adapters.js";
import { loadKnownDragons } from "../services/dragon-registry.js";
import { toolCommand } from "./config.js";
import { knownModels, parseModels, type ParsedModel } from "./parsers.js";
import { aiProfiles, TOOL_ID } from "./profiles.js";
import { SpawnToolRunner, type ToolRunner, type ToolRunOutput } from "./runner.js";
import type { SignInRefusal, ToolReadiness } from "./types.js";

/** This machine, where the agents module starts its runs */
export const LOCAL_MACHINE = "local";
export const MODELS_TTL_MS = 60 * 60_000;
export const STATUS_TTL_MS = 60_000;
export const COMMAND_TIMEOUT_MS = 15_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** A sign-in check's output is read this far for a signed-out message */
const MAX_CHECK_LINES = 20;
const MAX_LINE = 300;

/**
 * A failed sign-in check means "not signed in" only when it says so; any
 * other failure is unknown, so a crash or a missing subcommand never stops
 * the agents.
 */
export const SIGNED_OUT_PATTERN =
  /\b(not (?:currently )?(?:logged|signed) in|not authenticated|unauthenticated|(?:log|sign) ?in required|please (?:log|sign) ?in|no (?:active )?(?:session|credentials)|logged out|login required)\b/i;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** An error with the HTTP status the routes answer with. */
export class AiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface Clock {
  now(): number;
}

export interface AiToolsOptions {
  runner?: ToolRunner;
  clock?: Clock;
  /** The server's environment, where PATH, HOME and the agents' passthrough variables come from */
  env?: NodeJS.ProcessEnv;
  modelsTtlMs?: number;
  statusTtlMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** A tool as the service reads it: its adapter, with its commands checked. */
interface Tool {
  id: string;
  name: string;
  adapter: AgentAdapter;
  program: string | null;
  modelsCmd?: string[];
  authCheckCmd?: string[];
  versionCmd?: string[];
  loginHint: string | null;
  experimental: boolean;
}

interface Machine {
  id: string;
  ssh: SSHMachineConfig | null;
}

interface CacheEntry<T> {
  tool: string;
  at: number;
  ttl: number;
  value: T;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (ms: number) => new Date(ms).toISOString();

/** One line of a tool's text: control characters out, whitespace folded, bounded. */
function oneLine(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.slice(0, MAX_LINE * 4).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, " ");
  const folded = flat.replace(/\s+/g, " ").trim();
  return folded.length > max ? `${folded.slice(0, max - 3)}...` : folded;
}

/** The first non-empty line of `text`, as one bounded line ("" when there is none). */
function firstLine(text: string, max = 160): string {
  for (const line of text.slice(0, MAX_LINE * MAX_CHECK_LINES).split("\n").slice(0, MAX_CHECK_LINES)) {
    const clean = oneLine(line, max);
    if (clean) return clean;
  }
  return "";
}

/** Why a command gave no answer, in words. */
export function describeFailure(output: ToolRunOutput): string {
  switch (output.failure) {
    case "not_found":
      return "its program is not installed";
    case "timeout":
      return `it timed out (${output.message ?? "no answer"})`;
    case "too_large":
      return `its output was too large (${output.message ?? ""})`;
    case "spawn":
      return `it could not be started (${oneLine(output.message ?? "")})`;
    default: {
      const said = firstLine(output.stderr) || firstLine(output.stdout);
      return `it exited ${output.code}${said ? `: ${said}` : ""}`;
    }
  }
}

/**
 * A sign-in check's answer: exit 0 is signed in ("as" its first line); a
 * failure that says the tool is signed out is signed out; anything else
 * (a timeout, a crash, ssh failing, a missing subcommand) is unknown.
 * `remote`: the check ran through ssh, whose own failures exit 255.
 */
export function signInFrom(
  output: ToolRunOutput,
  fix: string | null,
  remote = false,
): ToolMachineStatus["signIn"] {
  if (output.failure) return { state: "unknown", as: null, detail: `can't tell: the sign-in check failed (${describeFailure(output)})`, fix };
  if (output.code === 0) {
    const as = firstLine(output.stdout, 120) || null;
    return { state: "signed_in", as, detail: as ? `signed in (${as})` : "signed in", fix };
  }
  if (remote && output.code === 255) {
    return { state: "unknown", as: null, detail: `the machine didn't answer (ssh: ${firstLine(output.stderr) || "exit 255"})`, fix };
  }
  const lines = `${output.stdout}\n${output.stderr}`.slice(0, MAX_LINE * MAX_CHECK_LINES * 2).split("\n").slice(0, MAX_CHECK_LINES * 2);
  const said = lines.map((line) => oneLine(line, MAX_LINE)).find((line) => SIGNED_OUT_PATTERN.test(line));
  if (said) return { state: "signed_out", as: null, detail: `not signed in (${oneLine(said, 160)})`, fix };
  return { state: "unknown", as: null, detail: `can't tell: the sign-in check failed (${describeFailure(output)})`, fix };
}

/** The program a start command runs: its first token, unless a placeholder is in it. */
function programOf(adapter: AgentAdapter): string | null {
  try {
    const first = tokenizeTemplate(typeof adapter.start_cmd === "string" ? adapter.start_cmd : "")[0];
    return first && !/\{[a-z_]+\}/.test(first) && !first.startsWith("-") ? first : null;
  } catch {
    return null;
  }
}

/** Where `program` is on `path` (an executable file), or null. A program with a "/" is checked as it is. */
export function findOnPath(program: string, path: string | undefined): string | null {
  const candidates = program.includes("/")
    ? [program]
    : (path ?? "")
        .split(delimiter)
        .filter((dir) => dir.length > 0)
        .slice(0, 100)
        .map((dir) => join(dir, program));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there, or not executable
    }
  }
  return null;
}

export class AiToolsService implements ToolReadiness {
  private readonly runner: ToolRunner;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly modelsTtlMs: number;
  private readonly statusTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(options: AiToolsOptions = {}) {
    this.runner = options.runner ?? new SpawnToolRunner();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.env = options.env ?? process.env;
    this.modelsTtlMs = options.modelsTtlMs ?? MODELS_TTL_MS;
    this.statusTtlMs = options.statusTtlMs ?? STATUS_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  // ============ TOOLS AND MACHINES ============

  /** Every tool the project can use: the presets, then its own agent_adapters (which replace a preset of the same id). */
  private toolList(config: ProjectConfig | null): Tool[] {
    const custom: unknown = config ? (config as ProjectConfig & { agent_adapters?: unknown }).agent_adapters : undefined;
    const merged: Record<string, unknown> = { ...BUILTIN_ADAPTERS, ...(isObject(custom) ? custom : {}) };
    const tools: Tool[] = [];
    for (const [id, raw] of Object.entries(merged)) {
      if (!TOOL_ID.test(id) || !isObject(raw)) continue;
      const adapter = raw as unknown as AgentAdapter;
      const hint = typeof adapter.login_hint === "string" ? oneLine(adapter.login_hint, 200) : "";
      tools.push({
        id,
        name: typeof adapter.name === "string" && adapter.name ? oneLine(adapter.name, 80) : id,
        adapter,
        program: programOf(adapter),
        modelsCmd: toolCommand(adapter.models_cmd),
        authCheckCmd: toolCommand(adapter.auth_check_cmd),
        versionCmd: toolCommand(adapter.version_cmd),
        loginHint: hint || null,
        experimental: adapter.experimental === true,
      });
    }
    return tools;
  }

  private tool(config: ProjectConfig | null, id: unknown): Tool {
    if (typeof id !== "string" || !TOOL_ID.test(id)) {
      throw new AiError(400, "tool must be a tool id: a built-in adapter (kiro, claude-code, ...) or one of agent_adapters");
    }
    const tool = this.toolList(config).find((t) => t.id === id);
    if (!tool) throw new AiError(404, `Unknown tool: ${id}`);
    return tool;
  }

  /** This machine, and the project's SSH machines. */
  private machineList(config: ProjectConfig | null): Machine[] {
    const machines: Machine[] = [{ id: LOCAL_MACHINE, ssh: null }];
    const configured: Record<string, MachineConfig> = config?.machines ?? {};
    for (const [id, machine] of Object.entries(configured)) {
      if (id === LOCAL_MACHINE || !MACHINE_ID.test(id) || !isObject(machine)) continue;
      if (isSSHMachine(machine)) machines.push({ id, ssh: machine });
    }
    return machines;
  }

  private machine(config: ProjectConfig | null, id: unknown): Machine {
    if (id === undefined || id === null || id === "") return { id: LOCAL_MACHINE, ssh: null };
    if (typeof id !== "string" || !MACHINE_ID.test(id)) throw new AiError(400, "machine must be a machine id");
    const machine = this.machineList(config).find((m) => m.id === id);
    if (!machine) throw new AiError(404, `Unknown machine: ${id} (local, or one of the project's SSH machines)`);
    return machine;
  }

  /** What an agent of the project gets from this server's environment (and so what its tool's commands see). */
  private environment(config: ProjectConfig | null): Record<string, string> {
    const agents: unknown = config?.agents;
    const listed = isObject(agents) && Array.isArray(agents.env_passthrough) ? agents.env_passthrough : [];
    const passthrough = listed.filter((name): name is string => typeof name === "string" && ENV_NAME.test(name));
    return agentEnvironment(this.env, passthrough, {});
  }

  /** Run `argv` on `machine` (through ssh for an SSH machine). */
  private run(machine: Machine, argv: string[], config: ProjectConfig | null): Promise<ToolRunOutput> {
    const command = machine.ssh ? ["ssh", ...buildRemoteArgvCommand(machine.ssh, argv)] : argv;
    return this.runner.run(command, { timeoutMs: this.timeoutMs, maxBytes: this.maxOutputBytes, env: this.environment(config) });
  }

  /** The tools a project names: its profiles', its dragons' (the default adapter too), its fallbacks', per machine. */
  private inUse(config: ProjectConfig | null): { all: Set<string>; byMachine: Map<string, Set<string>> } {
    const all = new Set<string>();
    const byMachine = new Map<string, Set<string>>();
    if (!config) return { all, byMachine };
    for (const profile of aiProfiles(config).values()) all.add(profile.tool);
    let dragons: ReturnType<typeof loadKnownDragons>;
    try {
      dragons = loadKnownDragons(config);
    } catch {
      dragons = new Map();
    }
    for (const dragon of dragons.values()) {
      const tool = dragon.adapter || "kiro";
      all.add(tool);
      const on = dragon.machine || LOCAL_MACHINE;
      if (!byMachine.has(on)) byMachine.set(on, new Set());
      byMachine.get(on)!.add(tool);
    }
    const agents: unknown = config.agents;
    if (isObject(agents) && isObject(agents.fallbacks)) {
      for (const list of Object.values(agents.fallbacks)) {
        for (const entry of Array.isArray(list) ? list : []) {
          if (isObject(entry) && typeof entry.adapter === "string") all.add(entry.adapter);
        }
      }
    }
    return { all, byMachine };
  }

  // ============ CACHE ============

  /** The cached value under `key` while it is fresh, else the value `load` gives (one load per key at a time). */
  private async cached<T>(
    key: string,
    tool: string,
    fresh: boolean,
    load: () => Promise<{ value: T; ttl: number }>,
  ): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!fresh && entry && this.clock.now() - entry.at < entry.ttl) return entry.value;
    const pending = this.running.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const loading = (async () => {
      try {
        const { value, ttl } = await load();
        this.cache.set(key, { tool, at: this.clock.now(), ttl, value });
        return value;
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, loading);
    return loading;
  }

  /** A key that changes when the tool's commands do, so an edited adapter is never answered from the old one's cache. */
  private key(kind: string, machine: Machine, tool: Tool, parts: unknown[]): string {
    return JSON.stringify([kind, machine.id, machine.ssh ? `${machine.ssh.user}@${machine.ssh.host}` : null, tool.id, tool.program, ...parts]);
  }

  // ============ STATUS ============

  /** Is the program there: a PATH lookup here, `command -v` on an SSH machine (null when it didn't answer). */
  private async installed(machine: Machine, tool: Tool, config: ProjectConfig | null): Promise<{ installed: boolean | null; path: string | null; detail?: string }> {
    if (!tool.program) return { installed: null, path: null, detail: "its start command's program can't be told" };
    if (!machine.ssh) {
      const path = findOnPath(tool.program, this.environment(config).PATH);
      return { installed: path !== null, path };
    }
    const out = await this.runner.run(["ssh", ...buildRemoteLookupCommand(machine.ssh, tool.program)], {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxOutputBytes,
      env: this.environment(config),
    });
    if (out.code === 0) return { installed: true, path: firstLine(out.stdout, 300) || null };
    if (out.code === 1) return { installed: false, path: null };
    return { installed: null, path: null, detail: `the machine didn't answer (${describeFailure(out)})` };
  }

  private status(machine: Machine, tool: Tool, config: ProjectConfig | null, fresh = false): Promise<ToolMachineStatus> {
    const key = this.key("status", machine, tool, [tool.authCheckCmd, tool.versionCmd, tool.loginHint]);
    return this.cached(key, tool.id, fresh, async () => ({ value: await this.check(machine, tool, config), ttl: this.statusTtlMs }));
  }

  private async check(machine: Machine, tool: Tool, config: ProjectConfig | null): Promise<ToolMachineStatus> {
    const checkedAt = iso(this.clock.now());
    const found = await this.installed(machine, tool, config);
    if (found.installed === false) {
      return {
        machine: machine.id,
        installed: false,
        path: null,
        version: null,
        signIn: { state: "unknown", as: null, detail: `not installed: ${tool.program} is not on PATH`, fix: tool.loginHint },
        checkedAt,
      };
    }
    if (found.installed === null && machine.ssh) {
      return {
        machine: machine.id,
        installed: null,
        path: null,
        version: null,
        signIn: { state: "unknown", as: null, detail: found.detail ?? "the machine didn't answer", fix: tool.loginHint },
        checkedAt,
      };
    }
    let version: string | null = null;
    if (tool.versionCmd) {
      const out = await this.run(machine, tool.versionCmd, config);
      if (out.code === 0) version = firstLine(out.stdout, 100) || firstLine(out.stderr, 100) || null;
    }
    const signIn = tool.authCheckCmd
      ? signInFrom(await this.run(machine, tool.authCheckCmd, config), tool.loginHint, machine.ssh !== null)
      : { state: "unknown" as SignInState, as: null, detail: "this tool has no sign-in check (auth_check_cmd)", fix: tool.loginHint };
    return { machine: machine.id, installed: found.installed, path: found.path, version, signIn, checkedAt };
  }

  /**
   * Every tool of the project, on this machine and on each SSH machine a
   * dragon of the project runs on (there, only that dragon's tools are
   * checked, so no machine is asked about tools it never runs).
   */
  async tools(project: string, config: ProjectConfig | null): Promise<AiToolsView> {
    const tools = this.toolList(config);
    const machines = this.machineList(config);
    const use = this.inUse(config);
    const notes: string[] = [];
    for (const machine of machines) {
      if (machine.ssh && !use.byMachine.has(machine.id)) notes.push(`${machine.id}: no dragon runs there, so its tools were not checked`);
    }
    const views = await Promise.all(
      tools.map(async (tool): Promise<ToolStatusView> => {
        const on = machines.filter((m) => !m.ssh || use.byMachine.get(m.id)?.has(tool.id));
        return {
          id: tool.id,
          name: tool.name,
          experimental: tool.experimental,
          program: tool.program,
          signInCheck: tool.authCheckCmd !== undefined,
          modelsCmd: tool.modelsCmd !== undefined,
          knownModels: knownModels(tool.adapter.models).length,
          inUse: use.all.has(tool.id),
          machines: await Promise.all(on.map((machine) => this.status(machine, tool, config))),
        };
      }),
    );
    return { project, tools: views, notes };
  }

  // ============ MODELS ============

  /**
   * The models `tool` offers on `machine`: its models_cmd's list (cached for
   * an hour; `refresh` reads it again), else its known list, else none.
   */
  async models(config: ProjectConfig | null, toolId: unknown, machineId?: unknown, refresh = false): Promise<AiModelsView> {
    const tool = this.tool(config, toolId);
    const machine = this.machine(config, machineId);
    const known = knownModels(tool.adapter.models);
    const fallback = (error?: string): AiModelsView => ({
      tool: tool.id,
      machine: machine.id,
      models: known,
      source: known.length > 0 ? "preset" : "none",
      fetchedAt: null,
      ...(error ? { error } : {}),
    });
    const command = tool.modelsCmd;
    if (!command) return fallback();
    const parser = tool.adapter.models_parser;
    const key = this.key("models", machine, tool, [command, parser ?? "lines"]);
    return this.cached(key, tool.id, refresh, async () => {
      const out = await this.run(machine, command, config);
      if (out.code === 0 && !out.failure) {
        const models: ParsedModel[] = parseModels(parser, out.stdout);
        if (models.length > 0) {
          const value: AiModelsView = {
            tool: tool.id,
            machine: machine.id,
            models,
            source: "cmd",
            fetchedAt: iso(this.clock.now()),
          };
          return { value, ttl: this.modelsTtlMs };
        }
        return { value: fallback(`\`${command.join(" ")}\` listed no models`), ttl: this.statusTtlMs };
      }
      return { value: fallback(`\`${command.join(" ")}\` gave no list: ${describeFailure(out)}`), ttl: this.statusTtlMs };
    });
  }

  // ============ READINESS (the agents module) ============

  async signInRefusal(toolId: string, config: ProjectConfig): Promise<SignInRefusal | null> {
    const tool = this.toolList(config).find((t) => t.id === toolId);
    if (!tool?.authCheckCmd) return null;
    const local: Machine = { id: LOCAL_MACHINE, ssh: null };
    const status = await this.status(local, tool, config);
    if (status.signIn.state !== "signed_out") return null;
    return {
      tool: tool.id,
      name: tool.name,
      machine: LOCAL_MACHINE,
      detail: status.signIn.detail,
      fix: tool.loginHint,
      check: tool.authCheckCmd,
    };
  }

  lastSignIn(toolId: string, config: ProjectConfig): SignInState | null {
    const tool = this.toolList(config).find((t) => t.id === toolId);
    if (!tool?.authCheckCmd) return null;
    const key = this.key("status", { id: LOCAL_MACHINE, ssh: null }, tool, [tool.authCheckCmd, tool.versionCmd, tool.loginHint]);
    const entry = this.cache.get(key) as CacheEntry<ToolMachineStatus> | undefined;
    return entry ? entry.value.signIn.state : null;
  }

  forget(toolId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.tool === toolId && JSON.parse(key)[0] === "status") this.cache.delete(key);
    }
  }
}
