#!/usr/bin/env node
/**
 * lair: commands for the agents Lair supervises.
 *
 *   lair review submit --pr <n> --head <sha> --verdict approve|request_changes
 *                      --summary-file <file> [--findings-file <file>]
 *
 * From the Lair repository: `npm run --silent lair -- review submit ...`, or
 * `node dist/cli/lair.js review submit ...` after `npm run build`.
 */
import { EXIT_USAGE, reviewSubmit, USAGE } from "./review-submit.js";

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
  process.stderr.write(`${USAGE}\n`);
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
