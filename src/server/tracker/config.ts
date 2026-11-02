/**
 * The `tracker:` block of a project config, validated, with defaults applied.
 * See docs/configuration.md#tracker and docs/design/tracker.md.
 *
 * The tracker is off unless `enabled: true`; then it starts in observe mode
 * (records what it would change, sends nothing) unless `mode: act`. One
 * project may track several repositories, each with its own Projects board
 * and milestone rules; a task goes to the repository its line names
 * (`repo:owner/name`), else to the first whose `match` rule takes it, else
 * to the `default` one.
 */
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { TrackerMode, TrackerStatus } from "../../shared/tracker-types.js";
import { parseAgentsConfig, compileTaskGlob } from "../agents/config.js";
import { parseReviewConfig } from "../review/config.js";

/** Internal status -> the board's option name */
export type StatusMapping = Record<TrackerStatus, string>;

export interface MilestoneRule {
  tasks: RegExp[];
  milestone: string;
}

export interface RepoSettings {
  /** owner/name */
  repo: string;
  default: boolean;
  /** The Projects (v2) board of this repository's issues, if any */
  board: { owner: string; number: number } | null;
  statusField: string;
  statusOptions: StatusMapping;
  agentField: string | null;
  /** Labels every issue Lair creates here gets */
  labels: string[];
  /** Tasks this repository takes when their line names no repository */
  match: { tasks: RegExp[]; agents: string[] };
  milestones: { closeWhenComplete: boolean; rules: MilestoneRule[] };
}

export interface TrackerSettings {
  enabled: boolean;
  mode: TrackerMode;
  repos: RepoSettings[];
  createIssuesForNewTasks: boolean;
  /** A linked task whose line left the tasks file (two reconciles in a row) has its issue closed as not planned; off: recorded as would_close */
  closeRemovedTasks: boolean;
  blockedLabel: string;
  /** The owner's patterns, applied after the built-in redaction */
  redactPatterns: RegExp[];
  reconcileIntervalSeconds: number;
  writeBudgetPerMinute: number;
  requestTimeoutSeconds: number;
  apiUrl: string;
  /** The token: this env var, else this command's output */
  token: { env: string; cmd: string[] | null; from: "tracker" | "review" | "default" };
  /** The repository the review module's PR numbers belong to (review.merged carries only the number) */
  reviewRepo: string | null;
  /** agents.fill's tasks file (absolute), the task lines the tracker follows; null: events only */
  tasksFile: string | null;
  /** The planner's done marker (a done line in the tasks file starts with it) */
  doneMarker: string;
  /** Agents fill starts: their new tasks go to Ready, others to Backlog */
  fillAgents: string[];
  warnings: string[];
}

export type TrackerParseResult = { ok: true; settings: TrackerSettings } | { ok: false; errors: string[] };

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const Label = z.string().min(1).max(50);
const Glob = z.string().min(1).max(200);

const StatusMappingSchema = z
  .object({
    backlog: z.string().min(1).max(100).default("Backlog"),
    ready: z.string().min(1).max(100).default("Ready"),
    in_progress: z.string().min(1).max(100).default("In progress"),
    in_review: z.string().min(1).max(100).default("In review"),
    done: z.string().min(1).max(100).default("Done"),
  })
  .strict();

const RepoSchema = z
  .object({
    repo: z.string().regex(OWNER_REPO, "use owner/name"),
    /** Tasks no rule takes go here */
    default: z.boolean().default(false),
    /** The board: the user or organization that owns it, and its number in the board's URL */
    project: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "a GitHub user or organization name"),
        number: z.number().int().min(1),
      })
      .strict()
      .optional(),
    status_field: z.string().min(1).max(100).default("Status"),
    status_options: StatusMappingSchema.default({}),
    agent_field: z.string().min(1).max(100).optional(),
    labels: z.array(Label).max(20).default([]),
    match: z
      .object({
        /** Task id globs (* and ?) */
        tasks: z.array(Glob).max(50).default([]),
        /** Agent ids */
        agents: z.array(z.string().min(1).max(64)).max(100).default([]),
      })
      .strict()
      .default({}),
    milestones: z
      .object({
        /** Close an open milestone once it has closed issues and no open one; reopen it when one reopens */
        close_when_complete: z.boolean().default(true),
        /** Issues Lair creates for these tasks go in this milestone (an existing one: Lair never creates milestones or sets due dates) */
        rules: z
          .array(z.object({ tasks: z.array(Glob).min(1).max(50), milestone: z.string().min(1).max(200) }).strict())
          .max(50)
          .default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export const TrackerSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    /** Default: the project's `github:` repository, without a board */
    repos: z.array(RepoSchema).max(20).default([]),
    create_issues_for_new_tasks: z.boolean().default(false),
    /** Close the issue of a linked task whose line was removed or commented out by hand (absent two reconciles in a row) */
    close_removed_tasks: z.boolean().default(false),
    blocked_label: Label.default("blocked"),
    /** Regular expressions (case-insensitive) redacted from every text sent to GitHub, after the built-in ones */
    redact_patterns: z.array(z.string().min(1).max(500)).max(50).default([]),
    reconcile_interval_seconds: z.number().int().min(60).max(86_400).default(900),
    write_budget_per_minute: z.number().int().min(1).max(100).default(30),
    request_timeout_seconds: z.number().int().min(1).max(120).default(15),
    /** Default: review.token_env, else GITHUB_TOKEN */
    token_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    /** Default: review.token_cmd */
    token_cmd: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
    api_url: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "must be an https:// URL (the token is sent to it)")
      .default("https://api.github.com"),
  })
  .strict();

type Raw = z.infer<typeof TrackerSchema>;

const DEFAULT_DONE_MARKER = "#done ";

function doneMarkerOf(project: ProjectConfig): string {
  const marker = (project.planner as { done_marker?: unknown } | undefined)?.done_marker;
  return typeof marker === "string" && /^#[A-Za-z0-9_-]{0,30} ?$/.test(marker) ? marker : DEFAULT_DONE_MARKER;
}

/** Validate a project's `tracker:` block (undefined: off). */
export function parseTrackerConfig(raw: unknown, project: ProjectConfig): TrackerParseResult {
  const parsed = TrackerSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `tracker.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const value: Raw = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const redactPatterns: RegExp[] = [];
  value.redact_patterns.forEach((pattern, i) => {
    try {
      redactPatterns.push(new RegExp(pattern, "gi"));
    } catch (e) {
      errors.push(`tracker.redact_patterns[${i}]: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  });

  let rawRepos = value.repos;
  if (rawRepos.length === 0 && value.enabled) {
    if (project.github && OWNER_REPO.test(project.github)) {
      rawRepos = [RepoSchema.parse({ repo: project.github, default: true })];
      warnings.push(`tracker.repos is not set: tracking ${project.github} (the project's github) without a board`);
    } else {
      errors.push("tracker.repos: list at least one repository (owner/name), or set the project's github");
    }
  }
  const seen = new Set<string>();
  for (const r of rawRepos) {
    const key = r.repo.toLowerCase();
    if (seen.has(key)) errors.push(`tracker.repos: ${r.repo} is listed twice`);
    seen.add(key);
  }
  const defaults = rawRepos.filter((r) => r.default);
  if (defaults.length > 1) errors.push(`tracker.repos: only one repository may be the default (${defaults.map((r) => r.repo).join(", ")})`);
  if (value.enabled && rawRepos.length > 1 && defaults.length === 0) {
    warnings.push("tracker.repos: no default repository: a task no match rule takes is not tracked");
  }
  for (const r of rawRepos) {
    if (!r.project && value.enabled) warnings.push(`tracker.repos ${r.repo}: no project (board): its issues are linked and closed, no card moves`);
  }

  const repos: RepoSettings[] = rawRepos.map((r) => ({
    repo: r.repo,
    default: r.default || rawRepos.length === 1,
    board: r.project ? { owner: r.project.owner, number: r.project.number } : null,
    statusField: r.status_field,
    statusOptions: { ...r.status_options },
    agentField: r.agent_field ?? null,
    labels: r.labels,
    match: { tasks: r.match.tasks.map(compileTaskGlob), agents: r.match.agents },
    milestones: {
      closeWhenComplete: r.milestones.close_when_complete,
      rules: r.milestones.rules.map((rule) => ({ tasks: rule.tasks.map(compileTaskGlob), milestone: rule.milestone })),
    },
  }));

  // The token: the tracker's own source, else the review module's (the same repositories, the same account)
  const review = parseReviewConfig(project.review, project);
  let token: TrackerSettings["token"];
  if (value.token_env || value.token_cmd) {
    token = { env: value.token_env ?? "GITHUB_TOKEN", cmd: value.token_cmd ?? null, from: "tracker" };
  } else if (review.ok) {
    token = { env: review.settings.tokenEnv, cmd: review.settings.tokenCmd, from: "review" };
  } else {
    token = { env: "GITHUB_TOKEN", cmd: null, from: "default" };
  }
  const reviewRepo = review.ok && review.settings.repo ? review.settings.repo : project.github && OWNER_REPO.test(project.github) ? project.github : null;

  // The tasks the tracker follows: agents.fill's tasks file (the planner keeps it)
  const agents = parseAgentsConfig(project.agents, project);
  const fill = agents.ok ? agents.settings.fill : null;
  const tasksFile = fill?.tasksFile ? (isAbsolute(fill.tasksFile) ? resolve(fill.tasksFile) : resolve(project.repo, fill.tasksFile)) : null;
  if (value.enabled && !tasksFile) {
    warnings.push("agents.fill.tasks_file is not set: the tracker follows tasks only through events, and a reconcile finds no new task");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      repos,
      createIssuesForNewTasks: value.create_issues_for_new_tasks,
      closeRemovedTasks: value.close_removed_tasks,
      blockedLabel: value.blocked_label,
      redactPatterns,
      reconcileIntervalSeconds: value.reconcile_interval_seconds,
      writeBudgetPerMinute: value.write_budget_per_minute,
      requestTimeoutSeconds: value.request_timeout_seconds,
      apiUrl: value.api_url.replace(/\/+$/, ""),
      token,
      reviewRepo,
      tasksFile,
      doneMarker: doneMarkerOf(project),
      fillAgents: fill?.enabled ? fill.agents : [],
      warnings,
    },
  };
}

/** The board option name of a status */
export function statusToOption(status: TrackerStatus, mapping: StatusMapping): string {
  return mapping[status];
}

/** The status of a board option name (null: not one of Lair's columns) */
export function optionToStatus(option: string, mapping: StatusMapping): TrackerStatus | null {
  const found = (Object.entries(mapping) as [TrackerStatus, string][]).find(([, name]) => name.toLowerCase() === option.toLowerCase());
  return found ? found[0] : null;
}
