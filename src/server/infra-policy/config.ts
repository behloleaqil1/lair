/**
 * The `infra_policy:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#infrastructure-policy-scan and docs/design/deploy-aws.md §2.1.
 */
import { z } from "zod";

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
    /** Addresses of denied blocks the owner accepts, e.g. `data.http.health` or `module.net.null_resource.notify` */
    allow: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface InfraPolicySettings {
  enabled: boolean;
  roots: string[];
  allowedProviders: string[];
  allowedModules: string[];
  allow: string[];
}

export type ParseResult =
  | { ok: true; settings: InfraPolicySettings }
  | { ok: false; errors: string[] };

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
