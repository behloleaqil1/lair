/**
 * The `host_services:` block of a project config, validated with defaults.
 * See docs/configuration.md#host-services.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { HostServicesSettings, ServiceConfig } from "./types.js";

/** Service and machine names: a letter first, then letters, digits, '_' or '-' (at most 32) */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** What a service is needed by: a pipeline lane, a pipeline, or a `<pipeline>.<lane>` job */
const NEEDED_BY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const name = (what: string) => z.string().regex(NAME, `${what} use a letter, then letters, digits, '_' or '-' (at most 32)`);
const argv = z.array(z.string().min(1).max(4096)).min(1).max(64);

const ServiceSchema = z
  .object({
    name: name("service names"),
    /** argv to probe: exit 0 = up */
    probe: argv,
    /** argv to start (act mode only) */
    start: argv,
    /** Pipeline lanes, pipelines or `<pipeline>.<lane>` jobs that need this service */
    needed_by: z
      .array(z.string().regex(NEEDED_BY, "needed_by names a lane, a pipeline or <pipeline>.<lane> (letters, digits, '.', '_', '-')"))
      .max(32)
      .default([]),
  })
  .strict();

const MachineServicesSchema = z.array(ServiceSchema).max(16);

export const HostServicesSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "act"]).default("observe"),
    interval_seconds: z.number().int().min(10).max(3600).default(60),
    probe_timeout_seconds: z.number().int().min(1).max(120).default(15),
    start_timeout_seconds: z.number().int().min(1).max(300).default(30),
    start_delay_seconds: z.number().int().min(1).max(300).default(10),
    start_grace_seconds: z.number().int().min(10).max(3600).default(120),
    backoff_max_seconds: z.number().int().min(60).max(86_400).default(1800),
    stable_seconds: z.number().int().min(30).max(86_400).default(300),
    max_start_attempts: z.number().int().min(1).max(20).default(3),
    escalate_after_probes: z.number().int().min(1).max(1000).default(5),
    machines: z.record(name("machine ids"), MachineServicesSchema).default({}),
  })
  .strict();

export type ParseResult =
  | { ok: true; settings: HostServicesSettings }
  | { ok: false; errors: string[] };

/** Validate a project's `host_services:` block (undefined means disabled). */
export function parseHostServicesConfig(raw: unknown): ParseResult {
  const parsed = HostServicesSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `host_services.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  const machines = new Map<string, ServiceConfig[]>();
  for (const [machineId, services] of Object.entries(value.machines)) {
    const names = new Set<string>();
    const machineServices: ServiceConfig[] = [];
    for (const service of services) {
      if (names.has(service.name)) {
        errors.push(`host_services.machines.${machineId}: duplicate service name "${service.name}"`);
      }
      names.add(service.name);
      machineServices.push({
        name: service.name,
        probe: service.probe,
        start: service.start,
        neededBy: service.needed_by,
      });
    }
    machines.set(machineId, machineServices);
  }

  if (value.enabled && [...machines.values()].every((services) => services.length === 0)) {
    errors.push("host_services is enabled but no machine has a service");
  }
  if (value.start_delay_seconds > value.start_grace_seconds) {
    errors.push("host_services.start_delay_seconds: must not be longer than start_grace_seconds");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      mode: value.mode,
      intervalSeconds: value.interval_seconds,
      probeTimeoutSeconds: value.probe_timeout_seconds,
      startTimeoutSeconds: value.start_timeout_seconds,
      startDelaySeconds: value.start_delay_seconds,
      startGraceSeconds: value.start_grace_seconds,
      backoffMaxSeconds: value.backoff_max_seconds,
      stableSeconds: value.stable_seconds,
      maxStartAttempts: value.max_start_attempts,
      escalateAfterProbes: value.escalate_after_probes,
      machines,
    },
  };
}

/** Why act mode is off (observe mode, a read_only project), or null when it is on. */
export function actBlockedReason(config: ProjectConfig, settings: HostServicesSettings): string | null {
  if (settings.mode !== "act") return "host_services.mode is observe";
  if (config.read_only === true) return "the project is read_only";
  return null;
}
