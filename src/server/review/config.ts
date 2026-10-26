/**
 * The `review:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#reviews-and-policy-merge.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { ReviewerOption, ReviewSlot, Tier } from "../../shared/review-types.js";
import { DEFAULT_FILE_KINDS, DEFAULT_RISK_RULES, type RiskRule } from "../policy/risk-rules.js";

const TierSchema = z.enum(["red", "amber", "green"]);
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
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
      })
      .strict(),
  ],
  {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union"
        ? { message: "use human, peer, self or agent:<id>, or {any_of: [...], different_model: true}" }
        : { message: ctx.defaultError },
  },
);

const GateSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("checks"),
      /** Check-run names or commit-status contexts on the git host */
      required: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("signed"),
      /** Gate pipeline ids whose signed results Lair receives (POST /api/review/gate-results) */
      required: z.array(z.string().min(1)).min(1),
      node_keys: z.record(z.string().min(1)),
      pipeline_versions: z.record(z.string().min(1)),
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
    hold_exempt_labels: z.array(z.string().min(1)).default(["revert"]),
  })
  .strict();

const ReviewSchema = z
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
        /** A regular expression with a named group `agent`, matched against the PR's branch */
        branch_pattern: z.string().min(1).optional(),
        /** Agent id -> model, for agents not listed under `dragons:` */
        models: z.record(z.string().min(1)).default({}),
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

export type GateSettings =
  | { source: "checks"; required: string[] }
  | {
      source: "signed";
      required: string[];
      nodeKeys: Record<string, string>;
      pipelineVersions: Record<string, string>;
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
  authors: { branchPattern: RegExp | null; models: Record<string, string> };
  tiers: { default: Tier; rules: RiskRule[]; fileKinds: Record<string, string[]> };
  reviewers: Record<Tier, ReviewSlot[]>;
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
  return { anyOf: value.any_of.map(parseOption), differentModel: value.different_model };
}

function cloneUrlFor(apiUrl: string, repo: string): string {
  const api = new URL(apiUrl);
  const web = api.hostname === "api.github.com" ? "https://github.com" : api.origin;
  return `${web}/${repo}.git`;
}

/** Validate a project's `review:` block (undefined means disabled). */
export function parseReviewConfig(raw: unknown, project: Pick<ProjectConfig, "github">): ParseResult {
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
    try {
      branchPattern = new RegExp(value.authors.branch_pattern);
      if (!value.authors.branch_pattern.includes("(?<agent>")) {
        errors.push("review.authors.branch_pattern: needs a named group (?<agent>...)");
      }
    } catch (e) {
      errors.push(
        `review.authors.branch_pattern: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`,
      );
    }
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

  if (errors.length > 0) return { ok: false, errors };

  const identity = merge?.identity ?? null;
  let gate: GateSettings = { source: "checks", required: [] };
  if (merge) {
    const g = merge.gate;
    gate =
      g.source === "checks"
        ? { source: "checks", required: g.required }
        : {
            source: "signed",
            required: g.required,
            nodeKeys: g.node_keys,
            pipelineVersions: g.pipeline_versions,
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
      authors: { branchPattern, models: value.authors.models },
      tiers: { default: value.tiers.default, rules, fileKinds },
      reviewers,
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
        holdExemptLabels: merge?.hold_exempt_labels ?? ["revert"],
      },
    },
  };
}
