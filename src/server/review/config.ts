/**
 * The `review:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#reviews-and-policy-merge.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { ReviewerOption, ReviewSlot, Tier } from "../../shared/review-types.js";
import { DEFAULT_FILE_KINDS, DEFAULT_RISK_RULES, type RiskRule } from "../policy/risk-rules.js";
import { isValidPromptName, PROMPT_NAME_RULE } from "../agents/prompts.js";
import { ROLE_REF, roleIsSet, type RolePath } from "../ai/profiles.js";
import { compileBranchGlob, type BranchGlob } from "./authors.js";

const TierSchema = z.enum(["red", "amber", "green"]);
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const AgentId = z.string().regex(new RegExp(`^${AGENT_ID}$`), "agent ids use letters, digits, '.', '_' and '-'");
/** An agent id, or `role:<role>`: the agents whose ai.profiles profile is in that role (ai.roles), in its order */
const PoolEntry = z
  .string()
  .regex(
    new RegExp(`^(?:${AGENT_ID}|${ROLE_REF.source.slice(1, -1)})$`),
    "agent ids (letters, digits, '.', '_' and '-'), or role:<role> such as role:review.amber",
  );
/** Reviewer agents the agent assigner may pick from; one `role:<role>` alone stands for a list of it */
const Pool = z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(PoolEntry).min(1).max(50));
const globs = z.array(z.string().min(1));

const RuleSchema = z
  .object({
    id: z.string().regex(RULE_ID, "rule ids use letters, digits, '.', '_' and '-'"),
    tier: TierSchema,
    description: z.string().optional(),
    paths: globs.optional(),
    kinds: z.array(z.string().min(1)).optional(),
    labels: z.array(z.string().min(1)).optional(),
    min_lines: z.number().int().positive().optional(),
    min_files: z.number().int().positive().optional(),
  })
  .strict();

const OptionString = z
  .string()
  .regex(new RegExp(`^(human|peer|self|agent:${AGENT_ID})$`), "use human, peer, self or agent:<id>");

const SlotSchema = z.union(
  [
    OptionString,
    z
      .object({
        any_of: z.array(OptionString).min(1),
        different_model: z.boolean().default(false),
        /** Reviewer agents for this slot (reviews by agents), instead of reviewers_pool.<tier> */
        pool: Pool.optional(),
      })
      .strict(),
  ],
  {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union"
        ? { message: "use human, peer, self or agent:<id>, or {any_of: [...], different_model: true, pool?: [...]}" }
        : { message: ctx.defaultError },
  },
);

/** GitHub Actions' app slug: check runs from any other app don't count unless configured. */
export const DEFAULT_CHECK_APP = "github-actions";

const RequiredCheckSchema = z.union([
  z
    .string()
    .min(1)
    .transform((name) => ({ name, app: DEFAULT_CHECK_APP })),
  z
    .object({
      name: z.string().min(1),
      /** The app that must have created the check run: its slug or numeric id */
      app: z
        .union([z.string().min(1), z.number().int().positive()])
        .transform((app) => String(app))
        .default(DEFAULT_CHECK_APP),
    })
    .strict(),
]);

const PipelineId = z.string().min(1).max(200);

/** A signed gate requirement: a pipeline id, or a group of which any one pipeline passing is enough. */
const GateRequirementSchema = z.union(
  [PipelineId, z.object({ any_of: z.array(PipelineId).min(1).max(50) }).strict()],
  {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union"
        ? { message: "use a pipeline id or {any_of: [pipeline ids]}" }
        : { message: ctx.defaultError },
  },
);

const GateSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("checks"),
      /** Check runs by name, each from an allow-listed app (default GitHub Actions) */
      required: z.array(RequiredCheckSchema).min(1),
      /** Accounts whose commit statuses count; statuses from anyone else are ignored */
      status_creators: z.array(z.string().min(1)).default([]),
    })
    .strict(),
  z
    .object({
      source: z.literal("signed"),
      /**
       * Gate pipeline ids whose signed results Lair receives (POST /api/review/gate-results, or from
       * triage with from_triage): each id must pass; a group {any_of: [ids]} needs one of its ids to pass
       */
      required: z.array(GateRequirementSchema).min(1).max(50),
      node_keys: z.record(z.string().min(1)),
      pipeline_versions: z.record(z.string().min(1)),
      /** Also take the signed results triage accepted for this project (POST /api/triage/results) */
      from_triage: z.boolean().default(false),
    })
    .strict(),
]);

const IdentitySchema = z
  .object({
    name: z.string().min(1),
    email: z.string().regex(/^[^\s@<>]+@[^\s@<>]+$/, "not an email address"),
  })
  .strict();

const MergeSchema = z
  .object({
    gate: GateSchema,
    require_up_to_date: z.boolean().default(true),
    method: z.enum(["auto", "host", "local"]).default("auto"),
    host_method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    local_strategy: z.enum(["ff-only", "squash"]).default("ff-only"),
    /** true when the host account keeps its email private, so host merges are safe to publish */
    host_email_private: z.boolean().optional(),
    identity: IdentitySchema.optional(),
    allowed_emails: z.array(z.string().min(1)).optional(),
    clone_url: z.string().min(1).optional(),
    work_dir: z.string().min(1).optional(),
    hold_when_default_red: z.boolean().default(true),
    /** Labels that let a proven revert merge while the default branch is red (none by default) */
    hold_exempt_labels: z.array(z.string().min(1)).default([]),
    /** An argv run after the policy allows a merge and before it is executed: non-zero refuses the merge */
    check_cmd: z.array(z.string().min(1).max(1000)).min(1).max(50).optional(),
    check_timeout_seconds: z.number().int().min(1).max(3600).default(300),
    /** Merge every PR the policy allows, from the periodic scan of open PRs */
    auto: z.boolean().default(false),
    /** Tiers automatic merge applies to: default is all tiers; an empty array is a config error (use auto: false) */
    auto_tiers: z.array(TierSchema).optional(),
    /** The least time between two automatic merges of the project */
    auto_min_interval_seconds: z.number().int().min(0).max(86_400).default(120),
  })
  .strict();

export const ReviewSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.literal("github").default("github"),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name").optional(),
    api_url: z.string().url().default("https://api.github.com"),
    token_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("GITHUB_TOKEN"),
    token_cmd: z.array(z.string().min(1)).min(1).optional(),
    default_branch: z.string().min(1).optional(),
    authors: z
      .object({
        /** A branch template such as agent/{agent}/** (not a regular expression) */
        branch_pattern: z.string().min(1).max(200).optional(),
        /** Agent id -> model, for agents not listed under `dragons:` */
        models: z.record(z.string().min(1)).default({}),
        /** Branch glob -> agent id, for branches that don't carry the agent id (team/topic) */
        branches: z.record(z.string().min(1).max(200), AgentId).default({}),
        /** Also take a branch's agent from the agents fill tasks file: "(branch: <name>)" or "(<prefix>/<topic>)" */
        from_tasks_file: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** Reviews by agents: the template (a file name in prompts_dir) of a reviewer agent's prompt */
    prompt_file: z.string().min(1).optional(),
    /** Reviewer agents per tier the agent assigner picks a peer from */
    reviewers_pool: z
      .object({ red: Pool.optional(), amber: Pool.optional(), green: Pool.optional() })
      .strict()
      .default({}),
    /** A reviewer run that ends without a review is retried, with backoff, then the owner is asked */
    retries: z
      .object({
        max_attempts: z.number().int().min(1).max(10).default(3),
        backoff_seconds: z.number().int().min(1).max(86_400).default(120),
        max_backoff_seconds: z.number().int().min(1).max(86_400).default(3600),
      })
      .strict()
      .default({}),
    tiers: z
      .object({
        default: TierSchema.default("amber"),
        rules: z.array(RuleSchema).optional(),
        file_kinds: z.record(globs).default({}),
      })
      .strict()
      .default({}),
    reviewers: z
      .object({
        red: z.array(SlotSchema).optional(),
        amber: z.array(SlotSchema).optional(),
        green: z.array(SlotSchema).optional(),
      })
      .strict()
      .default({}),
    integrity: z
      .object({
        enabled: z.boolean().default(true),
        blocking_tiers: z.array(TierSchema).default(["red"]),
        test_files: globs.optional(),
        /** Import prefixes that are the project's own code, besides relative imports (e.g. "@/", "@myorg/") */
        production_imports: z.array(z.string().min(1)).default([]),
        ignore: globs.optional(),
      })
      .strict()
      .default({}),
    merge: MergeSchema.optional(),
  })
  .strict();

/** A required check run: its name, and the app (slug or numeric id) that must have created it. */
export interface RequiredCheck {
  name: string;
  app: string;
}

/** A signed gate requirement: one pipeline that must pass, or a group of which any one passing is enough. */
export type GateRequirement = string | { anyOf: string[] };

/** How a requirement is named in the gate's results and in a refusal's reasons. */
export function requirementName(requirement: GateRequirement): string {
  return typeof requirement === "string" ? requirement : `any of (${requirement.anyOf.join(", ")})`;
}

export type GateSettings =
  | { source: "checks"; required: RequiredCheck[]; statusCreators: string[] }
  | {
      source: "signed";
      required: GateRequirement[];
      nodeKeys: Record<string, string>;
      pipelineVersions: Record<string, string>;
      /** Take the signed results triage accepted for the project too */
      fromTriage: boolean;
    };

export interface MergeSettings {
  gate: GateSettings;
  requireUpToDate: boolean;
  method: "auto" | "host" | "local";
  hostMethod: "squash" | "merge" | "rebase";
  localStrategy: "ff-only" | "squash";
  /** null: unknown */
  hostEmailPrivate: boolean | null;
  identity: { name: string; email: string } | null;
  /** Globs over email addresses that may appear as author or committer of a published commit */
  allowedEmails: string[];
  cloneUrl: string;
  /** Where temporary clones go; relative paths resolve against Lair's working directory */
  workDir: string;
  holdWhenDefaultRed: boolean;
  holdExemptLabels: string[];
  /** Run before a merge is executed: an argv with {pr}, {head}, {base} and {repo}; null: none */
  checkCmd: string[] | null;
  checkTimeoutSeconds: number;
  /** Merge the PRs the policy allows from the periodic scan of open PRs */
  auto: boolean;
  /** Tiers automatic merge applies to; null means all tiers */
  autoTiers: Tier[] | null;
  autoMinIntervalSeconds: number;
}

export interface IntegritySettings {
  enabled: boolean;
  blockingTiers: Tier[];
  testFiles: string[];
  productionImports: string[];
  ignore: string[];
}

/** The parsed `review:` block. */
export interface ReviewSettings {
  enabled: boolean;
  provider: "github";
  repo: string;
  apiUrl: string;
  tokenEnv: string;
  tokenCmd: string[] | null;
  defaultBranch: string | null;
  authors: {
    branchPattern: RegExp | null;
    models: Record<string, string>;
    /** review.authors.branches, in config order */
    branches: BranchGlob[];
    fromTasksFile: boolean;
  };
  tiers: { default: Tier; rules: RiskRule[]; fileKinds: Record<string, string[]> };
  reviewers: Record<Tier, ReviewSlot[]>;
  /** Reviews by agents: on when promptFile is set (and the agents module runs the project) */
  agentReviews: {
    promptFile: string | null;
    pools: Partial<Record<Tier, string[]>>;
    maxAttempts: number;
    backoffSeconds: number;
    maxBackoffSeconds: number;
  };
  integrity: IntegritySettings;
  merge: MergeSettings;
}

export type ParseResult =
  | { ok: true; settings: ReviewSettings }
  | { ok: false; errors: string[] };

/** Reviewers when a project sets none: a human for red, a peer for amber, a self-check for green. */
export const DEFAULT_REVIEWERS: Record<Tier, ReviewSlot[]> = {
  red: [{ anyOf: [{ kind: "human" }], differentModel: false }],
  amber: [{ anyOf: [{ kind: "peer" }], differentModel: false }],
  green: [{ anyOf: [{ kind: "self" }], differentModel: false }],
};

/** Paths the integrity check skips by default: end-to-end suites drive a running app, not imports. */
export const DEFAULT_INTEGRITY_IGNORE = ["**/e2e/**", "**/cypress/**", "**/playwright/**", "*.e2e.*", "*.cy.*"];

/** Noreply addresses are always safe to publish. */
export const NOREPLY_EMAILS = "*@users.noreply.github.com";

function parseOption(value: string): ReviewerOption {
  if (value === "human") return { kind: "human" };
  if (value === "peer") return { kind: "peer" };
  if (value === "self") return { kind: "self" };
  return { kind: "agent", agent: value.slice("agent:".length) };
}

function parseSlot(value: z.infer<typeof SlotSchema>): ReviewSlot {
  if (typeof value === "string") return { anyOf: [parseOption(value)], differentModel: false };
  const slot: ReviewSlot = { anyOf: value.any_of.map(parseOption), differentModel: value.different_model };
  if (value.pool) slot.pool = value.pool;
  return slot;
}

/** Branch names longer than this never match `authors.branch_pattern`. */
export const MAX_BRANCH_LENGTH = 255;

const TEMPLATE_CHARS = /^[A-Za-z0-9._/{}*-]+$/;

/**
 * Compile a branch template such as `agent/{agent}/**` into an anchored
 * regular expression. `{agent}` (exactly once) captures an agent id, `*`
 * matches within one path segment and `**` (at most once) across segments.
 * Everything else is literal, so a template can't be a catastrophic pattern.
 */
export function compileBranchTemplate(template: string): RegExp | string {
  if (!TEMPLATE_CHARS.test(template)) {
    return "use letters, digits, '.', '_', '-', '/', the wildcards * and **, and {agent}";
  }
  if (template.split("{agent}").length !== 2) return "needs {agent} exactly once";
  if (template.split("**").length > 2) return "** may appear at most once";
  let source = "";
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith("{agent}", i)) {
      source += "(?<agent>[A-Za-z0-9][A-Za-z0-9._-]{0,63})";
      i += "{agent}".length - 1;
    } else if (template.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (template[i] === "*") {
      source += "[^/]*";
    } else if (template[i] === "{" || template[i] === "}") {
      return "braces are only for {agent}";
    } else {
      source += template[i] === "." ? "\\." : template[i];
    }
  }
  return new RegExp(`^${source}$`);
}

/** The agent id a branch name carries, per the compiled template; null when it doesn't match or is too long. */
export function agentFromBranch(pattern: RegExp | null, branch: string): string | null {
  if (!pattern || branch.length > MAX_BRANCH_LENGTH) return null;
  return pattern.exec(branch)?.groups?.agent ?? null;
}

/** The placeholders merge.check_cmd may use. */
export const CHECK_PLACEHOLDERS = ["pr", "head", "base", "repo"] as const;

/** What is wrong with a check_cmd: an unknown placeholder, or one in the program's place. */
function checkCommandErrors(argv: string[]): string[] {
  const errors: string[] = [];
  const known: readonly string[] = CHECK_PLACEHOLDERS;
  argv.forEach((arg, index) => {
    for (const match of arg.matchAll(/\{([^{}]*)\}/g)) {
      if (!known.includes(match[1])) {
        errors.push(
          `review.merge.check_cmd.${index}: unknown placeholder {${match[1]}} (use ${known.map((p) => `{${p}}`).join(", ")})`,
        );
      } else if (index === 0) {
        errors.push("review.merge.check_cmd.0: the program is fixed: a placeholder can't be it");
      }
    }
  });
  return errors;
}

function cloneUrlFor(apiUrl: string, repo: string): string {
  const api = new URL(apiUrl);
  const web = api.hostname === "api.github.com" ? "https://github.com" : api.origin;
  return `${web}/${repo}.git`;
}

/** Validate a project's `review:` block (undefined means disabled). */
/**
 * review.reviewers_pool, with a tier that has no pool of its own taking its
 * review role's agents (`role:review.<tier>`) when the project sets that role.
 */
function reviewerPools(
  own: Partial<Record<Tier, string[]>>,
  project: Partial<Pick<ProjectConfig, "ai">>,
): Partial<Record<Tier, string[]>> {
  const pools: Partial<Record<Tier, string[]>> = {};
  for (const tier of ["red", "amber", "green"] as const) {
    const role: RolePath = tier === "red" ? "review.red" : tier === "amber" ? "review.amber" : "review.green";
    const pool = own[tier] ?? (roleIsSet(project, role) ? [`role:${role}`] : undefined);
    if (pool) pools[tier] = pool;
  }
  return pools;
}

export function parseReviewConfig(
  raw: unknown,
  project: Pick<ProjectConfig, "github"> & Partial<Pick<ProjectConfig, "agents" | "ai">>,
): ParseResult {
  const parsed = ReviewSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `review.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  const repo = value.repo ?? project.github;
  if (value.enabled && (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    errors.push("review.repo: set review.repo (or github:) to owner/name");
  }

  let branchPattern: RegExp | null = null;
  if (value.authors.branch_pattern) {
    const compiled = compileBranchTemplate(value.authors.branch_pattern);
    if (typeof compiled === "string") {
      errors.push(`review.authors.branch_pattern: ${compiled} (e.g. agent/{agent}/**)`);
    } else {
      branchPattern = compiled;
    }
  }
  const branches: BranchGlob[] = [];
  const branchEntries = Object.entries(value.authors.branches);
  if (branchEntries.length > 100) errors.push("review.authors.branches: at most 100 entries");
  for (const [glob, agent] of branchEntries.slice(0, 100)) {
    const compiled = compileBranchGlob(glob, agent);
    if (typeof compiled === "string") errors.push(`review.authors.branches."${glob}": ${compiled}`);
    else branches.push(compiled);
  }

  if (value.prompt_file !== undefined) {
    if (!isValidPromptName(value.prompt_file)) {
      errors.push(`review.prompt_file: ${PROMPT_NAME_RULE} (a file directly in prompts_dir)`);
    }
    if (value.enabled && project.agents?.enabled !== true) {
      errors.push("review.prompt_file: reviews by agents need the agents module (agents.enabled: true)");
    }
  }
  const retries = value.retries;
  if (retries.backoff_seconds > retries.max_backoff_seconds) {
    errors.push("review.retries.backoff_seconds: more than max_backoff_seconds");
  }

  // A pool's role:<role> names a role the project sets (ai.roles)
  const unsetRoles = (pool: string[] | undefined, where: string) => {
    for (const entry of pool ?? []) {
      const role = ROLE_REF.exec(entry)?.[1] as RolePath | undefined;
      if (role && !roleIsSet(project, role)) {
        errors.push(`${where}: ${entry} names a role the project doesn't set (ai.roles.${role})`);
      }
    }
  };
  for (const tier of ["red", "amber", "green"] as const) {
    unsetRoles(value.reviewers_pool[tier], `review.reviewers_pool.${tier}`);
    value.reviewers[tier]?.forEach((slot, i) => {
      if (typeof slot !== "string") unsetRoles(slot.pool, `review.reviewers.${tier}[${i}].pool`);
    });
  }

  const fileKinds = { ...DEFAULT_FILE_KINDS, ...value.tiers.file_kinds };
  const rules: RiskRule[] = value.tiers.rules
    ? value.tiers.rules.map((r) => ({
        id: r.id,
        tier: r.tier,
        description: r.description,
        paths: r.paths,
        kinds: r.kinds,
        labels: r.labels,
        minLines: r.min_lines,
        minFiles: r.min_files,
      }))
    : DEFAULT_RISK_RULES;
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) errors.push(`review.tiers.rules: duplicate rule id ${rule.id}`);
    ruleIds.add(rule.id);
    const conditions =
      (rule.paths?.length ?? 0) +
      (rule.kinds?.length ?? 0) +
      (rule.labels?.length ?? 0) +
      (rule.minLines !== undefined ? 1 : 0) +
      (rule.minFiles !== undefined ? 1 : 0);
    if (conditions === 0) {
      errors.push(`review.tiers.rules.${rule.id}: needs paths, kinds, labels, min_lines or min_files`);
    }
    for (const kind of rule.kinds ?? []) {
      if (!fileKinds[kind]) {
        errors.push(
          `review.tiers.rules.${rule.id}: unknown file kind ${kind} (known: ${Object.keys(fileKinds).join(", ")})`,
        );
      }
    }
  }

  const reviewers: Record<Tier, ReviewSlot[]> = {
    red: value.reviewers.red ? value.reviewers.red.map(parseSlot) : DEFAULT_REVIEWERS.red,
    amber: value.reviewers.amber ? value.reviewers.amber.map(parseSlot) : DEFAULT_REVIEWERS.amber,
    green: value.reviewers.green ? value.reviewers.green.map(parseSlot) : DEFAULT_REVIEWERS.green,
  };

  const merge = value.merge;
  if (value.enabled && !merge) {
    errors.push("review.merge.gate: required (a merge needs a passing gate at the head)");
  }
  if (merge && merge.local_strategy === "squash" && merge.method !== "host" && !merge.identity) {
    errors.push("review.merge.identity: required for a local squash merge (the squash commit's author)");
  }
  if (merge?.check_cmd) errors.push(...checkCommandErrors(merge.check_cmd));
  // auto_tiers validation: if set, must not be empty (that's auto: false)
  if (merge?.auto_tiers !== undefined && merge.auto_tiers.length === 0) {
    errors.push("review.merge.auto_tiers: an empty array is a config error; use auto: false instead");
  }

  if (errors.length > 0) return { ok: false, errors };

  const identity = merge?.identity ?? null;
  let gate: GateSettings = { source: "checks", required: [], statusCreators: [] };
  if (merge) {
    const g = merge.gate;
    gate =
      g.source === "checks"
        ? { source: "checks", required: g.required, statusCreators: g.status_creators }
        : {
            source: "signed",
            required: g.required.map((r) => (typeof r === "string" ? r : { anyOf: r.any_of })),
            nodeKeys: g.node_keys,
            pipelineVersions: g.pipeline_versions,
            fromTriage: g.from_triage,
          };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      provider: value.provider,
      repo: repo ?? "",
      apiUrl: value.api_url.replace(/\/+$/, ""),
      tokenEnv: value.token_env,
      tokenCmd: value.token_cmd ?? null,
      defaultBranch: value.default_branch ?? null,
      authors: {
        branchPattern,
        models: value.authors.models,
        branches,
        fromTasksFile: value.authors.from_tasks_file,
      },
      tiers: { default: value.tiers.default, rules, fileKinds },
      reviewers,
      agentReviews: {
        promptFile: value.prompt_file ?? null,
        pools: reviewerPools(value.reviewers_pool, project),
        maxAttempts: retries.max_attempts,
        backoffSeconds: retries.backoff_seconds,
        maxBackoffSeconds: retries.max_backoff_seconds,
      },
      integrity: {
        enabled: value.integrity.enabled,
        blockingTiers: value.integrity.blocking_tiers,
        testFiles: value.integrity.test_files ?? DEFAULT_FILE_KINDS.test,
        productionImports: value.integrity.production_imports,
        ignore: value.integrity.ignore ?? DEFAULT_INTEGRITY_IGNORE,
      },
      merge: {
        gate,
        requireUpToDate: merge?.require_up_to_date ?? true,
        method: merge?.method ?? "auto",
        hostMethod: merge?.host_method ?? "squash",
        localStrategy: merge?.local_strategy ?? "ff-only",
        hostEmailPrivate: merge?.host_email_private ?? null,
        identity,
        allowedEmails:
          merge?.allowed_emails ?? [...(identity ? [identity.email] : []), NOREPLY_EMAILS],
        cloneUrl: merge?.clone_url ?? (repo ? cloneUrlFor(value.api_url, repo) : ""),
        workDir: merge?.work_dir ?? "data/review",
        holdWhenDefaultRed: merge?.hold_when_default_red ?? true,
        holdExemptLabels: merge?.hold_exempt_labels ?? [],
        checkCmd: merge?.check_cmd ?? null,
        checkTimeoutSeconds: merge?.check_timeout_seconds ?? 300,
        auto: merge?.auto ?? false,
        autoTiers: merge?.auto_tiers ?? null,
        autoMinIntervalSeconds: merge?.auto_min_interval_seconds ?? 120,
      },
    },
  };
}
