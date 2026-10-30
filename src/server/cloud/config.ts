/**
 * The `cloud:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#cloud-machines.
 *
 * Credentials never go in the YAML: a machine names a profile from the
 * provider's own config files (for AWS, ~/.aws/config and
 * ~/.aws/credentials), and a key that looks like a credential is refused.
 */
import { z } from "zod";

/** Machine ids: a letter first (the same rule as placement's) */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** A named profile in the AWS config files; never an option (no leading "-") */
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.+=,@-]{0,63}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const INSTANCE_ID = /^i-[0-9a-f]{8}([0-9a-f]{9})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** EC2 tag keys and values: letters, digits, spaces and _ . : / = + - @ */
const TAG_KEY = /^[A-Za-z0-9_.:/=+@-][A-Za-z0-9 _.:/=+@-]{0,127}$/;
const TAG_VALUE = /^[A-Za-z0-9 _.:/=+@-]{0,256}$/;
/** Keys that would hold a credential */
const CREDENTIAL_KEY = /access[_-]?key|secret|session[_-]?token|password|credential/i;
/** An AWS access key id, wherever it is written */
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;

const DAY_MS = 86_400_000;

const name = z.string().regex(NAME, "names use a letter, then letters, digits, '_' or '-' (at most 32)");
const date = z.string().regex(DATE, "a date as YYYY-MM-DD");

const MachineSchema = z
  .object({
    provider: z.enum(["aws-ec2"]),
    region: z.string().regex(REGION, "an AWS region such as us-east-1"),
    /** A named profile in the AWS config files: the only source of credentials */
    profile: z.string().regex(PROFILE, "a profile name: letters, digits and _ . + = , @ - (at most 64, no leading '-')"),
    instance: z
      .object({
        id: z.string().regex(INSTANCE_ID, "an EC2 instance id such as i-0123456789abcdef0"),
        /** The tag the instance must carry: Lair refuses to act on an instance without it */
        tag: z
          .object({
            key: z.string().regex(TAG_KEY, "a tag key: letters, digits, spaces and _ . : / = + - @ (at most 128)"),
            value: z.string().regex(TAG_VALUE, "a tag value: letters, digits, spaces and _ . : / = + - @ (at most 256)"),
          })
          .strict(),
      })
      .strict(),
    /** The hourly price the meter counts, rounded up */
    price_per_hour: z.number().positive().max(1000),
    /** The machine's disk per month, counted for every month of the period begun so far */
    storage_per_month: z.number().min(0).max(100_000).default(0),
  })
  .strict();

const BudgetSchema = z
  .object({
    /** No start at or above this spend (US dollars) */
    limit: z.number().positive().max(1_000_000),
    /** The days the limit covers, both included (UTC) */
    period: z.object({ start: date, end: date }).strict(),
    /** Spend before the meter's first run (US dollars) */
    meter_start: z.number().min(0).max(1_000_000).default(0),
    /** How old the provider's cost reading may be (each read may cost money) */
    spend_check_hours: z.number().int().min(1).max(168).default(6),
    /** The status warns from this share of the limit on */
    warn_percent: z.number().int().min(1).max(100).default(80),
  })
  .strict();

export const CloudSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** How often each machine is described and the guard checked (seconds) */
    check_seconds: z.number().int().min(60).max(3600).default(300),
    /** Every provider call is cut off after this */
    request_timeout_seconds: z.number().int().min(5).max(120).default(30),
    machines: z.record(name, MachineSchema).default({}),
    budget: BudgetSchema.optional(),
  })
  .strict();

export interface CloudMachineSettings {
  id: string;
  provider: "aws-ec2";
  region: string;
  profile: string;
  instanceId: string;
  tagKey: string;
  tagValue: string;
  pricePerHour: number;
  storagePerMonth: number;
}

export interface CloudBudgetSettings {
  limit: number;
  periodStart: string;
  periodEnd: string;
  /** Midnight UTC of the first day */
  startMs: number;
  /** Midnight UTC after the last day (exclusive) */
  endMs: number;
  meterStart: number;
  spendCheckHours: number;
  warnPercent: number;
}

/** The parsed `cloud:` block. */
export interface CloudSettings {
  enabled: boolean;
  checkSeconds: number;
  requestTimeoutSeconds: number;
  machines: CloudMachineSettings[];
  budget: CloudBudgetSettings | null;
}

export type CloudParseResult = { ok: true; settings: CloudSettings } | { ok: false; errors: string[] };

/** Midnight UTC of a YYYY-MM-DD date, or null when there is no such day. */
function dayStart(text: string): number | null {
  const [y, m, d] = text.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : null;
}

/**
 * Credentials in the block: a key named like one, or a value shaped like an
 * AWS access key id. The message names the place, never the value.
 */
function credentialErrors(value: unknown, path: string, depth: number, errors: string[]): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (ACCESS_KEY_ID.test(value.slice(0, 4096))) {
      errors.push(`${path}: looks like an AWS access key; credentials never go in the project YAML, name a profile instead`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  for (const [key, child] of entries.slice(0, 500)) {
    if (CREDENTIAL_KEY.test(key)) {
      errors.push(`${path}.${key}: credentials never go in the project YAML; name a profile from your AWS config files with profile:`);
      continue;
    }
    credentialErrors(child, `${path}.${key}`, depth + 1, errors);
  }
}

/** Validate a project's `cloud:` block (undefined means off). */
export function parseCloudConfig(raw: unknown): CloudParseResult {
  const leaked: string[] = [];
  credentialErrors(raw, "cloud", 0, leaked);
  if (leaked.length > 0) return { ok: false, errors: leaked };

  const parsed = CloudSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `cloud.${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];

  const machines: CloudMachineSettings[] = Object.entries(value.machines).map(([id, m]) => ({
    id,
    provider: m.provider,
    region: m.region,
    profile: m.profile,
    instanceId: m.instance.id,
    tagKey: m.instance.tag.key,
    tagValue: m.instance.tag.value,
    pricePerHour: m.price_per_hour,
    storagePerMonth: m.storage_per_month,
  }));
  const seen = new Map<string, string>();
  for (const m of machines) {
    if (m.tagKey.toLowerCase().startsWith("aws:")) {
      errors.push(`cloud.machines.${m.id}.instance.tag.key: keys starting with aws: are AWS's own`);
    }
    const key = `${m.region}/${m.instanceId}`;
    const other = seen.get(key);
    if (other) errors.push(`cloud.machines.${m.id}.instance.id: ${m.instanceId} is machine ${other} already`);
    else seen.set(key, m.id);
  }

  let budget: CloudBudgetSettings | null = null;
  if (value.budget) {
    const b = value.budget;
    const startMs = dayStart(b.period.start);
    const lastMs = dayStart(b.period.end);
    if (startMs === null) errors.push(`cloud.budget.period.start: ${b.period.start} is not a day`);
    if (lastMs === null) errors.push(`cloud.budget.period.end: ${b.period.end} is not a day`);
    if (startMs !== null && lastMs !== null && lastMs < startMs) {
      errors.push("cloud.budget.period.end: before period.start");
    }
    if (startMs !== null && lastMs !== null) {
      budget = {
        limit: b.limit,
        periodStart: b.period.start,
        periodEnd: b.period.end,
        startMs,
        endMs: lastMs + DAY_MS,
        meterStart: b.meter_start,
        spendCheckHours: b.spend_check_hours,
        warnPercent: b.warn_percent,
      };
    }
  }

  if (value.enabled) {
    if (machines.length === 0) errors.push("cloud.machines: at least one machine is needed");
    // No budget, no starts: a cloud block that is on must say how much may be spent
    if (!value.budget) errors.push("cloud.budget: a limit and a period are needed (no start happens without them)");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      checkSeconds: value.check_seconds,
      requestTimeoutSeconds: value.request_timeout_seconds,
      machines,
      budget,
    },
  };
}
