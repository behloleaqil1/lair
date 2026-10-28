/**
 * The `planner:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#planner and docs/design/planner.md.
 */
import { realpathSync } from "fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "path";
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import { PLANNER_OPS, type PlannerMode, type PlannerOp } from "../../shared/planner-types.js";
import {
  DEFAULT_BLOCKED_PATTERN,
  DEFAULT_DONE_PATTERN,
  DEFAULT_WAITING_PATTERN,
  matchesByAgent,
  parseAgentsConfig,
} from "../agents/config.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getPromptsDir } from "../routes/controls.js";
import { knownDragonIds } from "../services/dragon-registry.js";
import { placeholdersIn } from "../watchdog/config.js";

/** The most bytes and lines a plan or backlog file may be read with */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_LINES = 100_000;

/** `<id>: text`: the id ends at the colon and must look like a task id */
export const DEFAULT_ID_PATTERN = "^(?<id>[A-Za-z0-9][A-Za-z0-9._/#-]{0,127}):\\s";
/** A heading "Phase 2 ..." or "Phase 2: ..." */
export const DEFAULT_PHASE_PATTERN = "^Phase\\s+(?<phase>[A-Za-z0-9][A-Za-z0-9.]{0,15})\\b";
/** "depends on A-1, A-2 and B-3": a list of ids, separated by ",", "and" or "&" */
export const DEFAULT_DEPENDS_PATTERN =
  "\\bdepends on:?\\s+([A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}(?:\\s*(?:,|and|&)\\s*[A-Za-z0-9][A-Za-z0-9._/#:-]{0,127}){0,19})";

/**
 * BLOCKED reasons that need the owner (checked first, case-insensitively):
 * approvals, decisions, credentials, accounts, money, legal.
 */
export const DEFAULT_OWNER_PATTERNS = [
  "\\bowner\\b",
  "\\bapprov(e|al|ed|es)\\b",
  "\\b(decision|decide|sign[- ]?off)\\b",
  "\\b(credentials?|api[ _-]?keys?|secrets?|passwords?)\\b",
  "\\b(account|billing|payment|pricing|legal|licen[cs]e|contract)s?\\b",
];

/**
 * BLOCKED reasons that are the environment's (checked next): permissions,
 * disk, memory, containers, network, timeouts, load, locks, stuck runners.
 * Anything else is a task problem.
 */
export const DEFAULT_ENVIRONMENT_PATTERNS = [
  "\\bpermission denied\\b",
  "\\b(EACCES|EPERM|ENOSPC|ENOMEM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\\b",
  "\\b(no space left|disk (is )?full|out of memory|oom(-?killed)?)\\b",
  "\\b(docker|daemon|container engine)\\b",
  "\\b(connection (refused|reset)|network|dns|unreachable|offline)\\b",
  "\\btimed? ?out\\b",
  "\\b(load|cpu)\\b.{0,20}\\b(above|over|too high|high)\\b",
  "\\bload\\s*[<>]",
  "\\b(lock|locked|lockfile)\\b",
  "\\bstuck\\b",
  "\\b(runner|machine|node|host)s? (is |are )?(down|offline|busy|unavailable)\\b",
  "\\b(rate[ -]?limit(ed)?|quota)\\b",
];

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const Pattern = z.string().min(1).max(500);
const Paths = z.array(z.string().min(1).max(4096)).min(1).max(20);
const Name = z.string().regex(SAFE_NAME, "source names use lowercase letters, digits, '_' and '-'");
const Approval = z.enum(["never", "always"]);

const PlanSourceSchema = z
  .object({
    kind: z.literal("markdown_plan"),
    name: Name.optional(),
    paths: Paths,
    id_pattern: Pattern.default(DEFAULT_ID_PATTERN),
    phase_pattern: Pattern.default(DEFAULT_PHASE_PATTERN),
    depends_pattern: Pattern.default(DEFAULT_DEPENDS_PATTERN),
    max_bytes: z.number().int().min(1).max(MAX_SOURCE_BYTES).default(1024 * 1024),
    max_lines: z.number().int().min(1).max(MAX_SOURCE_LINES).default(20_000),
  })
  .strict();

const BacklogSourceSchema = z
  .object({
    kind: z.literal("backlog_file"),
    name: Name.optional(),
    paths: Paths,
    /** checklist: `- [ ] id: text`; list: any list item; table: any table row (not the header) */
    format: z.enum(["checklist", "list", "table"]).default("checklist"),
    id_pattern: Pattern.default(DEFAULT_ID_PATTERN),
    depends_pattern: Pattern.default(DEFAULT_DEPENDS_PATTERN),
    /** list and table formats: an item that matches is done */
    done_pattern: Pattern.optional(),
    /** table format: the 1-based column the id is read from */
    id_column: z.number().int().min(1).max(20).default(1),
    max_bytes: z.number().int().min(1).max(MAX_SOURCE_BYTES).default(1024 * 1024),
    max_lines: z.number().int().min(1).max(MAX_SOURCE_LINES).default(20_000),
  })
  .strict();

const OwnerSourceSchema = z
  .object({
    kind: z.literal("owner_messages"),
    name: Name.optional(),
    /** `- OWNER <time> [<id>]: <text>` lines; default: inbox_file */
    path: z.string().min(1).max(4096).optional(),
    /** `- REPLY <id> ...` lines; default: outbox_file */
    replies_path: z.string().min(1).max(4096).optional(),
    max_messages: z.number().int().min(1).max(200).default(20),
    /** Each file's last this many bytes are read */
    max_bytes: z.number().int().min(1024).max(MAX_SOURCE_BYTES).default(256 * 1024),
  })
  .strict();

const QueueSourceSchema = z
  .object({
    kind: z.literal("queue_events"),
    name: Name.optional(),
    /** default: queue_file */
    path: z.string().min(1).max(4096).optional(),
    max_events: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

const SourceSchema = z.discriminatedUnion("kind", [PlanSourceSchema, BacklogSourceSchema, OwnerSourceSchema, QueueSourceSchema]);

const AgentSchema = z
  .object({
    /** The planner agent: a known agent, not one fill starts */
    id: z.string(),
    /** Its prompt template, inside prompts_dir; {prompts_dir}, {agent} and {task} are replaced */
    prompt_file: z.string().min(1).max(4096),
    min_interval_seconds: z.number().int().min(0).max(86_400).default(600),
    debounce_seconds: z.number().int().min(0).max(3600).default(60),
    max_proposals: z.number().int().min(1).max(50).default(10),
    /** Planner runs started in any 24 hours, whatever triggers them */
    max_runs_per_day: z.number().int().min(1).max(1000).default(24),
  })
  .strict();

const VerifierSchema = z
  .object({
    /** The verifier agent: a known agent, not one fill starts, not the planner agent */
    id: z.string(),
    /** Its prompt template, inside prompts_dir */
    prompt_file: z.string().min(1).max(4096),
    /** Verifier runs started in any 24 hours */
    max_runs_per_day: z.number().int().min(1).max(1000).default(48),
    /** Ops that skip verification and proceed straight to approval rules */
    skip_ops: z.array(z.enum(PLANNER_OPS)).default(["finish"]),
  })
  .strict();

const PlannerSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: z.number().int().min(1).max(3600).default(60),
    /** Must be agents.fill.tasks_file (the default) */
    tasks_file: z.string().min(1).max(4096).optional(),
    /** A done line is this followed by the line; it must start with "#", so fill reads it as a comment */
    done_marker: z
      .string()
      .regex(/^#[A-Za-z0-9_-]{0,30} ?$/, "a '#', then up to 30 letters, digits, '_' or '-', then an optional space")
      .default("#done "),
    /** all: every line; lair_runs: only tasks the agents module ran; off */
    mark_done: z.enum(["all", "lair_runs", "off"]).default("all"),
    drop_plan_done: z.boolean().default(true),
    /** Each planner run's directory (context.json, proposals.json); {agents_dir} and {repo} are replaced */
    work_dir: z.string().min(1).max(4096).default("{agents_dir}/lair-planner"),
    /** Directories sources may be read from, besides repo and agents_dir */
    roots: z.array(z.string().min(1).max(4096)).max(20).default([]),
    sources: z.array(SourceSchema).max(20).default([]),
    agent: AgentSchema.optional(),
    verifier: VerifierSchema.optional(),
    approval: z
      .object({
        add: Approval.default("never"),
        // A done line the queue reports is the rules' job: a finish of the planner's own has no such evidence
        finish: Approval.default("always"),
        reassign: Approval.default("always"),
        reword: Approval.default("never"),
        drop: Approval.default("always"),
        // An unblock starts again work fill held: the owner sees each one
        unblock: Approval.default("always"),
      })
      .strict()
      .default({}),
    /** Planner runs per blocked task; then the owner decides */
    attempts_per_task: z.number().int().min(1).max(20).default(2),
    /** Planner runs that fail in a row before runs pause and the owner is asked */
    max_failed_runs: z.number().int().min(1).max(20).default(3),
    blocked: z
      .object({
        owner_patterns: z.array(Pattern).max(50).default(DEFAULT_OWNER_PATTERNS),
        environment_patterns: z.array(Pattern).max(50).default(DEFAULT_ENVIRONMENT_PATTERNS),
      })
      .strict()
      .default({}),
    context_max_bytes: z.number().int().min(4096).max(150_000).default(64_000),
    /** An extra rule for the task ids proposals may name (fill's rules always apply) */
    task_id_pattern: Pattern.optional(),
  })
  .strict();

type Raw = z.infer<typeof PlannerSchema>;

export interface PlanSourceSettings {
  kind: "markdown_plan" | "backlog_file";
  name: string;
  paths: string[];
  format: "markdown" | "checklist" | "list" | "table";
  idPattern: RegExp;
  phasePattern: RegExp | null;
  dependsPattern: RegExp | null;
  donePattern: RegExp | null;
  idColumn: number;
  maxBytes: number;
  maxLines: number;
}

export interface OwnerSourceSettings {
  kind: "owner_messages";
  name: string;
  path: string;
  repliesPath: string | null;
  /** The path is the project's own inbox_file (checked against its own directory) */
  projectFile: boolean;
  maxMessages: number;
  maxBytes: number;
}

export interface QueueSourceSettings {
  kind: "queue_events";
  name: string;
  path: string;
  projectFile: boolean;
  maxEvents: number;
}

export type SourceSettings = PlanSourceSettings | OwnerSourceSettings | QueueSourceSettings;

export interface PlannerAgentSettings {
  id: string;
  promptFile: string;
  minIntervalSeconds: number;
  debounceSeconds: number;
  maxProposals: number;
  maxRunsPerDay: number;
}

export interface VerifierAgentSettings {
  id: string;
  promptFile: string;
  maxRunsPerDay: number;
  /** Ops that skip verification and proceed straight to approval rules */
  skipOps: PlannerOp[];
}

export interface PlannerSettings {
  enabled: boolean;
  mode: PlannerMode;
  intervalSeconds: number;
  /** Absolute: agents.fill.tasks_file */
  tasksFile: string;
  doneMarker: string;
  markDone: "all" | "lair_runs" | "off";
  dropPlanDone: boolean;
  /** Absolute */
  workDir: string;
  /** Absolute: repo, agents_dir, then planner.roots */
  roots: string[];
  sources: SourceSettings[];
  agent: PlannerAgentSettings | null;
  verifier: VerifierAgentSettings | null;
  approval: Record<PlannerOp, "never" | "always">;
  attemptsPerTask: number;
  maxFailedRuns: number;
  blocked: { owner: RegExp[]; environment: RegExp[] };
  contextMaxBytes: number;
  taskIdPattern: RegExp | null;
  /** agents.fill.agents: the agents proposals may name */
  allowlist: string[];
  /** agents.fill's done, waiting and blocked patterns (fill's done check reads them) */
  fillPatterns: { donePattern: string; waitingPattern: string; blockedPattern: string };
  /** Fill's patterns match by agent: one open line per agent, as fill parses the file */
  onePerAgent: boolean;
  /** agents.fill.enabled: fill runs the allowlisted agents' lines (and holds their BLOCKED runs for the owner) */
  fillEnabled: boolean;
  /** Not errors: the planner runs, but the owner should know */
  warnings: string[];
}

export type PlannerParseResult = { ok: true; settings: PlannerSettings } | { ok: false; errors: string[] };

const abs = (repo: string, path: string) => (isAbsolute(path) ? resolve(path) : resolve(repo, path));

function compile(pattern: string, flags: string, where: string, errors: string[]): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    errors.push(`${where}: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

/** How many capture groups a pattern has. */
function groupCount(pattern: RegExp): number {
  const match = new RegExp(`${pattern.source}|`, pattern.flags.replace("g", "")).exec("");
  return match ? match.length - 1 : 0;
}

function needsGroup(pattern: RegExp | null, name: string, where: string, errors: string[]): void {
  if (!pattern) return;
  if (!pattern.source.includes(`(?<${name}>`) && groupCount(pattern) === 0) {
    errors.push(`${where}: needs a named group (?<${name}>...) or a capture group`);
  }
}

/** The real path of `path`, or its nearest existing parent's real path joined with the rest. */
export function realish(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length > 0 ? resolve(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Validate a project's `planner:` block (undefined means off). It needs the
 * project's agents block: the tasks file, the allowlist and done_pattern are
 * fill's, and the planner agent runs through the agents module.
 */
export function parsePlannerConfig(raw: unknown, project: ProjectConfig): PlannerParseResult {
  const parsed = PlannerSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `planner.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const value: Raw = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const agents = parseAgentsConfig(project.agents, project);
  const fill = agents.ok ? agents.settings.fill : null;
  if (value.enabled) {
    if (!agents.ok) errors.push("planner: the agents block has errors, see GET /api/agents/status");
    else if (!agents.settings.enabled) errors.push("planner.enabled: the planner needs agents.enabled: true");
    if (agents.ok && !fill?.tasksFile) errors.push("planner: agents.fill.tasks_file must be set (the planner keeps that file)");
  }
  const tasksFile = fill?.tasksFile ? abs(project.repo, fill.tasksFile) : "";
  if (value.tasks_file !== undefined && tasksFile !== "" && abs(project.repo, value.tasks_file) !== tasksFile) {
    errors.push(`planner.tasks_file: must be agents.fill.tasks_file (${tasksFile})`);
  }

  const allowlist = fill?.agents ?? [];
  const fillPatterns = {
    donePattern: fill?.donePattern ?? DEFAULT_DONE_PATTERN,
    waitingPattern: fill?.waitingPattern ?? DEFAULT_WAITING_PATTERN,
    blockedPattern: fill?.blockedPattern ?? DEFAULT_BLOCKED_PATTERN,
  };
  const known = knownDragonIds(project);
  let agent: PlannerAgentSettings | null = null;
  if (value.agent) {
    const a = value.agent;
    if (!isValidDragonId(a.id)) errors.push(`planner.agent.id: ${a.id || "(empty)"} is not a valid agent id`);
    else if (!known.has(a.id)) errors.push(`planner.agent.id: ${a.id} is not one of the project's agents`);
    if (allowlist.includes(a.id)) {
      errors.push(`planner.agent.id: ${a.id} is in agents.fill.agents: the planner agent must not be an agent fill starts`);
    }
    if (a.prompt_file.split(/[\\/]/).includes("..")) {
      errors.push('planner.agent.prompt_file: a ".." segment is refused (it stays inside prompts_dir)');
    }
    for (const name of placeholdersIn([a.prompt_file])) {
      if (!["prompts_dir", "agent", "task"].includes(name)) {
        errors.push(`planner.agent.prompt_file: unknown placeholder {${name}} (allowed: {prompts_dir}, {agent}, {task})`);
      }
    }
    agent = {
      id: a.id,
      promptFile: a.prompt_file,
      minIntervalSeconds: a.min_interval_seconds,
      debounceSeconds: a.debounce_seconds,
      maxProposals: a.max_proposals,
      maxRunsPerDay: a.max_runs_per_day,
    };
  }

  let verifier: VerifierAgentSettings | null = null;
  if (value.verifier) {
    const v = value.verifier;
    if (!isValidDragonId(v.id)) errors.push(`planner.verifier.id: ${v.id || "(empty)"} is not a valid agent id`);
    else if (!known.has(v.id)) errors.push(`planner.verifier.id: ${v.id} is not one of the project's agents`);
    if (allowlist.includes(v.id)) {
      errors.push(`planner.verifier.id: ${v.id} is in agents.fill.agents: the verifier agent must not be an agent fill starts`);
    }
    if (agent && v.id === agent.id) {
      errors.push(`planner.verifier.id: ${v.id} is the planner agent: the verifier must be a different agent`);
    }
    if (v.prompt_file.split(/[\\/]/).includes("..")) {
      errors.push('planner.verifier.prompt_file: a ".." segment is refused (it stays inside prompts_dir)');
    }
    for (const name of placeholdersIn([v.prompt_file])) {
      if (!["prompts_dir", "agent", "task"].includes(name)) {
        errors.push(`planner.verifier.prompt_file: unknown placeholder {${name}} (allowed: {prompts_dir}, {agent}, {task})`);
      }
    }
    verifier = {
      id: v.id,
      promptFile: v.prompt_file,
      maxRunsPerDay: v.max_runs_per_day,
      skipOps: v.skip_ops,
    };
  }

  for (const name of placeholdersIn([value.work_dir])) {
    if (!["agents_dir", "repo"].includes(name)) {
      errors.push(`planner.work_dir: unknown placeholder {${name}} (allowed: {agents_dir}, {repo})`);
    }
  }
  const workDir = abs(
    project.repo,
    value.work_dir.replace(/\{(agents_dir|repo)\}/g, (_m, name: string) => (name === "agents_dir" ? project.agents_dir : project.repo)),
  );
  const roots = [resolve(project.repo), abs(project.repo, project.agents_dir), ...value.roots.map((r) => abs(project.repo, r))];

  // Sources: unique names, one owner_messages and one queue_events source at most
  const sources: SourceSettings[] = [];
  const names = new Set<string>();
  const kindCount = new Map<string, number>();
  value.sources.forEach((source, i) => {
    const where = `planner.sources[${i}]`;
    const count = (kindCount.get(source.kind) ?? 0) + 1;
    kindCount.set(source.kind, count);
    const name = source.name ?? (count === 1 ? source.kind.replace(/_/g, "-") : `${source.kind.replace(/_/g, "-")}-${count}`);
    if (names.has(name)) errors.push(`${where}.name: ${name} is used by another source`);
    names.add(name);
    switch (source.kind) {
      case "markdown_plan":
      case "backlog_file": {
        const idPattern = compile(source.id_pattern, "", `${where}.id_pattern`, errors);
        needsGroup(idPattern, "id", `${where}.id_pattern`, errors);
        const dependsPattern = compile(source.depends_pattern, "gi", `${where}.depends_pattern`, errors);
        needsGroup(dependsPattern, "ids", `${where}.depends_pattern`, errors);
        const phasePattern =
          source.kind === "markdown_plan" ? compile(source.phase_pattern, "i", `${where}.phase_pattern`, errors) : null;
        needsGroup(phasePattern, "phase", `${where}.phase_pattern`, errors);
        const donePattern =
          source.kind === "backlog_file" && source.done_pattern
            ? compile(source.done_pattern, "i", `${where}.done_pattern`, errors)
            : null;
        if (source.kind === "backlog_file" && source.format !== "checklist" && !source.done_pattern) {
          warnings.push(`${where}: format ${source.format} without done_pattern: every item counts as open`);
        }
        if (idPattern && dependsPattern) {
          sources.push({
            kind: source.kind,
            name,
            paths: source.paths.map((p) => abs(project.repo, p)),
            format: source.kind === "markdown_plan" ? "markdown" : source.format,
            idPattern,
            phasePattern,
            dependsPattern,
            donePattern,
            idColumn: source.kind === "backlog_file" ? source.id_column : 1,
            maxBytes: source.max_bytes,
            maxLines: source.max_lines,
          });
        }
        break;
      }
      case "owner_messages": {
        if (count > 1) errors.push(`${where}: only one owner_messages source`);
        const path = source.path ?? project.inbox_file;
        if (!path) {
          errors.push(`${where}.path: set it, or set the project's inbox_file`);
          break;
        }
        const replies = source.replies_path ?? project.outbox_file ?? null;
        sources.push({
          kind: "owner_messages",
          name,
          path: abs(project.repo, path),
          repliesPath: replies ? abs(project.repo, replies) : null,
          projectFile: source.path === undefined,
          maxMessages: source.max_messages,
          maxBytes: source.max_bytes,
        });
        break;
      }
      case "queue_events": {
        if (count > 1) errors.push(`${where}: only one queue_events source`);
        sources.push({
          kind: "queue_events",
          name,
          path: abs(project.repo, source.path ?? project.queue_file),
          projectFile: source.path === undefined,
          maxEvents: source.max_events,
        });
        break;
      }
    }
  });

  const owner = value.blocked.owner_patterns
    .map((p, i) => compile(p, "i", `planner.blocked.owner_patterns[${i}]`, errors))
    .filter((r): r is RegExp => r !== null);
  const environment = value.blocked.environment_patterns
    .map((p, i) => compile(p, "i", `planner.blocked.environment_patterns[${i}]`, errors))
    .filter((r): r is RegExp => r !== null);
  const taskIdPattern = value.task_id_pattern ? compile(value.task_id_pattern, "", "planner.task_id_pattern", errors) : null;

  // Files whoever can write chooses what the agents work on: keep them out of the repo the agents work in
  if (value.enabled) {
    const repo = realish(project.repo);
    if (tasksFile && isInside(repo, realish(tasksFile))) {
      warnings.push(`the tasks file ${tasksFile} is inside the repository the agents work in: keep it where they can't write`);
    }
    const promptsDir = getPromptsDir(project);
    if (agent && isInside(repo, realish(promptsDir))) {
      warnings.push(`prompts_dir ${promptsDir} is inside the repository the agents work in: the planner agent's prompt template is there`);
    }
    if (isInside(repo, realish(workDir))) {
      warnings.push(`planner.work_dir ${workDir} is inside the repository: planner runs would show up in git status`);
    }
    // What the planner reads is only as trustworthy as whoever can write it
    for (const source of sources) {
      const paths = "paths" in source ? source.paths : [source.path];
      const inRepo = paths.filter((p) => isInside(repo, realish(p)));
      if (inRepo.length === 0) continue;
      if (source.kind === "markdown_plan" || source.kind === "backlog_file") {
        warnings.push(
          `source ${source.name}: ${inRepo.join(", ")} is inside the repository the agents work in: an agent can change what the planner reads${
            value.drop_plan_done ? ", and drop a task from the tasks file by ticking it [x] (drop_plan_done)" : ""
          }`,
        );
      } else if (source.kind === "owner_messages") {
        warnings.push(`source ${source.name}: ${inRepo.join(", ")} is inside the repository the agents work in: an agent can write "owner" messages`);
      }
    }
    if (!agent) warnings.push("planner.agent is not set: only the deterministic part runs (no planner agent)");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      intervalSeconds: value.interval_seconds,
      tasksFile,
      doneMarker: value.done_marker,
      markDone: value.mark_done,
      dropPlanDone: value.drop_plan_done,
      workDir,
      roots,
      sources,
      agent,
      verifier,
      approval: Object.fromEntries(PLANNER_OPS.map((op) => [op, value.approval[op]])) as Record<PlannerOp, "never" | "always">,
      attemptsPerTask: value.attempts_per_task,
      maxFailedRuns: value.max_failed_runs,
      blocked: { owner, environment },
      contextMaxBytes: value.context_max_bytes,
      taskIdPattern,
      allowlist,
      fillPatterns,
      onePerAgent: matchesByAgent(fillPatterns),
      fillEnabled: fill?.enabled === true,
      warnings,
    },
  };
}
