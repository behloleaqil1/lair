/**
 * The `agents:` block of a project config, validated with defaults applied.
 * See docs/configuration.md#agents.
 */
import { z } from "zod";
import type { ProjectConfig } from "../../shared/types.js";
import type { BudgetMetric } from "../../shared/agents-types.js";
import { isValidDragonId } from "../parsers/dragon-config.js";
import { getAdapter } from "../services/adapters.js";
import { placeholdersIn } from "../watchdog/config.js";

const argv = z.array(z.string().min(1)).min(1);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Model ids such as "vendor/model-1.5:latest"; never starting with "-" */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/**
 * Lines that mean the provider is rate limiting (matched case-insensitively).
 * They look for an error, not the words alone, so an agent that writes about
 * rate limiting in its own work isn't mistaken for one that hit a limit.
 */
export const DEFAULT_RATE_LIMIT_PATTERNS = [
  "\\brate[ _-]?limit(ed)?\\b.*\\b(exceeded|reached|error|retry|try again)\\b",
  "\\b(exceeded|reached|hit)\\b.*\\brate[ _-]?limit\\b",
  "\\b(error|status|http)\\b\\W*429\\b",
  "\\b429 too many requests\\b",
  "\\bquota (exceeded|exhausted)\\b",
  "\\busage limit (reached|exceeded)\\b",
];

/** Lines that mean the provider is failing (matched case-insensitively). */
export const DEFAULT_PROVIDER_ERROR_PATTERNS = [
  "\\boverloaded_error\\b",
  "\\bmodel is (overloaded|unavailable)\\b",
  "\\bapi error\\b.*\\b5\\d\\d\\b",
  "\\b(status|http)\\W*5(00|02|03|04|29)\\b",
];

const LimitSchema = z
  .object({
    soft: z.number().positive().optional(),
    hard: z.number().positive().optional(),
  })
  .strict();

const LimitsSchema = z
  .object({
    daily_tokens: LimitSchema.optional(),
    daily_cost: LimitSchema.optional(),
    monthly_tokens: LimitSchema.optional(),
    monthly_cost: LimitSchema.optional(),
  })
  .strict();

const LockSchema = z
  .object({
    name: z.string().regex(SAFE_NAME, "lock names use letters, digits, '.', '_' and '-'"),
    /** A lock file, or a lock directory with its holder's pid in <path>/<pid_file> */
    path: z.string().min(1),
    pid_file: z.string().regex(SAFE_NAME).default("pid"),
    /** launch: held while a run starts; run: held by the agent process until it ends */
    hold: z.enum(["launch", "run"]).default("launch"),
    /** A lock with no holder pid (a legacy lock) is broken once it is this old, when a run waits on it */
    stale_minutes: z.number().positive().default(30),
    /** Also break such a pid-less lock when no run waits on it */
    break_without_waiter: z.boolean().default(false),
  })
  .strict();

/** An environment variable name */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ProfileSchema = z
  .object({
    adapter: z.string().regex(SAFE_NAME, "adapter ids use letters, digits, '.', '_' and '-'"),
    model: z.string().regex(MODEL_ID).optional(),
    provider: z.string().regex(PROVIDER).optional(),
  })
  .strict();

const AgentsSchema = z
  .object({
    enabled: z.boolean().default(false),
    interval_seconds: z.number().int().min(1).max(3600).default(15),
    /** A run with no live agent process this long after it was requested is never-started */
    start_timeout_minutes: z.number().positive().default(10),
    /** A process that dies this soon after it started (or with an empty log) died on start */
    dead_on_start_seconds: z.number().min(0).default(60),
    /** Default: watchdog.hung_minutes */
    hung_minutes: z.number().positive().optional(),
    /** SIGTERM, then SIGKILL after this long */
    stop_grace_seconds: z.number().min(0).max(3600).default(30),
    /** How far a process's start time may differ from the one recorded for its pid */
    pid_start_tolerance_seconds: z.number().min(0).max(600).default(5),
    /** The agent's session directory; {agents_dir}, {agent} and {repo} are replaced */
    session_dir: z.string().min(1).optional(),
    /** Prints the branch state for a resume summary; {task}, {agent} and {repo} are replaced */
    branch_state_cmd: argv.optional(),
    command_timeout_seconds: z.number().int().min(1).max(600).default(30),
    /** Variables of this server's environment an agent also gets (beyond PATH, HOME, ...), e.g. a provider API key */
    env_passthrough: z.array(z.string().regex(ENV_NAME, "environment variable names only")).default([]),
    recovery: z
      .object({
        same_session_restarts: z.number().int().min(0).max(10).default(2),
        fresh_sessions: z.number().int().min(0).max(10).default(1),
        backoff_seconds: z.number().min(0).default(30),
        max_backoff_seconds: z.number().min(0).default(1800),
      })
      .strict()
      .default({}),
    retries: z
      .object({
        /** Never-started runs are retried this many times, then escalated */
        max_retries: z.number().int().min(0).max(100).default(3),
        backoff_seconds: z.number().min(0).default(60),
        max_backoff_seconds: z.number().min(0).default(3600),
      })
      .strict()
      .default({}),
    locks: z.array(LockSchema).default([]),
    failover: z
      .object({
        rate_limit_patterns: z.array(z.string().min(1)).default(DEFAULT_RATE_LIMIT_PATTERNS),
        provider_error_patterns: z.array(z.string().min(1)).default(DEFAULT_PROVIDER_ERROR_PATTERNS),
        /** A live run fails over only when its log's last line matches and the log was silent this long */
        silence_seconds: z.number().min(0).default(120),
        /** A provider that rate-limited or failed is skipped this long */
        cooldown_minutes: z.number().min(0).default(30),
        /** Failovers per task (chain of runs); one more is escalated instead */
        max_failovers: z.number().int().min(0).max(20).default(3),
      })
      .strict()
      .default({}),
    /** Regular expressions with named groups (?<tokens>...) and/or (?<cost>...), read from run logs */
    usage_patterns: z.array(z.string().min(1)).default([]),
    /** Adapter id -> provider name (default: the adapter id) */
    providers: z.record(z.string().regex(PROVIDER)).default({}),
    /** Agent id -> profiles to fail over to, in order */
    fallbacks: z.record(z.array(ProfileSchema)).default({}),
    budgets: z
      .object({
        project: LimitsSchema.optional(),
        /** Every agent's budget, unless per_agent sets the metric */
        agent: LimitsSchema.optional(),
        per_agent: z.record(LimitsSchema).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

type RawSettings = z.infer<typeof AgentsSchema>;

export interface BudgetLimit {
  soft?: number;
  hard?: number;
}

export type BudgetLimits = Partial<Record<BudgetMetric, BudgetLimit>>;

export interface AgentLockSettings {
  name: string;
  path: string;
  pidFile: string;
  hold: "launch" | "run";
  staleMinutes: number;
  breakWithoutWaiter: boolean;
}

export interface ProfileSettings {
  adapter: string;
  model?: string;
  provider?: string;
}

/** The parsed `agents:` block. */
export interface AgentsSettings {
  enabled: boolean;
  intervalSeconds: number;
  startTimeoutMinutes: number;
  deadOnStartSeconds: number;
  hungMinutes?: number;
  stopGraceSeconds: number;
  pidStartToleranceSeconds: number;
  sessionDir?: string;
  branchStateCmd?: string[];
  commandTimeoutSeconds: number;
  /** Extra variables an agent gets from this server's environment (never LAIR_*) */
  envPassthrough: string[];
  recovery: {
    sameSessionRestarts: number;
    freshSessions: number;
    backoffSeconds: number;
    maxBackoffSeconds: number;
  };
  retries: { maxRetries: number; backoffSeconds: number; maxBackoffSeconds: number };
  locks: AgentLockSettings[];
  failover: {
    rateLimit: RegExp[];
    providerError: RegExp[];
    silenceSeconds: number;
    cooldownMinutes: number;
    maxFailovers: number;
  };
  /** Usage patterns, compiled case-insensitive and global */
  usagePatterns: RegExp[];
  providers: Record<string, string>;
  fallbacks: Record<string, ProfileSettings[]>;
  budgets: {
    project?: BudgetLimits;
    agent?: BudgetLimits;
    perAgent: Record<string, BudgetLimits>;
  };
}

export type AgentsParseResult =
  | { ok: true; settings: AgentsSettings }
  | { ok: false; errors: string[] };

function compile(patterns: string[], flags: string, where: string, errors: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  patterns.forEach((pattern, i) => {
    try {
      compiled.push(new RegExp(pattern, flags));
    } catch (e) {
      errors.push(`${where}[${i}]: not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  return compiled;
}

function checkPlaceholders(template: string, allowed: string[], where: string, errors: string[]): void {
  for (const name of placeholdersIn([template])) {
    if (!allowed.includes(name)) {
      errors.push(`${where}: unknown placeholder {${name}} (allowed: ${allowed.map((n) => `{${n}}`).join(", ")})`);
    }
  }
}

function checkLimits(limits: RawSettings["budgets"]["project"], where: string, errors: string[]): void {
  if (!limits) return;
  for (const [metric, limit] of Object.entries(limits)) {
    if (limit && limit.soft !== undefined && limit.hard !== undefined && limit.soft > limit.hard) {
      errors.push(`${where}.${metric}: soft (${limit.soft}) is above hard (${limit.hard})`);
    }
  }
}

/**
 * Validate a project's `agents:` block (undefined means disabled). The
 * project config is needed to check the adapters that fallbacks name.
 */
export function parseAgentsConfig(raw: unknown, project?: ProjectConfig): AgentsParseResult {
  const parsed = AgentsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `agents.${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const value: RawSettings = parsed.data;
  const errors: string[] = [];

  const rateLimit = compile(value.failover.rate_limit_patterns, "i", "agents.failover.rate_limit_patterns", errors);
  const providerError = compile(
    value.failover.provider_error_patterns,
    "i",
    "agents.failover.provider_error_patterns",
    errors,
  );
  const usagePatterns = compile(value.usage_patterns, "gi", "agents.usage_patterns", errors);
  value.usage_patterns.forEach((pattern, i) => {
    if (!pattern.includes("(?<tokens>") && !pattern.includes("(?<cost>")) {
      errors.push(`agents.usage_patterns[${i}]: needs a named group (?<tokens>...) or (?<cost>...)`);
    }
  });

  if (value.session_dir) {
    checkPlaceholders(value.session_dir, ["agents_dir", "agent", "repo"], "agents.session_dir", errors);
  }
  value.branch_state_cmd?.forEach((arg, i) =>
    checkPlaceholders(arg, ["task", "agent", "repo"], `agents.branch_state_cmd[${i}]`, errors),
  );

  for (const name of value.env_passthrough) {
    if (name.startsWith("LAIR_")) {
      errors.push(`agents.env_passthrough: ${name}: LAIR_* variables are never passed to agents`);
    }
  }

  const lockNames = new Set<string>();
  const lockPaths = new Set<string>();
  for (const lock of value.locks) {
    if (lockNames.has(lock.name)) errors.push(`agents.locks: duplicate lock name ${lock.name}`);
    if (lockPaths.has(lock.path)) errors.push(`agents.locks: duplicate lock path ${lock.path}`);
    lockNames.add(lock.name);
    lockPaths.add(lock.path);
  }

  for (const [agent, profiles] of Object.entries(value.fallbacks)) {
    if (!isValidDragonId(agent)) {
      errors.push(`agents.fallbacks.${agent}: not a valid agent id`);
      continue;
    }
    profiles.forEach((profile, i) => {
      if (project && !getAdapter(profile.adapter, project)) {
        errors.push(`agents.fallbacks.${agent}[${i}]: unknown adapter ${profile.adapter}`);
      }
    });
  }
  for (const agent of Object.keys(value.budgets.per_agent)) {
    if (!isValidDragonId(agent)) errors.push(`agents.budgets.per_agent.${agent}: not a valid agent id`);
  }
  checkLimits(value.budgets.project, "agents.budgets.project", errors);
  checkLimits(value.budgets.agent, "agents.budgets.agent", errors);
  for (const [agent, limits] of Object.entries(value.budgets.per_agent)) {
    checkLimits(limits, `agents.budgets.per_agent.${agent}`, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    settings: {
      enabled: value.enabled,
      intervalSeconds: value.interval_seconds,
      startTimeoutMinutes: value.start_timeout_minutes,
      deadOnStartSeconds: value.dead_on_start_seconds,
      hungMinutes: value.hung_minutes,
      stopGraceSeconds: value.stop_grace_seconds,
      pidStartToleranceSeconds: value.pid_start_tolerance_seconds,
      sessionDir: value.session_dir,
      branchStateCmd: value.branch_state_cmd,
      commandTimeoutSeconds: value.command_timeout_seconds,
      envPassthrough: value.env_passthrough,
      recovery: {
        sameSessionRestarts: value.recovery.same_session_restarts,
        freshSessions: value.recovery.fresh_sessions,
        backoffSeconds: value.recovery.backoff_seconds,
        maxBackoffSeconds: value.recovery.max_backoff_seconds,
      },
      retries: {
        maxRetries: value.retries.max_retries,
        backoffSeconds: value.retries.backoff_seconds,
        maxBackoffSeconds: value.retries.max_backoff_seconds,
      },
      locks: value.locks.map((lock) => ({
        name: lock.name,
        path: lock.path,
        pidFile: lock.pid_file,
        hold: lock.hold,
        staleMinutes: lock.stale_minutes,
        breakWithoutWaiter: lock.break_without_waiter,
      })),
      failover: {
        rateLimit,
        providerError,
        silenceSeconds: value.failover.silence_seconds,
        cooldownMinutes: value.failover.cooldown_minutes,
        maxFailovers: value.failover.max_failovers,
      },
      usagePatterns,
      providers: value.providers,
      fallbacks: value.fallbacks,
      budgets: {
        project: value.budgets.project,
        agent: value.budgets.agent,
        perAgent: value.budgets.per_agent,
      },
    },
  };
}

/** Backoff for attempt n (1-based): base * 2^(n-1), capped. In milliseconds. */
export function backoffMs(attempt: number, baseSeconds: number, maxSeconds: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent) * 1000;
}
