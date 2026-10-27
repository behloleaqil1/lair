#!/usr/bin/env node
/**
 * lair-node CLI commands (experimental)
 *
 * Usage:
 *   lair-node join <server-url>         - Configure this node for a server
 *   lair-node start [--server <url>] [--foreground] - Run the node daemon
 *   lair-node stop                      - Stop the daemon
 *   lair-node status                    - Show node status
 *   lair-node keygen --out <file>       - Write an Ed25519 key pair for signed gate results
 *   lair-node gate-result submit ...    - Sign a finished gate result and send it to triage
 *                                         (src/cli/gate-result.ts)
 */
import { spawn } from "child_process";
import { closeSync, openSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  loadConfig,
  initializeNode,
  isDaemonRunning,
  isProcessRunning,
  getNodeDir,
  removePidFile,
} from "../node/registration.js";
import { measureCapacity, getSystemInfo } from "../node/capacity.js";
import type { NodeStatusOutput } from "../shared/node-types.js";
import { gateResultCommand, keygenCommand, processIo } from "./gate-result.js";

const DEFAULT_SERVER_URL = "http://localhost:4777";

/**
 * Parse command-line arguments.
 */
function parseArgs(args: string[]): {
  command: string;
  serverUrl?: string;
  token?: string;
  foreground?: boolean;
} {
  const result: ReturnType<typeof parseArgs> = {
    command: args[0] || "help",
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--server" || arg === "-s") {
      result.serverUrl = args[++i];
    } else if (arg === "--foreground" || arg === "-f") {
      result.foreground = true;
    } else if (!arg.startsWith("-") && !result.token) {
      result.token = arg;
    }
  }

  return result;
}

/**
 * Start the node daemon.
 */
async function cmdStart(serverUrl?: string, foreground?: boolean): Promise<void> {
  // Check if already running
  const { running, pid } = isDaemonRunning();
  if (running) {
    console.log(`Node daemon already running (PID: ${pid})`);
    process.exit(1);
  }

  // Load config to verify node is configured
  const config = loadConfig();
  if (!config) {
    console.error("Node not configured. Run 'lair-node join <server-url>' first.");
    process.exit(1);
  }

  const url = serverUrl || config.serverUrl;

  if (foreground) {
    // Run in foreground
    console.log("Starting node daemon in foreground...");
    const { startDaemon } = await import("../node/index.js");
    await startDaemon(url);
  } else {
    // Run as background process: re-run this CLI detached with
    // LAIR_NODE_DAEMON=1, which starts the daemon (see the bottom of this
    // file). process.execArgv carries loader flags (tsx) in development.
    console.log("Starting node daemon in background...");

    const logPath = join(getNodeDir(), "daemon.log");
    const logFd = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--server", url],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          LAIR_NODE_DAEMON: "1",
        },
      },
    );
    closeSync(logFd);

    child.unref();
    console.log(`Node daemon started (PID: ${child.pid}), logging to ${logPath}`);
  }
}

/**
 * Stop the node daemon.
 */
function cmdStop(): void {
  const { running, pid } = isDaemonRunning();

  if (!running) {
    console.log("Node daemon is not running");
    return;
  }

  console.log(`Stopping node daemon (PID: ${pid})...`);

  try {
    process.kill(pid!, "SIGTERM");
    console.log("Stop signal sent");

    // Wait a moment and check if it stopped
    setTimeout(() => {
      if (!isProcessRunning(pid!)) {
        console.log("Node daemon stopped");
        removePidFile();
      } else {
        console.log("Daemon still running, sending SIGKILL...");
        process.kill(pid!, "SIGKILL");
        removePidFile();
      }
    }, 2000);
  } catch (error) {
    console.error("Failed to stop daemon:", error);
    removePidFile();
  }
}

/**
 * Show node status.
 */
function cmdStatus(): void {
  const config = loadConfig();
  const { running, pid } = isDaemonRunning();

  const status: NodeStatusOutput = {
    daemonRunning: running,
    daemonPid: pid,
    nodeId: config?.nodeId,
    serverUrl: config?.serverUrl,
    connectionStatus: !config
      ? "not_configured"
      : running
        ? "connected"
        : "disconnected",
    runningJobs: [],
  };

  // Get capacity if configured
  if (config) {
    status.capacity = measureCapacity(config.nodeId);
  }

  // Print status
  console.log("=== Lair Node Status ===\n");

  if (!config) {
    console.log("Status: NOT CONFIGURED");
    console.log("\nRun 'lair-node join <server-url>' to configure this node.\n");
    return;
  }

  console.log(`Node ID:     ${status.nodeId}`);
  console.log(`Server:      ${status.serverUrl}`);
  console.log(`Config:      ${getNodeDir()}`);
  console.log();

  if (running) {
    console.log(`Daemon:      RUNNING (PID: ${pid})`);
    console.log(`Connection:  ${status.connectionStatus.toUpperCase()}`);
  } else {
    console.log("Daemon:      STOPPED");
    console.log("\nRun 'lair-node start' to start the daemon.\n");
  }

  if (status.capacity) {
    console.log("\n--- Capacity ---");
    console.log(`CPU:         ${status.capacity.cores} cores`);
    console.log(
      `RAM:         ${status.capacity.ramAvailableMb} MB available / ${status.capacity.ramMb} MB total`,
    );
    console.log(
      `Disk:        ${status.capacity.diskAvailableGb} GB available / ${status.capacity.diskGb} GB total`,
    );
    console.log(
      `Load:        ${status.capacity.load1} / ${status.capacity.load5} / ${status.capacity.load15}`,
    );
    console.log(`Container:   ${status.capacity.containerRuntime}`);
  }

  console.log();
}

/**
 * Join a server with a one-time token or URL.
 */
function cmdJoin(tokenOrUrl: string): void {
  if (!tokenOrUrl) {
    console.error("Usage: lair-node join <server-url>");
    console.error("Example: lair-node join http://localhost:4777");
    process.exit(1);
  }

  // For M1, the "token" is just the server URL
  // In later milestones, this will be a one-time registration token
  const serverUrl = tokenOrUrl;

  // Validate URL format
  if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
    // Assume it's a token that needs to be exchanged (future feature)
    console.error(
      "For M1, provide the full server URL (e.g., http://localhost:4777)",
    );
    process.exit(1);
  }

  // Get system info for display
  const systemInfo = getSystemInfo();

  console.log("=== Joining Lair Server ===\n");
  console.log(`Server:      ${serverUrl}`);
  console.log(`Hostname:    ${systemInfo.hostname}`);
  console.log(`OS:          ${systemInfo.os}`);
  console.log(`CPU:         ${systemInfo.cores} cores`);
  console.log(`RAM:         ${systemInfo.ramMb} MB`);
  console.log(`Disk:        ${systemInfo.diskGb} GB`);
  console.log(`Container:   ${systemInfo.containerRuntime}`);
  console.log();

  // Initialize node config
  const config = initializeNode(serverUrl);

  console.log(`Node ID:     ${config.nodeId}`);
  console.log(`Config:      ${getNodeDir()}`);
  console.log();
  console.log("Node configured successfully!");
  console.log("Run 'lair-node start' to start the daemon.");
}

/**
 * Print help.
 */
function cmdHelp(): void {
  console.log(`
lair-node - Manage the lair-node daemon

EXPERIMENTAL: lair-node is a preview. Node keys and job signatures are
placeholders and jobs run a placeholder command. The connection is a plain,
unencrypted WebSocket: the server accepts nodes on its own machine, and
remote nodes only with its LAIR_NODE_TOKEN (sent when LAIR_NODE_TOKEN is set
here). Only use it on a trusted network.

Usage:
  lair-node <command> [options]
  npm run node -- <command> [options]     (from the Lair repository root)

Commands:
  start [--server <url>] [--foreground]
      Start the node daemon in the background (log: ~/.lair/node/daemon.log),
      or in this terminal with --foreground.

  stop
      Stop the node daemon.

  status
      Show node status, capacity, and running jobs.

  join <server-url>
      Configure this node to connect to a lair-server.
      Example: lair-node join http://localhost:4777

  keygen --out <file>
      Write an Ed25519 key pair (<file>, mode 0600, and <file>.pub) for
      signing gate results. Not a placeholder: triage verifies these.

  gate-result submit --key <file> --node <id> --project <id> [options]
      Sign a finished gate result from an existing gate system and send it
      to triage (POST /api/triage/results). See: gate-result submit --help.
      Exit codes: 0 accepted, 1 refused, 2 usage, 3 server unreachable.

Options:
  --server, -s <url>     Server URL to connect to
  --foreground, -f       Run daemon in foreground (for debugging)

Configuration:
  Node configuration is stored in ~/.lair/node/
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  // Commands with their own flags and exit codes (src/cli/gate-result.ts).
  // exitCode, not exit(): stdout may be a pipe that is still being written.
  const argv = process.argv.slice(2);
  if (argv[0] === "keygen") {
    process.exitCode = keygenCommand(argv.slice(1), processIo);
    return;
  }
  if (argv[0] === "gate-result") {
    process.exitCode = await gateResultCommand(argv.slice(1), processIo);
    return;
  }

  const args = parseArgs(argv);

  try {
    switch (args.command) {
      case "start":
        await cmdStart(args.serverUrl, args.foreground);
        break;
      case "stop":
        cmdStop();
        break;
      case "status":
        cmdStatus();
        break;
      case "join":
        cmdJoin(args.token || args.serverUrl || "");
        break;
      case "help":
      case "--help":
      case "-h":
        cmdHelp();
        break;
      default:
        console.error(`Unknown command: ${args.command}`);
        cmdHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run main if this is the entry point
// Check if running as daemon
if (process.env.LAIR_NODE_DAEMON === "1") {
  // Running as daemon, start immediately
  const { startDaemon } = await import("../node/index.js");
  const serverUrl = process.argv.find((_, i) => process.argv[i - 1] === "--server") || DEFAULT_SERVER_URL;
  await startDaemon(serverUrl);
} else {
  // Running as CLI
  main();
}
