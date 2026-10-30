/**
 * The `host_services:` block of a project config, validated with defaults.
 * See docs/configuration.md#host-services.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { HostServicesSettings, ServiceConfig } from "./types.js";

/** Service name: a letter first, then letters, digits, '_' or '-' (max 32) */
const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Machine id follows the same pattern */
const MACHINE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Lane or pipeline name */
const LANE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

const serviceName = z.string().regex(SERVICE_NAME, "service names use a letter, then letters, digits, '_' or '-' (at most 32)");
const machineId = z.string().regex(MACHINE_ID, "machine ids use a letter, then letters, digits, '_' or '-' (at most 32)");
const laneName = z.string().regex(LANE_NAME, "lane names use a letter, then letters, digits, '_' or '-' (at most 32)");
const argv = z.array(z.string().min(1).max(4096)).min(1).max(64);

const ServiceSchema = z
  .object({
    name: serviceName,
    /** argv to probe: exit 0 = up */
    probe: argv,
    /** argv to start (act mode only) */
    start: argv,
    /** Lanes or pipelines that need this service */
    needed_by: z.array(laneName).max(32).default([]),
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
    max_start_attempts: z.number().int().min(1).max(20).default(3),
    machines: z.record(machineId, MachineServicesSchema).default({}),
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

  // Validate: service names must be unique within a machine
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

  if (value.enabled && machines.size === 0) {
    errors.push("host_services is enabled but no machines have services configured");
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
      maxStartAttempts: value.max_start_attempts,
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
