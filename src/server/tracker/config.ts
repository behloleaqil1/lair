/**
 * The `tracker:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#tracker and docs/design/tracker.md.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { TrackerStatus } from "../../shared/tracker-types.js";

/** Maps status field option names to internal status names */
export interface StatusMapping {
  backlog: string;
  ready: string;
  in_progress: string;
  in_review: string;
  done: string;
}

/** Maps risk tiers to GitHub labels */
export interface TierLabels {
  red: string;
  amber: string;
  green: string;
}

export interface MilestoneSettings {
  /** Where milestone names come from: a task label or a plan section */
  from: "label" | "section";
  /** Close the milestone when it has no open issues */
  closeWhenComplete: boolean;
}

export interface TrackerSettings {
  enabled: boolean;
  mode: "off" | "observe" | "act";
  /** GitHub owner/repo (from project.github or tracker.repo) */
  repo: string;
  /** GitHub Projects v2 board */
  project: { owner: string; number: number } | null;
  /** The name of the Status single-select field on the board */
  statusField: string;
  /** Maps internal status names to the board's option names */
  statusOptions: StatusMapping;
  /** The name of the Agent text field on the board (optional) */
  agentField: string | null;
  /** Create issues for new tasks that have no issue */
  createIssuesForNewTasks: boolean;
  /** Default labels to add to created issues */
  defaultLabels: string[];
  /** Maps risk tiers to GitHub labels */
  tierLabels: TierLabels | null;
  /** Milestone settings */
  milestones: MilestoneSettings | null;
  /** Patterns to redact from text sent to GitHub */
  redactPatterns: RegExp[];
  /** How often to run a full reconcile (seconds) */
  reconcileIntervalSeconds: number;
  /** Max writes per minute (GitHub rate limiting) */
  writeBudgetPerMinute: number;
  /** Token source: env var name */
  tokenEnv: string | null;
  /** Token source: command to run */
  tokenCmd: string[] | null;
  /** API URL (for GitHub Enterprise) */
  apiUrl: string;
  warnings: string[];
}

export type TrackerParseResult = { ok: true; settings: TrackerSettings } | { ok: false; errors: string[] };

const Pattern = z.string().min(1).max(500);
const Label = z.string().min(1).max(100);

const StatusMappingSchema = z
  .object({
    backlog: z.string().min(1).max(100).default("Backlog"),
    ready: z.string().min(1).max(100).default("Ready"),
    in_progress: z.string().min(1).max(100).default("In progress"),
    in_review: z.string().min(1).max(100).default("In review"),
    done: z.string().min(1).max(100).default("Done"),
  })
  .strict();

const TierLabelsSchema = z
  .object({
    red: Label.default("tier: red"),
    amber: Label.default("tier: amber"),
    green: Label.default("tier: green"),
  })
  .strict();

const MilestoneSchema = z
  .object({
    from: z.enum(["label", "section"]).default("label"),
    close_when_complete: z.boolean().default(true),
  })
  .strict();

const ProjectSchema = z
  .object({
    owner: z.string().min(1).max(100),
    number: z.number().int().min(1),
  })
  .strict();

const TrackerSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["off", "observe", "act"]).default("off"),
    /** Override the project's github setting */
    repo: z.string().min(1).max(200).optional(),
    project: ProjectSchema.optional(),
    status_field: z.string().min(1).max(100).default("Status"),
    status_options: StatusMappingSchema.default({}),
    agent_field: z.string().min(1).max(100).optional(),
    create_issues_for_new_tasks: z.boolean().default(false),
    labels: z.array(Label).max(20).default([]),
    tier_labels: TierLabelsSchema.optional(),
    milestones: MilestoneSchema.optional(),
    redact_patterns: z.array(Pattern).max(50).default([]),
    reconcile_interval_seconds: z.number().int().min(60).max(86400).default(900),
    write_budget_per_minute: z.number().int().min(1).max(100).default(30),
    token_env: z.string().min(1).max(100).optional(),
    token_cmd: z.array(z.string().min(1).max(1000)).max(10).optional(),
    api_url: z.string().url().default("https://api.github.com"),
  })
  .strict();

type Raw = z.infer<typeof TrackerSchema>;

function compile(pattern: string, where: string, errors: string[]): RegExp | null {
  try {
    return new RegExp(pattern, "gi");
  } catch (e) {
    errors.push(`${where}: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

/**
 * Validate a project's `tracker:` block. Returns settings or errors.
 */
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

  // Repo: from tracker.repo or project.github
  const repo = value.repo ?? project.github;
  if (!repo) {
    errors.push("tracker: repo not set and project.github is empty");
  } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    errors.push(`tracker.repo: ${repo} is not a valid owner/repo`);
  }

  // Project board (optional but needed for status updates)
  let projectConfig: { owner: string; number: number } | null = null;
  if (value.project) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value.project.owner)) {
      errors.push(`tracker.project.owner: ${value.project.owner} is not a valid owner`);
    }
    projectConfig = { owner: value.project.owner, number: value.project.number };
  } else if (value.enabled && value.mode !== "off") {
    warnings.push("tracker.project is not set: status updates will not work");
  }

  // Token: at least one source if enabled
  if (value.enabled && value.mode !== "off" && !value.token_env && !value.token_cmd) {
    warnings.push(
      "tracker: no token source set (token_env or token_cmd); the existing review.token_env/token_cmd will be tried"
    );
  }

  // Redact patterns
  const redactPatterns = value.redact_patterns
    .map((p, i) => compile(p, `tracker.redact_patterns[${i}]`, errors))
    .filter((r): r is RegExp => r !== null);

  // Can't create issues in act mode without a repo
  if (value.create_issues_for_new_tasks && value.mode === "act" && !repo) {
    errors.push("tracker.create_issues_for_new_tasks: requires a repo");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      repo: repo ?? "",
      project: projectConfig,
      statusField: value.status_field,
      statusOptions: {
        backlog: value.status_options.backlog,
        ready: value.status_options.ready,
        in_progress: value.status_options.in_progress,
        in_review: value.status_options.in_review,
        done: value.status_options.done,
      },
      agentField: value.agent_field ?? null,
      createIssuesForNewTasks: value.create_issues_for_new_tasks,
      defaultLabels: value.labels,
      tierLabels: value.tier_labels
        ? { red: value.tier_labels.red, amber: value.tier_labels.amber, green: value.tier_labels.green }
        : null,
      milestones: value.milestones
        ? { from: value.milestones.from, closeWhenComplete: value.milestones.close_when_complete }
        : null,
      redactPatterns,
      reconcileIntervalSeconds: value.reconcile_interval_seconds,
      writeBudgetPerMinute: value.write_budget_per_minute,
      tokenEnv: value.token_env ?? null,
      tokenCmd: value.token_cmd ?? null,
      apiUrl: value.api_url,
      warnings,
    },
  };
}

/** Map internal status to the board's option name */
export function statusToOption(status: TrackerStatus, mapping: StatusMapping): string {
  return mapping[status];
}

/** Map a board option name to internal status */
export function optionToStatus(option: string, mapping: StatusMapping): TrackerStatus | null {
  const entries = Object.entries(mapping) as [TrackerStatus, string][];
  const found = entries.find(([, v]) => v.toLowerCase() === option.toLowerCase());
  return found ? found[0] : null;
}
