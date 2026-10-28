#!/usr/bin/env node
/**
 * lair: commands for the agents Lair supervises.
 *
 *   lair review submit --pr <n> --head <sha> --verdict approve|request_changes
 *                      --summary-file <file> [--findings-file <file>]
 *   lair ops-mcp       Lair's read-only ops API as an MCP server over stdio
 *                      (LAIR_OPS_TOKEN, LAIR_URL)
 *   lair ops call <tool> [--args <json>]
 *                      one ops tool, its answer printed as JSON (LAIR_OPS_TOKEN, LAIR_URL)
 *   lair supervisor answer --conversation <id> --file <markdown> [--evidence-file <json>]
 *                      a supervisor run's answer, once (LAIR_OPS_TOKEN, LAIR_URL)
 *
 * From the Lair repository: `npm run --silent lair -- review submit ...`, or
 * `node dist/cli/lair.js review submit ...` after `npm run build`.
 */
import { EXIT_USAGE, reviewSubmit, USAGE } from "./review-submit.js";
import { OPS_MCP_USAGE, runOpsMcp } from "./ops-mcp.js";
import { OPS_CALL_USAGE, opsCall } from "./ops-call.js";
import { ANSWER_USAGE, supervisorAnswer } from "./supervisor-answer.js";

async function main(argv: string[]): Promise<number> {
  const [command, subcommand, ...rest] = argv;
  if (command === "review" && subcommand === "submit") {
    return reviewSubmit(rest, {
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (command === "ops-mcp" && subcommand === undefined) {
    return runOpsMcp({
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (command === "ops" && subcommand === "call") {
    return opsCall(rest, {
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  if (command === "supervisor" && subcommand === "answer") {
    return supervisorAnswer(rest, {
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  }
  process.stderr.write(`${USAGE}\n\n${OPS_MCP_USAGE}\n\n${OPS_CALL_USAGE}\n\n${ANSWER_USAGE}\n`);
  return EXIT_USAGE;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`lair: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 3;
  },
);
