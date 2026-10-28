/**
 * The ops API's tools: their names, what they do, and their arguments. Read
 * tools only in this version (proposals.submit, the one write tool, comes
 * with S2). The server (ops-tools.ts) and the MCP bridge (src/cli/ops-mcp.ts)
 * read this one list, so both check the same arguments; the server's check
 * is the one that counts.
 *
 * Every id an argument names must start with a letter or digit, so no value
 * can read as an option (ROADMAP rule 3), and every list and count is
 * bounded (rule 5).
 */
import { z } from "zod";

export const STATUS_MODULES = ["watchdog", "agents", "triage", "delivery", "pipelines", "review", "planner"] as const;
export type StatusModule = (typeof STATUS_MODULES)[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

const project = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a project name")
  .optional()
  .describe("The project (default: Lair's default project)");
const id = (what: string) => z.string().regex(ID, `${what}: letters, digits and . _ : @ / -, not starting with - (at most 200)`);
const time = (what: string) => z.string().datetime({ offset: true }).optional().describe(what);

export interface OpsToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

export const OPS_TOOLS: readonly OpsToolSpec[] = [
  ...STATUS_MODULES.map(
    (module): OpsToolSpec => ({
      name: `status.${module}`,
      description: `The ${module} module's status for a project: whether it runs, its errors, and what it holds now. Redacted and bounded.`,
      shape: { project },
    }),
  ),
  {
    name: "events.query",
    description:
      "Events in a time range (default: the last 24 hours; at most 7 days), newest first. source agents (default): the agents module's stored events (runs, recoveries, holds, transient errors); source server: the server's recent events in memory. Filter by kinds, agent, task or run.",
    shape: {
      project,
      source: z.enum(["agents", "server"]).optional().describe("agents (default) or server"),
      since: time("ISO time; default 24 hours ago"),
      until: time("ISO time; default now"),
      kinds: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(20).optional().describe("Event kinds, e.g. transient, escalated, fill_held"),
      agent: id("agent").optional(),
      task: id("task").optional(),
      run_id: id("run_id").optional(),
      limit: z.number().int().min(1).max(200).optional().describe("At most 200 (default 50)"),
    },
  },
  {
    name: "decisions.list",
    description: "Decision Inbox items of a project, open ones first: kind, title, options, who raised it, its status. Context redacted and cut.",
    shape: {
      project,
      status: z.enum(["open", "answered", "expired", "withdrawn", "closed", "all"]).optional().describe("Default open"),
      attention: z.enum(["action", "notice"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("At most 100 (default 25)"),
    },
  },
  {
    name: "runs.get",
    description: "An agent run by id (its state, detail, attempts in its chain and its events), or an agent's latest runs.",
    shape: {
      project,
      id: id("id").optional().describe("The run id"),
      agent: id("agent").optional().describe("Instead of id: this agent's latest runs"),
      limit: z.number().int().min(1).max(20).optional().describe("With agent: at most 20 (default 5)"),
    },
  },
  {
    name: "logs.tail",
    description: "The last lines of an agent's log or a gate's log, at most 200, each line redacted (secrets, tokens, URL credentials and paths, ARNs and long digit runs taken out).",
    shape: {
      project,
      agent: id("agent").optional(),
      gate: id("gate").optional(),
      lines: z.number().int().min(1).max(200).optional().describe("At most 200 (default 50)"),
    },
  },
  {
    name: "gates.result",
    description: "A gate's result by id (its steps, verdict and where it ran), or the latest results of the project's gates.",
    shape: {
      project,
      id: id("id").optional().describe("A gate id; without it, the latest results"),
      hours: z.number().int().min(1).max(72).optional().describe("Without id: results of the last N hours (default 24)"),
      limit: z.number().int().min(1).max(50).optional().describe("Without id: at most 50 (default 20)"),
    },
  },
  {
    name: "triage.record",
    description: "Triage's records: one by id, those of a gate, or the latest; each with its verdict, causes and whether it blocks.",
    shape: {
      project,
      id: id("id").optional().describe("A triage record id"),
      gate: id("gate").optional().describe("The records of this gate"),
      limit: z.number().int().min(1).max(50).optional().describe("At most 50 (default 10)"),
    },
  },
  {
    name: "placement.status",
    description: "Placement's status: machines (up, down, load), lanes, queued jobs with their expected finish, and recent moves.",
    shape: { project },
  },
  {
    name: "config.get",
    description: "The project's config, redacted: secrets and tokens replaced, commands' environments removed.",
    shape: { project },
  },
  {
    name: "diagnostics.run",
    description: "Run Lair's self-checks now (the server's and the project's; at most once per 10 s) and return the results with their fixes.",
    shape: { project },
  },
];

export function opsTool(name: string): OpsToolSpec | undefined {
  return OPS_TOOLS.find((t) => t.name === name);
}
