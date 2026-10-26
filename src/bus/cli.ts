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
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { runServer } from "./server.js";
import type { BusProjectConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProjectYaml {
  name: string;
  queue_file: string;
  inbox_file?: string;
  mail_dir?: string;
  wake_file?: string;
}

function loadProjectConfig(projectName: string): BusProjectConfig {
  // Look for config in projects/ relative to the current directory, then
  // relative to the package root. As in the server, a private config in
  // projects/local/ wins over a public one of the same name.
  const searchPaths = [
    join(process.cwd(), "projects", "local", `${projectName}.yaml`),
    join(process.cwd(), "projects", `${projectName}.yaml`),
    join(__dirname, "..", "..", "projects", "local", `${projectName}.yaml`),
    join(__dirname, "..", "..", "projects", `${projectName}.yaml`),
  ];

  for (const configPath of searchPaths) {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const yaml = parseYaml(content) as ProjectYaml;

      return {
        name: yaml.name,
        queue_file: yaml.queue_file,
        inbox_file: yaml.inbox_file,
        mail_dir: yaml.mail_dir,
        wake_file: yaml.wake_file,
      };
    }
  }

  throw new Error(
    `Project config not found: ${projectName}\nSearched: ${searchPaths.join(", ")}`,
  );
}

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

    const config = loadProjectConfig(args.project);

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
