/**
 * Remote gate execution service
 *
 * Executes gates on SSH machines via spawn (no shell).
 * Streams output back to callbacks for real-time logging.
 *
 * Security: Commands use spawn with argument arrays, NEVER shell strings.
 */
import { spawn, type ChildProcess } from "child_process";
import type { MachineConfig, SSHMachineConfig } from "../../shared/types.js";
import {
  isSSHMachine,
  buildGateCommand,
  validateEnvVars,
} from "../machines/ssh.js";

/**
 * Options for remote gate execution
 */
export interface RemoteGateOptions {
  /** Timeout in milliseconds (default: 30 minutes) */
  timeout?: number;
  /** Environment variables to pass to the gate */
  envVars?: Record<string, string>;
  /** Callback for stdout data */
  onStdout?: (data: string) => void;
  /** Callback for stderr data */
  onStderr?: (data: string) => void;
  /** Callback when gate starts */
  onStart?: (pid: number) => void;
  /** Milliseconds between SIGTERM and SIGKILL on timeout or kill() (default: 5000) */
  killGraceMs?: number;
}

/**
 * Result of remote gate execution
 */
export interface RemoteGateResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  duration: number;
  error?: string;
}

/**
 * Running gate process handle
 */
export interface GateProcess {
  pid: number;
  kill: () => void;
  promise: Promise<RemoteGateResult>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const KILL_GRACE_MS = 5000; // SIGTERM -> SIGKILL

/**
 * True once the child has exited. `child.killed` is NOT that: it turns true
 * as soon as a signal is delivered, so it can't tell whether SIGTERM worked.
 */
export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

/**
 * Send SIGTERM, then SIGKILL after a grace period if the child is still alive.
 */
export function terminateWithEscalation(
  proc: ChildProcess,
  graceMs: number = KILL_GRACE_MS,
): void {
  if (hasExited(proc)) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!hasExited(proc)) {
      proc.kill("SIGKILL");
    }
  }, graceMs);
  proc.on("exit", () => clearTimeout(timer));
}

/** A gate process handle for a gate that failed before anything was spawned. */
function failedGate(stderr: string, error: string): GateProcess {
  return {
    pid: -1,
    kill: () => {},
    promise: Promise.resolve({
      success: false,
      exitCode: -1,
      stdout: "",
      stderr,
      timedOut: false,
      duration: 0,
      error,
    }),
  };
}

/**
 * Build SSH command array for remote gate execution
 *
 * @param machine - SSH machine configuration
 * @param gateScript - Path to gate script on remote machine
 * @param configPath - Path to config file
 * @param worktree - Path to worktree on remote machine
 * @param envVars - Optional environment variables
 * @returns Command array for spawn('ssh', args)
 */
export function buildSshGateCommand(
  machine: SSHMachineConfig,
  gateScript: string,
  configPath: string,
  worktree: string,
  envVars?: Record<string, string>,
): string[] {
  const workDir = machine.work_dir ?? worktree;
  return buildGateCommand(
    machine,
    gateScript,
    workDir,
    configPath,
    worktree,
    envVars,
  );
}

/**
 * Execute a gate on a remote SSH machine
 *
 * Spawns SSH process, streams output, handles timeouts.
 *
 * @param machine - Machine configuration (must be SSH type)
 * @param gateScript - Path to gate script on remote
 * @param configPath - Path to config file
 * @param worktree - Path to worktree on remote
 * @param options - Execution options
 * @returns Promise resolving to gate result
 */
export function executeRemoteGate(
  machine: MachineConfig,
  gateScript: string,
  configPath: string,
  worktree: string,
  options: RemoteGateOptions = {},
): GateProcess {
  const startTime = Date.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  // Validate machine is SSH
  if (!isSSHMachine(machine)) {
    return failedGate(
      "Machine is not configured for SSH",
      "Invalid machine type: expected SSH machine",
    );
  }

  // Env vars come from gate request files: validate before building the command
  const envErrors = validateEnvVars(options.envVars);
  if (envErrors.length > 0) {
    return failedGate(envErrors.join("\n"), "Invalid gate environment");
  }

  // Build command
  const args = buildSshGateCommand(
    machine,
    gateScript,
    configPath,
    worktree,
    options.envVars,
  );

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  // Spawn SSH process - NEVER use shell: true
  const proc = spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const promise = new Promise<RemoteGateResult>((resolve) => {
    // Notify start callback
    if (options.onStart && proc.pid) {
      options.onStart(proc.pid);
    }

    // Stream stdout
    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });

    // Stream stderr
    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });

    // Handle process errors
    proc.on("error", (err) => {
      const duration = Date.now() - startTime;
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        timedOut: false,
        duration,
        error: `SSH process error: ${err.message}`,
      });
    });

    // Handle process completion
    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      const exitCode = timedOut ? -1 : (code ?? 1);

      resolve({
        success: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        timedOut,
        duration,
        error: timedOut ? `Gate timed out after ${timeout}ms` : undefined,
      });
    });

    // Timeout handling: SIGTERM, then SIGKILL if the child ignores it
    const timeoutTimer = setTimeout(() => {
      if (!hasExited(proc)) {
        timedOut = true;
        terminateWithEscalation(proc, killGraceMs);
      }
    }, timeout);
    proc.on("close", () => clearTimeout(timeoutTimer));
  });

  return {
    pid: proc.pid ?? -1,
    kill: () => terminateWithEscalation(proc, killGraceMs),
    promise,
  };
}

/**
 * Execute a gate on a local machine
 *
 * Runs the gate script directly using spawn.
 */
export function executeLocalGate(
  gateScript: string,
  configPath: string,
  worktree: string,
  options: RemoteGateOptions = {},
): GateProcess {
  const startTime = Date.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  // Env vars come from gate request files: validate before using them
  const envErrors = validateEnvVars(options.envVars);
  if (envErrors.length > 0) {
    return failedGate(envErrors.join("\n"), "Invalid gate environment");
  }

  // Build environment with optional vars
  const env = {
    ...process.env,
    ...options.envVars,
  };

  // Spawn process - commands as argument array, NEVER shell
  const proc = spawn(gateScript, [configPath, worktree], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Notify start callback
  if (options.onStart && proc.pid) {
    options.onStart(proc.pid);
  }

  const promise = new Promise<RemoteGateResult>((resolve) => {
    // Stream stdout
    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });

    // Stream stderr
    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });

    // Handle process errors
    proc.on("error", (err) => {
      const duration = Date.now() - startTime;
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        timedOut: false,
        duration,
        error: `Process error: ${err.message}`,
      });
    });

    // Handle process completion
    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      const exitCode = timedOut ? -1 : (code ?? 1);

      resolve({
        success: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        timedOut,
        duration,
        error: timedOut ? `Gate timed out after ${timeout}ms` : undefined,
      });
    });

    // Timeout handling: SIGTERM, then SIGKILL if the child ignores it
    const timeoutTimer = setTimeout(() => {
      if (!hasExited(proc)) {
        timedOut = true;
        terminateWithEscalation(proc, killGraceMs);
      }
    }, timeout);
    proc.on("close", () => clearTimeout(timeoutTimer));
  });

  return {
    pid: proc.pid ?? -1,
    kill: () => terminateWithEscalation(proc, killGraceMs),
    promise,
  };
}

/**
 * Execute a gate on any machine (local or SSH)
 *
 * Automatically detects machine type and uses the appropriate execution method.
 */
export function executeGate(
  machine: MachineConfig,
  gateScript: string,
  configPath: string,
  worktree: string,
  options: RemoteGateOptions = {},
): GateProcess {
  if (machine.type === "local") {
    return executeLocalGate(gateScript, configPath, worktree, options);
  }

  // SSH machine
  const script = machine.gate_script ?? gateScript;
  return executeRemoteGate(machine, script, configPath, worktree, options);
}
