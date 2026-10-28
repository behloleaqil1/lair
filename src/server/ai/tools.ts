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
 * time, and callers share its result. Nothing of a tool's output is shown as
 * it is: sign-in details are fixed words (a known kind of sign-in at most),
 * failures are their category, and the rest goes through scrub().
 *
 * The agents module asks it before each start (ToolReadiness), without
 * waiting: a tool whose last check here says it is signed out starts
 * nothing on this machine; checks run in the background.
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
import { scrub } from "./scrub.js";
import type { SignInRefusal, ToolReadiness } from "./types.js";

/** This machine, where the agents module starts its runs */
export const LOCAL_MACHINE = "local";
export const MODELS_TTL_MS = 60 * 60_000;
/** A sign-in state (and a tools status) is good this long; past half of it, the next use checks again in the background */
export const STATUS_TTL_MS = 60_000;
export const COMMAND_TIMEOUT_MS = 15_000;
/** A sign-in check gets this long */
export const SIGN_IN_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** A sign-in check's output is read this far */
const MAX_CHECK_LINES = 20;
const MAX_LINE = 300;

/**
 * A failed sign-in check means "not signed in" only when its first line
 * says so; any other failure is unknown, so a crash, a missing subcommand or
 * a transient error that mentions logging in further down never stops the
 * agents.
 */
export const SIGNED_OUT_PATTERN =
  /\b(not (?:currently )?(?:logged|signed) in|not authenticated|unauthenticated|(?:log|sign) ?in required|please (?:log|sign) ?in|no (?:active )?(?:session|credentials)|logged out|login required)\b/i;

/**
 * The sign-in lines whose start Lair shows as "signed in as ...": the kind
 * of sign-in only, never what follows (a portal URL, a profile ARN, an
 * account).
 */
const KNOWN_SIGN_INS: readonly RegExp[] = [
  /^Logged in with (?:Builder ID|IAM Identity Center|AWS Builder ID)\b/i,
  /^Logged in using (?:ChatGPT|an API key)\b/i,
];

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
  signInTimeoutMs?: number;
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

/** Why a command gave no answer: its category only, never a line of its output. */
export function describeFailure(output: ToolRunOutput): string {
  switch (output.failure) {
    case "not_found":
      return "not installed";
    case "timeout":
      return "timed out";
    case "too_large":
      return "too much output";
    case "spawn":
      return "could not be started";
    default:
      return `exit code ${output.code}`;
  }
}

/** The fixed words for each sign-in state; `as` is a known kind of sign-in at most. */
export const SIGN_IN_DETAIL = {
  signedIn: "signed in",
  signedOut: "not signed in",
  unknown: "can't tell",
  unreachable: "the machine didn't answer",
} as const;

/**
 * A sign-in check's answer: exit 0 is signed in; a failure whose first
 * line says the tool is signed out is signed out; anything else (a timeout,
 * a crash, ssh failing, a missing subcommand) is unknown. Nothing of the
 * output is kept but a known kind of sign-in (KNOWN_SIGN_INS): the details
 * are fixed words and the failure's category. `remote`: the check ran
 * through ssh, whose own failures exit 255.
 */
export function signInFrom(
  output: ToolRunOutput,
  fix: string | null,
  remote = false,
): ToolMachineStatus["signIn"] {
  const unknown = (why: string): ToolMachineStatus["signIn"] => ({
    state: "unknown",
    as: null,
    detail: `${SIGN_IN_DETAIL.unknown}: the sign-in check failed (${why})`,
    fix,
  });
  if (output.failure) return unknown(describeFailure(output));
  if (output.code === 0) {
    const first = firstLine(output.stdout, MAX_LINE);
    const known = KNOWN_SIGN_INS.map((pattern) => pattern.exec(first)?.[0]).find((m): m is string => m !== undefined);
    const as = known ? scrub(known) : null;
    return { state: "signed_in", as, detail: as ? `${SIGN_IN_DETAIL.signedIn} (${as})` : SIGN_IN_DETAIL.signedIn, fix };
  }
  if (remote && output.code === 255) {
    return { state: "unknown", as: null, detail: `${SIGN_IN_DETAIL.unreachable} (ssh exit code 255)`, fix };
  }
  // Only the first line of each stream counts: a later line can be anything (a hint, a retry message)
  const said = [firstLine(output.stdout, MAX_LINE), firstLine(output.stderr, MAX_LINE)].some((line) => SIGNED_OUT_PATTERN.test(line));
  if (said) return { state: "signed_out", as: null, detail: SIGN_IN_DETAIL.signedOut, fix };
  return unknown(describeFailure(output));
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
  private readonly signInTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly running = new Map<string, Promise<unknown>>();
  /** This machine's sign-in state per tool and check, for the agents module: written by background checks only */
  private readonly signIns = new Map<string, { tool: string; at: number; state: SignInState }>();
  /** Background sign-in checks in flight, per key */
  private readonly checking = new Map<string, Promise<void>>();

  constructor(options: AiToolsOptions = {}) {
    this.runner = options.runner ?? new SpawnToolRunner();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.env = options.env ?? process.env;
    this.modelsTtlMs = options.modelsTtlMs ?? MODELS_TTL_MS;
    this.statusTtlMs = options.statusTtlMs ?? STATUS_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;
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
  private run(machine: Machine, argv: string[], config: ProjectConfig | null, timeoutMs = this.timeoutMs): Promise<ToolRunOutput> {
    const command = machine.ssh ? ["ssh", ...buildRemoteArgvCommand(machine.ssh, argv)] : argv;
    return this.runner.run(command, { timeoutMs, maxBytes: this.maxOutputBytes, env: this.environment(config) });
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
    if (out.code === 0) return { installed: true, path: scrub(firstLine(out.stdout, 300)) || null };
    if (out.code === 1) return { installed: false, path: null };
    return { installed: null, path: null, detail: `${SIGN_IN_DETAIL.unreachable} (${describeFailure(out)})` };
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
        signIn: { state: "unknown", as: null, detail: found.detail ?? SIGN_IN_DETAIL.unreachable, fix: tool.loginHint },
        checkedAt,
      };
    }
    // The version only here, for the API: the agents module's check runs the sign-in check alone
    let version: string | null = null;
    if (tool.versionCmd) {
      const out = await this.run(machine, tool.versionCmd, config);
      if (out.code === 0) version = scrub(firstLine(out.stdout, 100) || firstLine(out.stderr, 100)).slice(0, 100) || null;
    }
    let signIn: ToolMachineStatus["signIn"] = {
      state: "unknown",
      as: null,
      detail: "this tool has no sign-in check (auth_check_cmd)",
      fix: tool.loginHint,
    };
    if (tool.authCheckCmd) {
      signIn = signInFrom(await this.run(machine, tool.authCheckCmd, config, this.signInTimeoutMs), tool.loginHint, machine.ssh !== null);
      // This machine's answer serves the agents module too
      if (!machine.ssh) this.signIns.set(this.signInKey(tool), { tool: tool.id, at: this.clock.now(), state: signIn.state });
    }
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

  //
  // Nothing here waits for a command: the agents module reads the last state
  // this machine's check gave, and a check runs in the background (its
  // auth_check_cmd only, with SIGN_IN_TIMEOUT_MS) once the state is half its
  // life old. Never checked, or older than STATUS_TTL_MS: unknown, which
  // never blocks a start.

  /** The key of this machine's sign-in state for a tool: it changes when the tool's check does. */
  private signInKey(tool: Tool): string {
    return JSON.stringify([tool.id, tool.program, tool.authCheckCmd]);
  }

  private readinessTool(toolId: string, config: ProjectConfig): Tool | undefined {
    const tool = this.toolList(config).find((t) => t.id === toolId);
    return tool?.authCheckCmd ? tool : undefined;
  }

  /** Check `tool`'s sign-in here in the background, unless a check of it is running already. */
  private checkSignIn(tool: Tool, config: ProjectConfig): void {
    const key = this.signInKey(tool);
    const command = tool.authCheckCmd;
    if (!command || this.checking.has(key)) return;
    // Deferred, so it is in `checking` before any of it runs
    const running = Promise.resolve().then(async () => {
      let state: SignInState = "unknown";
      try {
        // A tool that isn't installed here has nothing to sign in: unknown (its start fails, and says why)
        const installed = !tool.program || findOnPath(tool.program, this.environment(config).PATH) !== null;
        if (installed) {
          const out = await this.run({ id: LOCAL_MACHINE, ssh: null }, command, config, this.signInTimeoutMs);
          state = signInFrom(out, tool.loginHint).state;
        }
      } catch {
        state = "unknown";
      } finally {
        this.signIns.set(key, { tool: tool.id, at: this.clock.now(), state });
        this.checking.delete(key);
      }
    });
    this.checking.set(key, running);
  }

  /** The last state of `tool` here while it is fresh; starts a background check once it is half its life old. */
  private freshSignIn(tool: Tool, config: ProjectConfig): { state: SignInState; at: number } | null {
    const entry = this.signIns.get(this.signInKey(tool));
    const age = entry ? this.clock.now() - entry.at : Infinity;
    if (age >= this.statusTtlMs / 2) this.checkSignIn(tool, config);
    return entry && age < this.statusTtlMs ? { state: entry.state, at: entry.at } : null;
  }

  signInRefusal(toolId: string, config: ProjectConfig): SignInRefusal | null {
    const tool = this.readinessTool(toolId, config);
    if (!tool?.authCheckCmd) return null;
    const known = this.freshSignIn(tool, config);
    if (!known || known.state !== "signed_out") return null;
    return {
      tool: tool.id,
      name: tool.name,
      machine: LOCAL_MACHINE,
      detail: SIGN_IN_DETAIL.signedOut,
      fix: tool.loginHint,
      check: tool.authCheckCmd,
      checkedAt: known.at,
    };
  }

  prime(toolId: string, config: ProjectConfig): void {
    const tool = this.readinessTool(toolId, config);
    if (tool) this.freshSignIn(tool, config);
  }

  lastSignIn(toolId: string, config: ProjectConfig): SignInState | null {
    const tool = this.readinessTool(toolId, config);
    if (!tool) return null;
    const entry = this.signIns.get(this.signInKey(tool));
    return entry && this.clock.now() - entry.at < this.statusTtlMs ? entry.state : null;
  }

  recheck(toolId: string, config: ProjectConfig): void {
    const tool = this.readinessTool(toolId, config);
    if (tool) this.checkSignIn(tool, config);
    // The tools view asks again too
    for (const [key, entry] of this.cache) {
      if (entry.tool === toolId && JSON.parse(key)[0] === "status") this.cache.delete(key);
    }
  }

  /** Resolves once the sign-in checks running now have ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.checking.values()]);
  }
}
