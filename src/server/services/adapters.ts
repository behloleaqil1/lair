/**
 * Agent Adapter Service
 *
 * Provides infrastructure for orchestrating any AI coding agent, not just Kiro.
 * Built-in adapters (presets) for Kiro, Aider, Claude Code, Cursor Agent,
 * Codex CLI, Gemini CLI, OpenCode, Goose and GitHub Copilot CLI; only Kiro
 * is tested end to end, the others are marked experimental. Custom adapters
 * can be defined in project config. A preset may also say how to list the
 * tool's models (models_cmd and models_parser, else a known `models` list),
 * how to check that it is signed in (auth_check_cmd, login_hint) and how to
 * read its version (version_cmd): src/server/ai/ runs those.
 */
import type {
  AgentAdapter,
  ProjectTerminology,
  AdapterValidationResult,
  AdapterCommandResult,
  DragonConfig,
  ProjectConfig,
} from "../../shared/types.js";

// ============ BUILT-IN ADAPTERS ============

/**
 * Built-in agent adapters that ship with Lair.
 * Users can override these in their project config (`agent_adapters`).
 *
 * Templates are split into argv tokens BEFORE placeholders are substituted,
 * so a substituted value is always exactly one argument. Use single or
 * double quotes in a template to keep words together.
 */
export const BUILTIN_ADAPTERS: Record<string, AgentAdapter> = {
  kiro: {
    id: "kiro",
    name: "Kiro CLI",
    start_cmd:
      "kiro-cli chat --no-interactive --trust-all-tools --agent {agent_profile} --model {model} {prompt_file}",
    stop_cmd: "touch {session_dir}/STOP",
    status_method: "file",
    queue_file: "work/queue.md",
    log_dir: "work/logs/",
    session_id_env: "KIRO_SESSION_ID",
    resume_flag: "--resume-id {session_id}",
    // Lines like "* auto  1.00x credits  Models chosen by task..." (the default marked with *)
    models_cmd: ["kiro-cli", "chat", "--list-models"],
    models_parser: "kiro",
    // Shown only when the list command fails
    models: [
      { id: "auto", label: "Models chosen by task", default: true },
      { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
      { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    ],
    auth_check_cmd: ["kiro-cli", "whoami"],
    login_hint: "kiro-cli login",
    version_cmd: ["kiro-cli", "--version"],
  },
  // The model is not part of the start command: aider takes it from its own
  // configuration (.aider.conf.yml or its environment variables)
  aider: {
    id: "aider",
    name: "Aider",
    start_cmd: "aider --yes --message-file {prompt_file}",
    stop_cmd: "kill -INT {pid}",
    status_method: "file",
    queue_file: ".aider/status.md",
    version_cmd: ["aider", "--version"],
  },
  // EXPERIMENTAL example. Flags checked against the public Claude Code CLI
  // reference: the binary is `claude`, `-p` runs non-interactively, `--model`,
  // `--resume <session>` and `--append-system-prompt-file <file>` exist. The
  // CLI has no flag that reads the task prompt from a file, so the prompt
  // file is appended to the system prompt and a short fixed query starts the
  // run. Status parsing (status_pattern) is a placeholder: adapt it, and the
  // permission flags your setup needs, in `agent_adapters` before relying on it.
  "claude-code": {
    id: "claude-code",
    name: "Claude Code (experimental)",
    start_cmd:
      'claude -p --model {model} --append-system-prompt-file {prompt_file} "Carry out the task described at the end of your system prompt."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "stdout",
    status_pattern: '^\\{"status":',
    resume_flag: "--resume {session_id}",
    // The CLI's model aliases (a full model name works too); no list command
    models: [
      { id: "opus", label: "Claude Opus (the latest)" },
      { id: "sonnet", label: "Claude Sonnet (the latest)" },
      { id: "haiku", label: "Claude Haiku (the latest)" },
    ],
    login_hint: "claude, then /login",
    version_cmd: ["claude", "--version"],
    experimental: true,
  },
  // EXPERIMENTAL example. Per the public Cursor CLI parameter reference the
  // binary is `agent`, `-p` runs non-interactively and the prompt is a
  // positional argument (there is no prompt-file option and no run/stop
  // subcommand), so the prompt names the file for the agent to read, and
  // stopping sends SIGTERM. The "mcp" status method is a placeholder:
  // adapt this adapter in `agent_adapters` before relying on it.
  "cursor-agent": {
    id: "cursor-agent",
    name: "Cursor Agent (experimental)",
    start_cmd:
      'agent -p --model {model} "Read the file {prompt_file} and carry out the task it describes."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "mcp",
    mcp_endpoint: "stdio",
    resume_flag: "--resume {session_id}",
    models: [{ id: "auto", label: "Chosen by Cursor", default: true }, { id: "sonnet-4.5" }, { id: "gpt-5" }],
    login_hint: "agent login",
    version_cmd: ["agent", "--version"],
    experimental: true,
  },
  // EXPERIMENTAL presets: start commands from each CLI's public reference,
  // not run end to end by Lair's tests. None of them reads the prompt from a
  // file, so the prompt names the file for the agent to read, and stopping
  // sends SIGTERM. Adapt them (permission flags, resume) in `agent_adapters`.
  //
  // Codex CLI: `codex exec` runs non-interactively, `--model` picks the model
  // and `--full-auto` lets it edit the workspace; `codex login status` exits 0
  // when signed in
  codex: {
    id: "codex",
    name: "Codex CLI (experimental)",
    start_cmd:
      'codex exec --full-auto --model {model} "Read the file {prompt_file} and carry out the task it describes."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    queue_file: "work/queue.md",
    models: [{ id: "gpt-5-codex", label: "GPT-5-Codex", default: true }, { id: "gpt-5", label: "GPT-5" }],
    auth_check_cmd: ["codex", "login", "status"],
    login_hint: "codex login",
    version_cmd: ["codex", "--version"],
    experimental: true,
  },
  // Gemini CLI: `--prompt` runs non-interactively, `--model` picks the model,
  // `--yolo` accepts its tool calls
  gemini: {
    id: "gemini",
    name: "Gemini CLI (experimental)",
    start_cmd:
      'gemini --model {model} --yolo --prompt "Read the file {prompt_file} and carry out the task it describes."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    queue_file: "work/queue.md",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", default: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
    login_hint: "gemini, then choose Login with Google",
    version_cmd: ["gemini", "--version"],
    experimental: true,
  },
  // OpenCode: `opencode run` runs non-interactively, `--model` takes
  // provider/model, and `opencode models` lists them one per line
  opencode: {
    id: "opencode",
    name: "OpenCode (experimental)",
    start_cmd: 'opencode run --model {model} "Read the file {prompt_file} and carry out the task it describes."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    queue_file: "work/queue.md",
    models_cmd: ["opencode", "models"],
    models_parser: "lines",
    login_hint: "opencode auth login",
    version_cmd: ["opencode", "--version"],
    experimental: true,
  },
  // Goose: `goose run --instructions <file>` runs the file's instructions. The
  // model is not part of the start command: goose takes it from its own
  // configuration (`goose configure`)
  goose: {
    id: "goose",
    name: "Goose (experimental)",
    start_cmd: "goose run --instructions {prompt_file}",
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    queue_file: "work/queue.md",
    login_hint: "goose configure",
    version_cmd: ["goose", "--version"],
    experimental: true,
  },
  // GitHub Copilot CLI: `--prompt` runs non-interactively, `--model` picks
  // the model, and `--allow-all-tools` lets it use its tools without asking
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI (experimental)",
    start_cmd:
      'copilot --model {model} --allow-all-tools --prompt "Read the file {prompt_file} and carry out the task it describes."',
    stop_cmd: "kill -TERM {pid}",
    status_method: "file",
    queue_file: "work/queue.md",
    models: [
      { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", default: true },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "gpt-5", label: "GPT-5" },
    ],
    login_hint: "copilot, then /login",
    version_cmd: ["copilot", "--version"],
    experimental: true,
  },
};

// ============ DEFAULT TERMINOLOGY ============

/**
 * Default terminology.
 */
export const DEFAULT_TERMINOLOGY: ProjectTerminology = {
  agent_singular: "dragon",
  agent_plural: "dragons",
  orchestrator: "orchestrator",
};

// ============ SECURITY ============

/**
 * Characters that are dangerous in shell commands.
 * These should never appear in substituted values.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>\\!"'*?\n\r\t]/;

/**
 * Check if a string contains shell metacharacters.
 */
export function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}

/**
 * Validate that a value is safe for shell command substitution.
 * Returns an error message if unsafe, or null if safe.
 */
export function validateSubstitutionValue(
  key: string,
  value: string,
): string | null {
  if (containsShellMetacharacters(value)) {
    return `Variable {${key}} contains shell metacharacters: "${value}"`;
  }
  return null;
}

// ============ VARIABLE SUBSTITUTION ============

/**
 * Supported variable placeholders for command templates.
 */
export type TemplateVariable =
  | "agent_id"
  | "agent_name"
  | "task"
  | "prompt_file"
  | "model"
  | "session_id"
  | "session_dir"
  | "output_dir"
  | "pid"
  | "agent_profile";

/**
 * Substitute variables in a command template string.
 *
 * @param template - Command string with {variable} placeholders
 * @param vars - Map of variable names to values
 * @returns Object with substituted string and any warnings
 */
export function substituteVariables(
  template: string,
  vars: Record<string, string>,
): { result: string; warnings: string[] } {
  // First, validate all provided values for shell safety.
  // If any values are unsafe, don't substitute them.
  const warnings = unsafeValueWarnings(vars);
  if (warnings.length > 0) {
    return { result: template, warnings };
  }

  const result = replacePlaceholders(template, vars);
  warnings.push(...unsubstitutedWarnings([result]));
  return { result, warnings };
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Warnings for values that contain shell metacharacters. */
function unsafeValueWarnings(vars: Record<string, string>): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    const error = validateSubstitutionValue(key, value);
    if (error) {
      warnings.push(error);
    }
  }
  return warnings;
}

/**
 * Replace {name} placeholders in one pass. A replacer function is used so
 * `$&`-style sequences in values are not interpreted, and substituted
 * values are never scanned again for placeholders.
 */
function replacePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

/** Warnings for placeholders that are still present. */
function unsubstitutedWarnings(parts: string[]): string[] {
  const warnings: string[] = [];
  for (const part of parts) {
    for (const match of part.match(PLACEHOLDER) ?? []) {
      warnings.push(`Unsubstituted variable: ${match}`);
    }
  }
  return warnings;
}

/**
 * Split a command template into argv tokens, before any substitution.
 *
 * Whitespace separates tokens. Single quotes keep text literally; double
 * quotes keep text together and allow \" and \\ escapes; outside quotes a
 * backslash escapes the next character. No other shell syntax is
 * interpreted (commands run without a shell).
 */
export function tokenizeTemplate(template: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && (template[i + 1] === '"' || template[i + 1] === "\\")) {
        current += template[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    inToken = true;
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "\\" && i + 1 < template.length) {
      current += template[++i];
    } else {
      current += ch;
    }
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command template: ${template}`);
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Why a placeholder in these tokens would put a value where only the
 * template may decide: the program (the first token) never holds one, and a
 * token that starts with one is refused when its value starts with "-" (it
 * would become an option).
 */
function placementWarnings(tokens: string[], vars: Record<string, string>): string[] {
  const warnings: string[] = [];
  tokens.forEach((token, i) => {
    if (i === 0) {
      const named = /\{([a-z_]+)\}/.exec(token);
      if (named) warnings.push(`The program can't come from a placeholder ({${named[1]}})`);
      return;
    }
    const lead = /^\{([a-z_]+)\}/.exec(token);
    if (lead && Object.prototype.hasOwnProperty.call(vars, lead[1]) && vars[lead[1]].startsWith("-")) {
      warnings.push(`Variable {${lead[1]}} would become an option: "${vars[lead[1]].slice(0, 60)}"`);
    }
  });
  return warnings;
}

/**
 * Tokenize templates, then substitute placeholders inside each token, so a
 * value (a path with spaces, say) always stays one argument. `extraArgs`
 * (a profile's options.args) are literal arguments that go after the first
 * template's, never substituted.
 */
function buildArgv(
  templates: string[],
  vars: Record<string, string>,
  extraArgs: readonly string[] = [],
): AdapterCommandResult {
  let groups: string[][];
  try {
    groups = templates.map((t) => tokenizeTemplate(t));
  } catch (e) {
    // validateAdapter reports this too; never hand back a half-parsed command
    return { command: [], warnings: [e instanceof Error ? e.message : String(e)] };
  }
  const tokens = groups.flat();
  const warnings = unsafeValueWarnings(vars);
  if (warnings.length > 0) {
    // Same rule as substituteVariables: unsafe values are not substituted
    return { command: tokens, warnings };
  }
  const misplaced = placementWarnings(tokens, vars);
  if (misplaced.length > 0) return { command: tokens, warnings: misplaced };
  const substituted = groups.map((group) => group.map((token) => replacePlaceholders(token, vars)));
  const command = [...(substituted[0] ?? []), ...extraArgs, ...substituted.slice(1).flat()];
  warnings.push(...unsubstitutedWarnings(substituted.flat()));
  return { command, warnings };
}

// ============ ADAPTER OPERATIONS ============

/**
 * Get an adapter by ID, checking project config first, then built-ins.
 */
export function getAdapter(
  id: string,
  projectConfig?: ProjectConfig,
): AgentAdapter | undefined {
  // Check project-specific adapters first
  const customAdapters =
    (projectConfig as ProjectConfig & { agent_adapters?: Record<string, AgentAdapter> })
      ?.agent_adapters || {};

  if (id in customAdapters) {
    return customAdapters[id];
  }

  // Fall back to built-ins
  if (id in BUILTIN_ADAPTERS) {
    return BUILTIN_ADAPTERS[id];
  }

  return undefined;
}

/**
 * List all available adapters (built-ins + project custom).
 */
export function listAdapters(projectConfig?: ProjectConfig): AgentAdapter[] {
  const customAdapters =
    (projectConfig as ProjectConfig & { agent_adapters?: Record<string, AgentAdapter> })
      ?.agent_adapters || {};

  // Merge: custom adapters override built-ins with the same ID
  const merged = { ...BUILTIN_ADAPTERS, ...customAdapters };
  return Object.values(merged);
}

/**
 * Validate an adapter configuration.
 */
export function validateAdapter(adapter: AgentAdapter): AdapterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!adapter.id || typeof adapter.id !== "string") {
    errors.push("Adapter must have a string 'id'");
  }
  if (!adapter.name || typeof adapter.name !== "string") {
    errors.push("Adapter must have a string 'name'");
  }
  if (!adapter.start_cmd || typeof adapter.start_cmd !== "string") {
    errors.push("Adapter must have a string 'start_cmd'");
  }
  if (!adapter.stop_cmd || typeof adapter.stop_cmd !== "string") {
    errors.push("Adapter must have a string 'stop_cmd'");
  }

  // Command templates must tokenize (balanced quotes), and the program is never a placeholder
  for (const template of [adapter.start_cmd, adapter.stop_cmd, adapter.resume_flag]) {
    if (typeof template !== "string") continue;
    try {
      const program = tokenizeTemplate(template)[0] ?? "";
      if (template !== adapter.resume_flag && /\{[a-z_]+\}/.test(program)) {
        errors.push(`The program of "${template.slice(0, 80)}" can't come from a placeholder`);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // status_method validation
  const validMethods = ["file", "stdout", "mcp"];
  if (!adapter.status_method || !validMethods.includes(adapter.status_method)) {
    errors.push(
      `Adapter status_method must be one of: ${validMethods.join(", ")}`,
    );
  }

  // Method-specific validation
  if (adapter.status_method === "file") {
    if (!adapter.queue_file && !adapter.log_dir) {
      warnings.push(
        "File-based adapter should have queue_file or log_dir configured",
      );
    }
  }

  if (adapter.status_method === "stdout") {
    if (!adapter.status_pattern) {
      warnings.push("Stdout-based adapter should have status_pattern configured");
    } else {
      // Try to compile the regex
      try {
        new RegExp(adapter.status_pattern);
      } catch {
        errors.push(`Invalid status_pattern regex: ${adapter.status_pattern}`);
      }
    }
  }

  if (adapter.status_method === "mcp") {
    if (!adapter.mcp_endpoint) {
      warnings.push("MCP-based adapter should have mcp_endpoint configured");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============ COMMAND BUILDING ============

/**
 * Input for building a start command.
 */
export interface StartCommandInput {
  agentId: string;
  agentName?: string;
  task: string;
  promptFile: string;
  model?: string;
  sessionId?: string;
  sessionDir?: string;
  outputDir?: string;
  agentProfile?: string;
  /** Literal arguments after the start command's (an ai.profiles entry's options.args), before the resume flag */
  extraArgs?: readonly string[];
}

/**
 * Build the start command array for an adapter.
 *
 * @param adapter - The agent adapter
 * @param input - Start command parameters
 * @returns Command array suitable for spawn(), plus any warnings
 */
export function buildStartCommand(
  adapter: AgentAdapter,
  input: StartCommandInput,
): AdapterCommandResult {
  const vars: Record<string, string> = {
    agent_id: input.agentId,
    agent_name: input.agentName || input.agentId,
    task: input.task,
    prompt_file: input.promptFile,
  };

  if (input.model) {
    vars.model = input.model;
  }
  if (input.sessionId) {
    vars.session_id = input.sessionId;
  }
  if (input.sessionDir) {
    vars.session_dir = input.sessionDir;
  }
  if (input.outputDir) {
    vars.output_dir = input.outputDir;
  }
  if (input.agentProfile) {
    vars.agent_profile = input.agentProfile;
  }

  // Base command, plus the resume flag if session_id provided and supported
  const templates = [adapter.start_cmd];
  if (input.sessionId && adapter.resume_flag) {
    templates.push(adapter.resume_flag);
  }

  return buildArgv(templates, vars, input.extraArgs);
}

/**
 * Input for building a stop command.
 */
export interface StopCommandInput {
  agentId: string;
  agentName?: string;
  sessionDir?: string;
  pid?: number;
}

/**
 * Build the stop command array for an adapter.
 *
 * @param adapter - The agent adapter
 * @param input - Stop command parameters
 * @returns Command array suitable for spawn(), plus any warnings
 */
export function buildStopCommand(
  adapter: AgentAdapter,
  input: StopCommandInput,
): AdapterCommandResult {
  const vars: Record<string, string> = {
    agent_id: input.agentId,
    agent_name: input.agentName || input.agentId,
  };

  if (input.sessionDir) {
    vars.session_dir = input.sessionDir;
  }
  if (input.pid !== undefined) {
    vars.pid = String(input.pid);
  }

  return buildArgv([adapter.stop_cmd], vars);
}

// ============ TERMINOLOGY ============

/**
 * Parse terminology from project config.
 */
export function parseTerminology(
  projectConfig?: ProjectConfig,
): ProjectTerminology {
  const config = projectConfig as ProjectConfig & {
    terminology?: Partial<ProjectTerminology>;
  };

  if (!config?.terminology) {
    return DEFAULT_TERMINOLOGY;
  }

  return {
    agent_singular:
      config.terminology.agent_singular || DEFAULT_TERMINOLOGY.agent_singular,
    agent_plural:
      config.terminology.agent_plural || DEFAULT_TERMINOLOGY.agent_plural,
    orchestrator:
      config.terminology.orchestrator || DEFAULT_TERMINOLOGY.orchestrator,
  };
}

// ============ CONFIG PARSING ============

/**
 * Parse agent adapters from project config.
 * Merges custom adapters with built-ins.
 */
export function parseAdapters(projectConfig?: ProjectConfig): AgentAdapter[] {
  return listAdapters(projectConfig);
}

/**
 * Merge custom adapters with built-ins.
 * Custom adapters with the same ID override built-ins.
 */
export function mergeWithBuiltins(
  custom: AgentAdapter[],
): Record<string, AgentAdapter> {
  const result = { ...BUILTIN_ADAPTERS };

  for (const adapter of custom) {
    result[adapter.id] = adapter;
  }

  return result;
}

/**
 * Get the adapter for a dragon (agent), falling back to 'kiro' if not specified.
 */
export function getDragonAdapter(
  dragon: DragonConfig,
  projectConfig?: ProjectConfig,
): AgentAdapter | undefined {
  const adapterId = dragon.adapter || "kiro";
  return getAdapter(adapterId, projectConfig);
}

/**
 * Validate that all dragons reference valid adapters.
 */
export function validateDragonsAdapters(
  projectConfig: ProjectConfig,
): string[] {
  const errors: string[] = [];
  const dragons = projectConfig.dragons || {};
  const availableAdapters = listAdapters(projectConfig).map((a) => a.id);

  for (const [id, dragon] of Object.entries(dragons)) {
    const adapterId = dragon.adapter || "kiro";
    if (!availableAdapters.includes(adapterId)) {
      errors.push(
        `Dragon ${id}: adapter '${adapterId}' not found. Available: ${availableAdapters.join(", ")}`,
      );
    }
  }

  return errors;
}


/**
 * Get the list of built-in adapters as an array.
 * Used by the Settings UI to show available adapters.
 */
export function getBuiltInAdapters(): AgentAdapter[] {
  return Object.values(BUILTIN_ADAPTERS);
}
