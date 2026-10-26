/**
 * Command execution service - SECURE command runner
 *
 * Safety rules:
 * - Commands run as argument arrays, NEVER through a shell
 * - User text is passed as a single argument, never parsed
 * - Only commands defined in the project config can run
 * - All executions are audited
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type {
  ProjectConfig,
  CommandResult,
  AuditEntry,
  DragonManagementConfig,
} from "../../shared/types.js";
import { listAdapters } from "./adapters.js";
import { loadKnownDragons } from "./dragon-registry.js";

const DATA_DIR = join(process.cwd(), "data");
const AUDIT_LOG = join(DATA_DIR, "audit.log");

// Ensure data directory exists
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Audit an action
 */
function audit(
  action: string,
  command: string[],
  exitCode: number,
  outputTail: string,
): void {
  ensureDataDir();
  const entry: AuditEntry = {
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    action,
    command,
    exitCode,
    outputTail: outputTail.slice(-500),
  };
  appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
}

/**
 * Get recent audit entries
 */
export function getAuditLog(limit = 50): AuditEntry[] {
  ensureDataDir();
  if (!existsSync(AUDIT_LOG)) {
    return [];
  }
  const content = readFileSync(AUDIT_LOG, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Build command array with substitutions
 * Substitutes placeholders: {text}, {task}, {track}, {sha}, {number}, etc.
 */
export function buildCommand(
  template: string[],
  vars: Record<string, string>,
): string[] {
  return template.map((arg) => {
    let result = arg;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    return result;
  });
}

/**
 * Execute a command securely (no shell)
 * Returns a promise with the result
 */
export function executeCommand(
  command: string[],
  action: string,
  options: { timeout?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    const timeout = options.timeout || 120000;

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(cmd, args, {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      // NEVER use shell: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? -1 : (code ?? 1);
      const output = stdout + stderr;

      audit(action, command, exitCode, output);

      resolve({
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        command,
        timestamp: new Date().toISOString(),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const errorMsg = err.message;
      audit(action, command, -1, errorMsg);

      resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: errorMsg,
        command,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/**
 * Command service for a project
 */
export class CommandService {
  constructor(private config: ProjectConfig) {}

  /**
   * Check if the project is in read-only mode
   */
  isReadOnly(): boolean {
    return this.config.read_only === true;
  }

  /**
   * Get allowed command names
   */
  getAllowedCommands(): string[] {
    const cmds: string[] = [];
    if (this.config.ask_cmd) cmds.push("ask");
    if (this.config.tick_now_cmd) cmds.push("tick_now");
    if (this.config.pause_cmd) cmds.push("pause");
    if (this.config.resume_cmd) cmds.push("resume");
    if (this.config.agent_run_cmd) cmds.push("agent_run");
    if (this.config.agent_stop_cmd) cmds.push("agent_stop");
    if (this.config.agent_release_cmd) cmds.push("agent_release");
    if (this.config.gate_submit_cmd) cmds.push("gate_submit");
    if (this.config.gate_stuck_cmd) cmds.push("gate_stuck");
    if (this.config.merge_cmd) cmds.push("merge");
    return cmds;
  }

  /**
   * Execute the ask command (question mode)
   */
  async ask(question: string): Promise<CommandResult> {
    if (!this.config.ask_cmd) {
      return {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "ask_cmd not configured",
        command: [],
        timestamp: new Date().toISOString(),
      };
    }
    // Prepend QUESTION MODE preamble
    const preamble =
      "QUESTION MODE: change nothing; answer only from commands you run now. ";
    const fullQuestion = preamble + question;
    const cmd = buildCommand(this.config.ask_cmd, { text: fullQuestion });
    return executeCommand(cmd, "ask");
  }

  /**
   * Run a tick now
   */
  async tickNow(): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("tick_now");
    }
    if (!this.config.tick_now_cmd) {
      return this.notConfiguredError("tick_now_cmd");
    }
    const cmd = buildCommand(this.config.tick_now_cmd, {});
    return executeCommand(cmd, "tick_now");
  }

  /**
   * Pause the orchestrator
   */
  async pause(): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("pause");
    }
    if (!this.config.pause_cmd) {
      return this.notConfiguredError("pause_cmd");
    }
    const cmd = buildCommand(this.config.pause_cmd, {});
    return executeCommand(cmd, "pause");
  }

  /**
   * Resume the orchestrator
   */
  async resume(): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("resume");
    }
    if (!this.config.resume_cmd) {
      return this.notConfiguredError("resume_cmd");
    }
    const cmd = buildCommand(this.config.resume_cmd, {});
    return executeCommand(cmd, "resume");
  }

  /**
   * Start an agent with a task
   */
  async agentRun(task: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("agent_run");
    }
    if (!this.config.agent_run_cmd) {
      return this.notConfiguredError("agent_run_cmd");
    }
    const cmd = buildCommand(this.config.agent_run_cmd, { task });
    return executeCommand(cmd, "agent_run", { env: { TASK: task } });
  }

  /**
   * Stop an agent
   */
  async agentStop(agentId: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("agent_stop");
    }
    if (!this.config.agent_stop_cmd) {
      return this.notConfiguredError("agent_stop_cmd");
    }
    const cmd = buildCommand(this.config.agent_stop_cmd, { agent: agentId });
    return executeCommand(cmd, "agent_stop");
  }

  /**
   * Release an agent's task
   */
  async agentRelease(agentId: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("agent_release");
    }
    if (!this.config.agent_release_cmd) {
      return this.notConfiguredError("agent_release_cmd");
    }
    const cmd = buildCommand(this.config.agent_release_cmd, { agent: agentId });
    return executeCommand(cmd, "agent_release");
  }

  /**
   * Submit a gate
   */
  async gateSubmit(
    track: string,
    options: { lane?: string; priority?: number; scope?: string } = {},
  ): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("gate_submit");
    }
    if (!this.config.gate_submit_cmd) {
      return this.notConfiguredError("gate_submit_cmd");
    }
    const cmd = buildCommand(this.config.gate_submit_cmd, {
      track,
      lane: options.lane || "heavy",
      priority: String(options.priority || 5),
      scope: options.scope || "",
    });
    return executeCommand(cmd, "gate_submit");
  }

  /**
   * Mark a gate as stuck
   */
  async gateStuck(gateId: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("gate_stuck");
    }
    if (!this.config.gate_stuck_cmd) {
      return this.notConfiguredError("gate_stuck_cmd");
    }
    const cmd = buildCommand(this.config.gate_stuck_cmd, { gate: gateId });
    return executeCommand(cmd, "gate_stuck");
  }

  /**
   * Merge a PR
   */
  async merge(prNumber: number, headSha: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("merge");
    }
    if (!this.config.merge_cmd) {
      return this.notConfiguredError("merge_cmd");
    }
    const cmd = buildCommand(this.config.merge_cmd, {
      number: String(prNumber),
      sha: headSha,
      github: this.config.github,
    });
    return executeCommand(cmd, "merge");
  }

  private readOnlyError(action: string): CommandResult {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Project is in read-only mode. Cannot execute: ${action}`,
      command: [],
      timestamp: new Date().toISOString(),
    };
  }

  private notConfiguredError(cmd: string): CommandResult {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `${cmd} not configured`,
      command: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ============ DRAGON MANAGEMENT (Phase 4) ============

  /**
   * Get dragon management config (dragons, models, adapters, commands).
   * `dragons` is every dragon start/stop accepts: the YAML map plus
   * dragons.txt, read now (see services/dragon-registry.ts).
   */
  getDragonManagementConfig(): DragonManagementConfig {
    const cfg = this.config as ProjectConfig & DragonManagementConfig;
    return {
      dragons: Object.fromEntries(loadKnownDragons(this.config)),
      available_models: cfg.available_models,
      available_adapters: listAdapters(this.config),
      default_instructions: cfg.default_instructions,
      dragon_start_cmd: cfg.dragon_start_cmd,
      dragon_stop_cmd: cfg.dragon_stop_cmd,
      dragon_release_cmd: cfg.dragon_release_cmd,
    };
  }

  /**
   * Start a dragon with task and prompt
   */
  async dragonStart(
    dragonId: string,
    task: string,
    promptFile: string,
    options: { model?: string; extraInstructions?: string } = {},
  ): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("dragon_start");
    }

    const cfg = this.config as ProjectConfig & DragonManagementConfig;
    if (!cfg.dragon_start_cmd) {
      return this.notConfiguredError("dragon_start_cmd");
    }

    // Build the command with substitutions
    const cmd = buildCommand(cfg.dragon_start_cmd, {
      dragon: dragonId,
      task,
      prompt_file: promptFile,
    });

    // Add environment variables for optional overrides
    const env: Record<string, string> = { TASK: task };
    if (options.model) {
      env.MODEL = options.model;
    }
    if (options.extraInstructions) {
      env.EXTRA_INSTRUCTIONS = options.extraInstructions;
    }

    return executeCommand(cmd, "dragon_start", { env });
  }

  /**
   * Stop a running dragon
   */
  async dragonStop(dragonId: string): Promise<CommandResult> {
    if (this.isReadOnly()) {
      return this.readOnlyError("dragon_stop");
    }

    const cfg = this.config as ProjectConfig & DragonManagementConfig;
    if (!cfg.dragon_stop_cmd) {
      return this.notConfiguredError("dragon_stop_cmd");
    }

    const cmd = buildCommand(cfg.dragon_stop_cmd, { dragon: dragonId });
    return executeCommand(cmd, "dragon_stop");
  }
}
