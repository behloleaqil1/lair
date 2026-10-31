/**
 * The `infra_policy:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#infrastructure-policy-scan and docs/design/deploy-aws.md §2.1.
 */
import { z } from "zod";

const AllowEntry = z
  .object({
    /** One of `roots` */
    root: z.string().min(1),
    /** The block's address, e.g. `data.http.health` or `module.net.null_resource.notify` */
    address: z.string().min(1),
    /** The hash of the block's content, as the scan reports it; an edited block no longer matches */
    hash: z.string().regex(/^[0-9a-f]{64}$/, "must be the 64-character hash the scan reports"),
  })
  .strict();

const Schema = z
  .object({
    /** The scan is off unless this is true */
    enabled: z.boolean().default(false),
    /** Absolute paths of infrastructure code directories (the roots that are scanned) */
    roots: z.array(z.string().min(1)).default([]),
    /** Provider sources that may be used, e.g. `hashicorp/aws` */
    allowed_providers: z.array(z.string().min(1)).default([]),
    /** Module sources that may be used: an exact source, or a prefix ending in `/`. Local `./` modules inside the root are always scanned and need no entry */
    allowed_modules: z.array(z.string().min(1)).default([]),
    /** Denied blocks the owner accepts, each bound to a root, an address and the block's content hash */
    allow: z.array(AllowEntry).default([]),
  })
  .strict();

export interface AllowEntry {
  root: string;
  address: string;
  hash: string;
}

export interface InfraPolicySettings {
  enabled: boolean;
  roots: string[];
  allowedProviders: string[];
  allowedModules: string[];
  allow: AllowEntry[];
}

export type ParseResult =
  | { ok: true; settings: InfraPolicySettings }
  | { ok: false; errors: string[] };

/** `hashicorp/aws` or `registry.example.com/org/name` */
const PROVIDER_SOURCE = /^(?:[a-z0-9.-]+\/)?[a-z0-9_-]+\/[a-z0-9_-]+$/;
/** A prefix: optional `getter::`, optional `scheme://`, a host, and at least one path segment, ending in `/` */
const MODULE_PREFIX = /^(?:[a-z0-9+.-]+::)?(?:[a-z0-9+.-]+:\/\/)?[^/\s:]+(?::\d+)?\/[^/\s]+(?:\/[^/\s]+)*\/$/i;

function moduleEntryProblem(entry: string): string | null {
  if (/\s/.test(entry)) return "must not contain spaces";
  if (entry.startsWith("/") || entry.startsWith("./") || entry.startsWith("../")) return "local paths need no entry";
  if (entry.split("/").includes("..")) return "must not contain ..";
  if (entry.endsWith("/")) return MODULE_PREFIX.test(entry) ? null : "a prefix needs a host and at least one path segment, such as git::https://example.com/org/";
  return /[^/\s]\/[^/\s]/.test(entry) ? null : "must be a source such as namespace/name/provider or a full URL";
}

/** Validate a project's `infra_policy:` block (undefined means disabled). */
export function parseInfraPolicyConfig(raw: unknown): ParseResult {
  const parsed = Schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `infra_policy.${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const v = parsed.data;
  const errors: string[] = [];
  v.roots.forEach((root, i) => {
    if (!root.startsWith("/")) errors.push(`infra_policy.roots[${i}]: must be an absolute path`);
  });
  if (v.enabled && v.roots.length === 0) {
    errors.push("infra_policy: enabled is true but no roots are configured");
  }
  v.allowed_providers.forEach((p, i) => {
    if (!PROVIDER_SOURCE.test(p.trim().toLowerCase())) errors.push(`infra_policy.allowed_providers[${i}]: must be a provider source such as hashicorp/aws`);
  });
  v.allowed_modules.forEach((m, i) => {
    const problem = moduleEntryProblem(m);
    if (problem) errors.push(`infra_policy.allowed_modules[${i}]: ${problem}`);
  });
  v.allow.forEach((a, i) => {
    if (!v.roots.includes(a.root)) errors.push(`infra_policy.allow[${i}].root: must be one of roots`);
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: v.enabled,
      roots: v.roots,
      allowedProviders: v.allowed_providers,
      allowedModules: v.allowed_modules,
      allow: v.allow,
    },
  };
}
