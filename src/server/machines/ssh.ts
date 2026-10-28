/**
 * SSH command builder for remote machine operations
 *
 * Security: the local `ssh` call is an argument array for spawn(), never run
 * through a local shell. The remote command is ONE string that the remote
 * user's shell parses, so every value in it is single-quoted (shellQuote) and
 * env var names are validated (isValidEnvKey).
 * BatchMode=yes prevents password prompts (would hang).
 * IdentitiesOnly=yes prevents agent key confusion.
 */
import type { MachineConfig, SSHMachineConfig } from "../../shared/types.js";
import { homedir } from "os";
import { resolve } from "path";

const DEFAULT_CONNECT_TIMEOUT = 4;

/**
 * Type guard to check if a machine config has all required SSH fields
 */
export function isSSHMachine(machine: MachineConfig): machine is SSHMachineConfig {
  return (
    machine.type === "ssh" &&
    typeof machine.host === "string" &&
    machine.host.length > 0 &&
    typeof machine.user === "string" &&
    machine.user.length > 0 &&
    typeof machine.key === "string" &&
    machine.key.length > 0
  );
}

/**
 * Resolve a key path, expanding ~ to home directory
 */
export function resolveKeyPath(keyPath: string): string {
  if (keyPath.startsWith("~/")) {
    return resolve(homedir(), keyPath.slice(2));
  }
  return resolve(keyPath);
}

/**
 * Build SSH connection args (without the remote command)
 */
export function buildSSHBaseArgs(machine: SSHMachineConfig): string[] {
  const keyPath = resolveKeyPath(machine.key);
  const timeout = machine.connect_timeout ?? DEFAULT_CONNECT_TIMEOUT;

  return [
    "-i",
    keyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeout}`,
    `${machine.user}@${machine.host}`,
  ];
}

/**
 * Build a complete SSH command array for spawn()
 *
 * @param machine - SSH machine configuration
 * @param remoteCommand - Command to run on the remote (as a single string)
 * @returns Array of command arguments for spawn('ssh', args)
 */
export function buildSSHCommand(
  machine: SSHMachineConfig,
  remoteCommand: string
): string[] {
  return [...buildSSHBaseArgs(machine), remoteCommand];
}

/**
 * Build the health check command for an SSH machine
 * Runs: echo up && uptime
 */
export function buildHealthCheckCommand(machine: SSHMachineConfig): string[] {
  return buildSSHCommand(machine, "echo up && uptime");
}

/**
 * SSH arguments that run `argv` on the machine as one command: every
 * element is single-quoted for the remote shell, so none of them is parsed
 * there (no word splitting, globbing or substitution).
 */
export function buildRemoteArgvCommand(machine: SSHMachineConfig, argv: string[]): string[] {
  return buildSSHCommand(machine, argv.map(shellQuote).join(" "));
}

/** SSH arguments that print where `program` is on the machine's PATH (exit 0), or exit 1 when it isn't there. */
export function buildRemoteLookupCommand(machine: SSHMachineConfig, program: string): string[] {
  return buildSSHCommand(machine, `command -v ${shellQuote(program)}`);
}

/**
 * Build a remote gate execution command
 *
 * @param machine - SSH machine configuration
 * @param gateScript - Path to gate script on remote
 * @param workDir - Working directory on remote
 * @param configPath - Config file path
 * @param worktree - Worktree path
 * @param envVars - Optional environment variables to pass
 */
export function buildGateCommand(
  machine: SSHMachineConfig,
  gateScript: string,
  workDir: string,
  configPath: string,
  worktree: string,
  envVars?: Record<string, string>
): string[] {
  // Build the remote command string.
  // Env values are shell-quoted. Env KEYS cannot be quoted (`'K'=v` is a
  // command, not an assignment), so they are validated instead.
  const envErrors = validateEnvVars(envVars);
  if (envErrors.length > 0) {
    throw new Error(`Invalid gate environment: ${envErrors.join("; ")}`);
  }

  // The assignments go directly before the gate script so they apply to it
  // (a prefix before `cd ... &&` would only apply to `cd`).
  const envPrefix = Object.entries(envVars ?? {})
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join("");
  const remoteCmd = `cd ${shellQuote(workDir)} && ${envPrefix}${shellQuote(gateScript)} ${shellQuote(configPath)} ${shellQuote(worktree)}`;

  return buildSSHCommand(machine, remoteCmd);
}

/** A POSIX environment variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables that change how the dynamic loader, shells, git or runtimes
 * start, or where they load code from. A gate request (written by an agent)
 * must not be able to set them.
 */
const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "IFS",
  "ENV",
  "BASH_ENV",
  "CDPATH",
  "ZDOTDIR",
  "PS4",
  "PROMPT_COMMAND",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5OPT",
  "RUBYOPT",
]);
// GIT_CONFIG_ covers GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>, GIT_CONFIG_VALUE_<n>,
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM (any of them can set core.sshCommand
// or other config that runs commands)
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "GIT_CONFIG_"];

/** True if `key` is a plain, non-reserved environment variable name. */
export function isValidEnvKey(key: string): boolean {
  if (!ENV_KEY_PATTERN.test(key)) return false;
  const upper = key.toUpperCase();
  if (RESERVED_ENV_KEYS.has(upper)) return false;
  return !RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Validate gate env vars from an untrusted source (a .req file).
 * Returns a list of errors; empty means every key and value is acceptable.
 */
export function validateEnvVars(envVars: unknown): string[] {
  if (envVars === undefined || envVars === null) return [];
  if (typeof envVars !== "object" || Array.isArray(envVars)) {
    return ["envVars must be an object of strings"];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(envVars as Record<string, unknown>)) {
    if (!isValidEnvKey(key)) {
      errors.push(`invalid env var name: ${JSON.stringify(key)}`);
    } else if (typeof value !== "string") {
      errors.push(`env var ${key} must be a string`);
    }
  }
  return errors;
}

/**
 * Shell-quote a value for use in a remote command string
 * Uses single quotes, escaping any embedded single quotes
 */
function shellQuote(value: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate an SSH machine config and return errors if invalid
 */
export function validateSSHConfig(
  machineId: string,
  machine: MachineConfig
): string[] {
  const errors: string[] = [];

  if (machine.type !== "ssh") {
    return errors; // Local machines don't need SSH validation
  }

  if (!machine.host || machine.host.trim().length === 0) {
    errors.push(`Machine '${machineId}': missing 'host' for SSH machine`);
  }

  if (!machine.user || machine.user.trim().length === 0) {
    errors.push(`Machine '${machineId}': missing 'user' for SSH machine`);
  }

  if (!machine.key || machine.key.trim().length === 0) {
    errors.push(`Machine '${machineId}': missing 'key' for SSH machine`);
  }

  if (
    machine.connect_timeout !== undefined &&
    (typeof machine.connect_timeout !== "number" || machine.connect_timeout < 1)
  ) {
    errors.push(
      `Machine '${machineId}': 'connect_timeout' must be a positive number`
    );
  }

  return errors;
}
