/**
 * The `tofu_runner:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#tofu-runner and docs/design/deploy-aws.md §1.2 and §2.6.
 */
import { z } from "zod";

/** The apply role's life in the design (§4.1): 1 hour */
export const APPLY_ROLE_SECONDS = 3600;

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ENV_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLAIN_PATH = /^\/[\w@%+=./ -]*$/;

const Schema = z
  .object({
    /** Off unless true */
    enabled: z.boolean().default(false),
    /** `observe` plans only; `act` also applies an approved plan (design §6) */
    mode: z.enum(["observe", "act"]).default("observe"),
    /** The role that applies; never the plan role */
    apply_role_arn: z.string().optional(),
    external_id: z.string().min(2).max(1224).optional(),
    /** The versioned, encrypted bucket of the project's state: `<project>/<env>/terraform.tfstate` */
    state_bucket: z.string().optional(),
    /** The environments that may be planned and applied, each with its own state file */
    environments: z.array(z.string().regex(ENV_NAME)).max(20).default([]),
    /** Absolute directory where plan files are kept (owner-only, outside any repository) */
    plan_dir: z.string().optional(),
    apply_timeout_seconds: z.number().int().min(60).max(APPLY_ROLE_SECONDS).default(1800),
    /** A plan older than this can no longer be applied; plan again */
    plan_max_age_seconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
  })
  .strict();

export interface TofuRunnerSettings {
  enabled: boolean;
  mode: "observe" | "act";
  applyRoleArn: string;
  externalId?: string;
  stateBucket: string;
  environments: string[];
  planDir: string;
  applyTimeoutSeconds: number;
  planMaxAgeSeconds: number;
}

export type ParseResult = { ok: true; settings: TofuRunnerSettings } | { ok: false; errors: string[] };

export function parseTofuRunnerConfig(raw: unknown): ParseResult {
  const parsed = Schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `tofu_runner.${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const v = parsed.data;
  const errors: string[] = [];
  if (v.enabled) {
    if (!v.apply_role_arn) errors.push("tofu_runner.apply_role_arn: required when enabled");
    else if (!ROLE_ARN.test(v.apply_role_arn)) errors.push("tofu_runner.apply_role_arn: must be an IAM role ARN");
    if (!v.external_id) errors.push("tofu_runner.external_id: required when enabled");
    if (!v.state_bucket) errors.push("tofu_runner.state_bucket: required when enabled");
    if (!v.plan_dir) errors.push("tofu_runner.plan_dir: required when enabled");
    if (v.environments.length === 0) errors.push("tofu_runner.environments: name at least one");
  }
  if (v.state_bucket !== undefined && !BUCKET.test(v.state_bucket)) errors.push("tofu_runner.state_bucket: must be an S3 bucket name");
  if (v.plan_dir !== undefined && (!PLAIN_PATH.test(v.plan_dir) || v.plan_dir.split("/").includes(".."))) {
    errors.push("tofu_runner.plan_dir: must be a plain absolute path");
  }
  if (new Set(v.environments).size !== v.environments.length) errors.push("tofu_runner.environments: names must be unique");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: v.enabled,
      mode: v.mode,
      applyRoleArn: v.apply_role_arn ?? "",
      externalId: v.external_id,
      stateBucket: v.state_bucket ?? "",
      environments: v.environments,
      planDir: v.plan_dir ?? "",
      applyTimeoutSeconds: v.apply_timeout_seconds,
      planMaxAgeSeconds: v.plan_max_age_seconds,
    },
  };
}
