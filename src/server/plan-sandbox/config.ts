/**
 * The `plan_sandbox:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#plan-sandbox and docs/design/deploy-aws.md §2.2.
 */
import { z } from "zod";

/** The shortest session AWS STS issues, and the plan role's life in the design (§4.1): 15 minutes */
export const PLAN_ROLE_SECONDS = 900;

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;
const PLAIN_PATH = /^\/[\w@%+=./ -]*$/;
/** Network modes that give the process the host's or an open network instead of a filtering proxy (`container:` fails the name pattern) */
const OPEN_NETWORKS = new Set(["host", "bridge", "default"]);
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

const Schema = z
  .object({
    /** Off unless true */
    enabled: z.boolean().default(false),
    /** The read-only role the plan assumes; the only credentials the sandbox ever holds */
    plan_role_arn: z.string().optional(),
    /** The external id the role's trust policy asks for (not a secret); required when enabled, so the role is never assumed without one */
    external_id: z.string().min(2).max(1224).optional(),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).default("us-east-1"),
    /** Container image with the `tofu` binary and nothing else of yours */
    image: z.string().min(1).optional(),
    /** Absolute path of the provider mirror: providers are installed from here, never downloaded at plan time */
    plugin_dir: z.string().optional(),
    /** Hosts the plan may reach: the provider APIs */
    provider_api_hosts: z.array(z.string().regex(HOST)).default([]),
    /** Hosts the plan may reach: the module and provider registries */
    registry_hosts: z.array(z.string().regex(HOST)).default(["registry.opentofu.org"]),
    /** A container network whose only exit is a proxy that lets the hosts above through; unset or `none` means no network at all. `host`, `bridge` and `default` are refused */
    egress_network: z.string().regex(/^[\w.-]+$/).optional(),
    /** A plan that runs longer is killed; never longer than the role's life */
    timeout_seconds: z.number().int().min(10).max(PLAN_ROLE_SECONDS).default(600),
    max_output_bytes: z.number().int().min(1024).max(4_194_304).default(262_144),
  })
  .strict();

export interface PlanSandboxSettings {
  enabled: boolean;
  planRoleArn: string;
  externalId?: string;
  region: string;
  image: string;
  pluginDir: string;
  providerApiHosts: string[];
  registryHosts: string[];
  egressNetwork?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export type ParseResult = { ok: true; settings: PlanSandboxSettings } | { ok: false; errors: string[] };

/** Validate a project's `plan_sandbox:` block (undefined means disabled). */
export function parsePlanSandboxConfig(raw: unknown): ParseResult {
  const parsed = Schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `plan_sandbox.${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const v = parsed.data;
  const errors: string[] = [];
  if (v.enabled) {
    if (!v.plan_role_arn) errors.push("plan_sandbox.plan_role_arn: required when enabled");
    else if (!ROLE_ARN.test(v.plan_role_arn)) errors.push("plan_sandbox.plan_role_arn: must be an IAM role ARN");
    if (!v.external_id) errors.push("plan_sandbox.external_id: required when enabled (the plan role is never assumed without one)");
    if (!v.image) errors.push("plan_sandbox.image: required when enabled");
    if (!v.plugin_dir) errors.push("plan_sandbox.plugin_dir: required when enabled (providers are never downloaded at plan time)");
  }
  if (v.image !== undefined && !IMAGE.test(v.image)) errors.push("plan_sandbox.image: must be an image reference (letters, digits and . _ / : @ -, not starting with -)");
  if (v.plugin_dir !== undefined) {
    if (!v.plugin_dir.startsWith("/")) errors.push("plan_sandbox.plugin_dir: must be an absolute path");
    else if (!PLAIN_PATH.test(v.plugin_dir) || v.plugin_dir.split("/").includes("..")) errors.push("plan_sandbox.plugin_dir: must be a plain path (no : , .. or other mount syntax)");
  }
  if (v.egress_network !== undefined && OPEN_NETWORKS.has(v.egress_network.toLowerCase())) {
    errors.push("plan_sandbox.egress_network: host, bridge and default give open network access; name a network whose only exit is a filtering proxy, or leave it out");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: v.enabled,
      planRoleArn: v.plan_role_arn ?? "",
      externalId: v.external_id,
      region: v.region,
      image: v.image ?? "",
      pluginDir: v.plugin_dir ?? "",
      providerApiHosts: v.provider_api_hosts,
      registryHosts: v.registry_hosts,
      egressNetwork: v.egress_network && v.egress_network.toLowerCase() !== "none" ? v.egress_network : undefined,
      timeoutSeconds: v.timeout_seconds,
      maxOutputBytes: v.max_output_bytes,
    },
  };
}
