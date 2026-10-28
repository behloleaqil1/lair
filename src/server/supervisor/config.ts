/**
 * The `supervisor:` block of a project config, validated with defaults
 * applied. In this version it holds the self-checks' settings
 * (`supervisor.checks`); see docs/configuration.md#supervisor-self-checks-and-the-ops-api.
 *
 * The server's own checks (event loop, latency, files, disk, stores,
 * command timeouts) follow the default project's block; a project's checks
 * follow its own.
 */
import { z } from "zod";
import { CHECK_IDS, type CheckId } from "../../shared/supervisor-types.js";

const ms = (fallback: number) => z.number().int().min(1).max(600_000).default(fallback);
const percent = (fallback: number) => z.number().min(0).max(100).default(fallback);
const count = (fallback: number) => z.number().int().min(1).max(1_000_000).default(fallback);
const minutes = (fallback: number) => z.number().int().min(1).max(10_080).default(fallback);

const EventLoopSchema = z.object({ warning_ms: ms(200), failing_ms: ms(1000) }).strict();

const LatencySchema = z
  .object({
    warning_ms: ms(1000),
    failing_ms: ms(5000),
    /** Fewer requests in the window than this are too few to judge */
    min_requests: count(20),
    window_minutes: z.number().int().min(1).max(60).default(5),
  })
  .strict();

const OpenFilesSchema = z.object({ warning_percent: percent(70), failing_percent: percent(90) }).strict();

const DiskSchema = z
  .object({
    warning_percent: percent(10),
    failing_percent: percent(5),
    warning_gib: z.number().min(0).max(100_000).default(5),
    failing_gib: z.number().min(0).max(100_000).default(1),
  })
  .strict();

const StoreSchema = z
  .object({
    warning_mb: count(500),
    failing_mb: count(2000),
    wal_warning_mb: count(64),
    wal_failing_mb: count(512),
  })
  .strict();

const TimeoutsSchema = z
  .object({ window_minutes: z.number().int().min(1).max(1440).default(15), warning: count(3), failing: count(10) })
  .strict();

const HoldsSchema = z.object({ warning: count(1), failing: count(3) }).strict();

const MachinesSchema = z.object({ failing_minutes: minutes(10) }).strict();

const GateQueueSchema = z.object({ warning_minutes: minutes(60), failing_minutes: minutes(180) }).strict();

const RetentionSchema = z.object({ warning_entries: count(5000), failing_entries: count(20_000) }).strict();

export const ChecksSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval_seconds: z.number().int().min(10).max(3600).default(60),
    /** A measure still running after this long reports unknown */
    timeout_seconds: z.number().int().min(1).max(120).default(10),
    /** A check failing this long raises one notice in the Decision Inbox */
    notice_minutes: z.number().int().min(1).max(1440).default(5),
    /** After a notice is withdrawn, the same check raises none again for this long */
    notice_cooldown_minutes: z.number().int().min(0).max(10_080).default(60),
    disabled: z.array(z.enum(CHECK_IDS)).max(CHECK_IDS.length).default([]),
    event_loop_lag: EventLoopSchema.default({}),
    request_latency: LatencySchema.default({}),
    open_files: OpenFilesSchema.default({}),
    disk_free: DiskSchema.default({}),
    store_size: StoreSchema.default({}),
    command_timeouts: TimeoutsSchema.default({}),
    infra_holds: HoldsSchema.default({}),
    machines: MachinesSchema.default({}),
    gate_queue_age: GateQueueSchema.default({}),
    retention: RetentionSchema.default({}),
  })
  .strict();

export const SupervisorSchema = z.object({ checks: ChecksSchema.default({}) }).strict();

export type ChecksSettings = z.infer<typeof ChecksSchema>;

export interface SupervisorSettings {
  checks: ChecksSettings;
}

export type ParseResult = { ok: true; settings: SupervisorSettings } | { ok: false; errors: string[] };

/** A warning threshold must come before its failing one. */
function orderErrors(c: ChecksSettings): string[] {
  const errors: string[] = [];
  const above = (path: string, warning: number, failing: number) => {
    if (warning > failing) errors.push(`supervisor.checks.${path}: the warning threshold (${warning}) is above the failing one (${failing})`);
  };
  const below = (path: string, warning: number, failing: number) => {
    if (warning < failing) errors.push(`supervisor.checks.${path}: the warning threshold (${warning}) is below the failing one (${failing})`);
  };
  above("event_loop_lag", c.event_loop_lag.warning_ms, c.event_loop_lag.failing_ms);
  above("request_latency", c.request_latency.warning_ms, c.request_latency.failing_ms);
  above("open_files", c.open_files.warning_percent, c.open_files.failing_percent);
  below("disk_free (percent)", c.disk_free.warning_percent, c.disk_free.failing_percent);
  below("disk_free (GiB)", c.disk_free.warning_gib, c.disk_free.failing_gib);
  above("store_size", c.store_size.warning_mb, c.store_size.failing_mb);
  above("store_size (WAL)", c.store_size.wal_warning_mb, c.store_size.wal_failing_mb);
  above("command_timeouts", c.command_timeouts.warning, c.command_timeouts.failing);
  above("infra_holds", c.infra_holds.warning, c.infra_holds.failing);
  above("gate_queue_age", c.gate_queue_age.warning_minutes, c.gate_queue_age.failing_minutes);
  above("retention", c.retention.warning_entries, c.retention.failing_entries);
  return errors;
}

/** Parse a project's `supervisor:` block (absent: every default). */
export function parseSupervisorConfig(raw: unknown): ParseResult {
  const parsed = SupervisorSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `supervisor.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const errors = orderErrors(parsed.data.checks);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { checks: parsed.data.checks } };
}

/** Every default (a project without the block, or one whose block is invalid, for the server's checks). */
export function defaultSupervisorSettings(): SupervisorSettings {
  const parsed = parseSupervisorConfig(undefined);
  if (!parsed.ok) throw new Error("the supervisor defaults are invalid");
  return parsed.settings;
}

export function checkDisabled(settings: ChecksSettings, id: CheckId): boolean {
  return settings.disabled.includes(id);
}
