#!/usr/bin/env node
/**
 * lair-bus CLI entry point
 *
 * Usage (from the Lair repository root):
 *   npm run --silent bus -- --project <name>
 *   node dist/bus/cli.js --project <name>     (after `npm run build`)
 *
 * The agent's identity comes from the LAIR_AGENT_ID environment variable.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runServer } from "./server.js";
import { loadBusProjectConfig } from "./project-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Look for the config in projects/ under the current directory, then under
 * the package root (two levels up from src/bus/ or dist/bus/).
 */
const CONFIG_ROOTS = [process.cwd(), join(__dirname, "..", "..")];

function parseArgs(args: string[]): { project: string } {
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "-p") {
      project = args[i + 1];
      i++;
    }
  }

  if (!project) {
    throw new Error("Missing required argument: --project <name>");
  }

  return { project };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const agentId = process.env.LAIR_AGENT_ID;

    if (!agentId) {
      throw new Error(
        "LAIR_AGENT_ID environment variable must be set (e.g., kiro-A, orchestrator)",
      );
    }

    const config = loadBusProjectConfig(args.project, CONFIG_ROOTS);

    // Data directory is relative to CWD
    const dataDir = join(process.cwd(), "data");

    // Log startup info to stderr (stdout is for MCP protocol)
    console.error(`lair-bus starting for project "${config.name}"`);
    console.error(`  Agent ID: ${agentId}`);
    console.error(`  Data dir: ${dataDir}`);

    await runServer(config, agentId, dataDir);
  } catch (error) {
    console.error("lair-bus error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
